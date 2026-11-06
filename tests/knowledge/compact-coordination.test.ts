import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { compactCoordinationSchema, coordinationReferences, materializeCoordination } from '../../src/knowledge/compact-coordination.ts';
import { assertStructuredModelRequest, structuredDiscoveryModelSchema, fromStructuredModel } from '../../src/knowledge/structured-model-boundary.ts';
import { StructuredCompiler } from '../../src/knowledge/structured-compiler.ts';
import { validateDiscovery, discoveryInput } from '../../src/knowledge/discovery.ts';
import type { KnowledgeCore } from '../../src/knowledge/service.ts';
import { retainedCoordination } from './coordination-fixture.ts';

const sourceId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const candidate = (index = 1) => ({ name: '业务对象', types: [{ id: `Type${index}`, name: '对象',
  properties: [{ id: `id${index}`, name: '编号', valueType: 'integer', sourceColumns: [{ sourceVersionId: sourceId(index), column: 'id' }],
    uncertainties: [{ kind: 'missing_context', question: '金额口径未知', dimensions: ['scope'] }] }],
}], links: [] });
const inputFor = (candidates: unknown[]) => ({ tableCandidates: coordinationReferences(candidates) });

test('reference plan restores every unchanged field, binding and unresolved issue', () => {
  const candidates = [candidate(1), candidate(2)], input = inputFor(candidates), plan = retainedCoordination(input);
  const rebuilt = materializeCoordination(candidates, plan);
  assert.deepEqual(rebuilt.types, input.tableCandidates.map(c => {
    const { ref: _, ...type } = c.types[0];
    return { ...type, properties: type.properties.map(({ ref: __, ...p }) => p) };
  }));
  assert.ok(!JSON.stringify(plan).includes('sourceColumns'));
  assert.ok(!JSON.stringify(plan).includes('金额口径未知'));
  assert.ok(!JSON.stringify(plan).includes('valueType'));
});

test('a partial rename never injects defaults that reset constraints or descriptions', () => {
  const raw: any = candidate();
  raw.types[0].description = '已有正式业务说明'; raw.types[0].identityNamespaces = ['legacy'];
  raw.types[0].properties[0].required = true; raw.types[0].properties[0].comparisonRequired = ['unit'];
  raw.links = [{ id: 'self', name: '单值自关联', from: 'Type1', to: 'Type1', multiple: false }];
  const plan: any = retainedCoordination(inputFor([raw]));
  plan.types[0].changes = { id: 'Renamed' }; plan.types[0].reason = '显式改名';
  plan.types[0].properties[0].changes = { id: 'renamed_id' }; plan.types[0].properties[0].reason = '显式改名';
  plan.links[0].changes = { id: 'renamed_self' }; plan.links[0].reason = '显式改名';
  const parsed = compactCoordinationSchema.parse(plan);
  assert.deepEqual(parsed.types[0].changes, { id: 'Renamed' });
  assert.deepEqual(parsed.types[0].properties[0].changes, { id: 'renamed_id' });
  assert.deepEqual(parsed.links[0].changes, { id: 'renamed_self' });
  const rebuilt = materializeCoordination([raw], plan);
  assert.equal(rebuilt.types[0].description, raw.types[0].description);
  assert.deepEqual(rebuilt.types[0].identityNamespaces, ['legacy']);
  assert.equal(rebuilt.types[0].properties[0].required, true);
  assert.deepEqual(rebuilt.types[0].properties[0].comparisonRequired, ['unit']);
  assert.equal(rebuilt.links[0].multiple, false);
  assert.equal(rebuilt.links[0].from, 'Renamed');
});

test('omissions, invented refs, duplicates, wrong kinds and moving properties across types fail closed', () => {
  const candidates = [candidate(1), candidate(2)], input = inputFor(candidates);
  for (const mutate of [
    (p: any) => { p.types[0].refs = ['t999']; },
    (p: any) => { p.types[0].refs.push('t0'); },
    (p: any) => { p.types[0].properties[0].refs = ['t0']; },
    (p: any) => { p.types[0].properties[0].refs = ['p1']; p.types[1].properties[0].refs = ['p0']; },
  ]) {
    const plan = retainedCoordination(input); mutate(plan);
    assert.throws(() => materializeCoordination(candidates, plan), /遗漏|不存在|重复|类别|不属于|必须说明理由/);
  }
  const duplicate = retainedCoordination(input);
  Object.assign(duplicate.types[1], { changes: { id: 'Type1' }, reason: '错误地重复编号' });
  assert.throws(() => materializeCoordination(candidates, duplicate), /编号重复/);
});

test('explicit merge preserves all provenance and requires explicit decisions for differing semantics', () => {
  const a = candidate(1), b = candidate(2);
  b.types[0].id = a.types[0].id; b.types[0].properties[0].id = a.types[0].properties[0].id;
  b.types[0].properties[0].valueType = 'decimal';
  const candidates = [a, b], input = inputFor(candidates), plan = retainedCoordination(input);
  assert.throws(() => materializeCoordination(candidates, plan), /字段冲突：valueType/);
  Object.assign(plan.types[0].properties[0], { changes: { valueType: 'decimal' }, reason: '同一业务编号属性，显式选择十进制表示' });
  const merged = materializeCoordination(candidates, plan);
  assert.equal(merged.types.length, 1); assert.equal(merged.types[0].properties.length, 1);
  assert.equal(merged.types[0].properties[0].sourceColumns.length, 2);
  assert.equal(merged.types[0].properties[0].uncertainties.length, 1);
  delete (plan.types[0].properties[0] as any).reason;
  assert.throws(() => materializeCoordination(candidates, plan), /必须说明理由/);
});

test('only explicit indexed resolutions remove issues; additions and unresolved issues survive', () => {
  const candidates = [candidate()], plan: any = retainedCoordination(inputFor(candidates));
  plan.resolutions = [{ ref: 'p0', indexes: [0], reason: '已有来源声明明确口径' }];
  plan.uncertainties = [{ ref: 'p0', kind: 'definition', question: '另一个业务含义尚不明确' }];
  const result = materializeCoordination(candidates, plan);
  assert.deepEqual(result.types[0].properties[0].uncertainties, [{ kind: 'definition', question: '另一个业务含义尚不明确' }]);
  for (const indexes of [[3], [0, 0]]) {
    plan.resolutions[0].indexes = indexes;
    assert.throws(() => materializeCoordination(candidates, plan), /索引/);
  }
  plan.resolutions = [{ ref: 't999', indexes: [0], reason: '不合法' }];
  assert.throws(() => materializeCoordination(candidates, plan), /不存在/);
});

test('type renames rewrite endpoints while missing or ambiguous targets never silently pick another object', () => {
  const a = candidate(1), b = candidate(2);
  const candidates: any[] = [a, b];
  candidates[0].links = [{ id: 'related', name: '关联', from: 'Type1', to: 'Type2', sourceColumns: [{ sourceVersionId: sourceId(1), column: 'id' }] }];
  const plan: any = retainedCoordination(inputFor(candidates));
  plan.types[1].changes = { id: 'Company' }; plan.types[1].reason = '显式业务命名';
  const result = materializeCoordination(candidates, plan);
  assert.equal(result.links[0].from, 'Type1'); assert.equal(result.links[0].to, 'Company');
  candidates[0].links[0].to = 'Missing';
  assert.equal(materializeCoordination(candidates, plan).links[0].to, 'Missing');
  const c: any = candidate(3); c.types[0].id = 'Type2'; candidates.push(c);
  const ambiguous: any = retainedCoordination(inputFor(candidates));
  // Keep distinct type groups rather than merge them.
  ambiguous.types = inputFor(candidates).tableCandidates.map(c => ({ refs: [c.types[0].ref], properties: c.types[0].properties.map(p => ({ refs: [p.ref] })) }));
  ambiguous.types[1].changes = { id: 'TargetA' }; ambiguous.types[1].reason = '分别保留';
  ambiguous.types[2].changes = { id: 'TargetB' }; ambiguous.types[2].reason = '分别保留';
  candidates[0].links[0].to = 'Type2';
  assert.throws(() => materializeCoordination(candidates, ambiguous), /端点存在多个/);
});

test('provider boundary accepts only compact output for references-v3 and forbids provenance edits', () => {
  const input = { stage: 'coordinate', coordinationFormat: 'references-v3', sources: [{ kind: 'table' }], ...inputFor([candidate()]) };
  assert.doesNotThrow(() => assertStructuredModelRequest('discover', input, compactCoordinationSchema));
  assert.throws(() => assertStructuredModelRequest('discover', input, structuredDiscoveryModelSchema('coordinate')), /输出契约/);
  assert.throws(() => assertStructuredModelRequest('discover', { ...input, coordinationFormat: 'unknown' }, compactCoordinationSchema), /未知/);
  const plan: any = retainedCoordination(input);
  plan.types[0].properties[0].changes = { sourceColumns: [] };
  assert.equal(compactCoordinationSchema.safeParse(plan).success, false);
  assert.ok(JSON.stringify(z.toJSONSchema(compactCoordinationSchema)).includes('sourceColumns'));
});

test('schema-valid compact decisions are persisted before coverage validation and reused without repurchase', async () => {
  const source = { id: sourceId(1), kind: 'table' as const, columns: ['id'], keyColumn: 'id', rows: [{ id: '1' }], warnings: [], metadata: { name: 'one', columns: [{ name: 'id', type: 'integer' }] } };
  const receipts = new Map<string, any>(); let calls = 0;
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith('SELECT fingerprint')) return { rows: receipts.has(String(values[1])) ? [receipts.get(String(values[1]))] : [] };
    if (sql.startsWith('INSERT INTO')) receipts.set(String(values[1]), { fingerprint: values[2], result: JSON.parse(String(values[3])) });
    return { rows: [{ id: 'lease' }] };
  };
  const core = { db: { pool: { query }, transaction: async (run: any) => run({ query }) } } as unknown as KnowledgeCore;
  const compiler = new StructuredCompiler({ core, job: { id: 'fixture', leaseToken: 'lease' }, policy: {}, reusedTables: { [source.id]: candidate() }, cached() {},
    async generate(_stage, _task, input: any) { calls++; const plan = retainedCoordination(input); plan.types[0].refs = ['t999']; return plan; } });
  await assert.rejects(compiler.discover([source], null), /不存在/);
  await assert.rejects(compiler.discover([source], null), /不存在/);
  assert.equal(calls, 1); assert.ok(receipts.has('coordinate'));
});

test('full host validation still defers unsupported bindings after compact reconstruction', () => {
  const raw = candidate(); raw.types[0].properties[0].sourceColumns[0].column = 'missing';
  const rebuilt = materializeCoordination([raw], retainedCoordination(inputFor([raw])));
  const source = { id: sourceId(1), kind: 'table' as const, columns: ['id'], keyColumn: 'id', rows: [{ id: '1' }], warnings: [], metadata: { name: 'one', columns: [{ name: 'id', type: 'integer' }] } };
  // Keep the valid type itself while its unbound property remains deferred.
  rebuilt.types[0].sourceColumns = [{ sourceVersionId: source.id, column: 'id' }];
  const checked = validateDiscovery(fromStructuredModel(rebuilt, 'coordinate'), [source], discoveryInput([source], null).catalog, null);
  assert.ok(checked.validation.deferred.some(item => item.member.id === 'id1'));
});

test('large candidates retain complete content with a much smaller reference response', () => {
  const candidates = Array.from({ length: 14 }, (_, index) => {
    const raw: any = candidate(index + 1);
    raw.types[0].properties = Array.from({ length: 13 }, (_, p) => ({ ...raw.types[0].properties[0], id: `field_${index}_${p}`, name: '业务属性及来源声明保持完整'.repeat(5) }));
    return raw;
  });
  const input = inputFor(candidates), plan = retainedCoordination(input), rebuilt = materializeCoordination(candidates, plan);
  assert.equal(rebuilt.types.flatMap(type => type.properties).length, 182);
  assert.ok(Buffer.byteLength(JSON.stringify(plan)) < Buffer.byteLength(JSON.stringify(rebuilt)) / 10);
});


test('distinct owners qualify inherited property IDs without merging definitions or evidence', () => {
  const a = candidate(1), b = candidate(2);
  b.types[0].properties[0].id = a.types[0].properties[0].id;
  const candidates = [a, b];
  const plan = retainedCoordination(inputFor(candidates));
  const result = materializeCoordination(candidates, plan);
  assert.deepEqual(result.types.map(t => t.properties[0].id), ['Type1:id1', 'Type2:id1']);
  result.types.forEach((type, index) => {
    assert.deepEqual(type.properties[0].sourceColumns, candidates[index].types[0].properties[0].sourceColumns);
    assert.deepEqual(type.properties[0].uncertainties, candidates[index].types[0].properties[0].uncertainties);
  });
  assert.deepEqual(materializeCoordination(candidates, plan), result);
  // Explicit conflicts remain errors; a same-owner collision needs a decision.
  plan.types.forEach(type => Object.assign(type.properties[0], { changes: { id: 'chosen' }, reason: '显式编号' }));
  assert.throws(() => materializeCoordination(candidates, plan), /编号重复/);
  a.types[0].properties.push({ ...a.types[0].properties[0] });
  const separate: any = { name: '同类型冲突', types: [{ refs: ['t0'], properties: [{ refs: ['p0'] }, { refs: ['p1'] }] }], links: [] };
  assert.throws(() => materializeCoordination([a], separate), /编号重复/);
});

test('qualified property IDs respect length and avoid existing identifiers', () => {
  const a = candidate(1), b = candidate(2);
  const id = 'x'.repeat(160);
  a.types[0].properties[0].id = id; b.types[0].properties[0].id = id;
  a.types[0].properties.push({ ...a.types[0].properties[0], id: 'Type1:' + id.slice(0, 20) });
  const result = materializeCoordination([a, b], retainedCoordination(inputFor([a, b])));
  const ids = result.types.flatMap(t => t.properties.map(p => p.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => id.length <= 160));
  a.types[0].properties[0].id = 'id'; b.types[0].properties[0].id = 'id';
  a.types[0].properties[1].id = 'Type1:id';
  const collision = materializeCoordination([a, b], retainedCoordination(inputFor([a, b])));
  assert.notEqual(collision.types[0].properties[0].id, 'Type1:id');
  assert.equal(collision.types[0].properties[1].id, 'Type1:id');
});


test('omission preserves members, additions create cross-table relations and property moves require reasons',()=>{
  const candidates=[candidate(1),candidate(2)];
  const unchanged=materializeCoordination(candidates,{name:'保留'});
  assert.equal(unchanged.types.length,2);assert.equal(unchanged.types[0].properties.length,1);
  const moved=materializeCoordination(candidates,{name:'修订',types:[{refs:['t1'],properties:[{refs:['p0'],reason:'业务属性应属于第二个对象'}]}],
    additions:{links:[{reason:'来源声明与业务注释明确两个对象的关系',member:{id:'global',name:'负责',from:'Type1',to:'Type2',sourceColumns:[{sourceVersionId:sourceId(1),column:'id'},{sourceVersionId:sourceId(2),column:'id'}]}}]}});
  assert.equal(moved.links.length,1);assert.equal(moved.types.find(t=>t.id==='Type2')!.properties.length,2);
  assert.equal(moved.types.find(t=>t.id==='Type1')!.properties.length,0);
  assert.throws(()=>materializeCoordination(candidates,{name:'删除',removals:[{ref:'t0',reason:'删除对象但遗漏处理属性'}]}),/处理其属性/);
  assert.equal(compactCoordinationSchema.safeParse({name:'错误',additions:{links:[{reason:'无来源',member:{id:'bad',name:'错误',from:'Type1',to:'Type2'}}]}}).success,false);
});

test('large business tasks retain global discovery and recover successful stages without repurchase',async()=>{
 const sources=Array.from({length:6},(_,index)=>({id:sourceId(index+1),kind:'table' as const,columns:['id'],keyColumn:'id',rows:[{id:'1'}],warnings:[],metadata:{name:`table${index}`,columns:[{name:'id',type:'integer'}]}}));
 const tables=Object.fromEntries(sources.map((s,index)=>{const raw:any=candidate(index+1);raw.types[0].description='业务对象描述'.repeat(500);raw.types[0].properties=Array.from({length:12},(_,p)=>({...raw.types[0].properties[0],id:`property_${index}_${p}`,name:'业务属性'.repeat(20)}));return [s.id,raw];}));
 sources.push({...sources[0],id:sourceId(7),rows:[],rowCount:0} as any);
 const receipts=new Map<string,any>(),calls:string[]=[];let failed=false,added=false;
 const query=async(sql:string,args:unknown[]=[])=>{
  if(sql.startsWith('SELECT fingerprint'))return {rows:receipts.has(String(args[1]))?[receipts.get(String(args[1]))]:[]};
  if(sql.startsWith('INSERT INTO'))receipts.set(String(args[1]),{fingerprint:args[2],result:JSON.parse(String(args[3]))});
  return {rows:[{id:'lease'}]};
 };
 const core={db:{pool:{query},transaction:async(run:any)=>run({query})}} as unknown as KnowledgeCore;
 const compiler=new StructuredCompiler({core,job:{id:'large',leaseToken:'lease'},policy:{},reusedTables:tables,cached(){},async generate(stage,_task,input:any){
  calls.push(stage);assert.ok(input.globalDirectory.length>=1||stage.includes('uncovered'));
  if(stage.startsWith('coordinate:definition:')&&calls.filter(s=>s.startsWith('coordinate:definition:')).length===2&&!failed){failed=true;throw new Error('模拟上游失败');}
  if(stage.startsWith('coordinate:coverage')&&!added){added=true;return {name:'全局已检查',additions:{links:[{reason:'跨批次业务关系依据',member:{id:'cross_batch',name:'关联',from:'Type1',to:'Type6',sourceColumns:[{sourceVersionId:sourceId(1),column:'id'},{sourceVersionId:sourceId(6),column:'id'}]}}]}};}
  return {name:'局部已检查'};
 }});
 await assert.rejects(compiler.discover(sources,null),/模拟上游失败/);
 const result=await compiler.discover(sources,null);
 const first=calls.find(s=>s.startsWith('coordinate:definition:'))!;assert.equal(calls.filter(s=>s===first).length,1);
 assert.equal(calls.length,new Set(calls).size+1);
 assert.ok(calls.some(stage=>stage.startsWith('coordinate:uncovered:')));
 assert.ok(calls.at(-1)!.startsWith('coordinate:coverage'));assert.equal((result.raw as any).links[0].id,'cross_batch');
 assert.equal((result.raw as any).types.length,6);
});

test('new classes, owned attributes and links share the full evidence validator',()=>{
 const candidates=[candidate(1)];
 const plan={name:'新增',additions:{types:[{reason:'资料声明新的业务对象',member:{id:'Additional',name:'新增对象',sourceColumns:[{sourceVersionId:sourceId(1),column:'id'}],properties:[]}}],
 properties:[{owner:'Additional',reason:'新增对象的业务标识',member:{id:'additional_id',name:'编号',valueType:'integer',sourceColumns:[{sourceVersionId:sourceId(1),column:'id'}]}}],
 links:[{reason:'同一来源的明确角色关系',member:{id:'additional_link',name:'关联',from:'Type1',to:'Additional',sourceColumns:[{sourceVersionId:sourceId(1),column:'missing'}]}}]}};
 const wire=materializeCoordination(candidates,plan);
 const source={id:sourceId(1),kind:'table' as const,columns:['id'],keyColumn:'id',rows:[{id:'1'}],warnings:[],metadata:{name:'one',columns:[{name:'id',type:'integer'}]}};
 const result=validateDiscovery(fromStructuredModel(wire,'coordinate'),[source],discoveryInput([source],null).catalog,null);
 assert.equal(result.definition.types.find(t=>t.id==='Additional')!.properties[0].id,'additional_id');
 assert.equal(result.definition.links.length,0);assert.ok(result.validation.deferred.some(d=>d.member.id==='additional_link'));
});

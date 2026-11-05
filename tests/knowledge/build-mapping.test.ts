import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ontologySchema } from '../../src/knowledge/contracts.ts';
import { compileCsvPlan } from '../../src/knowledge/build-mapping.ts';
import { planReviewSchema } from '../../src/knowledge/build-contracts.ts';

const ontology = ontologySchema.parse({ name: 'Generated', types: [
  { id: 'deal_7', name: 'Contract', properties: [{ id: 'money_8', name: 'Amount', valueType: 'decimal' }, { id: 'ends_9', name: 'Contract end', valueType: 'datetime' }] },
  { id: 'staff_3', name: 'Employee', properties: [] },
], links: [{ id: 'assignment_5', name: 'Employee handles contract', from: 'staff_3', to: 'deal_7', multiple: true }] });
const content = { kind: 'csv' as const, keyColumn: 'row', columns: ['row', 'contract', 'employee', 'amount', 'assigned_from', 'assigned_to'], rows: [{ row: 'r1', contract: 'C001', employee: 'E001', amount: '100.00', assigned_from: '2026-04-01T00:00:00Z', assigned_to: '2026-05-01T00:00:00Z' }], warnings: [] };
const mapping = {
  sourceVersionId: '00000000-0000-4000-8000-000000000001',
  objects: [{ id: 'contract', typeId: 'deal_7', identityColumn: 'contract' }, { id: 'employee', typeId: 'staff_3', identityColumn: 'employee' }],
  properties: [{ id: 'amount', object: 'contract', predicate: 'money_8', column: 'amount', time: { mode: 'unknown' }, comparison: {} }],
  links: [{ id: 'owner', predicate: 'assignment_5', from: 'employee', to: 'contract', time: { mode: 'columns', fromColumn: 'assigned_from', toColumn: 'assigned_to', reason: 'These columns describe the assignment, not the contract lifecycle' } }],
};
test('build mapping supports generated IDs, multiple objects, reverse direction and per-statement time', () => {
  const output = compileCsvPlan(content, mapping, ontology, 'source.local');
  assert.equal(output.claims[0].validity.precision, 'unknown');
  const relation = output.claims[1];
  assert.equal(relation.subject.value, 'E001'); assert.equal(relation.object?.value, 'C001');
  assert.equal(relation.validity.to, '2026-05-01T00:00:00.000Z');
  assert.ok(relation.evidence.some(e => e.kind === 'field' && e.field === 'employee'));
  assert.ok(relation.evidence.some(e => e.kind === 'field' && e.field === 'contract'));
});
test('build mapping rejects unexecutable endpoints and time without an explanation', () => {
  assert.throws(() => compileCsvPlan(content, { ...mapping, links: [{ ...mapping.links[0], from: 'contract', to: 'employee' }] }, ontology, 'source.local'));
  assert.throws(() => compileCsvPlan(content, { ...mapping, links: [{ ...mapping.links[0], time: { mode: 'columns', fromColumn: 'assigned_from' } }] }, ontology, 'source.local'));
  assert.throws(() => compileCsvPlan(content, { ...mapping, properties: [{ ...mapping.properties[0], column: 'missing' }] }, ontology, 'source.local'));
});

const auditOntology = ontologySchema.parse({name:'Audit',types:[{id:'Log',name:'Log',properties:[
  {id:'duration',name:'Request duration',valueType:'decimal'}, {id:'created',name:'Created',valueType:'datetime'},
]}]});
const auditTable = {kind:'table' as const,keyColumn:'id',columns:['id','time','create_time','start_time','end_time'],
  metadata:{columns:[{name:'time',type:'decimal(10,2)',comment:'请求耗时，单位：毫秒'},{name:'create_time',type:'datetime'},{name:'start_time',type:'timestamp'},{name:'end_time',type:'timestamp'}]},
  rows:[{id:'1',time:'30.82',create_time:'2024-06-18 22:40:41',start_time:'2024-06-18 14:40:41',end_time:'2024-06-18 14:41:41'}],warnings:[]};
const auditMapping = {sourceVersionId:mapping.sourceVersionId,objects:[{id:'log',typeId:'Log',identityColumn:'id'}],properties:[{id:'p7',object:'log',predicate:'duration',column:'time',time:{mode:'unknown'}}],links:[]};

test('a native field named time retains its decimal duration instead of being classified by its name',()=>{
  const result=compileCsvPlan(auditTable,auditMapping,auditOntology,'source.audit');
  assert.equal(result.claims[0].value,'30.82');assert.equal(result.claims[0].validity.precision,'unknown');
});

test('native TIMESTAMP date text uses the UTC read session and supports distinct interval boundaries',()=>{
  const result=compileCsvPlan(auditTable,{...auditMapping,properties:[{...auditMapping.properties[0],time:{mode:'columns',fromColumn:'start_time',toColumn:'end_time',reason:'confirmed validity boundaries'}}]},auditOntology,'source.audit');
  assert.equal(result.claims[0].validity.from,'2024-06-18T14:40:41.000Z');assert.equal(result.claims[0].validity.to,'2024-06-18T14:41:41.000Z');
});

test('native DATETIME requires explicit offset and identifies the actual bound field in errors',()=>{
  const proposal={...auditMapping,properties:[{...auditMapping.properties[0],time:{mode:'columns',fromColumn:'create_time',reason:'confirmed effective start'}}]};
  assert.throws(()=>compileCsvPlan(auditTable,proposal,auditOntology,'source.audit'),/属性绑定 p7.*有效起点 from.*create_time.*未声明时区/);
  const result=compileCsvPlan(auditTable,proposal,auditOntology,'source.audit',planReviewSchema.parse({datetimeOffset:'+08:00'}));
  assert.equal(result.claims[0].validity.from,'2024-06-18T14:40:41.000Z');
  const property=compileCsvPlan(auditTable,{...auditMapping,properties:[{id:'created',object:'log',predicate:'created',column:'create_time',meaning:'日志操作时间',time:{mode:'unknown'}}]},auditOntology,'source.audit',planReviewSchema.parse({datetimeOffset:'+08:00'}));
  assert.equal(property.claims[0].value,'2024-06-18T14:40:41.000Z');
});

test('equal parsed interval boundaries report the fields and interval error rather than a datetime regex',()=>{
  assert.throws(()=>compileCsvPlan(auditTable,{...auditMapping,properties:[{...auditMapping.properties[0],time:{mode:'columns',fromColumn:'start_time',toColumn:'start_time',reason:'explicit proposal'}}]},auditOntology,'source.audit'),/日期格式可解析.*起点不早于终点.*start_time/);
  assert.throws(()=>compileCsvPlan(auditTable,{...auditMapping,properties:[{...auditMapping.properties[0],time:{mode:'columns',fromColumn:'time',reason:'incorrect duration binding'}}]},auditOntology,'source.audit'),/有效起点 from.*来源字段 time.*耗时/);
});

test('confirming a datetime candidate cannot turn a numeric duration into a date during construction',()=>{
  assert.throws(()=>compileCsvPlan(auditTable,{...auditMapping,properties:[{id:'created',object:'log',predicate:'created',column:'time',meaning:'候选创建时间，仍需校验表示规则',time:{mode:'unknown'}}]},auditOntology,'source.audit'),/取值列 time.*无法解析日期时间/);
});

test('scientific decimal text expands exactly without rounding or accepting unbounded exponents',()=>{
  const proposal={...mapping,links:[]};
  for(const [raw,expected] of [['1e-8','0.00000001'],['9007199254740993123e-2','90071992547409931.23'],['-1.2300e2','-123.00']]){
    const data={...content,rows:[{...content.rows[0],amount:raw}]};
    assert.equal(compileCsvPlan(data,proposal,ontology,'source.local').claims[0].value,expected);
  }
  assert.throws(()=>compileCsvPlan({...content,rows:[{...content.rows[0],amount:'1e999999'}]},proposal,ontology,'source.local'),/预算/);
});

test('boolean zero-one encoding must be explicit and still rejects unrecognised codes',()=>{
  const model=ontologySchema.parse({name:'Flags',types:[{id:'Flag',name:'Flag',properties:[{id:'enabled',name:'Enabled',valueType:'boolean'}]}]});
  const data={kind:'csv' as const,keyColumn:'id',columns:['id','enabled'],rows:[{id:'A',enabled:'0'},{id:'B',enabled:'1'}],warnings:[]};
  const proposal={sourceVersionId:mapping.sourceVersionId,objects:[{id:'f',typeId:'Flag',identityColumn:'id'}],properties:[{id:'e',object:'f',predicate:'enabled',column:'enabled'}],links:[]};
  assert.throws(()=>compileCsvPlan(data,proposal,model,'source.local'),/显式选择zero_one/);
  const encoded={...proposal,properties:[{...proposal.properties[0],booleanEncoding:'zero_one'}]};
  assert.deepEqual(compileCsvPlan(data,encoded,model,'source.local').claims.map(c=>c.value),[false,true]);
  assert.throws(()=>compileCsvPlan({...data,rows:[{id:'C',enabled:'2'}]},encoded,model,'source.local'),/仅允许0\/1/);
});

test('explicit nullable role skips only native SQL NULL, keeping root facts and rejecting empty identity strings',()=>{
  const model=ontologySchema.parse({name:'Staff',types:[{id:'Staff',name:'Staff',properties:[{id:'name',name:'Name',valueType:'string'}]}],links:[{id:'manager',name:'Manager',from:'Staff',to:'Staff'}]});
  const data={kind:'table' as const,keyColumn:'key',columns:['key','id','manager_id','name'],metadata:{primaryKey:['id'],columns:[{name:'id',nullable:false},{name:'manager_id',nullable:true}]},
    rows:[{key:'r1',id:'A',manager_id:'',name:'Root'},{key:'r2',id:'B',manager_id:'A',name:'Child'}],
    nativeValues:{r1:{id:'A',manager_id:null,name:'Root'},r2:{id:'B',manager_id:'A',name:'Child'}},warnings:[]};
  const proposal={sourceVersionId:mapping.sourceVersionId,objects:[{id:'person',typeId:'Staff',identityColumn:'id'},{id:'boss',typeId:'Staff',identityColumn:'manager_id',onNull:'skip_object'}],
    properties:[{id:'name',object:'person',predicate:'name',column:'name'}],links:[{id:'manager',predicate:'manager',from:'person',to:'boss'}]};
  const result=compileCsvPlan(data,proposal,model,'source.local');
  assert.equal(result.claims.length,3);assert.equal(result.claims.find(c=>c.object)?.object?.value,'A');
  assert.throws(()=>compileCsvPlan({...data,nativeValues:{...data.nativeValues,r1:{...data.nativeValues.r1,manager_id:''}}},proposal,model,'source.local'),/空编号/);
  assert.throws(()=>compileCsvPlan(data,{...proposal,objects:[{...proposal.objects[0],onNull:'skip_object'},proposal.objects[1]]},model,'source.local'),/非主键/);
});

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

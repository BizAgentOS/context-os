import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ontologySchema } from '../../src/knowledge/contracts.ts';
import { compileCsvPlan } from '../../src/knowledge/build-mapping.ts';

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

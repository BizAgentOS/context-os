import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { claimSchema, ontologySchema, validitySchema, validateValue } from '../../src/knowledge/contracts.ts';
import { fingerprint, locateEvidence, mapCsv } from '../../src/knowledge/sources.ts';
import { projectStatements, type Statement } from '../../src/knowledge/projection.ts';

const ontology = ontologySchema.parse(JSON.parse(readFileSync(new URL('../../data/samples/knowledge-core/ontology.json', import.meta.url), 'utf8')));
const property = ontology.types.find(t => t.id === 'Contract')!.properties.find(p => p.id === 'contract_amount')!;
const statement = (overrides: Partial<Statement> = {}): Statement => ({
  id: 's1', revision: 1, predicate: 'contract_amount', value: '1000000.00', target_id: null, origin: 'source', status: 'accepted', basis: 'explicit',
  valid_from: '2026-04-01T00:00:00Z', valid_to: null, time_precision: 'instant', override_mode: null, override_source_version: null,
  source_id: 'src', source_version_id: 'v1', ...overrides,
});
const field = (rows: Statement[]) => (projectStatements('Contract', ontology, rows, '2026-04-20T00:00:00Z').fields.contract_amount as any);

test('decimal values are exact strings and unknown time cannot invent bounds', () => {
  validateValue(property, '999999999999999999.99');
  assert.throws(() => validateValue(property, 0.1));
  assert.throws(() => validitySchema.parse({ from: '2026-01-01T00:00:00Z', precision: 'unknown' }));
  assert.throws(() => validitySchema.parse({ from: '2026-05-01T00:00:00Z', to: '2026-04-01T00:00:00Z', precision: 'instant' }));
});
test('ontology rejects duplicated members and nonexistent link endpoints', () => {
  assert.throws(() => ontologySchema.parse({ ...ontology, types: [...ontology.types, ontology.types[0]] }));
  assert.throws(() => ontologySchema.parse({ ...ontology, links: [{ ...ontology.links[0], to: 'Missing' }] }));
});
test('a statement has exactly one of scalar value and object reference', () => {
  assert.throws(() => claimSchema.parse({ subject: { typeId: 'Contract', namespace: 'contract_no', value: 'C001' }, predicate: 'contract_amount', value: '1', object: { typeId: 'Company', namespace: 'company_code', value: 'ORG001' }, evidence: [{ kind: 'field', recordKey: 'C001', field: 'amount' }] }));
});
test('evidence must match the exact source version location', () => {
  const content = { kind: 'pdf' as const, text: 'A contract C001.', blocks: [{ kind: 'page', start: 0, end: 16, page: 2 }], warnings: [] };
  assert.deepEqual((locateEvidence(content, { kind: 'quote', quote: 'C001', start: 11 }) as any).location.pages, [2]);
  const aligned = locateEvidence(content, { kind: 'quote', quote: 'C001', start: 0 });
  assert.equal(aligned.kind === 'quote' && aligned.start, 11);
  assert.throws(() => locateEvidence({ ...content, text: 'C001 and C001' }, { kind: 'quote', quote: 'C001', start: 2 }));
  assert.throws(() => locateEvidence(content, { kind: 'quote', quote: 'invented', start: 0 }));
});
test('JSONB property order does not change idempotency fingerprints', () => {
  assert.equal(fingerprint({ a: 1, b: { d: 2, c: 3 } }), fingerprint({ b: { c: 3, d: 2 }, a: 1 }));
});
test('conflicting sources remain a conflict and equal values collect support', () => {
  assert.equal(field([statement(), statement({ id: 's2', value: '1200000.00' })]).status, 'conflict');
  const equal = field([statement(), statement({ id: 's2' })]);
  assert.equal(equal.value, '1000000.00'); assert.equal(equal.supportingAssertions.length, 2);
});
test('unknown business time is uncertain rather than timeless fact', () => {
  const result = field([statement({ valid_from: null, time_precision: 'unknown' })]);
  assert.equal(result.status, 'uncertain'); assert.equal(result.value, null);
});
test('source-version overrides expire and until-revoked overrides preserve disagreement', () => {
  const human = statement({ id: 'h', value: '1300000.00', origin: 'human', override_mode: 'source_version', override_source_version: 'v1' });
  assert.equal(field([statement(), human]).value, '1300000.00');
  assert.equal(field([statement({ source_version_id: 'v2' }), human]).value, '1000000.00');
  const persistent = field([statement({ source_version_id: 'v2' }), { ...human, override_mode: 'until_revoked' }]);
  assert.equal(persistent.value, '1300000.00'); assert.equal(persistent.disputed, true);
});
test('a relationship ends exactly at the half-open business boundary', () => {
  const rows = [statement({ predicate: 'contract_owner', value: null, target_id: 'employee-one', valid_to: '2026-05-01T00:00:00Z' }), statement({ id: 's2', predicate: 'contract_owner', value: null, target_id: 'employee-two', valid_from: '2026-05-01T00:00:00Z' })];
  const result = projectStatements('Contract', ontology, rows, '2026-05-01T00:00:00Z').fields.contract_owner as any;
  assert.deepEqual(result.value, { objectId: 'employee-two' });
});
test('CSV mapping retains record, identity and time evidence without float conversion', () => {
  const mapping = JSON.parse(readFileSync(new URL('../../data/samples/knowledge-core/mapping.json', import.meta.url), 'utf8'));
  const content = { kind: 'csv' as const, keyColumn: 'contract_no', columns: ['contract_no', 'amount', 'company_code', 'employee_no', 'valid_from', 'valid_to'], rows: [{ contract_no: 'C001', amount: '1000000.00', company_code: 'ORG001', employee_no: 'E001', valid_from: '2026-04-01T00:00:00Z', valid_to: '' }], warnings: [] };
  const output = mapCsv(content, mapping, ontology);
  assert.equal(output.claims.find(c => c.predicate === 'contract_amount')!.value, '1000000.00');
  assert.equal(output.claims.length, 4);
  assert.ok(output.claims.every(c => c.evidence.some(e => e.kind === 'field' && e.field === 'contract_no')));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ontologySchema } from '../../src/knowledge/contracts.ts';
import { projectStatements, type Statement } from '../../src/knowledge/projection.ts';
const comparison = { currency: 'CNY', unit: 'yuan', scope: 'tax-included' };
const ontology = ontologySchema.parse({ name: 'Money acceptance conditions', types: [{ id: 'Contract', name: 'Contract', properties: [{ id: 'amount', name: 'Amount', valueType: 'decimal', comparison }] }], links: [] });
const statement = (id: string, value: string, context: object, unknown = false): Statement => ({ id, revision: 1, predicate: 'amount', value, target_id: null, origin: 'source', override_mode: null, override_source_version: null, source_id: id, source_version_id: id, status: 'accepted', basis: 'explicit', valid_from: unknown ? null : '2026-04-01T00:00:00Z', valid_to: null, time_precision: unknown ? 'unknown' : 'instant', comparison: context });
test('money acceptance distinguishes reviewed comparability from missing context and unknown time', () => {
  for (const [contexts, expected] of [
    [[comparison, comparison], 'conflict'],
    [[comparison, {}], 'incomparable'],
    [[{}, {}], 'incomparable'],
  ] as const) {
    const view = projectStatements('Contract', ontology, [statement('csv', '1000000.00', contexts[0]), statement('pdf', '1200000.00', contexts[1])], '2026-04-20T00:00:00Z');
    assert.equal((view.fields.amount as any).status, expected);
  }
  const unknown = projectStatements('Contract', ontology, [statement('csv', '1000000.00', comparison, true), statement('pdf', '1200000.00', comparison, true)], '2026-04-20T00:00:00Z');
  assert.equal((unknown.fields.amount as any).status, 'uncertain');
});

test('comparison dimensions may be required without inventing expected context values', () => {
  const dimensions = ontologySchema.parse({ name: 'Unknown currency', types: [{ id: 'Contract', name: 'Contract', properties: [{ id: 'amount', name: 'Amount', valueType: 'decimal', comparisonRequired: ['currency'] }] }], links: [] });
  const view = projectStatements('Contract', dimensions, [statement('csv', '100', {}), statement('pdf', '120', {})], '2026-04-20T00:00:00Z');
  assert.equal((view.fields.amount as any).status, 'incomparable');
  assert.equal((view.fields.amount as any).candidates.length, 2);
});

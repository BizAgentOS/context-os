import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConflictEvents } from '../../src/knowledge/build-events.ts';
import { extractionSchema, ontologySchema } from '../../src/knowledge/contracts.ts';
const ontology = ontologySchema.parse({ name: 'Contracts', types: [{ id: 'Contract', name: 'Contract', properties: [{ id: 'amount', name: 'Amount', valueType: 'decimal' }] }], links: [] });
const claim = (value: string, from: string, to: string | null = null) => extractionSchema.parse({ claims: [{ subject: { typeId: 'Contract', namespace: 'approved.contract', value: 'C001' }, predicate: 'amount', value, validity: { from, to, precision: 'instant' }, evidence: [{ kind: 'field', recordKey: 'C001', field: 'amount' }] }] }).claims[0];
test('conflict events cover overlapping distinct facts but leave ordinary and sequential updates automatic', () => {
  assert.equal(buildConflictEvents(ontology, [claim('100', '2026-04-01T00:00:00Z')]).length, 0);
  assert.equal(buildConflictEvents(ontology, [claim('100', '2026-04-01T00:00:00Z'), claim('120', '2026-04-01T00:00:00Z')]).length, 1);
  assert.equal(buildConflictEvents(ontology, [claim('100', '2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z'), claim('120', '2026-05-01T00:00:00Z')]).length, 0);
});

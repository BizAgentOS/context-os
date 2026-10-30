import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ontologySchema, extractionSchema } from '../../src/knowledge/contracts.ts';
import { locateEvidence, validateClaim, type SourceContent } from '../../src/knowledge/sources.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/glm53-output.json', import.meta.url), 'utf8'));
test('recorded GLM 5.3 ontology evidence aligns unique exact quotes without accepting invented quotes', () => {
  const definition = ontologySchema.parse(fixture.discovery);
  let corrected = 0;
  for (const e of definition.discoveryEvidence) {
    const content = fixture.sources[e.sourceVersionId] as SourceContent;
    const located = locateEvidence(content, e.locator);
    if (located.kind === 'quote' && e.locator.kind === 'quote' && located.start !== e.locator.start) corrected++;
  }
  assert.ok(corrected > 0, '真实失败样本必须覆盖偏移重定位');
  assert.equal(definition.types.length, 4); assert.equal(definition.links.length, 3);
});
test('recorded GLM extraction retains exact amount, half-open responsibility periods and unknown times', () => {
  const definition = ontologySchema.parse(fixture.reviewedOntology);
  const output = extractionSchema.parse(fixture.extraction);
  assert.equal(output.claims.length, 6);
  for (const claim of output.claims) {
    validateClaim(definition, claim);
    for (const e of claim.evidence) {
      const located = locateEvidence(fixture.pdfContent, e);
      assert.ok(located.kind === 'quote' && located.location?.pages.length);
    }
  }
  const amount = output.claims.find(c => c.predicate === 'contract_amount')!;
  assert.equal(amount.value, '1200000.00');
  const owners = output.claims.filter(c => c.predicate === 'contract_owner');
  assert.equal(owners.find(c => c.object?.value === 'E001')!.validity.to, '2026-05-01T00:00:00Z');
  assert.equal(owners.find(c => c.object?.value === 'E002')!.validity.from, '2026-05-01T00:00:00Z');
  assert.equal(output.claims.find(c => c.predicate === 'company_name')!.validity.precision, 'unknown');
});

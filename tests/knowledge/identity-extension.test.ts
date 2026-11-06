import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/knowledge/database.ts';
import { KnowledgeCore } from '../../src/knowledge/service.ts';
import { BuildPlans } from '../../src/knowledge/build-plans.ts';
import { prepareCsv } from '../../src/knowledge/sources.ts';
const url = process.env.CONTEXT_OS_KNOWLEDGE_TEST_DATABASE_URL;
test('new source identity can join one existing object after approval, but cannot merge two objects', { skip: !url }, async () => {
  const db = await openDatabase(url!), dir = await mkdtemp(join(tmpdir(), 'identity-extension-'));
  let owns = false;
  const actor = { id: 'admin', role: 'admin' as const };
  try {
    assert.equal((await db.pool.query("SELECT 1 FROM pg_namespace WHERE nspname='knowledge'")).rows.length, 0);
    await db.initialize(); owns = true;
    const core = new KnowledgeCore(db), plans = new BuildPlans(core);
    const ontology = await core.draft(actor, { name: 'Staff', types: [{ id: 'Staff', name: '员工', properties: [{ id: 'code', name: '编号', valueType: 'string' }] }] });
    await core.act(actor, { operationId: 'publish', kind: 'PublishOntologyVersion', targetId: ontology.id, expectedRevision: 1, reason: 'test' });
    const text = 'Employee E002.';
    const pdf = await core.importSource(actor, 'pdf', 'pdf', 'PDF', { hash: 'pdf', path: 'fixture', content: { kind: 'pdf', text, warnings: [] }, async discard() {} });
    const documents = [{ sourceVersionId: pdf.version.id, claims: [{ claim: { subject: { typeId: 'Staff', namespace: `source.${pdf.source.id}`, value: 'E002' }, predicate: 'code', value: 'E002', evidence: [{ kind: 'quote', quote: text, start: 0 }] } }] }];
    let initial = await plans.create(actor, ontology.id, [pdf.version.id], { documents });
    initial = await plans.preflight(actor, initial.id, initial.revision);
    assert.equal(initial.status, 'approved');
    await plans.build(actor, initial.id);
    const old = (await core.list(actor, 'objects'))[0];
    const csv = await core.importSource(actor, 'csv', 'csv', 'CSV', await prepareCsv(dir, 'id\nE002\n', 'id'));
    const csvProposal = { sourceVersionId: csv.version.id, objects: [{ id: 'employee', typeId: 'Staff', identityColumn: 'id' }], properties: [{ id: 'code-map', object: 'employee', predicate: 'code', column: 'id' }], links: [] };
    let next = await plans.create(actor, ontology.id, [csv.version.id, pdf.version.id], { csv: [csvProposal], documents });
    next = await plans.preflight(actor, next.id, next.revision);
    assert.equal(next.preview!.ready, false);
    assert.ok(next.preview!.errors.some(e => e.includes('尚未决定')));
    next = await plans.save(actor, next.id, next.revision, next.proposal, { identities: Object.fromEntries(next.preview!.identities.map(g => [g.key, { decision: 'same', reason: 'explicitly approve exact source pair' }])) });
    next = await plans.preflight(actor, next.id, next.revision);
    assert.equal(next.status, 'approved', JSON.stringify(next.preview?.errors));
    await plans.build(actor, next.id);
    assert.equal((await core.list(actor, 'objects')).length, 1);
    const after = await core.object(actor, old.id);
    assert.equal(after.identifiers.length, 3);
    assert.equal(after.id, old.id);
    const third = await core.importSource(actor, 'third', 'third', 'Third', await prepareCsv(dir, 'id\nE002\n', 'id'));
    const isolated = await plans.create(actor, ontology.id, [third.version.id], { csv: [{ ...csvProposal, sourceVersionId: third.version.id }] });
    const isolatedReady = await plans.preflight(actor, isolated.id, isolated.revision); await plans.build(actor, isolatedReady.id);
    let conflicting = await plans.create(actor, ontology.id, [third.version.id, pdf.version.id], { csv: [{ ...csvProposal, sourceVersionId: third.version.id }], documents });
    conflicting = await plans.preflight(actor, conflicting.id, conflicting.revision);
    conflicting = await plans.save(actor, conflicting.id, conflicting.revision, conflicting.proposal, { identities: Object.fromEntries(conflicting.preview!.identities.map(g => [g.key, { decision: 'same', reason: 'must not silently merge two objects' }])) });
    conflicting = await plans.preflight(actor, conflicting.id, conflicting.revision);
    assert.equal(conflicting.preview!.ready, false);
    assert.ok(conflicting.preview!.errors.some(e => e.includes('身份纠错')));
    assert.equal((await core.list(actor, 'objects')).length, 2);
  } finally {
    if (owns) { await db.pool.query('DROP SCHEMA knowledge CASCADE'); await db.pool.query('DELETE FROM knowledge_schema_versions WHERE version BETWEEN 1 AND 5'); }
    await db.close(); await rm(dir, { recursive: true, force: true });
  }
});

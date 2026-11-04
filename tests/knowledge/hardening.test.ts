import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/knowledge/database.ts';
import { KnowledgeCore } from '../../src/knowledge/service.ts';
import { prepareCsv, mapCsv } from '../../src/knowledge/sources.ts';
import { ontologySchema } from '../../src/knowledge/contracts.ts';

const url = process.env.CONTEXT_OS_KNOWLEDGE_TEST_DATABASE_URL;
const admin = { id: 'reviewer', role: 'admin' as const };
test('hardening: semantic isolation and revision-specific correction evidence', { skip: !url }, async () => {
  const db = await openDatabase(url!), dir = await mkdtemp(join(tmpdir(), 'knowledge-hardening-'));
  let owns = false;
  try {
    assert.equal((await db.pool.query("SELECT 1 FROM pg_namespace WHERE nspname='knowledge'")).rows.length, 0);
    await db.initialize(); owns = true; await db.initialize();
    const core = new KnowledgeCore(db);
    const definition = ontologySchema.parse({ name: 'Test', types: [{ id: 'Contract', name: 'Contract', identityNamespaces: ['contract_no'], properties: [{ id: 'amount', name: 'Amount', valueType: 'decimal', comparison: { currency: 'CNY', unit: 'yuan', scope: 'tax-included' } }, { id: 'guaranteed', name: 'Has guarantee', valueType: 'boolean' }] }], links: [] });
    const draft = await core.draft(admin, definition);
    await core.act(admin, { operationId: 'publish', kind: 'PublishOntologyVersion', targetId: draft.id, expectedRevision: 1, reason: 'reviewed' });
    const source = await core.importSource(admin, 'upload', 'test', 'Contracts', await prepareCsv(dir, 'id,amount,guaranteed\nC1,100,false\n', 'id'));
    const mapping = { typeId: 'Contract', namespace: `source.${source.source.id}`, identityColumn: 'id', properties: { amount: 'amount', guaranteed: 'guaranteed' }, links: [], comparisons: { amount: { currency: 'CNY', unit: 'yuan', scope: 'tax-included' } }, validity: undefined };
    const mapped = mapCsv(source.version.content, mapping, definition);
    const validity = { from: '2026-01-01T00:00:00Z', to: null, precision: 'instant' };
    await core.commitExtraction(admin, { operationId: 'extract', ontologyId: draft.id, sourceVersionId: source.version.id, configuration: {}, output: { claims: mapped.claims.map(c => ({ ...c, validity })) } });
    const object = (await core.list(admin, 'objects'))[0];
    let view = await core.object(admin, object.id);
    assert.equal((view.fields.guaranteed as any).value, false);
    for (const semantics of [{ polarity: 'negated' }, { modality: 'planned' }, { condition: 'approval required' }]) {
      await core.commitExtraction(admin, { operationId: `semantic-${JSON.stringify(semantics)}`, ontologyId: draft.id, sourceVersionId: source.version.id, configuration: { semantics }, output: { claims: [{ ...mapped.claims[0], validity, value: '999', semantics }] } });
    }
    view = await core.object(admin, object.id);
    assert.equal((view.fields.amount as any).value, '100');
    assert.equal((view.fields.amount as any).pendingAssertions.length, 3);
    assert.equal(view.policy, 'semantic-conflict-v3-context');
    const correction = { operationId: 'correct', kind: 'CorrectProperty', targetId: object.id, expectedRevision: view.revision, predicate: 'amount', value: '200', validity, duration: 'until_revoked', reason: 'human review', comparison: mapping.comparisons.amount, evidence: [{ sourceVersionId: source.version.id, locator: { kind: 'field', recordKey: 'C1', field: 'amount' } }] };
    await assert.rejects(core.act(admin, { ...correction, operationId: 'bad-evidence', evidence: [{ sourceVersionId: source.version.id, locator: { kind: 'field', recordKey: 'missing', field: 'amount' } }] }));
    assert.equal((await core.object(admin, object.id)).revision, view.revision);
    const receipt = await core.act(admin, correction);
    assert.equal((await core.evidence(admin, String(receipt.assertionId), 1)).length, 1);
    const original = view.assertions.find((a: any) => a.predicate === 'amount' && a.status === 'accepted')!;
    await core.act(admin, { operationId: 'time-fix', kind: 'CorrectValidity', targetId: original.id, expectedRevision: original.revision, reason: 'additional time evidence', validity, evidence: correction.evidence });
    assert.equal((await core.evidence(admin, original.id, 1)).filter(e => e.role === 'revision_basis').length, 0);
    assert.equal((await core.evidence(admin, original.id, 2)).filter(e => e.role === 'revision_basis').length, 1);
    assert.equal((await core.object(admin, object.id)).fields.amount && ((await core.object(admin, object.id)).fields.amount as any).value, '200');
    await core.commitExtraction(admin, { operationId: 'foreign-currency', ontologyId: draft.id, sourceVersionId: source.version.id, configuration: { currency: 'USD' }, output: { claims: [{ ...mapped.claims[0], validity, comparison: { currency: 'USD', unit: 'yuan', scope: 'tax-included' } }] } });
    const incomparable = await core.object(admin, object.id);
    assert.equal((incomparable.fields.amount as any).status, 'incomparable');
    assert.equal((incomparable.fields.amount as any).value, null, 'human override cannot hide a scope mismatch');
  } finally {
    if (owns) { await db.pool.query('DROP SCHEMA knowledge CASCADE'); await db.pool.query('DELETE FROM knowledge_schema_versions WHERE version BETWEEN 1 AND 6'); }
    await db.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('hardening: updating schema preserves existing version-one data and identity history', { skip: !url }, async () => {
  const db = await openDatabase(url!);
  let owns = false;
  try {
    assert.equal((await db.pool.query("SELECT 1 FROM pg_namespace WHERE nspname='knowledge'")).rows.length, 0);
    await db.pool.query(await readFile(new URL('../../src/knowledge/sql/001-core.sql', import.meta.url), 'utf8')); owns = true;
    await db.pool.query('CREATE TABLE IF NOT EXISTS knowledge_schema_versions(version integer PRIMARY KEY,installed_at timestamptz DEFAULT clock_timestamp())');
    await db.pool.query('INSERT INTO knowledge_schema_versions(version) VALUES(1)');
    await db.pool.query("INSERT INTO knowledge.objects(id,type_id) VALUES('00000000-0000-4000-8000-000000000001','Contract')");
    await db.pool.query("INSERT INTO knowledge.identifiers(type_id,namespace,value,object_id) VALUES('Contract','contract_no','C1','00000000-0000-4000-8000-000000000001')");
    await db.initialize(); await db.initialize();
    const view = await db.pool.query("SELECT object_id,value FROM knowledge.identity_bindings WHERE system_to IS NULL");
    assert.deepEqual(view.rows, [{ object_id: '00000000-0000-4000-8000-000000000001', value: 'C1' }]);
    assert.equal((await db.pool.query('SELECT * FROM knowledge.objects')).rows.length, 1);
  } finally {
    if (owns) { await db.pool.query('DROP SCHEMA knowledge CASCADE'); await db.pool.query('DELETE FROM knowledge_schema_versions WHERE version BETWEEN 1 AND 6'); }
    await db.close();
  }
});

test('hardening: identity rematch preserves history, selected ownership, undo and future imports', { skip: !url }, async () => {
  const db = await openDatabase(url!), dir = await mkdtemp(join(tmpdir(), 'knowledge-identity-'));
  let owns = false;
  try {
    assert.equal((await db.pool.query("SELECT 1 FROM pg_namespace WHERE nspname='knowledge'")).rows.length, 0);
    await db.initialize(); owns = true;
    const core = new KnowledgeCore(db);
    const definition = ontologySchema.parse({ name: 'Identity', types: [{ id: 'Person', name: 'Person', identityNamespaces: ['employee_no'], properties: [{ id: 'title', name: 'Title', valueType: 'string' }] }], links: [{ id: 'reports_to', name: 'Reports to', from: 'Person', to: 'Person' }] });
    const draft = await core.draft(admin, definition);
    await core.act(admin, { operationId: 'publish', kind: 'PublishOntologyVersion', targetId: draft.id, expectedRevision: 1, reason: 'reviewed' });
    const source = await core.importSource(admin, 'upload', 'people', 'People', await prepareCsv(dir, 'id,title,manager\nE1,Engineer,E2\nE2,Director,E1\n', 'id'));
    const mapping = { typeId: 'Person', namespace: `source.${source.source.id}`, identityColumn: 'id', properties: { title: 'title' }, links: [{ predicate: 'reports_to', column: 'manager', targetType: 'Person', targetNamespace: `source.${source.source.id}` }], comparisons: {} };
    const output = mapCsv(source.version.content, mapping, definition);
    const validity = { from: '2026-01-01T00:00:00Z', to: null, precision: 'instant' };
    await core.commitExtraction(admin, { operationId: 'extract', ontologyId: draft.id, sourceVersionId: source.version.id, configuration: {}, output: { claims: output.claims.map(c => ({ ...c, validity })) } });
    const views = await Promise.all((await core.list(admin, 'objects')).map(o => core.object(admin, o.id)));
    const old = views.find(o => o.identifiers.some(i => i.value === 'E1'))!, other = views.find(o => o.id !== old.id)!;
    const selected = old.assertions.filter((a: any) => a.predicate === 'title').map((a: any) => a.id);
    const incoming = old.incoming[0];
    const knownAt = (await db.pool.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS stamp")).rows[0].stamp;
    const action = { operationId: 'rematch', kind: 'RematchIdentity', targetId: old.id, expectedRevision: old.revision, identity: { typeId: 'Person', namespace: `source.${source.source.id}`, value: 'E1' }, assertionIds: [...selected, incoming.id], reason: 'wrong identity mapping reviewed' };
    await assert.rejects(core.act({ id: 'editor', role: 'editor' }, action));
    await assert.rejects(core.act(admin, { ...action, operationId: 'bad-selection', assertionIds: [...selected, '00000000-0000-4000-8000-000000000099'] }));
    assert.equal((await core.object(admin, old.id)).revision, old.revision);
    const receipt = await core.act(admin, action);
    assert.deepEqual(await core.act(admin, action), receipt);
    const targetId = String(receipt.newObjectId);
    const after = await core.object(admin, targetId);
    const atBoundary = await core.object(admin, targetId, { knownAt: String(receipt.systemAt) });
    assert.equal(atBoundary.identifiers[0].value, 'E1');
    assert.equal((atBoundary.fields.title as any).value, 'Engineer');
    assert.equal((await core.object(admin, old.id, { knownAt: String(receipt.systemAt) })).identifiers.length, 0);
    assert.equal(after.identifiers[0].value, 'E1');
    assert.equal((after.fields.title as any).value, 'Engineer');
    assert.equal((await core.evidence(admin, String((receipt.moves as any[])[0].newAssertionId))).length, 2);
    const remaining = await core.object(admin, old.id);
    assert.equal(remaining.identifiers.length, 0);
    assert.equal((remaining.fields.title as any).value, null);
    assert.equal((remaining.fields.reports_to as any).value[0].objectId, other.id, 'unselected assertion is not moved');
    assert.equal((await core.object(admin, other.id)).incoming.length, 1);
    assert.equal(after.incoming[0].object_id, other.id);
    const historical = await core.object(admin, old.id, { knownAt });
    assert.equal(historical.identifiers[0].value, 'E1');
    assert.equal((historical.fields.title as any).value, 'Engineer');
    await assert.rejects(core.act(admin, { ...action, operationId: 'stale' }));
    const reverse = await core.act(admin, { ...action, operationId: 'undo', targetId, expectedRevision: after.revision, newObjectId: old.id, expectedTargetRevision: remaining.revision, assertionIds: (receipt.moves as any[]).map(m => m.newAssertionId) });
    const restored = await core.object(admin, old.id);
    assert.equal(restored.identifiers[0].value, 'E1');
    assert.equal((restored.fields.title as any).value, 'Engineer');
    assert.ok(reverse.moves);
    const next = await core.importSource(admin, 'upload-next', 'people', 'People', await prepareCsv(dir, 'id,title,manager\nE1,Lead,E2\nE2,Director,E1\n', 'id'));
    await core.commitExtraction(admin, { operationId: 'extract-next', ontologyId: draft.id, sourceVersionId: next.version.id, configuration: {}, output: { claims: mapCsv(next.version.content, mapping, definition).claims.map(c => ({ ...c, validity })) } });
    assert.equal(((await core.object(admin, old.id)).fields.title as any).value, 'Lead');
    assert.equal((await core.object(admin, old.id, { knownAt })).identifiers[0].value, 'E1');
  } finally {
    if (owns) { await db.pool.query('DROP SCHEMA knowledge CASCADE'); await db.pool.query('DELETE FROM knowledge_schema_versions WHERE version BETWEEN 1 AND 6'); }
    await db.close(); await rm(dir, { recursive: true, force: true });
  }
});

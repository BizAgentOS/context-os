import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/knowledge/database.ts';
import { KnowledgeCore } from '../../src/knowledge/service.ts';
import { KnowledgeJobs } from '../../src/knowledge/jobs.ts';
import { prepareCsv, mapCsv } from '../../src/knowledge/sources.ts';
import type { JsonModel } from '../../src/knowledge/model.ts';
import { ontologySchema } from '../../src/knowledge/contracts.ts';

const url = process.env.CONTEXT_OS_KNOWLEDGE_TEST_DATABASE_URL;
const actor = { id: 'test-admin', role: 'admin' as const };
/** Integration tests require an explicitly dedicated EMPTY database; never drop an existing schema. */
test('PostgreSQL: import, evidence, conflicts, dual time, corrections, resync, retries and authorizations', { skip: !url }, async () => {
  const db = await openDatabase(url!);
  const dir = await mkdtemp(join(tmpdir(), 'context-os-knowledge-'));
  let ownsSchema = false;
  try {
    const exists = await db.pool.query("SELECT 1 FROM pg_namespace WHERE nspname='knowledge'");
    assert.equal(exists.rows.length, 0, '必须使用没有 knowledge schema 的专用空测试数据库');
    await db.initialize(); ownsSchema = true;
    const core = new KnowledgeCore(db);
    const definition = JSON.parse(await readFile(new URL('../../data/samples/knowledge-core/ontology.json', import.meta.url), 'utf8'));
    const mapping = JSON.parse(await readFile(new URL('../../data/samples/knowledge-core/mapping.json', import.meta.url), 'utf8'));
    const csv = await readFile(new URL('../../data/samples/knowledge-core/contracts.csv', import.meta.url), 'utf8');
    const draft = await core.draft(actor, definition);
    const published = await core.act(actor, { operationId: 'publish', kind: 'PublishOntologyVersion', targetId: draft.id, expectedRevision: 1, reason: 'test' });
    const source = await core.importSource(actor, 'import-1', 'contracts', 'Contracts', await prepareCsv(dir, csv, 'contract_no'));
    const repeatedSource = await core.importSource(actor, 'import-2', 'contracts', 'Contracts', await prepareCsv(dir, csv, 'contract_no'));
    assert.equal(source.version.id, repeatedSource.version.id);
    const output = mapCsv(source.version.content, mapping, ontologySchema.parse(definition));
    const config = { mapping, model: 'test-mapping' };
    const result = await core.commitExtraction(actor, { operationId: 'extract-1', ontologyId: String(published.id), sourceVersionId: source.version.id, configuration: config, output });
    const repeated = await core.commitExtraction(actor, { operationId: 'extract-1', ontologyId: String(published.id), sourceVersionId: source.version.id, configuration: config, output });
    assert.deepEqual(result, repeated);
    const objectId = (await db.pool.query("SELECT object_id FROM knowledge.identifiers WHERE namespace='contract_no' AND value='C001'")).rows[0].object_id;
    const first = await core.object(actor, objectId, { validAt: '2026-04-20T00:00:00Z' });
    assert.equal((first.fields.contract_amount as any).value, '1000000.00');
    const amount = first.assertions.find((a: any) => a.predicate === 'contract_amount');
    assert.ok(amount);
    assert.equal((await core.evidence(actor, amount.id))[0].locator.kind, 'field');
    // A second document is a separately versioned source with exact quote evidence.
    const text = 'Contract C001 amount is 1200000.00.';
    const pdf = await core.importSource(actor, 'pdf-fixture', 'pdf-fixture', 'PDF fixture (preparsed)', { hash: 'fixture', content: { kind: 'pdf', text, blocks: [{ kind: 'page', start: 0, end: text.length, page: 1 }], warnings: [] }, path: 'fixture-not-an-original-pdf', async discard() {} });
    const documentClaim = { subject: { typeId: 'Contract', namespace: 'contract_no', value: 'C001' }, predicate: 'contract_amount', value: '1200000.00', validity: { from: '2026-04-01T00:00:00Z', to: null, precision: 'instant' }, evidence: [{ kind: 'quote', quote: text, start: 0 }] };
    await core.commitExtraction(actor, { operationId: 'pdf-extract', ontologyId: draft.id, sourceVersionId: pdf.version.id, configuration: { model: 'fixture' }, output: { claims: [documentClaim] } });
    const conflict = await core.object(actor, objectId, { validAt: '2026-04-20T00:00:00Z' });
    assert.equal((conflict.fields.contract_amount as any).status, 'conflict');
    const known = (await db.pool.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stamp`)).rows[0].stamp;
    const correction = { operationId: 'correct', kind: 'CorrectProperty', targetId: objectId, expectedRevision: conflict.revision, predicate: 'contract_amount', value: '1300000.00', validity: { from: '2026-04-01T00:00:00Z', to: null, precision: 'instant' }, duration: 'until_revoked', reason: 'signed amendment checked' };
    const receipt = await core.act(actor, correction);
    assert.deepEqual(await core.act(actor, correction), receipt);
    const historical = await core.object(actor, objectId, { validAt: '2026-04-20T00:00:00Z', knownAt: known });
    assert.equal((historical.fields.contract_amount as any).status, 'conflict');
    const corrected = await core.object(actor, objectId, { validAt: '2026-04-20T00:00:00Z' });
    assert.equal((corrected.fields.contract_amount as any).value, '1300000.00');
    assert.equal((corrected.fields.contract_amount as any).disputed, true);
    await assert.rejects(core.act(actor, { ...correction, operationId: 'stale', value: '2.00' }));
    const nextCsv = await readFile(new URL('../../data/samples/knowledge-core/contracts-updated.csv', import.meta.url), 'utf8');
    const next = await core.importSource(actor, 'import-update', 'contracts', 'Contracts', await prepareCsv(dir, nextCsv, 'contract_no'));
    await core.commitExtraction(actor, { operationId: 'extract-update', ontologyId: draft.id, sourceVersionId: next.version.id, configuration: config, output: mapCsv(next.version.content, mapping, ontologySchema.parse(definition)) });
    assert.equal((await core.object(actor, objectId, { validAt: '2026-05-20T00:00:00Z' })).fields.contract_amount && ((await core.object(actor, objectId, { validAt: '2026-05-20T00:00:00Z' })).fields.contract_amount as any).value, '1300000.00');
    assert.equal((await core.evidence(actor, amount.id))[0].source_version_id, source.version.id);
    const pdfAmount = conflict.assertions.find((a: any) => a.source_version_id === pdf.version.id)!;
    await core.act(actor, { operationId: 'fix-time', kind: 'CorrectValidity', targetId: pdfAmount.id, expectedRevision: pdfAmount.revision, reason: 'explicit end of the effective interval', validity: { from: '2026-04-01T00:00:00Z', to: '2026-05-01T00:00:00Z', precision: 'instant' } });
    await core.act(actor, { operationId: 'revoke-human', kind: 'RejectAssertion', targetId: String(receipt.assertionId), expectedRevision: 1, reason: 'withdraw previous human override' });
    const sourceOnly = await core.object(actor, objectId, { validAt: '2026-05-20T00:00:00Z' });
    assert.equal((sourceOnly.fields.contract_amount as any).value, '1100000.00');
    await core.act(actor, { ...correction, operationId: 'scoped-human', expectedRevision: sourceOnly.revision, value: '1400000.00', duration: 'source_version', sourceVersionId: next.version.id });
    assert.equal(((await core.object(actor, objectId, { validAt: '2026-05-20T00:00:00Z' })).fields.contract_amount as any).value, '1400000.00');
    const third = await core.importSource(actor, 'third-import', 'contracts', 'Contracts', await prepareCsv(dir, nextCsv.replace('1100000.00', '1150000.00'), 'contract_no'));
    await core.commitExtraction(actor, { operationId: 'third-extract', ontologyId: draft.id, sourceVersionId: third.version.id, configuration: config, output: mapCsv(third.version.content, mapping, ontologySchema.parse(definition)) });
    const expired = await core.object(actor, objectId, { validAt: '2026-05-20T00:00:00Z' });
    assert.equal((expired.fields.contract_amount as any).value, '1150000.00', '来源新版本使限定版本的人工覆盖失效');
    const raced = await Promise.allSettled([
      core.act(actor, { ...correction, operationId: 'race-one', expectedRevision: expired.revision }),
      core.act(actor, { ...correction, operationId: 'race-two', expectedRevision: expired.revision }),
    ]);
    assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1, '两个相同对象修订上的并发修正只能成功一次');
    await assert.rejects(core.act({ id: 'viewer', role: 'viewer' }, correction));
    await assert.rejects(core.commitExtraction(actor, { operationId: 'old-source', ontologyId: draft.id, sourceVersionId: source.version.id, configuration: {}, output }));
    // A failed job is explicit and retryable, never silently treated as successful.
    const model: JsonModel = { identity: 'failure-fixture', async generate() { throw new Error('fixture failure'); }, async close() {} };
    const jobs = new KnowledgeJobs(core, model);
    const job = await jobs.enqueue(actor, { kind: 'discover', operationId: 'discover-failure', sourceVersionIds: [next.version.id] });
    await jobs.once();
    assert.equal((await db.pool.query('SELECT state FROM knowledge.jobs WHERE id=$1', [job.id])).rows[0].state, 'failed');
    await jobs.retry(actor, job.id);
    assert.equal((await db.pool.query('SELECT state FROM knowledge.jobs WHERE id=$1', [job.id])).rows[0].state, 'queued');
    await jobs.close();
  } finally {
    if (ownsSchema) { await db.pool.query('DROP SCHEMA knowledge CASCADE'); await db.pool.query('DELETE FROM knowledge_schema_versions WHERE version=1'); }
    await db.close(); await rm(dir, { recursive: true, force: true });
  }
});

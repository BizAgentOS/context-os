import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../../src/knowledge/database.ts';
import { createKnowledgeServer } from '../../src/knowledge/server.ts';
import { textPdf } from '../agent/document-fixture.ts';
import type { JsonModel } from '../../src/knowledge/model.ts';

const url = process.env.CONTEXT_OS_KNOWLEDGE_TEST_DATABASE_URL;
test('HTTP: authenticate, PDF parse, publish, queued extraction, conflict, feedback, historical view and permissions', { skip: !url }, async () => {
  const db = await openDatabase(url!);
  const directory = await mkdtemp(join(tmpdir(), 'context-os-knowledge-http-'));
  let app: Awaited<ReturnType<typeof createKnowledgeServer>> | undefined, ownsSchema = false;
  try {
    assert.equal((await db.pool.query("SELECT 1 FROM pg_namespace WHERE nspname='knowledge'")).rows.length, 0, '需使用空的专用测试库');
    await db.initialize(); ownsSchema = true;
    const admin = randomBytes(32).toString('hex'), editor = randomBytes(32).toString('hex'), viewer = randomBytes(32).toString('hex');
    const model: JsonModel = { identity: 'http-fixture', async close() {}, async generate(task, raw) {
      assert.equal(task, 'extract');
      const input = raw as { content: { text: string } };
      const quote = input.content.text.trim();
      return { claims: [{ subject: { typeId: 'Contract', namespace: 'contract_no', value: 'C001' }, predicate: 'contract_amount', value: '1200000.00', validity: { from: '2026-04-01T00:00:00Z', to: null, precision: 'instant' }, evidence: [{ kind: 'quote', quote, start: input.content.text.indexOf(quote) }] }] };
    } };
    app = await createKnowledgeServer({ db, directory, worker: false, model, principals: [{ id: 'admin', role: 'admin', token: admin }, { id: 'editor', role: 'editor', token: editor }, { id: 'viewer', role: 'viewer', token: viewer }] });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const call = async (path: string, data?: unknown, token = admin) => {
      const response = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json() as any };
    };
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await call('/api/state', undefined, '')).status, 401);
    assert.equal((await fetch(base + '/api/state', { headers: { Authorization: `Bearer ${admin}`, Origin: 'https://example.invalid' } })).status, 403);
    const definition = JSON.parse(await readFile(new URL('../../data/samples/knowledge-core/ontology.json', import.meta.url), 'utf8'));
    assert.equal((await call('/api/ontologies', { definition }, viewer)).status, 403);
    const draft = await call('/api/ontologies', { definition }); assert.equal(draft.status, 200);
    const publish = { operationId: 'http-publish', kind: 'PublishOntologyVersion', targetId: draft.body.id, expectedRevision: 1, reason: 'reviewed sample' };
    assert.equal((await call('/api/actions', publish, editor)).status, 403);
    assert.equal((await call('/api/actions', publish)).status, 200);
    const csv = await readFile(new URL('../../data/samples/knowledge-core/contracts.csv', import.meta.url), 'utf8');
    const source = await call('/api/sources/csv', { operationId: 'http-csv', sourceKey: 'contracts', title: 'Contracts', keyColumn: 'contract_no', text: csv });
    assert.equal(source.status, 200);
    const mapping = JSON.parse(await readFile(new URL('../../data/samples/knowledge-core/mapping.json', import.meta.url), 'utf8'));
    assert.equal((await call('/api/jobs', { kind: 'extract', operationId: 'http-map', ontologyId: draft.body.id, sourceVersionId: source.body.version.id, mapping })).status, 202);
    await app.jobs.once();
    const pdf = await call('/api/sources/pdf', { operationId: 'http-pdf', sourceKey: 'pdf', title: 'PDF contract', name: 'contract.pdf', base64: textPdf(['Contract C001 amount is 1200000.00 effective 2026-04-01.']).toString('base64') });
    assert.equal(pdf.status, 200, JSON.stringify(pdf.body));
    assert.equal(pdf.body.version.content.blocks[0].page, 1);
    await call('/api/jobs', { kind: 'extract', operationId: 'http-document', ontologyId: draft.body.id, sourceVersionId: pdf.body.version.id });
    await app.jobs.once();
    const state = await call('/api/state');
    assert.ok(state.body.jobs.every((j: any) => j.state === 'completed'), JSON.stringify(state.body.jobs));
    const objectId = state.body.objects.find((o: any) => o.type_id === 'Contract').id;
    const object = await call(`/api/objects/${objectId}?validAt=2026-04-20T00:00:00Z`);
    assert.equal(object.body.fields.contract_amount.status, 'conflict');
    const claim = object.body.assertions.find((a: any) => a.source_version_id === pdf.body.version.id);
    const evidence = await call('/api/evidence/' + claim.id);
    assert.deepEqual(evidence.body[0].locator.location.pages, [1]);
    const correction = { operationId: 'http-correct', kind: 'CorrectProperty', targetId: objectId, expectedRevision: object.body.revision, reason: 'reviewed amendment', predicate: 'contract_amount', value: '1300000.00', duration: 'until_revoked', validity: { from: '2026-04-01T00:00:00Z', to: null, precision: 'instant' } };
    assert.equal((await call('/api/actions', correction, viewer)).status, 403);
    assert.equal((await call('/api/actions', correction)).status, 200);
    assert.equal((await call(`/api/objects/${objectId}?validAt=2026-04-20T00:00:00Z`, undefined, viewer)).body.fields.contract_amount.value, '1300000.00');
    assert.ok((await call('/api/audit')).body.length >= 2);
  } finally {
    if (ownsSchema) { await db.pool.query('DROP SCHEMA knowledge CASCADE'); await db.pool.query('DELETE FROM knowledge_schema_versions WHERE version=1'); }
    if (app) await app.close(); else await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

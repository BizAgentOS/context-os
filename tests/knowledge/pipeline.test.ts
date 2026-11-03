import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../src/knowledge/database.ts';
import { KnowledgeCore } from '../../src/knowledge/service.ts';
import { KnowledgeJobs, PROMPT_VERSION } from '../../src/knowledge/jobs.ts';
import { BuildPlans } from '../../src/knowledge/build-plans.ts';
import { prepareCsv } from '../../src/knowledge/sources.ts';
import type { JsonModel } from '../../src/knowledge/model.ts';
const url = process.env.CONTEXT_OS_KNOWLEDGE_TEST_DATABASE_URL;
test('one start persists continuation, pauses only for batch identity decision and resumes without another model call', { skip: !url }, async () => {
  const db = await openDatabase(url!), directory = await mkdtemp(join(tmpdir(), 'knowledge-pipeline-'));
  const actor = { id: 'owner', role: 'admin' as const }; let owns = false;
  try {
    assert.equal((await db.pool.query("SELECT 1 FROM pg_namespace WHERE nspname='knowledge'")).rows.length, 0);
    await db.initialize(); owns = true;
    const core = new KnowledgeCore(db), plans = new BuildPlans(core);
    const ontology = await core.draft(actor, { name: 'Contracts', types: [{ id: 'Contract', name: 'Contract', properties: [{ id: 'amount', name: 'Amount', valueType: 'decimal', comparisonRequired: ['currency'] }] }, { id: 'Company', name: 'Company', properties: [] }, { id: 'Employee', name: 'Employee', properties: [] }], links: [{ id: 'company', name: 'References company', from: 'Contract', to: 'Company' }, { id: 'employee', name: 'References employee', from: 'Contract', to: 'Employee' }] });
    await core.act(actor, { kind: 'PublishOntologyVersion', operationId: 'publish', targetId: ontology.id, expectedRevision: 1, reason: 'initial scope approved' });
    const a = await core.importSource(actor, 'a', 'a', 'A', await prepareCsv(directory, 'id,amount,company,employee\nC001,100,ORG001,E001\n', 'id'));
    const b = await core.importSource(actor, 'b', 'b', 'B', await prepareCsv(directory, 'id,amount,company,employee\nC001,120,ORG001,E001\n', 'id'));
    let calls = 0;
    const model: JsonModel = { identity: 'fixture', async close() {}, async generate(task, raw) {
      calls++; assert.equal(task, 'plan');
      const input = raw as { sources: Array<{ id: string }> };
      return { csv: input.sources.map(s => ({ sourceVersionId: s.id, objects: [{ id: 'contract', typeId: 'Contract', identityColumn: 'id' }, { id: 'company', typeId: 'Company', identityColumn: 'company' }, { id: 'employee', typeId: 'Employee', identityColumn: 'employee' }], properties: [{ id: 'amount', object: 'contract', predicate: 'amount', column: 'amount', time: { mode: 'unknown' }, comparison: {} }], links: [{ id: 'company-link', predicate: 'company', from: 'contract', to: 'company', time: { mode: 'unknown' } }, { id: 'employee-link', predicate: 'employee', from: 'contract', to: 'employee', time: { mode: 'unknown' } }] })), documents: [] };
    } };
    const jobs = new KnowledgeJobs(core, model);
    const published = await core.ontology(actor, ontology.id);
    const parent = await jobs.enqueue(actor, { kind: 'plan', operationId: 'start', ontologyId: ontology.id, expectedRevision: published.revision, sourceVersionIds: [a.version.id, b.version.id], autoBuild: true });
    await jobs.once();
    const result = (await db.pool.query('SELECT result FROM knowledge.jobs WHERE id=$1', [parent.id])).rows[0].result;
    assert.equal(result.stage, 'queued_preflight'); assert.ok(result.continuationJobId);
    await jobs.once();
    const paused = (await db.pool.query('SELECT result FROM knowledge.jobs WHERE id=$1', [result.continuationJobId])).rows[0].result;
    assert.equal(paused.stage, 'awaiting_decision', JSON.stringify(paused)); assert.equal((await core.list(actor, 'objects')).length, 0);
    const plan = await plans.get(actor, result.planId);
    assert.equal(plan.preview!.identities.length, 3, 'three concrete identity groups share one batch decision');
    const decided = await plans.decideIdentityBatch(actor, plan.id, { expectedRevision: plan.revision, candidateHash: plan.preview!.identityCandidateHash, decision: 'same', reason: 'same issuer and concrete identifiers in these two sources' }, PROMPT_VERSION);
    assert.ok(decided.continuationJobId, 'decision and continuation are committed together');
    const resume = { id: decided.continuationJobId };
    await jobs.once();
    assert.equal((await db.pool.query('SELECT result FROM knowledge.jobs WHERE id=$1', [resume.id])).rows[0].result.stage, 'built');
    assert.equal(calls, 1);
    assert.equal((await core.list(actor, 'objects')).length, 3);
    assert.equal((await db.pool.query('SELECT count(*)::int AS count FROM knowledge.assertions')).rows[0].count, 6);
    await jobs.close();
  } finally {
    if (owns) { await db.pool.query('DROP SCHEMA knowledge CASCADE'); await db.pool.query('DELETE FROM knowledge_schema_versions WHERE version IN (1,2,3,4,5)'); }
    await db.close(); await rm(directory, { recursive: true, force: true });
  }
});

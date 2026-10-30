/** Explicit paid-model smoke test. Uses synthetic sources and an EMPTY, dedicated database. */
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { CredentialVault } from '../../src/security/credential-vault.ts';
import { KodaXDriver, modelKeyEnvironments, modelKeyEnvironment, type ModelSettings } from '../../src/agent/runtime.ts';
import { DriverJsonModel } from '../../src/knowledge/model.ts';
import { openDatabase } from '../../src/knowledge/database.ts';
import { KnowledgeCore } from '../../src/knowledge/service.ts';
import { KnowledgeJobs } from '../../src/knowledge/jobs.ts';
import { prepareCsv, preparePdf, mapCsv } from '../../src/knowledge/sources.ts';
import { ontologySchema } from '../../src/knowledge/contracts.ts';
import { textPdf } from '../../tests/agent/document-fixture.ts';

const directory = resolve(process.env.CONTEXT_OS_KNOWLEDGE_VERIFY_DIRECTORY ?? 'local-state/knowledge-model-verification');
const legacy = resolve(process.env.CONTEXT_OS_KNOWLEDGE_VERIFY_SETTINGS ?? 'local-state/agent');
await mkdir(directory, { recursive: true, mode: 0o700 });
const settingsDb = new DatabaseSync(join(legacy, 'memory.sqlite'), { readOnly: true });
const row = settingsDb.prepare("SELECT body FROM settings WHERE id='model'").get() as { body: string } | undefined;
settingsDb.close();
if (!row) throw new Error('找不到用户授权使用的已配置模型');
const settings = JSON.parse(row.body) as ModelSettings;
if (settings.model !== 'glm/glm-5.3') throw new Error('模型不是用户指定的 glm/glm-5.3，停止付费测试');
const credentials = new CredentialVault(legacy).get('models');
const savedName = modelKeyEnvironments(settings).find(name => typeof credentials[name] === 'string' && credentials[name]);
if (savedName) process.env[modelKeyEnvironment(settings)] = String(credentials[savedName]);
if (!process.env[modelKeyEnvironment(settings)]) throw new Error('指定模型凭据不可用；没有尝试其他提供方');

const report: Record<string, any> = { model: settings.model, startedAt: new Date().toISOString(), sourceKind: 'synthetic-contract-fixture', calls: [], checks: {} };
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
const model = new DriverJsonModel(`${settings.provider}:${settings.model}`, new KodaXDriver(join(directory, 'runtime'), settings));
const wrapped = { identity: model.identity, close: () => model.close(), async generate(task: 'discover' | 'extract', input: unknown, schema: Parameters<DriverJsonModel['generate']>[2]) {
  const start = Date.now();
  try { const output = await model.generate(task, input, schema); report.calls.push({ task, elapsedMs: Date.now() - start, ...model.lastRun, output }); await save(); return output; }
  catch { report.calls.push({ task, elapsedMs: Date.now() - start, ...model.lastRun, failure: '模型未成功返回有效结构化结果' }); await save(); throw new Error('真实模型调用失败，详见安全报告'); }
} };
const db = await openDatabase(process.env.CONTEXT_OS_KNOWLEDGE_TEST_DATABASE_URL ?? '');
const jobs = new KnowledgeJobs(new KnowledgeCore(db), wrapped), core = new KnowledgeCore(db);
const actor = { id: 'model-verification', role: 'admin' as const };
try {
  if ((await db.pool.query("SELECT 1 FROM pg_namespace WHERE nspname='knowledge'")).rows.length) throw new Error('验证仅允许空的专用数据库');
  await db.initialize();
  const csv = await readFile(new URL('../../data/samples/knowledge-core/contracts.csv', import.meta.url), 'utf8');
  const text = await readFile(new URL('../../data/samples/knowledge-core/contract-document.txt', import.meta.url), 'utf8');
  const source = await core.importSource(actor, 'model-csv', 'contracts', 'Contract records', await prepareCsv(directory, csv, 'contract_no'));
  const pdf = await core.importSource(actor, 'model-pdf', 'contract-document', 'Contract document', await preparePdf(directory, 'contract.pdf', textPdf(text.trim().split('\n'))));
  const discovery = await jobs.enqueue(actor, { kind: 'discover', operationId: 'real-discover', sourceVersionIds: [source.version.id, pdf.version.id] });
  await jobs.once();
  const discoveryResult = (await db.pool.query('SELECT state,error,result FROM knowledge.jobs WHERE id=$1', [discovery.id])).rows[0];
  report.discovery = discoveryResult; report.checks.discoverySucceeded = discoveryResult.state === 'completed'; await save();
  // Use the frozen reviewed ontology for extraction: discovery and extraction quality are independent checks.
  const definition = JSON.parse(await readFile(new URL('../../data/samples/knowledge-core/ontology.json', import.meta.url), 'utf8'));
  const mapping = JSON.parse(await readFile(new URL('../../data/samples/knowledge-core/mapping.json', import.meta.url), 'utf8'));
  const draft = await core.draft(actor, definition);
  await core.act(actor, { operationId: 'model-publish', kind: 'PublishOntologyVersion', targetId: draft.id, expectedRevision: 1, reason: '冻结人工检查的工程本体用于独立抽取评测' });
  await core.commitExtraction(actor, { operationId: 'model-map', ontologyId: draft.id, sourceVersionId: source.version.id, configuration: { mapping, model: 'mapping' }, output: mapCsv(source.version.content, mapping, ontologySchema.parse(definition)) });
  const extraction = await jobs.enqueue(actor, { kind: 'extract', operationId: 'real-extract', ontologyId: draft.id, sourceVersionId: pdf.version.id });
  await jobs.once();
  const extractionResult = (await db.pool.query('SELECT state,error,result FROM knowledge.jobs WHERE id=$1', [extraction.id])).rows[0];
  report.extraction = extractionResult; report.checks.extractionSucceeded = extractionResult.state === 'completed';
  const objectId = (await db.pool.query("SELECT object_id FROM knowledge.identifiers WHERE namespace='contract_no' AND value='C001'")).rows[0].object_id;
  const object = await core.object(actor, objectId, { validAt: '2026-04-20T00:00:00Z' });
  report.object = object;
  report.checks.amountConflictDetected = (object.fields.contract_amount as any).status === 'conflict';
  const documentAssertions = object.assertions.filter(a => a.source_version_id === pdf.version.id);
  report.checks.originalPdfPageLocated = documentAssertions.length > 0;
  for (const a of documentAssertions) {
    if (!(await core.evidence(actor, a.id)).some(e => e.locator.kind === 'quote' && !!e.locator.location?.pages.length)) report.checks.originalPdfPageLocated = false;
  }
  report.finishedAt = new Date().toISOString(); await save();
  process.stdout.write(JSON.stringify({ model: report.model, checks: report.checks, calls: report.calls.map((c: any) => ({ task: c.task, elapsedMs: c.elapsedMs, status: c.status })) }) + '\n');
} catch {
  report.error = '验证未全部完成，请查看任务安全错误及调用状态'; report.finishedAt = new Date().toISOString(); await save(); process.exitCode = 1;
} finally { await jobs.close(); await db.close(); }

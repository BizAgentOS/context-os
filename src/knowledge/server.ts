import { CredentialVault } from '../security/credential-vault.ts';
import { ConnectedSources } from './connected-sources.ts';
import { DecisionPackages } from './decision-packages.ts';
import { getLogger } from '../observability/logger.ts';
import { createServer as httpServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { openDatabase, type Database } from './database.ts';
import { KnowledgeCore } from './service.ts';
import { KnowledgeJobs, PROMPT_VERSION } from './jobs.ts';
import { BuildPlans } from './build-plans.ts';
import { configuredModel, ModelConfigurationError, type JsonModel } from './model.ts';
import { prepareCsv, preparePdf } from './sources.ts';
import { AccessDenied, type Principal } from './contracts.ts';

const principalConfig = z.array(z.object({ id: z.string().min(1).max(160), role: z.enum(['admin', 'editor', 'viewer']), token: z.string().min(32).max(200) }).strict()).min(1);
async function body(request: IncomingMessage) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('需要 application/json');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const data = Buffer.from(chunk); bytes += data.length;
    if (bytes > 22_000_000) throw new Error('请求过大，开发界面最多上传 15 MB PDF');
    chunks.push(data);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/autonomy.js', ['autonomy.js', 'text/javascript; charset=utf-8']],
  ['/plans.js', ['plans.js', 'text/javascript; charset=utf-8']],
  ['/action-target.js', ['action-target.js', 'text/javascript; charset=utf-8']],
  ['/evidence.js', ['evidence.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
export async function createKnowledgeServer(options: { db: Database; directory: string; principals: unknown; model?: JsonModel; worker?: boolean; vault?: CredentialVault }) {
  const principals = principalConfig.parse(options.principals);
  if (new Set(principals.map(p => p.token)).size !== principals.length || new Set(principals.map(p => p.id)).size !== principals.length) throw new Error('身份或令牌重复');
  const core = new KnowledgeCore(options.db), jobs = new KnowledgeJobs(core, options.model), plans = new BuildPlans(core);
  const vault = options.vault ?? new CredentialVault(options.directory);
  const connections = new ConnectedSources(core,vault), packages = new DecisionPackages(core,plans);
  jobs.observe = (actor,id,operationId,maxRows) => connections.captureAll(actor,id,operationId,maxRows);
  // Startup reads schema version only, never initializes or resets the database implicitly.
  if (!(await options.db.pool.query('SELECT version FROM knowledge_schema_versions WHERE version=6')).rows.length) throw new Error('请先运行 knowledge:init 更新知识数据库');
  const tables = (await options.db.pool.query("SELECT to_regclass('knowledge.jobs') AS jobs,to_regclass('knowledge.job_attempts') AS attempts")).rows[0];
  if (!tables.jobs || !tables.attempts) throw new Error('任务表缺失，迁移记录与实际结构不一致；请运行 npm run knowledge:init 检查并修复');
  const server = httpServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    const send = (status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    try {
      const host = request.headers.host ?? '';
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) { send(403, { error: '第一阶段入口仅接受本机访问' }); return; }
      if (request.headers.origin && request.headers.origin !== `http://${host}`) { send(403, { error: '请求来源不匹配' }); return; }
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (request.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname)!;
        response.writeHead(200, { 'Content-Type': type });
        response.end(await readFile(new URL(`../../web/knowledge/${file}`, import.meta.url))); return;
      }
      if (request.method === 'GET' && ['/example/ontology.json', '/example/mapping.json'].includes(url.pathname)) {
        const file = url.pathname.endsWith('ontology.json') ? 'ontology.json' : 'mapping.json';
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(await readFile(new URL(`../../data/samples/knowledge-core/${file}`, import.meta.url))); return;
      }
      const token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
      const supplied = Buffer.from(token);
      const matched = principals.find(p => { const expected = Buffer.from(p.token); return supplied.length === expected.length && timingSafeEqual(supplied, expected); });
      if (!matched) { send(401, { error: '请提供有效的企业实例访问令牌' }); return; }
      const actor: Principal = { id: matched.id, role: matched.role };
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const [sources, ontologies, objects, tasks] = await Promise.all(['sources', 'ontologies', 'objects', 'jobs'].map(kind => core.list(actor, kind as 'sources' | 'ontologies' | 'objects' | 'jobs')));
        send(200, { actor, model: options.model?.identity ?? null, modelPolicy: options.model?.executionPolicy ?? null, promptVersion: PROMPT_VERSION, sources, ontologies, objects, jobs: tasks, plans: await plans.list(actor), connections: await connections.list(actor), decisionPackages: await packages.list(actor), accessScope: 'all_instance_data', fineGrainedPermissions: false, inference: 'pending_only', pagination: { limit: 100, offset: 0, note: '仅展示第一页，请使用列表接口翻页' } }); return;
      }
      if(url.pathname==='/api/connections') {
        if(request.method==='GET'){send(200,await connections.list(actor));return;}
        if(request.method==='POST'){send(200,await connections.create(actor,await body(request)));return;}
      }
      const connectionPath=/^\/api\/connections\/([^/]+)\/(catalog|sync|observations|revoke)$/.exec(url.pathname);
      if(connectionPath){
        const [,id,operation]=connectionPath;
        if(request.method==='GET'&&operation==='catalog'){send(200,await connections.catalog(actor,id));return;}
        if(request.method==='GET'&&operation==='observations'){send(200,await connections.observations(actor,id));return;}
        if(request.method==='POST'&&operation==='sync'){
          const input=z.object({operationId:z.string().min(1).max(160),construct:z.boolean().default(false),maxRows:z.number().int().min(1).max(100000).default(10000)}).strict().parse(await body(request));
          send(202,await jobs.enqueue(actor,{kind:'observe',connectionId:id,...input}));return;
        }
        if(request.method==='POST'&&operation==='revoke'){const input=z.object({expectedRevision:z.number().int().positive()}).strict().parse(await body(request));send(200,await connections.revoke(actor,id,input.expectedRevision));return;}
      }
      if(url.pathname==='/api/decision-packages'){
        if(request.method==='GET'){send(200,await packages.list(actor));return;}
        if(request.method==='POST'){send(200,await packages.create(actor,await body(request)));return;}
      }
      const packagePath=/^\/api\/decision-packages\/([^/]+)(?:\/(submit|refresh|archive))?$/.exec(url.pathname);
      if(packagePath){
        const [,id,operation]=packagePath;
        if(request.method==='GET'&&!operation){send(200,await packages.get(actor,id));return;}
        if(request.method==='POST'&&operation==='archive'){send(200,await packages.archive(actor,id,await body(request)));return;}
        if(request.method==='POST'&&operation==='submit'){send(200,await packages.submit(actor,id,await body(request)));return;}
        if(request.method==='POST'&&operation==='refresh'){const input=z.object({expectedRevision:z.number().int().positive()}).strict().parse(await body(request));send(200,await packages.refresh(actor,id,input.expectedRevision));return;}
      }
      const list = /^\/api\/list\/(sources|ontologies|objects|jobs)$/.exec(url.pathname);
      if (request.method === 'GET' && list) {
        send(200, await core.list(actor, list[1] as 'sources' | 'ontologies' | 'objects' | 'jobs', Number(url.searchParams.get('limit') ?? 100), Number(url.searchParams.get('offset') ?? 0))); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/sources/csv') {
        if (actor.role === 'viewer') { send(403, { error: '只读身份不能上传' }); return; }
        const input = z.object({ operationId: z.string().min(1), sourceKey: z.string().min(1), title: z.string().min(1), text: z.string(), keyColumn: z.string().min(1) }).strict().parse(await body(request));
        send(200, await core.importSource(actor, input.operationId, input.sourceKey, input.title, await prepareCsv(options.directory, input.text, input.keyColumn))); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/sources/pdf') {
        if (actor.role === 'viewer') { send(403, { error: '只读身份不能上传' }); return; }
        const input = z.object({ operationId: z.string().min(1), sourceKey: z.string().min(1), title: z.string().min(1), name: z.string().min(1), base64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict().parse(await body(request));
        send(200, await core.importSource(actor, input.operationId, input.sourceKey, input.title, await preparePdf(options.directory, input.name, Buffer.from(input.base64, 'base64')))); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/ontologies') {
        const input = z.object({ definition: z.unknown(), copyFromId: z.string().uuid().optional(), id: z.string().uuid().optional(), expectedRevision: z.number().int().positive().optional() }).strict().parse(await body(request));
        if (input.id && input.copyFromId) throw new Error('不能同时编辑和复制草稿');
        if (input.id && !input.expectedRevision) throw new Error('编辑草稿需要 expectedRevision');
        send(200, await core.draft(actor, input.definition, input.id ? { id: input.id, expectedRevision: input.expectedRevision! } : undefined, undefined, {}, input.copyFromId)); return;
      }
      const reviewPath = /^\/api\/ontologies\/([^/]+)\/review$/.exec(url.pathname);
      if (request.method === 'POST' && reviewPath) { send(200, await core.reviewDiscovery(actor, reviewPath[1], await body(request))); return; }
      const ontologyPath = /^\/api\/ontologies\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && ontologyPath) { send(200, await core.ontology(actor, ontologyPath[1])); return; }
      if (request.method === 'POST' && url.pathname === '/api/jobs') { send(202, await jobs.enqueue(actor, await body(request))); return; }
      if (request.method === 'POST' && url.pathname === '/api/actions') { send(200, await core.act(actor, await body(request))); return; }
      if (request.method === 'GET' && url.pathname === '/api/audit') { send(200, await core.events(actor)); return; }
      if (request.method === 'GET' && url.pathname === '/api/plans') { send(200, await plans.list(actor)); return; }
      const planPath = /^\/api\/plans\/([^/]+)(?:\/(save|preflight|approve|events|identities))?$/.exec(url.pathname);
      if (planPath) {
        const [, id, operation] = planPath;
        if (request.method === 'GET' && !operation) { send(200, await plans.get(actor, id)); return; }
        if (request.method === 'GET' && operation === 'events') { send(200, await plans.events(actor, id)); return; }
        if (request.method === 'POST' && operation) {
          if (actor.role === 'viewer') { send(403, { error: '只读身份不能审核或批准计划' }); return; }
          if (operation === 'identities') { send(200, await plans.decideIdentityBatch(actor, id, await body(request), PROMPT_VERSION)); return; }
          if (operation === 'save') {
            const input = z.object({ expectedRevision: z.number().int().positive(), proposal: z.unknown(), review: z.unknown() }).strict().parse(await body(request));
            send(200, await plans.save(actor, id, input.expectedRevision, input.proposal, input.review)); return;
          }
          const input = z.object({ expectedRevision: z.number().int().positive() }).strict().parse(await body(request));
          if (operation === 'preflight') { send(200, await plans.preflight(actor, id, input.expectedRevision)); return; }
          if (operation === 'approve') { send(200, await plans.approve(actor, id, input.expectedRevision)); return; }
        }
      }
      const object = /^\/api\/objects\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && object) { send(200, await core.object(actor, object[1], { validAt: url.searchParams.get('validAt') ?? undefined, knownAt: url.searchParams.get('knownAt') ?? undefined })); return; }
      const evidence = /^\/api\/evidence\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && evidence) { send(200, await core.evidence(actor, evidence[1], url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined)); return; }
      const source = /^\/api\/source-versions\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && source) { const { original_path, ...safe } = await core.sourceVersion(actor, source[1]); send(200, safe); return; }
      const retry = /^\/api\/jobs\/([^/]+)\/retry$/.exec(url.pathname);
      if (request.method === 'POST' && retry) { await body(request); send(200, await jobs.retry(actor, retry[1])); return; }
      const revalidate = /^\/api\/jobs\/([^/]+)\/revalidate$/.exec(url.pathname);
      if (request.method === 'POST' && revalidate) { await body(request); send(202, await jobs.revalidate(actor, revalidate[1])); return; }
      const recreate = /^\/api\/jobs\/([^/]+)\/recreate$/.exec(url.pathname);
      if (request.method === 'POST' && recreate) { await body(request); send(202, await jobs.recreate(actor, recreate[1])); return; }
      const attempts = /^\/api\/jobs\/([^/]+)\/attempts$/.exec(url.pathname);
      if (request.method === 'GET' && attempts) { send(200, await core.jobAttempts(actor, attempts[1])); return; }
      send(404, { error: '接口不存在' });
    } catch (error) {
      const detail = error instanceof z.ZodError ? error.issues.map(i => i.message).join('；') : error instanceof Error ? error.message : '';
      // Never echo SQL, connection strings, provider errors or filesystem locations.
      const safe = !/postgres|password|token|bearer|authorization|https?:|\/[A-Za-z]/i.test(detail) && !('code' in Object(error));
      send(error instanceof AccessDenied ? 403 : 400, { error: safe ? detail.slice(0, 500) : '操作失败，请核对输入、权限和服务配置' });
    }
  });
  server.requestTimeout = 90000; server.headersTimeout = 15000;
  if (options.worker !== false) jobs.start();
  return { server, core, jobs, plans, connections, packages, async close() { await jobs.close(); await new Promise<void>((done, fail) => server.listening ? server.close(error => error ? fail(error) : done()) : done()); await options.db.close(); } };
}
let startupStage = '数据库连接配置';
async function main() {
  const db = await openDatabase(process.env.CONTEXT_OS_KNOWLEDGE_DATABASE_URL ?? '');
  try {
    const directory = resolve(process.env.CONTEXT_OS_KNOWLEDGE_DIRECTORY ?? 'local-state/knowledge');
    startupStage = '访问身份配置（CONTEXT_OS_KNOWLEDGE_PRINCIPALS：JSON 数组，token 至少 32 字符）';
    const principals = JSON.parse(process.env.CONTEXT_OS_KNOWLEDGE_PRINCIPALS ?? '[]');
    principalConfig.parse(principals);
    startupStage = '模型配置（检查 MODEL_PROVIDER、MODEL 和自定义 MODEL_PROTOCOL）';
    const model = configuredModel(resolve(directory, 'runtime'));
    startupStage = '数据库连接、迁移版本或重复的访问身份（请检查连接并运行 npm run knowledge:init）';
    const app = await createKnowledgeServer({ db, directory, principals, model });
    startupStage = '监听端口配置（CONTEXT_OS_KNOWLEDGE_PORT：1–65535）';
    const port = z.coerce.number().int().min(1).max(65535).parse(process.env.CONTEXT_OS_KNOWLEDGE_PORT ?? 3211);
    await new Promise<void>((done, fail) => {
      app.server.once('error', fail);
      app.server.listen(port, '127.0.0.1', () => { app.server.removeListener('error', fail); done(); });
    }).catch(async error => { await app.jobs.close(); throw error; });
    getLogger().info('server.started', { port });
    process.stdout.write(`Context OS knowledge: http://127.0.0.1:${port}\n`);
    let closing = false;
    const close = () => { if (closing) return; closing = true; void app.close().catch(() => { process.exitCode = 1; getLogger().error('server.shutdown_failed'); }).finally(async () => { getLogger().info('server.stopped'); await getLogger().flush(); }); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  } catch (error) { await db.close(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(async error => {
    const reason = error instanceof ModelConfigurationError ? error.message : startupStage;
    getLogger().error('server.startup_failed', { stage: startupStage, reason });
    await getLogger().flush();
    process.stderr.write(`知识核心启动失败：${reason}。\n`);
    process.exitCode = 1;
  });
}

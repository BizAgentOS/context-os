import { OntologyWorkspace } from "../semantic/workspace.ts";
import {BackupService} from '../security/workspace-backup.ts';
import {CredentialVault} from '../security/credential-vault.ts';
import {SourceLifecycle} from '../engine/source-lifecycle.ts';
import {ExternalGapFeedback} from '../engine/external-gap-feedback.ts';
import {withActor,assertRole,RoleDenied,type Actor} from '../security/actors.ts';
import {requestRoleAction} from '../security/http-role-policy.ts';
import {exportLegacyConsumptionAudit} from '../live/legacy-audit.ts';
import {demoSimulation,simulateDemoRequest} from '../demo/request-policy.ts';
import { Workspace } from "./workspace.ts";
import { historicalConsumption, LegacyConsumptionFrozen } from "../live/legacy-consumption.ts";
import { sourceSummary } from "./source-summary.ts";
import {ConsumerMigrations} from "../live/consumer-migrations.ts";
import { OpenApiImports } from "../live/openapi-import.ts";
import {ConsumerViews} from "../live/consumer-views.ts";
import { OntologyDatasets } from "../live/ontology-datasets.ts";
import { testDatasetMcp } from "../live/dataset-mcp-test.ts";
import { MappingChanges } from "../live/mapping-changes.ts";
import { RelationCorrections } from "../live/relation-corrections.ts";
import { EvidenceService } from "./evidence.ts";
import { MetricReader } from "./metrics.ts";
import { KnowledgeReader, sourceCatalog } from "./knowledge.ts";
import { createServer as httpServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AgentApplication } from "./app.ts";
import { SourcePolicyService } from "./source-policy.ts";
import { Releases } from "../engine/releases.ts";
import { ChangeConflict } from "../engine/changes.ts";
import { DelegationDenied } from "../engine/delegations.ts";
import { reviewVerification } from "./maintenance.ts";
import type { AgentDriver } from "./runtime.ts";
import type { Artifact } from "./contracts.ts";
import { ontologySceneAsset } from "./browser-assets.ts";
import { WorkspaceEvents, snapshotScopes } from "./workspace-events.ts";

const webRoot = fileURLToPath(new URL("../../web/agent/", import.meta.url));
const managementArtifactKinds=new Set(['local_user','audit_record','workspace_backup','retention_settings','retention_run','usage_policy_receipt']);
const staticFiles: Record<string, { file: string; type: string }> = {
  ...Object.fromEntries(["local-auth", "workspace-settings", "ontology-workbench", "database-connection", "answer-card", "answer-visualization", "naming-review", "document-preview", "feishu-tables", "sync-settings", "sync-issue", "agent-mode-controls", "gap-detail", "run-card", "decision-card", "message-markdown", "workspace-store", "agent-panel", "task-center", "pending-center", "data-profile", "share-workspace", "page-region", "sessions"].map(name => [`/${name}.js`, { file: `${name}.js`, type: "text/javascript; charset=utf-8" }])),
  "/glass-theme.css": {file:"glass-theme.css",type:"text/css; charset=utf-8"},
  "/glass-ontology.css": {file:"glass-ontology.css",type:"text/css; charset=utf-8"},
  "/ontology-workspace.css": {file:"ontology-workspace.css",type:"text/css; charset=utf-8"},
  "/engine.css": {file:"engine.css",type:"text/css; charset=utf-8"},
  "/agent-panel.css": {file:"agent-panel.css",type:"text/css; charset=utf-8"},
  "/pending-center.css": {file:"pending-center.css",type:"text/css; charset=utf-8"},
  "/ui-display.js": { file:"ui-display.js", type:"text/javascript; charset=utf-8" },
  "/engine-ui.js": {file:"engine-ui.js",type:"text/javascript; charset=utf-8"},
  "/engine-workspace.js": {file:"engine-workspace.js",type:"text/javascript; charset=utf-8"},
  "/release-workspace.js": {file:"release-workspace.js",type:"text/javascript; charset=utf-8"},
  "/history-access.js": { file: "history-access.js", type: "text/javascript; charset=utf-8" },
  "/dataset-workspace.js": { file: "dataset-workspace.js", type: "text/javascript; charset=utf-8" },
  "/ontology-space.js": { file: "ontology-space.js", type: "text/javascript; charset=utf-8" },
  "/ontology-space-model.js": { file: "ontology-space-model.js", type: "text/javascript; charset=utf-8" },
  "/ontology-space.css": { file: "ontology-space.css", type: "text/css; charset=utf-8" },
  "/ontology-scene.js": { file: "ontology-scene.js", type: "text/javascript; charset=utf-8" },
  "/connection-ui.js": { file: "connection-ui.js", type: "text/javascript; charset=utf-8" },
  "/feishu-connection.js": { file: "feishu-connection.js", type: "text/javascript; charset=utf-8" },
  "/feishu-directory.js": { file: "feishu-directory.js", type: "text/javascript; charset=utf-8" },
  "/mcp-connection.js": { file: "mcp-connection.js", type: "text/javascript; charset=utf-8" },
  "/openapi-import.js": { file: "openapi-import.js", type: "text/javascript; charset=utf-8" },
  "/connections.js": { file: "connections.js", type: "text/javascript; charset=utf-8" },
  "/onboarding.js": { file: "onboarding.js", type: "text/javascript; charset=utf-8" },
  "/enterprise-profile.js": { file: "enterprise-profile.js", type: "text/javascript; charset=utf-8" },
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/capabilities.js": {
    file: "capabilities.js",
    type: "text/javascript; charset=utf-8",
  },
  "/evidence.js": {
    file: "evidence.js",
    type: "text/javascript; charset=utf-8",
  },
  "/fusion.js": { file: "fusion.js", type: "text/javascript; charset=utf-8" },
  "/foundation-bindings.js": {
    file: "foundation-bindings.js",
    type: "text/javascript; charset=utf-8",
  },
  "/metrics.js": { file: "metrics.js", type: "text/javascript; charset=utf-8" },
  "/consumer-migrations.js": {file:"consumer-migrations.js",type:"text/javascript; charset=utf-8"},
  "/consumer-views.js": {file:"consumer-views.js",type:"text/javascript; charset=utf-8"},
  "/changes-workspace.js": {file:"changes-workspace.js",type:"text/javascript; charset=utf-8"},
  "/mapping-changes.js": {file:"mapping-changes.js",type:"text/javascript; charset=utf-8"},
  "/relation-corrections.js": {
    file: "relation-corrections.js",
    type: "text/javascript; charset=utf-8",
  },
  "/live-objects.js": {
    file: "live-objects.js",
    type: "text/javascript; charset=utf-8",
  },
  "/foundation-workspace.js": {
    file: "foundation-workspace.js",
    type: "text/javascript; charset=utf-8",
  },
  "/foundation.js": {
    file: "foundation.js",
    type: "text/javascript; charset=utf-8",
  },
  "/drafts.js": { file: "drafts.js", type: "text/javascript; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/live-workspace.js": {
    file: "live-workspace.js",
    type: "text/javascript; charset=utf-8",
  },
  "/share-mode.js": {
    file: "share-mode.js",
    type: "text/javascript; charset=utf-8",
  },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/ontology-workspace.js": {
    file: "ontology-workspace.js",
    type: "text/javascript; charset=utf-8",
  },
  "/memory-graph.js": {
    file: "memory-graph.js",
    type: "text/javascript; charset=utf-8",
  },
  "/memory-graph.css": {
    file: "memory-graph.css",
    type: "text/css; charset=utf-8",
  },
};

async function readBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new Error("请使用 JSON 请求");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 6_000_000) throw new Error("请求过大，单份资料最多 5 MB");
    chunks.push(Buffer.from(chunk));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("请求需要对象");
  return value as Record<string, unknown>;
}

export async function createServer(
  options: {
    directory?: string;
    driver?: AgentDriver;
    researchTestOrigins?: ReadonlySet<string>;
    /** Manual-mapping integration hosts can opt out; the product defaults to automatic. */
    automaticApi?: boolean;
    demo?: { name: string };
  } = {},
) {
  const directory = options.directory ?? resolve("local-state/agent");
  const app = new AgentApplication(
    directory,
    options.driver,
    options.researchTestOrigins,
    options.automaticApi,
  );
  const tokenFile = join(directory, "admin-token");
  try {
    writeFileSync(
      tokenFile,
      `de_admin_${randomBytes(32).toString("base64url")}`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      await app.close();
      throw error;
    }
  }
  chmodSync(tokenFile, 0o600);
  const token = readFileSync(tokenFile, "utf8").trim();
  if (!/^de_admin_[A-Za-z0-9_-]{43}$/.test(token)) {
    await app.close();
    throw new Error("管理员凭据文件无效");
  }
  const cookieName = `dataengine_admin_${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
  const openApiImports = new OpenApiImports(app.live.sources);
  const events = new WorkspaceEvents(app.memory.changes);
  const matchesToken = (value: unknown) => {
    if (typeof value !== "string") return false;
    const bytes = Buffer.from(value);
    const expected = Buffer.from(token);
    return bytes.length === expected.length && timingSafeEqual(bytes, expected);
  };
  let closed = false;
  let mutation = Promise.resolve<unknown>(undefined);
  const queue = <T>(operation: () => Promise<T>) => {
    const next = mutation.then(operation, operation);
    mutation = next.catch(() => {});
    return next;
  };
  const server = httpServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    const send = (status: number, body: unknown) => {
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      const payload =
        options.demo &&
        body &&
        typeof body === "object" &&
        "currentPage" in body
          ? { ...body, demo: options.demo }
          : body;
      response.end(JSON.stringify(payload));
    };
    try {
      const host = request.headers.host ?? "";
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
        send(403, { error: "仅支持本地访问" });
        return;
      }
      const url = new URL(request.url ?? "/", `http://${host}`);
      if(/^\/v[123](?:\/|$)/.test(url.pathname)){send(410,{code:'legacy_consumption_retired',error:'旧消费接口已下线，请使用发布版本和 v4 接入；历史授权与审计由管理员导出。'});return;}
      if(url.pathname==='/api/auth/login'&&request.method==='POST'){
        if(options.demo){send(409,demoSimulation);return;}
        if(request.headers.origin&&request.headers.origin!==`http://${host}`){send(403,{error:'登录请求来源不匹配'});return;}
        const result=app.users.login(await readBody(request));response.setHeader('Set-Cookie',`${cookieName}=${result.token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=86400`);send(200,result);return;
      }
      if (url.pathname === "/v4/agent/tasks" || url.pathname.startsWith("/v4/agent/tasks/")) {
        const key = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : "";
        if (url.pathname === "/v4/agent/tasks" && request.method === "POST") {
          send(202, app.delegations.submit(await readBody(request), key)); return;
        }
        const match = /^\/v4\/agent\/tasks\/([^/]+)(\/cancel)?$/.exec(url.pathname);
        if (match && !match[2] && request.method === "GET") { send(200, app.delegations.read(decodeURIComponent(match[1]), key)); return; }
        if (match?.[2] && request.method === "POST") { await readBody(request); send(200, await app.delegations.cancel(decodeURIComponent(match[1]), key)); return; }
        send(405, {error:"不支持的委托操作"}); return;
      }
      if (url.pathname.startsWith("/v4/")) {
        if (request.method !== "GET") { send(405, { error: "仅支持只读请求" }); return; }
        const result = await new OntologyDatasets(app.memory, app.live).handle(url.pathname, url.searchParams, request.headers.authorization);
        send(result.status, result.body); return;
      }
      let requestActor:Actor|undefined,sessionToken='';
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        const supplied = request.headers["x-dataengine-token"];
        const cookie = request.headers.cookie
          ?.split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith(`${cookieName}=`))
          ?.slice(cookieName.length + 1);
        const origin = request.headers.origin;
        const credential=supplied!==undefined?supplied:request.method==='GET'?cookie:undefined;
        if(typeof credential==='string'){
          sessionToken=credential;
          if(matchesToken(credential))requestActor={kind:'human',id:'local-admin',name:'本地管理员',role:'admin'};
          else try{requestActor=app.users.authenticate(credential);}catch{}
        }
        // Consumer credentials never establish a management session, even if a browser also has an admin cookie.
        if (
          !requestActor ||
          request.headers.authorization !== undefined ||
          (origin && origin !== `http://${host}`)
        ) {
          send(403, {
            error: "请使用本机管理入口或登录本地账号",
          });
          return;
        }
        if (
          request.method === "GET" &&
          (url.pathname === "/api/bootstrap" ||
            url.pathname === "/api/canvas/bootstrap")
        )
          response.setHeader(
            "Set-Cookie",
            `${cookieName}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/api`,
          );
      }
      const dispatch=async()=>{
      if(requestActor&&request.method!=='POST')assertRole(requestRoleAction(request.method??'GET',url.pathname));
      if(requestActor&&request.method==='POST'&&['/api/canvas/upload/table','/api/canvas/upload/document'].includes(url.pathname))assertRole(requestRoleAction('POST',url.pathname));
      if(options.demo&&simulateDemoRequest(request.method??'GET',url.pathname)){send(409,demoSimulation);return;}
      if (request.method === "POST" && url.pathname === "/api/canvas/upload/table") {
        if (request.headers["content-type"]?.split(";")[0].trim() !== "application/octet-stream") throw new Error("表格上传需要原始文件内容");
        const options = url.searchParams.has("options") ? JSON.parse(url.searchParams.get("options")!) : undefined;
        const result = await app.canvasTableUpload({ page: url.searchParams.get("page") ?? "setup", name: url.searchParams.get("name"),
          sessionId: url.searchParams.get("sessionId") ?? undefined, options,
          batchId:url.searchParams.get('batchId')??undefined,operationId:url.searchParams.get('operationId')??undefined }, request);
        send(200, result); return;
      }
      if(request.method==="POST"&&url.pathname==="/api/canvas/upload/document"){
        if(request.headers["content-type"]?.split(";")[0].trim()!=="application/octet-stream")throw new Error("文档上传需要原始文件内容");
        send(200,{batch:await app.documentUploads.addFile({batchId:url.searchParams.get("batchId"),operationId:url.searchParams.get("operationId"),name:url.searchParams.get("name")},request)});return;
      }
      const sessionRoute=/^\/api\/sessions\/([^/]+)(\/messages)?$/.exec(url.pathname);
      if(url.pathname==="/api/sessions"&&request.method==="GET") {
        app.memory.defaultSession();send(200,{sessions:app.memory.listSessions(url.searchParams.get("archived")==="true")});return;
      }
      if(url.pathname==="/api/sessions"&&request.method==="POST") {
        const body=await readBody(request);if(body.title!==undefined&&typeof body.title!=="string")throw new Error("会话标题应为文本");
        send(201,{session:app.memory.createSession(body.title as string|undefined)});return;
      }
      if(sessionRoute&&request.method==="PATCH") {
        if(sessionRoute[2])throw new Error("此接口仅支持读取消息");
        const body=await readBody(request);
        if(body.title!==undefined&&typeof body.title!=="string")throw new Error("会话标题应为文本");
        send(200,{session:app.memory.updateSession(decodeURIComponent(sessionRoute[1]),body as {title?:string;archived?:boolean})});return;
      }
      if(sessionRoute&&request.method==="GET") {
        const id=decodeURIComponent(sessionRoute[1]);
        send(200,sessionRoute[2]?app.memory.sessionMessages(id,{before:url.searchParams.get("before")??undefined,limit:Number(url.searchParams.get("limit")??40)}):{session:app.memory.getSession(id)});return;
      }
      if (request.method === "GET") {
        if(url.pathname==='/api/consumers/audit-export'){assertRole('users');send(200,exportLegacyConsumptionAudit(app.memory,app.consumption));return;}
        if(url.pathname==='/api/datasets'||url.pathname.startsWith('/api/datasets/')){send(410,{code:'legacy_consumption_retired',error:'旧独立数据集入口已下线，请使用发布与接入；历史内容保留在审计导出。'});return;}
        if(url.pathname==='/api/auth/me'){send(200,{actor:requestActor});return;}
        if(url.pathname==='/api/users'){send(200,{users:app.users.list()});return;}
        if(url.pathname==='/api/usage'){send(200,app.usage.overview());return;}
        if(url.pathname==='/api/audit'){send(200,app.audit.list({offset:Number(url.searchParams.get('offset')??0),limit:Number(url.searchParams.get('limit')??50)}));return;}
        if(url.pathname==='/api/releases/gap-feedback'){send(200,new ExternalGapFeedback(app.memory).read({id:url.searchParams.get('id')??'',version:Number(url.searchParams.get('version'))}));return;}
        if(url.pathname==='/api/changes/impact'){send(200,await app.changes.preparePreview({id:url.searchParams.get('id')??'',version:Number(url.searchParams.get('version'))}));return;}
        if(url.pathname==='/api/sources/impact'){send(200,new SourceLifecycle(app.memory,app.live).impact({id:url.searchParams.get('id'),version:Number(url.searchParams.get('version'))}));return;}
        if(url.pathname==='/api/settings/retention'){
          send(200,{settings:app.retention.settings(),credentials:new CredentialVault(app.memory.directory).status()});return;
        }
        if(url.pathname==='/api/settings/retention/preview'){send(200,app.retention.preview());return;}
        if(url.pathname==="/api/canvas/upload/batch/read"){
          send(200,{batch:app.documentUploads.read(url.searchParams.get("id")??"")});return;
        }
        if(url.pathname==='/api/canvas/upload/table-batch/read'){send(200,{batch:app.tableUploads.read(url.searchParams.get('id')??'')});return;}
        if (url.pathname === "/api/ontology/workspace" || url.pathname === "/api/ontology/detail") {
          const workspace = new OntologyWorkspace(app.memory, app.foundation, app.live, app.pendingCenter, app.workspaceVersions);
          send(200, url.pathname.endsWith("/workspace") ? workspace.overview() : await workspace.detail({kind:url.searchParams.get("kind"), id:url.searchParams.get("id"), developer:url.searchParams.get("developer")==="true", evidenceOffset:Number(url.searchParams.get("evidenceOffset")??0)})); return;
        }
        if (url.pathname === "/api/foundation/evidence-list") {
          send(200, app.foundation.listEvidence({ id: url.searchParams.get("id"), version: Number(url.searchParams.get("version")),
            offset: Number(url.searchParams.get("offset") ?? 0), limit: Number(url.searchParams.get("limit") ?? 50) })); return;
        }
        if (url.pathname === "/api/foundation/adjudication") {
          send(200, app.adjudication.list({ offset: Number(url.searchParams.get("offset") ?? 0), limit: Number(url.searchParams.get("limit") ?? 40) })); return;
        }
        if (url.pathname === "/api/foundation/adjudication/read") {
          send(200, app.adjudication.read({ foundationRef: { id: url.searchParams.get("id"), version: Number(url.searchParams.get("version")) },
            issue: { kind: url.searchParams.get("kind"), id: url.searchParams.get("issueId") } })); return;
        }
        if (url.pathname === "/api/ontology/model") {
          send(200, app.live.readLayered(url.searchParams.get("id") ?? "", url.searchParams.has("version") ? Number(url.searchParams.get("version")) : undefined)); return;
        }
        if (url.pathname === "/api/events") {
          const after = request.headers["last-event-id"] ?? url.searchParams.get("after");
          events.connect(response, typeof after === "string" ? after : undefined,{validate:()=>{if(!matchesToken(sessionToken))app.users.authenticate(sessionToken);},project:event=>requestActor?.role!=='admin'&&event.ref?.kind&&managementArtifactKinds.has(event.ref.kind)?null:event}); return;
        }
        if (url.pathname === "/api/snapshot") {
          const snapshot = app.canvasState(url.searchParams.get("page") ?? undefined, url.searchParams.get("sessionId") ?? undefined);
          const scope = url.searchParams.get("scope");
          if (scope && !snapshotScopes[scope]) throw new Error("未知快照范围");
          const value = scope ? Object.fromEntries(snapshotScopes[scope].filter(key => Object.hasOwn(snapshot, key)).map(key => [key, (snapshot as Record<string, unknown>)[key]])) : snapshot;
          send(200, { ...value, eventCursor: events.cursor }); return;
        }
        if (url.pathname === "/api/databases/tables") {
          send(200, await app.live.sources.databases.tables(url.searchParams.get("id") ?? "")); return;
        }
        if (url.pathname === "/api/sources/rows") {
          const id = url.searchParams.get("id") ?? "", version = Number(url.searchParams.get("version"));
          const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 50);
          if (!Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("无效的资料分页范围");
          if (app.memory.getArtifact(id, version).kind !== "source") throw new Error("需要资料来源引用");
          send(200, await new Workspace(app.memory).execute("memory_read", { id, version, offset, limit })); return;
        }
        if (url.pathname === "/api/sources/summary") { send(200, sourceSummary(app.memory)); return; }
        if (url.pathname === "/api/pending") {
          const q = url.searchParams;
          send(200, app.pendingCenter.list({ ...Object.fromEntries(["category", "source", "object", "owner"].filter(key => q.has(key)).map(key => [key, q.get(key)])),
            ...(q.has("limit") ? { limit: Number(q.get("limit")) } : {}), ...(q.has("offset") ? { offset: Number(q.get("offset")) } : {}) })); return;
        }
        if (url.pathname === "/api/pending/read") { send(200, { item: app.pendingCenter.read(url.searchParams.get("id") ?? "") }); return; }
        if (url.pathname === "/api/changes") {
          const q = url.searchParams;
          send(200, app.changes.list({ ...(q.get("status") ? { status: q.get("status") } : {}), ...(q.get("type") ? { type: q.get("type") } : {}),
            ...(q.has("limit") ? { limit: Number(q.get("limit")) } : {}), ...(q.has("offset") ? { offset: Number(q.get("offset")) } : {}) })); return;
        }
        if (url.pathname === "/api/changes/read") {
          send(200, { change: app.changes.read(url.searchParams.get("id") ?? "", url.searchParams.has("version") ? Number(url.searchParams.get("version")) : undefined) }); return;
        }
        if(url.pathname==="/api/naming/batches/read"){
          send(200,app.namingBatches.read(url.searchParams.get("id")??"",url.searchParams.has("version")?Number(url.searchParams.get("version")):undefined));return;
        }
        if (url.pathname === "/api/workspace-versions") { send(200, { versions: app.workspaceVersions.list(), composition: app.workspaceVersions.composition() }); return; }
        if (url.pathname === "/api/workspace-versions/read") { send(200, { version: app.workspaceVersions.read(Number(url.searchParams.get("number"))) }); return; }
        if (url.pathname === "/api/engine") { send(200, app.programBuilds.overview()); return; }
        if (url.pathname === "/api/data") { send(200, app.snapshots.overview()); return; }
        if (url.pathname === "/api/data/sync-policy") { send(200,url.searchParams.has('sourceId')?app.syncGovernance.policy(url.searchParams.get('sourceId')!):{policies:app.syncGovernance.policies()}); return; }
        if (url.pathname === "/api/data/issues/read") { send(200,{issue:app.syncGovernance.detail(url.searchParams.get('id')??'')}); return; }
        if (url.pathname === "/api/data/preview") {
          send(200, await app.snapshots.preview({ datasetId: url.searchParams.get("datasetId"), ...(url.searchParams.get("snapshotId") ? { snapshotId: url.searchParams.get("snapshotId") } : {}),
            offset: Number(url.searchParams.get("offset") ?? 0), limit: Number(url.searchParams.get("limit") ?? 50) })); return;
        }
        if (url.pathname === "/api/qa/views") {
          const reference=(item:Artifact)=>({id:item.id,version:item.version});
          const releases=app.memory.listArtifacts("data_release").filter(item=>item.status==="published");
          send(200,{currentReleaseRef:releases[0]?reference(releases[0]):null,releases:releases.map(item=>({ref:reference(item),title:item.title,createdAt:item.createdAt})),connections:app.memory.listArtifacts("release_connection").filter(item=>item.status==="active"&&releases.some(release=>JSON.stringify(reference(release))===JSON.stringify(item.content.releaseRef))).map(item=>({ref:reference(item),title:item.title,releaseRef:item.content.releaseRef}))}); return;
        }
        if (url.pathname === "/api/gaps") { send(200,{items:app.questionAnswering.gaps.list()}); return; }
        if (url.pathname === "/api/gaps/read") { send(200,{gap:app.questionAnswering.gaps.get(url.searchParams.get("id")??"")}); return; }
        if (url.pathname === "/api/releases") { send(200, {...new Releases(app.memory, app.live).overview(), delegations: app.delegations.list()}); return; }
        if (url.pathname === "/api/releases/compare") {
          send(200, new Releases(app.memory, app.live).compare({
            from: { id: url.searchParams.get("fromId"), version: Number(url.searchParams.get("fromVersion")) },
            to: { id: url.searchParams.get("toId"), version: Number(url.searchParams.get("toVersion")) },
          })); return;
        }
        if (url.pathname === "/api/releases/data-diff") {
          const param = (prefix: string) => url.searchParams.get(prefix + "Id") ? { [prefix]: { id: url.searchParams.get(prefix + "Id"), version: Number(url.searchParams.get(prefix + "Version")) } } : {};
          send(200, await new Releases(app.memory, app.live).dataDiff({ ...param("from"), ...param("to") })); return;
        }
        if (url.pathname === "/api/releases/connection-detail") {
          send(200,new Releases(app.memory,app.live).connectionDetail({id:url.searchParams.get("id"),version:Number(url.searchParams.get("version"))}));return;
        }
        if (url.pathname === "/api/releases/upgrade-preview") {
          send(200,new Releases(app.memory,app.live).upgradePreview({connectionRef:{id:url.searchParams.get("connectionId"),version:Number(url.searchParams.get("connectionVersion"))},releaseRef:{id:url.searchParams.get("releaseId"),version:Number(url.searchParams.get("releaseVersion"))}}));return;
        }
        if (url.pathname === "/api/releases/read" || url.pathname === "/api/releases/connection") {
          const releases = new Releases(app.memory, app.live), ref = {id:url.searchParams.get("id"), version:Number(url.searchParams.get("version"))};
          send(200, url.pathname.endsWith("/read") ? releases.read(ref) : releases.connection(ref,url.origin)); return;
        }
        if (url.pathname === "/api/onboarding") { send(200, app.onboarding.view(app.model().configured)); return; }
        if (url.pathname === '/api/onboarding/examples') {send(200,app.onboarding.examples());return;}
        if (url.pathname === "/api/datasets") {
          send(200, new OntologyDatasets(app.memory, app.live).list()); return;
        }
        if (url.pathname === "/api/datasets/connection") {
          send(200, new OntologyDatasets(app.memory, app.live).connection({ id: url.searchParams.get("id"), version: Number(url.searchParams.get("version")) }, url.origin)); return;
        }
        if (url.pathname === "/api/canvas/bootstrap") {
          send(200, { token:sessionToken,actor:requestActor, ...app.canvasState() });
          return;
        }
        if (url.pathname === "/api/foundation/evidence") {
          send(
            200,
            app.foundation.evidence(
              url.searchParams.get("foundationId") ?? "",
              Number(url.searchParams.get("version")),
              url.searchParams.get("evidenceId") ?? "",
            ),
          );
          return;
        }
        if (url.pathname === "/api/canvas/messages") {
          send(200, app.canvasMessages(url.searchParams));
          return;
        }
        if (url.pathname === "/api/canvas/history") {
          send(200, app.canvasHistory(url.searchParams.get("section")));
          return;
        }
        if (url.pathname === "/api/canvas") {
          send(200, app.canvasState(url.searchParams.get("page") ?? undefined,url.searchParams.get("sessionId") ?? undefined));
          return;
        }
        if (url.pathname === "/api/bootstrap") {
          const snapshot=app.state();send(200, { token:sessionToken,actor:requestActor, ...snapshot,artifacts:requestActor?.role==='admin'?snapshot.artifacts:snapshot.artifacts.filter(item=>!managementArtifactKinds.has(item.kind)) });
          return;
        }
        if (url.pathname === "/api/state") {
          const snapshot=app.state(url.searchParams.get('taskId')??undefined);send(200,{...snapshot,artifacts:requestActor?.role==='admin'?snapshot.artifacts:snapshot.artifacts.filter(item=>!managementArtifactKinds.has(item.kind))});
          return;
        }
        if (url.pathname === "/api/capabilities") {
          send(200, await app.capabilities.overview());
          return;
        }
        if (url.pathname === "/api/connectors/feishu") {
          send(200, { ...app.capabilities.feishu.status(), documents: app.capabilities.feishuDocuments!.list(), modelConfigured: app.model().configured });
          return;
        }
        if (url.pathname === "/api/connectors/feishu/document") {
          send(200, app.capabilities.feishuDocuments!.get(url.searchParams.get("sourceId") || ""));
          return;
        }
        if (url.pathname === "/api/capabilities/mcp") {
          send(200, { servers: app.capabilities.mcp.list() });
          return;
        }
        if (url.pathname === "/api/consumers/history") {
          send(200, historicalConsumption(app.memory, {
            offset: Number(url.searchParams.get("offset") ?? 0), limit: Number(url.searchParams.get("limit") ?? 40),
          })); return;
        }
        if (url.pathname === "/api/consumers") {
          send(200, {
            consumers: app.consumption.list(),
            audit: app.consumption.logs(
              url.searchParams.get("consumerId") ?? undefined,
            ),
          });
          return;
        }
        if(url.pathname==='/api/live/views/evidence-options') {
          send(200,new ConsumerViews(app.memory,app.live).evidenceOptions({id:url.searchParams.get('id'),version:Number(url.searchParams.get('version'))}));return;
        }
        if(url.pathname==='/api/live/views/connection') {
          send(200,new ConsumerViews(app.memory,app.live).connection({id:url.searchParams.get('id'),version:Number(url.searchParams.get('version'))},url.origin));return;
        }
        if (url.pathname === "/api/consumers/connection") {
          const origin = `http://${host}`;
          send(200, {
            mcp: {
              mcpServers: {
                dataengine: {
                  command: process.execPath,
                  args: [
                    fileURLToPath(
                      new URL(
                        "../../scripts/dataengine-mcp.ts",
                        import.meta.url,
                      ),
                    ),
                  ],
                  env: {
                    DATAENGINE_URL: origin,
                    DATAENGINE_CONSUMER_KEY: "<本调用方 API Key>",
                  },
                },
              },
            },
            http: {
              schema: `${origin}/v1/schema`,
              objects: `${origin}/v1/objects`,
            },
            localOnly: true,
          });
          return;
        }
        if (url.pathname === "/api/objects") {
          send(200, app.objectDetails(url.searchParams));
          return;
        }
        if (url.pathname.startsWith("/api/artifacts/")) {
          const version = url.searchParams.has("version")
            ? Number(url.searchParams.get("version"))
            : undefined;
          if (
            version !== undefined &&
            (!Number.isInteger(version) || version < 1)
          )
            throw new Error("无效版本");
          const artifact = app.memory.getArtifact(decodeURIComponent(url.pathname.slice("/api/artifacts/".length)), version, {evidence:"compact"});
          if(managementArtifactKinds.has(artifact.kind))assertRole('users');
          send(200, artifact.kind === "change_evidence_receipt" ? artifact : app.memory.getArtifact(artifact.id, artifact.version));
          return;
        }
        const normalized = url.pathname.startsWith("/agent/")
          ? url.pathname.slice("/agent".length)
          : url.pathname;
        const entry = staticFiles[normalized];
        if (!entry) {
          send(404, { error: "页面不存在" });
          return;
        }
        const contents = normalized === "/ontology-scene.js"
          ? await ontologySceneAsset()
          : await readFile(join(webRoot, entry.file));
        response.writeHead(200, { "Content-Type": entry.type });
        response.end(contents);
        return;
      }
      if (request.method !== "POST") {
        send(405, { error: "不支持的请求方式" });
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        send(404, { error: "接口不存在" });
        return;
      }
      const body = await readBody(request);
      assertRole(requestRoleAction('POST',url.pathname,body));
      if (new Set([
        "/api/consumers/prepare", "/api/consumers/activate", "/api/consumers/data-publish",
        "/api/live/prepare", "/api/live/activate", "/api/live/views/propose", "/api/live/views/activate",
        "/api/live/migrations/preview", "/api/live/migrations/commit", "/api/datasets/publish",
      ]).has(url.pathname)) {
        const error = new LegacyConsumptionFrozen();
        send(409, { error: error.message, code: error.code }); return;
      }
      let result: unknown;
      switch (url.pathname) {
        case '/api/auth/logout':result=app.users.logout(sessionToken);response.setHeader('Set-Cookie',`${cookieName}=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0`);break;
        case '/api/users/create':result={user:app.users.create(body)};break;
        case '/api/users/update':result={user:app.users.update(body)};break;
        case '/api/usage/policy':result=app.usage.configure(body);break;
        case '/api/releases/gap-feedback':result=new ExternalGapFeedback(app.memory).configure(body);break;
        case '/api/sources/manage':result=await queue(()=>app.manageSource(body));break;
        case '/api/settings/retention':result={settings:app.retention.configure(body)};break;
        case '/api/settings/retention/run':result=await app.retention.run(body as {operationId:string});break;
        case '/api/backup':result=await app.backups.create(body as {destination:string;operationId:string});break;
        case '/api/backup/config':result=await app.backups.exportConfig(body as {destination:string});break;
        case '/api/restore':result=await BackupService.restore(body as {backup:string;destination:string});break;
        case "/api/data/sync-policy": result=app.syncGovernance.configure(body); break;
        case "/api/data/issues/resolve": result=app.syncGovernance.resolve(body); break;
        case "/api/gaps/handoff": result=app.questionAnswering.gaps.handoff(body); break;
        case "/api/gaps/preview": result=await app.questionAnswering.gaps.preview(body); break;
        case "/api/gaps/link": result=app.questionAnswering.gaps.linkChange(body); break;
        case "/api/gaps/dismiss": result=app.questionAnswering.gaps.dismiss(body); break;
        case "/api/gaps/reask": result=await app.questionAnswering.gaps.reask(body); break;
        case "/api/semantic/query": {
          const abort = new AbortController();
          const closed = () => abort.abort(); response.once("close", closed);
          try { result = await app.semanticQuery.execute(body, {signal:abort.signal}); }
          finally { response.off("close", closed); }
          break;
        }
        case "/api/databases/test":
          result = await app.live.sources.databases.test(body); break;
        case "/api/databases/connect":
          result = await app.live.sources.databases.connect(body); break;
        case "/api/databases/select":
          result = await app.live.sources.databases.select(body); break;
        case "/api/canvas/upload/batch/start":
          result = app.canvasDocumentBatchStart(body); break;
        case "/api/canvas/upload/batch/file":
          result = { batch: app.documentUploads.add(body) }; break;
        case "/api/canvas/upload/batch/finalize":
          result = app.canvasDocumentBatchFinalize(body); break;
        case '/api/canvas/upload/table-batch/start':result=app.canvasTableBatchStart(body);break;
        case '/api/canvas/upload/table-batch/finalize':result=app.canvasTableBatchFinalize(body);break;
        case "/api/canvas/upload/reparse":
          result = await app.canvasTableReparse(body); break;
        case "/api/foundation/adjudication/propose":
          result = await app.adjudication.propose(body); break;
        case "/api/changes/batch-adopt":
          result = await app.changes.batchAdopt(body); break;
        case "/api/changes/batch-reject":
          result = app.changes.batchReject(body); break;
        case "/api/changes/propose": {
          const proposed = await app.changes.propose(body);
          send(proposed.suppressed ? 200 : 201, proposed); return;
        }
        case "/api/changes/verify":
          result = { change: await app.changes.verify(body) }; break;
        case "/api/changes/adopt":
          result = { change: await app.changes.adopt(body) }; break;
        case "/api/changes/reject":
          result = { change: app.changes.reject(body) }; break;
        case "/api/changes/withdraw":
          result = { change: app.changes.withdraw(body) }; break;
        case "/api/naming/batches/edit":
          result=app.namingBatches.edit(body);break;
        case "/api/engine/build":
          send(202, {job:app.programBuilds.start(body)}); return;
        case "/api/data/sync":
          send(202, {job:app.snapshots.start(body)}); return;
        case "/api/data/accept":
          result = app.snapshots.accept(body); break;
        case "/api/data/policy":
          result = app.snapshots.setPolicy(body); break;
        case "/api/engine/check":
          result = await app.programBuilds.check(body); break;
        case "/api/engine/adopt": {
          const adopted = await app.programBuilds.adopt(body);
          result = adopted; break;
        }
        case "/api/engine/cancel":
          result = app.programBuilds.cancel(body); break;
        case "/api/releases/check":
          result = await new Releases(app.memory, app.live).check(body); break;
        case "/api/releases/publish":
          result = new Releases(app.memory, app.live).publish(body); break;
        case "/api/releases/connect":
          result = new Releases(app.memory, app.live).connect(body); break;
        case "/api/releases/upgrade":
          result = new Releases(app.memory, app.live).upgrade(body); break;
        case "/api/releases/revoke":
          result = new Releases(app.memory, app.live).revoke(body); break;
        case "/api/datasets/test":
          result = await testDatasetMcp(new OntologyDatasets(app.memory, app.live), body, url.origin);
          break;
        case "/api/datasets/publish":
          result = new OntologyDatasets(app.memory, app.live).publish(body);
          break;
        case "/api/datasets/revoke":
          result = { dataset: new OntologyDatasets(app.memory, app.live).revoke(body) };
          break;
        case "/api/connectors/feishu/start":
          result = app.capabilities.feishu.start();
          break;
        case "/api/connectors/feishu/authorize-tables":
          result=app.capabilities.feishu.authorizeTables();break;
        case "/api/connectors/feishu/tables/browse":
          result=await app.feishuTables.browse(body);break;
        case "/api/connectors/feishu/tables/describe":
          result=await app.feishuTables.describe(body);break;
        case "/api/connectors/feishu/tables/select":
          result=await app.feishuTables.select(body);break;
        case "/api/connectors/feishu/cancel":
          result = await app.capabilities.feishu.cancel(String(body.id));
          break;
        case "/api/connectors/feishu/disconnect":
          result = await app.capabilities.feishu.disconnect();
          break;
        case "/api/connectors/feishu/read":
          result = await app.capabilities.readFeishu(String(body.url));
          break;
        case "/api/connectors/feishu/directory":
          result = await app.capabilities.sdk.call("feishu.directory.list", body);
          break;
        case "/api/connectors/feishu/prepare":
          result = await queue(() => app.prepareFeishuFoundation(body));
          break;
        case "/api/capabilities/mcp/disconnect":
          await app.capabilities.mcp.disconnect(String(body.name));
          result = await app.capabilities.overview();
          break;
        case "/api/capabilities/mcp/grant":
          if (
            !Array.isArray(body.ids) ||
            body.ids.some((id) => typeof id !== "string")
          )
            throw new Error("请选择具体能力");
          if (!Number.isInteger(body.revision))
            throw new Error("缺少能力目录版本，请重新打开设置");
          app.capabilities.mcp.grant(
            String(body.name),
            body.ids as string[],
            Number(body.revision),
          );
          result = await app.capabilities.overview();
          break;
        case "/api/capabilities/mcp/refresh":
        case "/api/capabilities/mcp/connect":
        case "/api/capabilities/skill/install":
          result = await queue(async () => {
            if (app.canvasState().busy)
              throw new Error("请先停止当前整理，再添加能力");
            if (url.pathname.endsWith("/refresh"))
              await app.capabilities.mcp.refresh(String(body.name));
            else if (url.pathname.endsWith("/connect"))
              await app.capabilities.mcp.connect(body);
            else
              await app.capabilities.installSkill(
                String(body.name),
                String(body.content),
              );
            return app.capabilities.overview();
          });
          break;
        case "/api/live/openapi/parse":
          result = await openApiImports.parse(body);
          break;
        case "/api/live/openapi/preview":
          result = await openApiImports.preview(body);
          break;
        case "/api/live/openapi/commit":
          result = await queue(async () => {
            if (app.canvasState().busy && !app.automaticRunning) throw new Error("请先停止当前整理，再保存来源");
            const saved = await openApiImports.commit(body);
            return { ...app.canvasState(), saved };
          });
          break;
        case "/api/live/connect":
        case "/api/live/propose":
        case "/api/live/adopt":
        case "/api/live/prepare":
        case "/api/live/activate":
          result = await queue(async () => {
            if (app.canvasState().busy && !(url.pathname === "/api/live/connect" && app.automaticRunning))
              throw new Error("请先停止当前整理，再修改连接或本体");
            let saved: unknown;
            switch (url.pathname) {
              case "/api/live/connect":
                saved = await app.live.sources.connect(body);
                break;
              case "/api/live/propose":
                saved = await app.live.propose(body);
                break;
              case "/api/live/adopt": {
                const adopted = await app.adoptLive(
                  String(body.id),
                  Number(body.version),
                );
                saved = adopted;
                break;
              }
              case "/api/live/prepare":
                saved = app.live.prepare(body);
                break;
              case "/api/live/activate":
                saved = app.live.activate(
                  String(body.id),
                  Number(body.version),
                );
                break;
            }
            return { ...app.canvasState(), saved };
          });
          break;
        case "/api/live/disable": {
          const saved = app.live.sources.disable(
            String(body.id),
            Number(body.version),
          );
          result = { ...app.canvasState(), saved };
          break;
        }
        case "/api/live/revoke": {
          const saved = app.live.revoke(String(body.id), Number(body.version));
          result = { ...app.canvasState(), saved };
          break;
        }
        case "/api/live/read":
          result = await app.live.sources.readRecords(
            String(body.sourceId),
            String(body.capability),
            (body.where ?? {}) as import("./contracts.ts").Data,
            Number(body.offset ?? 0),
            Number(body.limit ?? 3),
          );
          break;
        case "/api/live/metrics/describe":
          result = await new MetricReader(app.live.sources).describe(body);
          break;
        case "/api/live/metrics/query":
          result = await new MetricReader(app.live.sources).query(body);
          break;
        case "/api/live/catalog":
          result = sourceCatalog(app.memory, body);
          break;
        case "/api/live/knowledge/query":
          result = await new KnowledgeReader(app.live.sources).query(body);
          break;
        case "/api/live/knowledge/read":
          result = await new KnowledgeReader(app.live.sources).read(body);
          break;
        case "/api/live/evidence/collect":
          {
            const saved = await new EvidenceService(
              app.memory,
              app.live,
            ).collect(body);
            result = { ...app.canvasState(), saved };
          }
          break;
        case "/api/live/evidence/read":
          result = new EvidenceService(app.memory, app.live).read(body);
          break;
        case "/api/live/views/propose":
        case "/api/live/views/activate":
        case "/api/live/views/revoke": {
          const views=new ConsumerViews(app.memory,app.live);
          const saved=url.pathname.endsWith("propose")?views.propose(body):url.pathname.endsWith("activate")?views.activate(body):views.revoke(body);
          result={...app.canvasState(),saved};break;
        }
        case '/api/live/migrations/impact': result=new ConsumerMigrations(app.memory,app.live).impact(body);break;
        case '/api/live/migrations/list': result={items:new ConsumerMigrations(app.memory,app.live).list()};break;
        case '/api/live/migrations/read': result=new ConsumerMigrations(app.memory,app.live).read(body);break;
        case '/api/live/migrations/preview':
        case '/api/live/migrations/commit': {
          const saved=new ConsumerMigrations(app.memory,app.live).execute(url.pathname.endsWith('preview')?'preview':'commit',body);
          result={...app.canvasState(),saved};break;
        }
        case "/api/live/changes/list":
          result = {items:new MappingChanges(app.memory,app.live).list()}; break;
        case "/api/live/changes/read":
          result = new MappingChanges(app.memory,app.live).read(String(body.id),Number(body.version)); break;
        case "/api/live/changes/issues":
          result = new MappingChanges(app.memory,app.live).issues(body.baseRef as {id:string,version:number}); break;
        case "/api/live/changes/propose":
        case "/api/live/changes/check":
        case "/api/live/changes/adopt":
        case "/api/live/changes/cancel": {
          const saved=await new MappingChanges(app.memory,app.live).execute(url.pathname.split("/").at(-1) as "propose"|"check"|"adopt"|"cancel",body);
          result={...app.canvasState(),saved}; break;
        }
        case "/api/live/corrections/read":
          result = new RelationCorrections(app.memory, app.live).read(
            String(body.id),
            Number(body.version),
          );
          break;
        case "/api/live/corrections/list":
          result = {
            items: new RelationCorrections(app.memory, app.live).list(),
          };
          break;
        case "/api/live/corrections/propose":
        case "/api/live/corrections/check":
        case "/api/live/corrections/adopt":
        case "/api/live/corrections/cancel": {
          const method = url.pathname.split("/").at(-1) as
            "propose" | "check" | "adopt" | "cancel";
          const saved = await new RelationCorrections(app.memory, app.live).execute(method, body);
          result = { ...app.canvasState(), saved };
          break;
        }
        case "/api/live/query":
          result = await app.live.query(body);
          break;
        case "/api/sources/policy":
          result = await queue(async () => {
            const policy = new SourcePolicyService(app.memory).update(body);
            return { ...app.canvasState(), policy };
          });
          break;
        case "/api/verifications/review":
          result = await queue(async () => {
            if (app.canvasState().busy)
              throw new Error("请等待当前整理完成或先停止，再确认验证结果");
            const verification = reviewVerification(app.memory, body);
            return { ...app.canvasState(), verification };
          });
          break;
        case "/api/consumers/activate":
          result = await queue(() => app.activateConsumer(body));
          break;
        case "/api/consumers/prepare":
          result = await queue(async () => app.prepareConsumer(body));
          break;
        case "/api/consumers/data-preview":
          result = app.consumption.previewDataUpdate(
            String(body.id ?? ""),
            Number(body.version),
          );
          break;
        case "/api/consumers/data-publish":
          result = await queue(async () => {
            const consumer = app.consumption.publishDataUpdate(
              String(body.id ?? ""),
              Number(body.version),
              body.sourceVersions as Record<string, number>,
            );
            return { ...app.canvasState(), consumer };
          });
          break;
        case "/api/consumers/revoke":
          result = await app.revokeConsumer(body);
          break;
        case "/api/canvas/message/receipt":
          result = app.canvasMessageReceipt(body);
          break;
        case "/api/canvas/context":
          result = app.canvasContext(body);
          break;
        case "/api/canvas/context/read":
          result = await app.contexts.read(app.canvasContext(body).context, undefined, body.readMode as "active_snapshot" | "live" | undefined);
          break;
        case "/api/canvas/message":
          result = await queue(() => app.canvasMessage(body));
          send(202, result);
          return;
        case "/api/canvas/upload":
          result = await queue(() => app.canvasUpload(body));
          break;
        case "/api/canvas/foundation/automatic":
          result = await queue(async () => app.retryAutomaticBuild());
          break;
        case '/api/naming/retry':
          app.automaticNaming.retry();result=app.canvasState(body.page);break;
        case "/api/canvas/upload/remove":
          result = await queue(() => app.removeUpload(body));
          break;
        case "/api/canvas/navigate":
          result = await queue(() => app.canvasNavigate(body));
          break;
        case "/api/canvas/stop":
          result = await app.canvasStop(body);
          break;
        case "/api/canvas/foundation/adopt": {
          const adoptedFoundation = await queue(() => app.canvasFoundationAdopt(body));
          result = adoptedFoundation; break;
        }
        case "/api/canvas/decision":
          result = await queue(() => app.canvasDecision(body));
          break;
        case "/api/messages":
          result = await queue(() => app.message(body));
          send(202, result);
          return;
        case "/api/upload":
          result = await queue(() => app.upload(body));
          break;
        case "/api/sample":
          result = await queue(() => app.sample(body));
          break;
        case "/api/stop":
          if (typeof body.taskId !== "string") throw new Error("需要任务标识");
          result = await app.stop(body.taskId);
          break;
        case "/api/decision":
          result = await queue(() => app.decision(body));
          break;
        case "/api/profile":
          result = await queue(() => app.editProfile(body));
          break;
        case "/api/refresh":
          result = await queue(() => app.refresh(body));
          break;
        case "/api/onboarding/start":
        case "/api/onboarding/suspend":
        case "/api/onboarding/company":
        case "/api/onboarding/step":
        case "/api/onboarding/pack":
        case "/api/onboarding/complete":
          result = await queue(() => app.updateOnboarding(url.pathname.split("/").at(-1)!, body));
          break;
        case "/api/onboarding/research":
          result = await queue(() => app.researchOnboarding(body));
          break;
        case "/api/settings":
          result = await queue(() => app.configure(body));
          break;
        case "/api/settings/key/delete":
          result = await queue(async () => app.deleteModelKey());
          break;
        case "/api/settings/test":
          result = await app.testConnection();
          break;
        default:
          send(404, { error: "接口不存在" });
          return;
      }
      send(200, result);
      };
      if(requestActor)await withActor(requestActor,dispatch,()=>{if(!matchesToken(sessionToken))app.users.authenticate(sessionToken);});
      else await dispatch();
    } catch (error) {
      const message = app.safeError(error);
      // A stale or already-decided change is a conflict the caller resolves by re-reading, not a malformed request.
      if (error instanceof ChangeConflict) { send(409, { error: message.slice(0, 600), code: error.code }); return; }
      if(error instanceof RoleDenied){send(403,{error:message.slice(0,600),code:error.code});return;}
      // Never include request bodies, provider credentials or raw SDK objects in HTTP errors.
      send(error instanceof DelegationDenied ? 403 : /不存在/.test(message) ? 404 : 400, {
        error: message.slice(0, 600),
      });
    }
  });
  return {
    app,
    server,
    adminToken: token,
    async close() {
      if (closed) return;
      closed = true;
      events.close();
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
      openApiImports.close();
      await app.close();
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const port = Number(process.env.DATAENGINE_PORT ?? 8788);
  const service = await createServer({
    directory: process.env.DATAENGINE_STATE_DIR,
  });
  service.server.listen(port, "127.0.0.1", () => {
    console.log(
      `DataEngine: http://127.0.0.1:${port}/#access=${service.adminToken}`,
    );
  });
  const shutdown = () => {
    void service.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

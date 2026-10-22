import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createFeishuCli, FEISHU_VERSION, type FeishuCliPort } from "./feishu-cli.ts";

export function authorizationUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8192 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const u = new URL(value);
    const app = u.hostname === "open.feishu.cn" && u.pathname === "/page/cli";
    const user = u.hostname === "accounts.feishu.cn" && u.pathname === "/oauth/v1/device/verify";
    const allowed = app ? ["user_code", "lpv", "ocv", "from"] : ["user_code", "flow_id"];
    const keys = [...u.searchParams.keys()];
    return u.protocol === "https:" && !u.username && !u.password && !u.hash && (!u.port || u.port === "443") && (app || user) && !!u.searchParams.get("user_code") && new Set(keys).size === keys.length && keys.every(k => allowed.includes(k)) && [...u.searchParams.values()].every(v => !!v && !/[\s\u0000-\u001f\u007f]/.test(v));
  } catch { return false; }
}
const record = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("飞书返回格式不正确");
  return value as Record<string, any>;
};
const nodeToken = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const pageToken = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_+/=-]{0,2047}$/.test(value);
export const FEISHU_TABLE_SCOPES = ["base:table:read", "base:field:read", "base:record:read"];
export function feishuBaseUrl(value: string) {
  const u = new URL(value);
  if (u.protocol !== "https:" || !(u.hostname === "feishu.cn" || u.hostname.endsWith(".feishu.cn")) || u.port || u.username || u.password || u.hash || !/^\/base\/[A-Za-z0-9_-]{1,128}$/.test(u.pathname) || [...u.searchParams.keys()].some(key => key !== "table") || u.searchParams.has("table") && !nodeToken(u.searchParams.get("table"))) throw new Error("请填写飞书多维表格 base 链接；接入范围为整张数据表，不接受筛选视图或分享参数");
  return { url: u.origin + u.pathname, token: u.pathname.split("/").at(-1)! };
}
function documentUrl(url: string) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !(u.hostname === "feishu.cn" || u.hostname.endsWith(".feishu.cn")) || u.port || u.username || u.password || u.search || u.hash || !/^\/(docx|wiki)\/[A-Za-z0-9_-]{1,128}$/.test(u.pathname)) throw new Error("请填写飞书 docx 文档或 wiki 知识库页面链接（不含查询参数）");
  return u;
}
function directoryNode(value: unknown) {
  const node = record(value);
  if (!nodeToken(node.node_token) || !nodeToken(node.obj_token) || typeof node.space_id !== "string" || !/^\d{1,30}$/.test(node.space_id) || (node.parent_node_token !== "" && !nodeToken(node.parent_node_token)) || typeof node.title !== "string" || node.title.length > 1000 || typeof node.has_child !== "boolean" || typeof node.obj_type !== "string") throw new Error("知识库目录返回无法验证");
  return { node_token: node.node_token, obj_token: node.obj_token, space_id: node.space_id, parent_node_token: node.parent_node_token as string, title: node.title, has_child: node.has_child, obj_type: node.obj_type };
}
interface Account { profile: string; appId: string; openId: string; label: string; verifiedAt: string; scopes?: string[]; }
type Phase = "preparing" | "waiting_app" | "waiting_authorization" | "verifying" | "connected" | "cancelled" | "failed";
interface Job { id: string; phase: Phase; authorizationUrl?: string; error?: string; }
export class FeishuConnector {
  onDisconnected?: () => void;
  private cli: FeishuCliPort;
  private file: string;
  private account?: Account;
  private job?: Job;
  private controller?: AbortController;
  private running?: Promise<void>;
  private revision = 0;
  constructor(directory: string, cli = createFeishuCli(directory)) {
    this.cli = cli;
    const root = join(directory, "connectors", "feishu");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.file = join(root, "account.json");
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8"));
      if (value && /^de-[a-f0-9-]+$/.test(value.profile) && /^cli_[\w-]+$/.test(value.appId) && /^ou_[\w-]+$/.test(value.openId)) this.account = value;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  private save() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.account || null), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
  status() {
    return { provider: "feishu", version: FEISHU_VERSION, account: this.account ? { label: this.account.label, verifiedAt: this.account.verifiedAt, tablesAuthorized: FEISHU_TABLE_SCOPES.every(scope => this.account!.scopes?.includes(scope)) } : null, job: this.job ? { ...this.job } : null };
  }
  accountKey() { return this.account ? createHash("sha256").update(JSON.stringify([this.account.profile, this.account.appId, this.account.openId])).digest("hex") : null; }
  assertAccount(key: string) { if (!key || this.accountKey() !== key) throw new Error("飞书连接已断开或账号已变化，请重新选择来源"); }
  authorizeTables() {
    if (!this.account) throw new Error("请先连接飞书账号");
    if (this.running) throw new Error("已有飞书连接任务，请等待或取消");
    const account = this.account, revision = ++this.revision, controller = new AbortController(), job: Job = { id: randomUUID(), phase: "preparing" };
    this.controller = controller; this.job = job;
    this.running = (async () => {
      await this.cli.prepare(controller.signal); let authorized = false, shown = false;
      await this.cli.run({ args: [`--profile=${account.profile}`, "auth", "login", "--json", "--scope", ["docx:document:readonly", ...FEISHU_TABLE_SCOPES].join(" ")], signal: controller.signal, timeoutMs: 630000, onLine: (stream, line) => {
        if (stream !== "stdout" || !line.trim() || controller.signal.aborted) return;
        const event = record(JSON.parse(line));
        if (event.event === "device_authorization" && !shown && authorizationUrl(event.verification_uri_complete) && new URL(event.verification_uri_complete).hostname === "accounts.feishu.cn") { shown = true; job.phase = "waiting_authorization"; job.authorizationUrl = event.verification_uri_complete; }
        else if (event.event === "authorization_complete" && shown && !authorized && Array.isArray(event.granted) && FEISHU_TABLE_SCOPES.every(scope => event.granted.includes(scope)) && Array.isArray(event.missing) && !event.missing.length) authorized = true;
        else throw new Error("飞书表格授权回执无法验证");
      } });
      controller.signal.throwIfAborted(); if (!authorized) throw new Error("未取得表格只读授权");
      const verified = await this.verify(account.profile, controller.signal); controller.signal.throwIfAborted();
      if (this.revision !== revision || verified.appId !== account.appId || verified.openId !== account.openId || !FEISHU_TABLE_SCOPES.every(scope => verified.scopes?.includes(scope))) throw new Error("表格授权账号或权限不一致");
      this.account = verified; this.save(); job.phase = "connected"; delete job.authorizationUrl;
    })().catch(() => { if (revision === this.revision) { job.phase = controller.signal.aborted ? "cancelled" : "failed"; job.error = controller.signal.aborted ? undefined : "多维表格授权未完成，请检查管理员许可和账号后重试。"; delete job.authorizationUrl; } }).finally(() => { this.running = undefined; this.controller = undefined; });
    return this.status();
  }
  start() {
    if (this.running) throw new Error("已有飞书连接任务，请等待或取消");
    if (this.account) throw new Error("已有飞书连接，请先断开再重新登录");
    const controller = new AbortController();
    this.controller = controller;
    const job: Job = { id: randomUUID(), phase: "preparing" };
    this.job = job;
    const profile = `de-${randomUUID()}`;
    const revision = ++this.revision;
    this.running = this.onboard(profile, job, controller.signal).catch(() => {
      if (revision === this.revision) { job.phase = controller.signal.aborted ? "cancelled" : "failed"; job.error = controller.signal.aborted ? undefined : "连接未完成。请检查网络、飞书管理员许可后重试。"; delete job.authorizationUrl; }
    }).finally(() => { this.running = undefined; this.controller = undefined; });
    return this.status();
  }
  private async onboard(profile: string, job: Job, signal: AbortSignal) {
    await this.cli.prepare(signal);
    const run = (args: string[], onLine?: (stream: "stdout" | "stderr", line: string) => void) => this.cli.run({ args, signal, onLine, timeoutMs: onLine ? 630000 : 45000 });
    if ((await run(["--version"])).trim() !== `lark-cli version ${FEISHU_VERSION}`) throw new Error("组件版本不匹配");
    const existing = JSON.parse(await run(["profile", "list"]));
    if (!Array.isArray(existing) || existing.some(x => x?.name === profile)) throw new Error("账号配置冲突");
    let appUrl = false;
    const result = record(JSON.parse(await run(["config", "init", "--new", "--brand", "feishu", "--name", profile], (stream, line) => {
      if (signal.aborted || stream !== "stderr" || !line.trim().startsWith("https://")) return;
      const url = line.trim();
      if (!authorizationUrl(url) || new URL(url).hostname !== "open.feishu.cn") throw new Error("申请地址无效");
      job.phase = "waiting_app"; job.authorizationUrl = url; appUrl = true;
    })));
    signal.throwIfAborted();
    if (!appUrl || result.brand !== "feishu" || typeof result.appId !== "string" || !/^cli_[\w-]{1,128}$/.test(result.appId) || result.appSecret !== "****") throw new Error("应用创建未验证");
    const profiles = JSON.parse(await run(["profile", "list"]));
    if (!Array.isArray(profiles) || profiles.filter(x => x?.name === profile && x.appId === result.appId && x.brand === "feishu").length !== 1) throw new Error("应用身份不匹配");
    let completed = false, userUrl = false;
    delete job.authorizationUrl;
    job.phase = "verifying";
    await run([`--profile=${profile}`, "auth", "login", "--json", "--scope", "docx:document:readonly"], (stream, line) => {
      if (signal.aborted || stream !== "stdout" || !line.trim()) return;
      const event = record(JSON.parse(line));
      if (event.event === "device_authorization") {
        if (!authorizationUrl(event.verification_uri_complete) || new URL(event.verification_uri_complete).hostname !== "accounts.feishu.cn" || userUrl) throw new Error("授权地址无效");
        job.phase = "waiting_authorization"; job.authorizationUrl = event.verification_uri_complete; userUrl = true;
      } else if (event.event === "authorization_complete") {
        if (!userUrl || completed || !Array.isArray(event.granted) || !event.granted.includes("docx:document:readonly") || !Array.isArray(event.missing) || event.missing.length) throw new Error("缺少只读权限");
        completed = true;
      } else throw new Error("飞书授权未完成");
    });
    signal.throwIfAborted();
    if (!completed) throw new Error("未取得授权回执");
    delete job.authorizationUrl;
    job.phase = "verifying";
    const account = await this.verify(profile, signal);
    signal.throwIfAborted();
    if (account.appId !== result.appId) throw new Error("账号身份发生变化");
    this.account = account;
    this.save();
    job.phase = "connected";
  }
  private async verify(profile: string, signal: AbortSignal): Promise<Account> {
    const data = record(JSON.parse(await this.cli.run({ args: [`--profile=${profile}`, "auth", "status", "--json", "--verify"], signal })));
    const user = record(record(data.identities).user);
    if (data.brand !== "feishu" || typeof data.appId !== "string" || !/^cli_[\w-]{1,128}$/.test(data.appId) || user.available !== true || user.verified !== true || typeof user.openId !== "string" || !/^ou_[\w-]{1,128}$/.test(user.openId) || typeof user.scope !== "string" || !user.scope.split(/\s+/).includes("docx:document:readonly")) throw new Error("飞书账号验证失败，请重新连接");
    return { profile, appId: data.appId, openId: user.openId, label: typeof user.userName === "string" ? user.userName.replace(/[\u0000-\u001f]/g, "").slice(0, 120) : "飞书账号", verifiedAt: new Date().toISOString(), scopes: user.scope.split(/\s+/) };
  }
  async cancel(id: string) {
    if (this.job?.id !== id) throw new Error("连接任务已变化，请刷新");
    this.controller?.abort();
    await this.running;
    return this.status();
  }
  async disconnect() {
    this.revision++;
    this.controller?.abort();
    await this.running;
    this.account = undefined; this.job = undefined; this.save();
    this.onDisconnected?.();
    return this.status();
  }
  private async readSession() {
    const account = this.account, revision = this.revision;
    if (!account) throw new Error("请先连接飞书账号");
    const signal = AbortSignal.timeout(60000);
    await this.cli.prepare(signal);
    const verified = await this.verify(account.profile, signal);
    if (verified.appId !== account.appId || verified.openId !== account.openId || revision !== this.revision) throw new Error("飞书账号已变化，请重新连接");
    const authorized = () => {
      signal.throwIfAborted();
      if (revision !== this.revision || this.account !== account) throw new Error("连接已断开，读取结果不再交付");
    };
    authorized();
    return { account, signal, verified, authorized };
  }
  private async tableSession(expectedAccount?: string) {
    const session = await this.readSession();
    if (!FEISHU_TABLE_SCOPES.every(scope => session.verified.scopes?.includes(scope))) throw new Error("飞书账号缺少多维表格只读权限，请先完成表格授权");
    if (expectedAccount) this.assertAccount(expectedAccount);
    return session;
  }
  async tableDirectory(url: string, offset = 0, limit = 50) {
    const base = feishuBaseUrl(url);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("表格目录分页范围无效");
    const session = await this.tableSession(), envelope = record(JSON.parse(await this.cli.run({ args: [`--profile=${session.account.profile}`, "base", "+table-list", "--base-token", base.token, "--offset", String(offset), "--limit", String(limit), "--as", "user", "--json"], signal: session.signal })));
    session.authorized(); const data = record(envelope.data);
    if (envelope.ok !== true || envelope.identity !== "user" || !Array.isArray(data.tables) || data.tables.length > limit || !Number.isSafeInteger(data.total) || data.total < offset + data.tables.length) throw new Error("表格目录分页回执无法验证");
    const tables = data.tables.map((raw: unknown) => { const table = record(raw), id = table.id ?? table.table_id, name = table.name ?? table.table_name; if (!nodeToken(id) || typeof name !== "string" || !name.trim() || name.length > 200) throw new Error("飞书数据表标识无效"); return { id, name }; });
    if (new Set(tables.map(item => item.id)).size !== tables.length || !tables.length && offset < data.total) throw new Error("表格目录没有前进或包含重复项");
    return { base, tables, coverage: { offset, shown: tables.length, total: data.total as number, complete: offset === 0 && tables.length === data.total, nextOffset: offset + tables.length < data.total ? offset + tables.length : null } };
  }
  async tableFields(url: string, tableId: string) {
    const base = feishuBaseUrl(url); if (!nodeToken(tableId)) throw new Error("飞书数据表标识无效");
    const session = await this.tableSession(), fields: Record<string, any>[] = []; let total = Infinity;
    while (fields.length < total) {
      const envelope = record(JSON.parse(await this.cli.run({ args: [`--profile=${session.account.profile}`, "base", "+field-list", "--base-token", base.token, "--table-id", tableId, "--offset", String(fields.length), "--limit", "100", "--as", "user", "--json"], signal: session.signal })));
      session.authorized(); const data = record(envelope.data);
      if (envelope.ok !== true || envelope.identity !== "user" || !Array.isArray(data.fields) || data.fields.length > 100 || !Number.isSafeInteger(data.total) || data.total > 1000 || data.total < fields.length + data.fields.length || fields.length && total !== data.total || !data.fields.length && fields.length < data.total) throw new Error("飞书字段目录分页无效或超过 1000 列");
      total = data.total; fields.push(...data.fields.map(record));
    }
    const parsed = fields.map(field => { const id = field.id ?? field.field_id, name = field.name ?? field.field_name; if (!nodeToken(id) || typeof name !== "string" || !name.trim() || name.length > 200 || typeof field.type !== "string") throw new Error("飞书字段定义无法验证"); return { id, name, type: field.type, multiple: field.multiple === true }; });
    if (new Set(parsed.map(field => field.id)).size !== parsed.length || new Set(parsed.map(field => field.name)).size !== parsed.length || parsed.some(field => field.name === "record_id")) throw new Error("飞书字段名或标识重复，无法保留准确映射");
    return parsed;
  }
  async tableRecords(input: { url: string; tableId: string; fieldIds: string[]; offset: number; limit: number; accountKey: string; recordId?: string }) {
    const base = feishuBaseUrl(input.url);
    if (!nodeToken(input.tableId) || input.fieldIds.length > 99 || !input.fieldIds.length || input.fieldIds.some(id => !nodeToken(id)) || !Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100 || input.recordId !== undefined && !nodeToken(input.recordId)) throw new Error("飞书记录范围无效");
    const session = await this.tableSession(input.accountKey); if (!this.cli.exportRecords) throw new Error("连接组件缺少表格读取能力");
    const args = [`--profile=${session.account.profile}`, "base", input.recordId ? "+record-get" : "+record-list", "--base-token", base.token, "--table-id", input.tableId,
      ...input.fieldIds.flatMap(id => ["--field-id", id]), ...(input.recordId ? ["--record-id", input.recordId] : ["--offset", String(input.offset), "--limit", String(input.limit)]), "--as", "user", "--json"];
    const result = await this.cli.exportRecords({ args, signal: session.signal }); session.authorized(); this.assertAccount(input.accountKey);
    const m = result.manifest, count = result.records.length;
    if (m.manifest_version !== "v1" || m.format !== "ndjson" || m.base_token !== base.token || m.table_id !== input.tableId || count > input.limit || m.records_count !== count || typeof m.has_more !== "boolean" || !Number.isSafeInteger(m.rev) || Number(m.rev) < 0 || !input.recordId && (m.offset ?? 0) !== input.offset || m.has_more && (!count || m.next_offset !== input.offset + count)) throw new Error("飞书记录页范围或版本回执无法验证");
    const scope = record(m.query_context).record_scope;
    if (scope !== (input.recordId ? "selected_record_ids" : "all_records")) throw new Error("飞书记录返回范围与请求不一致");
    return result;
  }
  async browseDirectory(url: string, options: { parent?: boolean; pageToken?: string } = {}) {
    const u = documentUrl(url);
    if (!u.pathname.startsWith("/wiki/")) throw new Error("查看目录需要飞书 wiki 链接");
    if (options.parent !== undefined && typeof options.parent !== "boolean") throw new Error("目录范围无效");
    if (options.pageToken !== undefined && !pageToken(options.pageToken)) throw new Error("目录分页标识无效，请重新打开目录");
    const { account, signal, verified, authorized } = await this.readSession();
    if (!verified.scopes?.some(s => ["wiki:node:read", "wiki:wiki:readonly", "wiki:wiki"].includes(s))) throw new Error("此账号缺少知识库只读权限，请在飞书补充 wiki:node:read 授权后重试");
    const run = async (args: string[]) => {
      authorized();
      const envelope = record(JSON.parse(await this.cli.run({ args: [`--profile=${account.profile}`, "wiki", ...args, "--as", "user", "--json"], signal })));
      authorized();
      if (envelope.ok !== true || envelope.identity !== "user") throw new Error("知识库目录返回无法验证");
      return envelope.data;
    };
    const getNode = async (id: string) => {
      const node = directoryNode(await run(["+node-get", "--node-token", `${u.origin}/wiki/${id}`]));
      if (node.node_token !== id) throw new Error("知识库页面身份不一致");
      return node;
    };
    let node = await getNode(u.pathname.split("/").at(-1)!);
    if (options.parent) {
      if (!node.parent_node_token) throw new Error("此页面没有可查看的上级目录");
      const space = node.space_id;
      node = await getNode(node.parent_node_token);
      if (node.space_id !== space) throw new Error("上级目录不在同一知识空间");
    }
    const data = record(await run(["+node-list", "--space-id", node.space_id, "--parent-node-token", node.node_token, "--page-size", "20", ...(options.pageToken ? ["--page-token", options.pageToken] : [])]));
    if (!Array.isArray(data.nodes) || data.nodes.length > 20 || typeof data.has_more !== "boolean" || (data.has_more && (!pageToken(data.page_token) || data.page_token === options.pageToken))) throw new Error("目录分页返回无法验证，请重新读取");
    const items = data.nodes.map(directoryNode).map(child => {
      if (child.parent_node_token !== node.node_token || child.space_id !== node.space_id) throw new Error("返回文件不属于当前目录");
      return { title: child.title, url: `${u.origin}/wiki/${child.node_token}`, nodeToken: child.node_token, documentId: child.obj_token, type: child.obj_type, hasChildren: child.has_child, readable: child.obj_type === "docx" || child.obj_type === "file" && /\.(md|markdown|txt|csv)$/i.test(child.title) };
    });
    if (new Set(items.map(item => item.nodeToken)).size !== items.length) throw new Error("目录返回重复文件，请重新读取");
    return { directory: { title: node.title, url: `${u.origin}/wiki/${node.node_token}`, parentUrl: node.parent_node_token ? `${u.origin}/wiki/${node.parent_node_token}` : null }, items, readAt: new Date().toISOString(), coverage: { shown: items.length, complete: !options.pageToken && !data.has_more, hasMore: data.has_more, nextPageToken: data.has_more ? data.page_token as string : null, scope: "direct-children" } };
  }
  async readDocument(url: string) {
    const u = documentUrl(url);
    const { account, signal, verified, authorized } = await this.readSession();
    let id = u.pathname.split("/").at(-1)!, title: string | undefined;
    if (u.pathname.startsWith("/wiki/")) {
      if (!verified.scopes?.some(s => ["wiki:node:read", "wiki:wiki:readonly", "wiki:wiki"].includes(s))) throw new Error("此账号缺少知识库只读权限，请在飞书补充 wiki:node:read 授权后重试");
      const envelope = record(JSON.parse(await this.cli.run({ args: [`--profile=${account.profile}`, "wiki", "+node-get", "--as", "user", "--json", "--node-token", u.href], signal })));
      authorized();
      const node = record(envelope.data);
      if (envelope.ok !== true || envelope.identity !== "user" || node.node_token !== id || typeof node.obj_token !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(node.obj_token) || typeof node.title !== "string" || node.title.length > 1000) throw new Error("知识库页面返回无法验证");
      id = node.obj_token; title = node.title;
      if (node.obj_type === "file") {
        const extension = /\.(md|markdown|txt|csv)$/i.exec(title)?.[1].toLowerCase();
        if (!extension) throw new Error("这是上传附件，目前支持 Markdown、TXT、CSV 文本文件；请打开支持的具体文件链接");
        if (!verified.scopes?.includes("drive:file:download")) throw new Error("此账号缺少文件读取权限，请在飞书补充 drive:file:download 授权后重试");
        authorized();
        const file = await this.cli.downloadText({ args: [`--profile=${account.profile}`, "drive", "+download", "--as", "user", "--json", "--file-token", id], signal });
        authorized();
        if (typeof file.content !== "string" || file.content.length > 60000 || file.content.includes("\0") || file.bytes > 256000) throw new Error("文件返回无法验证或超过单次读取范围");
        return { provider: "feishu", documentId: id, title, url: u.href, revision: null, content: file.content, format: extension === "txt" ? "text" : extension === "csv" ? "csv" : "markdown", contentHash: createHash("sha256").update(file.content).digest("hex"), readAt: new Date().toISOString(), coverage: "file" };
      }
      if (node.obj_type !== "docx") throw new Error(node.has_child ? "这是知识库目录，请打开其中具体的文档或 Markdown、TXT、CSV 文件，再复制链接读取" : "此知识库页面类型暂不支持，请使用在线 docx 文档或 Markdown、TXT、CSV 文件");
    }
    authorized();
    const envelope = record(JSON.parse(await this.cli.run({ args: [`--profile=${account.profile}`, "docs", "+fetch", "--as", "user", "--format", "json", "--doc", id, "--doc-format", "markdown", "--detail", "simple"], signal })));
    const doc = record(record(envelope.data).document);
    authorized();
    if (envelope.ok !== true || envelope.identity !== "user" || doc.document_id !== id || !Number.isSafeInteger(doc.revision_id) || doc.revision_id < 1 || typeof doc.content !== "string" || doc.content.length > 60000 || doc.content.includes("\0")) throw new Error("文档返回无法验证或超过单次读取范围");
    return { provider: "feishu", documentId: id, title, url: u.href, revision: doc.revision_id, content: doc.content, format: "markdown", contentHash: undefined, readAt: new Date().toISOString(), coverage: "document" };
  }
  async close() { this.controller?.abort(); await this.running; }
}

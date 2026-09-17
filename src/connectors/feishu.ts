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
interface Account { profile: string; appId: string; openId: string; label: string; verifiedAt: string; scopes?: string[]; }
type Phase = "preparing" | "waiting_app" | "waiting_authorization" | "verifying" | "connected" | "cancelled" | "failed";
interface Job { id: string; phase: Phase; authorizationUrl?: string; error?: string; }
export class FeishuConnector {
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
    return { provider: "feishu", version: FEISHU_VERSION, account: this.account ? { label: this.account.label, verifiedAt: this.account.verifiedAt } : null, job: this.job ? { ...this.job } : null };
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
    return this.status();
  }
  async readDocument(url: string) {
    const u = new URL(url);
    if (u.protocol !== "https:" || !(u.hostname === "feishu.cn" || u.hostname.endsWith(".feishu.cn")) || u.port || u.username || u.password || u.search || u.hash || !/^\/(docx|wiki)\/[A-Za-z0-9_-]{1,128}$/.test(u.pathname)) throw new Error("请填写飞书 docx 文档或 wiki 知识库页面链接（不含查询参数）");
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

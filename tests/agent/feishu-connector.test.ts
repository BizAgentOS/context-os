import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuConnector, authorizationUrl } from "../../src/connectors/feishu.ts";
import type { FeishuCliPort, CliRequest } from "../../src/connectors/feishu-cli.ts";

class FakeCli implements FeishuCliPort {
  profile = "";
  calls: string[][] = [];
  openId = "ou_user";
  missing = false;
  scopes = "docx:document:readonly wiki:node:read drive:file:download";
  node = { node_token: "testWiki", obj_type: "file", obj_token: "testFile", title: "库存快照.md", has_child: false };
  fileContent = "# 库存快照\n门店 A：12 件";
  fetchGate?: Promise<void>;
  prepareGate?: Promise<void>;
  async prepare(signal: AbortSignal) { await this.prepareGate; signal.throwIfAborted(); }
  async run({ args, signal, onLine }: CliRequest) {
    this.calls.push(args);
    signal.throwIfAborted();
    if (args[0] === "--version") return "lark-cli version 1.0.92";
    if (args[0] === "profile") return JSON.stringify(this.profile ? [{ name: this.profile, brand: "feishu", appId: "cli_test" }] : []);
    if (args[0] === "config") {
      this.profile = args.at(-1)!;
      onLine?.("stderr", "https://open.feishu.cn/page/cli?user_code=mock");
      return JSON.stringify({ brand: "feishu", appId: "cli_test", appSecret: "****" });
    }
    if (args.includes("login")) {
      assert.equal(args.at(-1), "docx:document:readonly");
      onLine?.("stdout", JSON.stringify({ event: "device_authorization", verification_uri_complete: "https://accounts.feishu.cn/oauth/v1/device/verify?user_code=mock" }));
      onLine?.("stdout", JSON.stringify({ event: "authorization_complete", granted: this.missing ? [] : ["docx:document:readonly"], missing: this.missing ? ["docx:document:readonly"] : [] }));
      return "";
    }
    if (args.includes("status")) return JSON.stringify({ brand: "feishu", appId: "cli_test", identities: { user: { openId: this.openId, userName: "测试账号", verified: true, available: true, scope: this.scopes } } });
    if (args.includes("+node-get")) return JSON.stringify({ ok: true, identity: "user", data: this.node });
    if (args.includes("+fetch")) {
      await this.fetchGate;
      return JSON.stringify({ ok: true, identity: "user", data: { document: { document_id: "testDoc", revision_id: 3, content: "# 企业资料\n实际正文" } } });
    }
    throw new Error("Unexpected command");
  }
  async downloadText(request: CliRequest) {
    this.calls.push(request.args); await this.fetchGate;
    return { content: this.fileContent, bytes: Buffer.byteLength(this.fileContent) };
  }
}
async function settle(connector: FeishuConnector) {
  for (let i = 0; i < 50; i++) {
    if (["connected", "failed", "cancelled"].includes(connector.status().job?.phase || "")) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error("job did not settle");
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "de-feishu-test-"));
  const cli = new FakeCli();
  const connector = new FeishuConnector(directory, cli);
  return { cli, connector, directory, async close() { await connector.close(); rmSync(directory, { recursive: true, force: true }); } };
}
test("Feishu accepts only its two device authorization surfaces", () => {
  assert.equal(authorizationUrl("https://open.feishu.cn/page/cli?user_code=abc"), true);
  for (const url of ["https://evil.example/?user_code=abc", "https://open.feishu.cn.evil.example/page/cli?user_code=x", "https://open.feishu.cn/page/cli?user_code=x&redirect_uri=https://evil.example", "https://accounts.feishu.cn/oauth/v1/device/verify?user_code=a&user_code=b", "javascript:alert(1)"]) assert.equal(authorizationUrl(url), false);
});
test("Feishu onboarding verifies identity, persists no tokens, and reads only explicit documents", async () => {
  const f = fixture();
  try {
    f.connector.start(); await settle(f.connector);
    assert.equal(f.connector.status().job?.phase, "connected");
    assert.equal(f.connector.status().account?.label, "测试账号");
    const result = await f.connector.readDocument("https://team.feishu.cn/docx/testDoc");
    assert.equal(result.revision, 3);
    assert.equal(result.content, "# 企业资料\n实际正文");
    const recovered = new FeishuConnector(f.directory, f.cli);
    assert.equal(recovered.status().account?.label, "测试账号");
    assert.equal(JSON.stringify(recovered.status()).includes("cli_test"), false);
    await assert.rejects(f.connector.readDocument("https://evil.example/docx/testDoc"));
    await recovered.close();
  } finally { await f.close(); }
});
test("missing readonly scope never marks the account connected", async () => {
  const f = fixture();
  try { f.cli.missing = true; f.connector.start(); await settle(f.connector); assert.equal(f.connector.status().account, null); assert.equal(f.connector.status().job?.phase, "failed"); } finally { await f.close(); }
});
test("cancelling preparation blocks late completion and allows retry", async () => {
  const f = fixture(); let release!: () => void;
  f.cli.prepareGate = new Promise<void>(resolve => release = resolve);
  try {
    const state = f.connector.start(); const cancelling = f.connector.cancel(state.job!.id); release(); await cancelling;
    assert.equal(f.connector.status().job?.phase, "cancelled"); assert.equal(f.connector.status().account, null);
    f.cli.prepareGate = undefined; f.connector.start(); await settle(f.connector); assert.equal(f.connector.status().job?.phase, "connected");
  } finally { release(); await f.close(); }
});
test("account change prevents document dispatch", async () => {
  const f = fixture();
  try { f.connector.start(); await settle(f.connector); f.cli.openId = "ou_other"; await assert.rejects(f.connector.readDocument("https://team.feishu.cn/docx/testDoc"), /账号已变化/); assert.equal(f.cli.calls.some(args => args.includes("+fetch")), false); } finally { await f.close(); }
});
test("disconnect suppresses an in-flight read result", async () => {
  const f = fixture(); let release!: () => void;
  try {
    f.connector.start(); await settle(f.connector);
    f.cli.fetchGate = new Promise<void>(resolve => release = resolve);
    const reading = f.connector.readDocument("https://team.feishu.cn/docx/testDoc");
    const rejected = assert.rejects(reading, /连接已断开/);
    for (let i=0; i<20 && !f.cli.calls.some(args => args.includes("+fetch")); i++) await new Promise(resolve => setImmediate(resolve));
    await f.connector.disconnect(); release(); await rejected;
    assert.equal(f.connector.status().account, null);
  } finally { release?.(); await f.close(); }
});

test("a wiki link to a Markdown attachment reads that file without changing the original source", async () => {
  const f = fixture();
  try {
    f.connector.start(); await settle(f.connector);
    const doc = await f.connector.readDocument("https://team.feishu.cn/wiki/testWiki");
    assert.equal(doc.content, "# 库存快照\n门店 A：12 件");
    assert.equal(doc.title, "库存快照.md");
    assert.equal(doc.documentId, "testFile");
    assert.equal(doc.url, "https://team.feishu.cn/wiki/testWiki");
    assert.equal(doc.format, "markdown");
    assert.equal(doc.revision, null);
    assert.match(doc.contentHash!, /^[a-f0-9]{64}$/);
    assert.ok(f.cli.calls.some(a => a.includes("+download") && a.includes("testFile")));
    assert.equal(f.cli.calls.some(a => a.includes("+fetch") || a.includes("+import")), false);
  } finally { await f.close(); }
});

test("wiki online documents and CSV attachments preserve their real content kinds", async () => {
  const f = fixture();
  try {
    f.connector.start(); await settle(f.connector);
    f.cli.node = { ...f.cli.node, obj_type: "docx", obj_token: "testDoc", title: "在线说明" };
    const online = await f.connector.readDocument("https://team.feishu.cn/wiki/testWiki");
    assert.equal(online.revision, 3);
    assert.equal(online.coverage, "document");
    f.cli.node = { ...f.cli.node, obj_type: "file", obj_token: "testFile", title: "数据.CSV" };
    f.cli.fileContent = "门店,数量\nA,12";
    const csv = await f.connector.readDocument("https://team.feishu.cn/wiki/testWiki");
    assert.equal(csv.format, "csv");
    assert.equal(csv.content, "门店,数量\nA,12");
  } finally { await f.close(); }
});

test("wiki reads reject wrong nodes, unsupported files, oversized content and missing grants", async () => {
  const f = fixture();
  try {
    f.connector.start(); await settle(f.connector);
    f.cli.node.node_token = "otherWiki";
    await assert.rejects(f.connector.readDocument("https://team.feishu.cn/wiki/testWiki"), /无法验证/);
    f.cli.node.node_token = "testWiki"; f.cli.node.title = "archive.zip";
    await assert.rejects(f.connector.readDocument("https://team.feishu.cn/wiki/testWiki"), /目前支持/);
    assert.equal(f.cli.calls.some(a => a.includes("+download")), false);
    f.cli.node.title = "数据.txt"; f.cli.scopes = "docx:document:readonly wiki:node:read";
    await assert.rejects(f.connector.readDocument("https://team.feishu.cn/wiki/testWiki"), /drive:file:download/);
    assert.equal(f.cli.calls.some(a => a.includes("+download")), false);
    f.cli.scopes = "docx:document:readonly";
    const count = f.cli.calls.filter(a => a.includes("+node-get")).length;
    await assert.rejects(f.connector.readDocument("https://team.feishu.cn/wiki/testWiki"), /wiki:node:read/);
    assert.equal(f.cli.calls.filter(a => a.includes("+node-get")).length, count);
    f.cli.scopes += " wiki:node:read drive:file:download"; f.cli.fileContent = "a".repeat(60001);
    await assert.rejects(f.connector.readDocument("https://team.feishu.cn/wiki/testWiki"), /超过单次读取范围/);
    for (const url of ["https://team.feishu.cn.evil.example/wiki/testWiki", "http://team.feishu.cn/wiki/testWiki", "https://team.feishu.cn/wiki/testWiki?redirect=evil"]) await assert.rejects(f.connector.readDocument(url), /请填写飞书/);
  } finally { await f.close(); }
});

test("disconnect blocks an in-flight attachment from reaching the caller", async () => {
  const f = fixture(); let release!: () => void;
  try {
    f.connector.start(); await settle(f.connector);
    f.cli.fetchGate = new Promise<void>(r => release = r);
    const pending = f.connector.readDocument("https://team.feishu.cn/wiki/testWiki");
    const rejected = assert.rejects(pending, /连接已断开/);
    for (let i = 0; i < 50 && !f.cli.calls.some(a => a.includes("+download")); i++) await new Promise(r => setImmediate(r));
    assert.ok(f.cli.calls.some(a => a.includes("+download")));
    await f.connector.disconnect(); release(); await rejected;
  } finally { release?.(); await f.close(); }
});

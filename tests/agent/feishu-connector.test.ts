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
    if (args.includes("status")) return JSON.stringify({ brand: "feishu", appId: "cli_test", identities: { user: { openId: this.openId, userName: "测试账号", verified: true, available: true, scope: "docx:document:readonly" } } });
    if (args.includes("+fetch")) {
      await this.fetchGate;
      return JSON.stringify({ ok: true, identity: "user", data: { document: { document_id: "testDoc", revision_id: 3, content: "# 企业资料\n实际正文" } } });
    }
    throw new Error("Unexpected command");
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

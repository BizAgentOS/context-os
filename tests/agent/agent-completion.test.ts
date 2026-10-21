import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentApplication } from "../../src/agent/app.ts";
import { seedHeatingDemo } from "../../src/demo/heating-seed.ts";
import type { AgentDriver, RunRequest } from "../../src/agent/runtime.ts";

async function runConversation(text: string, run: (request: RunRequest) => Promise<string>) {
  const directory = mkdtempSync(join(tmpdir(), "ade-completion-"));
  const driver: AgentDriver = {
    async run(request) { return { text: await run(request), sessionId: "fixture", runId: "fixture" }; },
    async stop() {}, async close() {},
  };
  const app = new AgentApplication(directory, driver, new Set(), false);
  try {
    seedHeatingDemo(app);
    await app.canvasNavigate({ page: "ontology" });
    await app.canvasMessage({ page: "ontology", text, messageId: "question" });
    await app.idle();
    return app.canvasState().messages.at(-1)!.content;
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
}

test("a run ending after a real query delivers actual results instead of preparatory English", { timeout: 20_000 }, async () => {
  const answer = await runConversation("共有多少条投诉？", async request => {
    const preamble = "I have what I need. Let me record this as a verification.";
    request.onEvent("assistant.delta", { text: preamble });
    await request.onTool("object_execute", {
      operations: [{ op: "query", type: "投诉", as: "complaints" }, { op: "aggregate", input: "$complaints", as: "count" }],
    });
    return preamble;
  });
  assert.doesNotMatch(answer, /I have what I need|Let me/);
  assert.match(answer, /6/);
  assert.match(answer, /结果|统计/);
  assert.match(answer, /读取范围|覆盖/);
});

test("empty and analysis-only replies never claim success; ordinary English answers remain English", async () => {
  const empty = await runConversation("告诉我最新收入", async () => "");
  assert.match(empty, /未.*结论|尚未.*结论/);
  assert.doesNotMatch(empty, /完成|成功/);
  const tagged = await runConversation("共有多少条投诉？", async () => "<think>Internal analysis</think>共有 6 条投诉。");
  assert.equal(tagged, "共有 6 条投诉。");
  const english = await runConversation("How many complaints are in the workspace?", async () => "There are 6 complaints.");
  assert.equal(english, "There are 6 complaints.");
});

test("a valid answer after tools is kept, including limited coverage", async () => {
  const answer = await runConversation("先看一条投诉", async request => {
    request.onEvent("assistant.delta", { text: "我先查看。" });
    await request.onTool("object_execute", { operations: [{ op: "query", type: "投诉", limit: 1 }] });
    request.onEvent("assistant.delta", { text: "已读取 1 条投诉；共有 6 条，这次只查看第一页。" });
    return "已读取 1 条投诉；共有 6 条，这次只查看第一页。";
  });
  assert.equal(answer, "已读取 1 条投诉；共有 6 条，这次只查看第一页。");
});

test("fallback preserves partial coverage and later tool failures", async () => {
  const answer = await runConversation("先统计这一页，再查看缺失的类型", async request => {
    await request.onTool("object_execute", { operations: [{ op: "query", type: "投诉", limit: 1, as: "first" }, { op: "aggregate", input: "$first" }] });
    await assert.rejects(request.onTool("object_execute", { operations: [{ op: "query", type: "不存在" }] }));
    return "";
  });
  assert.match(answer, /统计结果：1/);
  assert.match(answer, /部分/);
  assert.match(answer, /覆盖不完整/);
  assert.doesNotMatch(answer, /```json|"count"|"partial"|"complete"/);
  assert.match(answer, /最后一次操作未完成/);
  assert.doesNotMatch(answer, /全量.*通过|成功/);
});

test("a corrected query delivers its result without reporting the recovered failure as the final outcome", async () => {
  const answer = await runConversation("纠正类型后统计投诉", async request => {
    await assert.rejects(request.onTool("object_execute", {operations:[{op:"query", type:"不存在"}]}));
    await request.onTool("object_execute", {operations:[{op:"query", type:"投诉", as:"complaints"}, {op:"aggregate", input:"$complaints"}]});
    return "";
  });
  assert.match(answer, /统计结果：6/);
  assert.doesNotMatch(answer, /最后一次操作未完成|不存在/);
});

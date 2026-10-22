import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KodaXDriver } from "../../src/agent/runtime.ts";

for (const finalText of ["", "本轮读取到 6 条记录。"])
  test(`KodaX driver returns only post-tool output (${finalText ? "answer" : "tool-ending run"})`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "context-os-runtime-output-"));
    let listener: (event: any) => void = () => {};
    let toolCalls = 0;
    const preamble = "I have what I need. Let me record this as a verification.";
    const runtime = {
      sessions: { async create() { return { id: "session" }; } },
      events: { subscribe(_filter: unknown, handler: typeof listener) { listener = handler; return { close() {} }; } },
      runs: { async start(input: any) {
        listener({ type: "assistant.delta", payload: { text: preamble } });
        listener({ type: "tool.started", payload: { tool: { name: "ontology_verify", id: "tool" } } });
        await input.options.extensionRuntime.executeCapability("mcp", "ontology_verify", {});
        listener({ type: "tool.finished", payload: { result: { name: "ontology_verify", id: "tool", content: "{}" } } });
        if (finalText) listener({ type: "assistant.delta", payload: { text: finalText } });
        return { runId: "run", result: Promise.resolve({ phase: "completed", result: { lastText: finalText || preamble } }) };
      }, async abort() {} }, async close() {},
    };
    const driver = new KodaXDriver(directory, { provider: "deepseek", model: "fixture" });
    // Substitute the SDK service at its public boundary; no model or network is involved.
    driver.initialize = async () => runtime as any;
    try {
      const outcome = await driver.run({ title: "test", input: "统计", system: "fixture",
        tools: [{ name: "ontology_verify", description: "fixture", inputSchema: {}, mutates: true }],
        async onTool() { toolCalls++; return { count: 6 }; }, onSession() {}, onEvent() {} });
      assert.equal(toolCalls, 1);
      assert.equal(outcome.text, finalText);
      assert.doesNotMatch(outcome.text, /Let me/);
    } finally { await driver.close(); rmSync(directory, { recursive: true, force: true }); }
  });

test("timeout is reported to the host before abort and preserves the provider's usage receipt", async t => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-runtime-timeout-"));
  const events: string[] = [];
  let settle!: (value: unknown) => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const result = new Promise(resolve => { settle = resolve; });
  const runtime = {
    sessions: { async create() { return { id: "session" }; } },
    events: { subscribe() { return { close() {} }; } },
    runs: { async start() { return { runId: "run", result }; }, async abort() { events.push("abort"); settle({ phase: "cancelled", result: { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } }); } },
    async close() {},
  };
  const driver = new KodaXDriver(directory, { provider: "deepseek", model: "fixture" });
  driver.initialize = async () => runtime as any;
  driver.stop = async () => runtime.runs.abort();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const running = driver.run({ title: "超时", input: "核对", system: "fixture", tools: [], async onTool() { return null; }, onSession() {}, onEvent(kind) { events.push(kind); if (kind === "run.started") started(); } });
    await ready;
    t.mock.timers.tick(240_000);
    const outcome = await running;
    assert.equal(outcome.status, "timed_out");
    assert.ok(events.indexOf("run.timed_out") >= 0 && events.indexOf("run.timed_out") < events.indexOf("abort"), "the host can revoke writes before SDK abort");
    assert.deepEqual(outcome.usage, { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
  } finally { t.mock.timers.reset(); await driver.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("the SDK capability boundary refuses undeclared external tools and calls host authorization again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-runtime-mode-")); let calls = 0, authorizations = 0;
  const runtime = { sessions: { async create() { return { id: "s" }; } }, events: { subscribe() { return { close() {} }; } },
    runs: { async start(input: any) {
      const extension = input.options.extensionRuntime;
      await assert.rejects(extension.executeCapability("mcp", "mcp:foreign:write", {}), /不允许/);
      await assert.rejects(extension.executeCapability("mcp", "allowed_read", {}), /已停止/);
      return { runId: "r", result: Promise.resolve({ phase: "completed", result: { lastText: "" } }) };
    } }, async close() {} };
  const driver = new KodaXDriver(directory, { provider: "deepseek", model: "fixture" }); driver.initialize = async () => runtime as any;
  try {
    await driver.run({ title: "mode", system: "fixture", input: "read", tools: [{ name: "allowed_read", description: "fixture", mutates: false, inputSchema: {} }],
      authorizeTool() { authorizations++; throw new Error("已停止"); }, async onTool() { calls++; return null; }, onSession() {}, onEvent() {} });
    assert.equal(calls, 0); assert.equal(authorizations, 1);
  } finally { await driver.close(); rmSync(directory, { recursive: true, force: true }); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KodaXDriver } from "../../src/agent/runtime.ts";

for (const finalText of ["", "本轮读取到 6 条记录。"])
  test(`KodaX driver returns only post-tool output (${finalText ? "answer" : "tool-ending run"})`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "ade-runtime-output-"));
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { RunPresentation, projectAgentRuns } from "../../src/agent/run-presentation.ts";
import { requestDecision } from "../../src/agent/decision-requests.ts";
import { jsonData } from "../../src/live/sources.ts";

test("a stopped run keeps saved changes and completed steps across restart without inventing usage", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-run-cards-"));
  let memory = new MemoryStore(directory);
  try {
    const task = memory.createTask("核对任务负责人"), context = memory.beginExecution(task.id);
    const run = new RunPresentation(memory, context, { goal: "核对任务负责人" });
    run.event("assistant.delta", { text: "我将先核对来源，再提出关系。" });
    run.event("operation.started", { id: "query", name: "live_query" });
    run.tool("live_query", { type: "任务" }, { items: [{ 任务: "版本交付", 负责人: "王晨" }], coverage: { complete: true, total: 1 } });
    run.event("operation.completed", { id: "query", name: "live_query" });
    const change = memory.putArtifact({ kind: "ontology_change", title: "任务负责人关系", status: "proposed", content: { type: "relation", origin: "agent", subject: {}, evidence: "已读取来源" } });
    run.tool("changes_propose", {}, jsonData({ change }));
    run.event("operation.started", { id: "check", name: "changes_verify" });
    run.finish({ status: "stopped" });
    memory.endExecution(context);
    memory.close(); memory = new MemoryStore(directory);
    const [card] = projectAgentRuns(memory, task.id);
    assert.equal(card.status, "stopped");
    assert.equal(card.steps.find(step => step.kind === "query")?.status, "completed");
    assert.equal(card.steps.find(step => step.kind === "check")?.status, "stopped");
    assert.equal(card.changeList[0].title, "任务负责人关系");
    assert.deepEqual(card.changeList[0].ref, { id: change.id, version: change.version });
    assert.equal(card.changeList[0].status, "proposed", "saving a proposal never reports adoption");
    assert.equal(card.usage.tokens, null);
    assert.equal(card.usage.cost, null);
    assert.equal(card.usage.status, "unknown");
    assert.match(card.intermediate.join(""), /核对来源/);
    assert.deepEqual(card.tables[0].rows, [{ 任务: "版本交付", 负责人: "王晨" }]);
    assert.equal(card.continuation.goal, "核对任务负责人");
    assert.ok(card.continuation.remaining.some(item => /复验/.test(item)));
  } finally { memory.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a timeout keeps a committed receipt that returns late and records actual provider usage", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-run-late-receipt-")), memory = new MemoryStore(directory);
  try {
    const task = memory.createTask("准备关系提议"), context = memory.beginExecution(task.id);
    const run = new RunPresentation(memory, context, { goal: task.goal });
    run.event("operation.started", { id: "save", name: "changes_propose" });
    const change = memory.putArtifact({ kind: "ontology_change", title: "已保存的关系", status: "proposed", content: { type: "relation" } });
    run.event("run.timed_out", { reason: "运行超过240秒" });
    run.tool("changes_propose", {}, jsonData({ change }));
    run.finish({ status: "completed", usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } });
    const [card] = projectAgentRuns(memory, task.id);
    assert.equal(card.status, "timed_out", "late completion cannot turn timeout into success");
    assert.equal(card.changeList[0]?.title, "已保存的关系");
    assert.equal(card.usage.tokens, 25);
    assert.equal(card.usage.cost, null, "token telemetry alone cannot manufacture a price");
  } finally { memory.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a decision card binds an existing change version and never adopts it through a question", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-run-decision-")), memory = new MemoryStore(directory);
  try {
    const task = memory.createTask("决定任务负责人关系"), context = memory.beginExecution(task.id);
    const run = new RunPresentation(memory, context, { goal: task.goal });
    const change = memory.putArtifact({ kind: "ontology_change", title: "任务负责人", status: "verified", content: { type: "relation", verification: { result: "review", metrics: { matched: 9, total: 10 } } } });
    assert.throws(() => requestDecision(memory, context, { question: "采用这个关系吗？", reason: "需核对未匹配记录", refs: [{ id: change.id, version: change.version + 1 }] }), /版本/);
    const waiting = requestDecision(memory, context, { question: "采用这个关系吗？", reason: "需核对未匹配记录", refs: [{ id: change.id, version: change.version }], options: [{ label: "先检查负责人来源", description: "核对未匹配的任务" }] });
    run.finish({ status: "waiting", pending: waiting.pending });
    const [card] = projectAgentRuns(memory, task.id);
    assert.equal(card.decisions[0].question, "采用这个关系吗？");
    assert.deepEqual(card.decisions[0].refs, [{ id: change.id, version: change.version }]);
    assert.equal(memory.getArtifact(change.id).status, "verified", "requesting a decision does not execute adoption");
    assert.equal(memory.getTask(task.id).status, "waiting");
  } finally { memory.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("restart projects unfinished execution as stopped and preserves its saved receipt", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-run-restart-")); let memory = new MemoryStore(directory);
  try {
    const task = memory.createTask("复验关系"), context = memory.beginExecution(task.id);
    const run = new RunPresentation(memory, context, { goal: task.goal });
    run.event("operation.started", { id: "verify", name: "changes_verify" });
    memory.close(); memory = new MemoryStore(directory);
    const [card] = projectAgentRuns(memory, task.id);
    assert.equal(card.status, "stopped");
    assert.equal(card.steps[0].status, "stopped");
    assert.match(card.systemEvents.at(-1)?.message || "", /重启|中断/);
    assert.ok(card.continuation.remaining.length);
  } finally { memory.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("saved decision cards follow a handled change and do not offer a second decision", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-run-decided-")), memory = new MemoryStore(directory);
  try {
    const task = memory.createTask("决定关系"), context = memory.beginExecution(task.id);
    const run = new RunPresentation(memory, context, { goal: task.goal });
    const change = memory.putArtifact({ kind: "ontology_change", title: "负责人", status: "verified", content: { type: "relation" } });
    const waiting = requestDecision(memory, context, { question: "是否采用？", reason: "需要人工核对", refs: [{ id: change.id, version: change.version }] });
    run.finish({ status: "waiting", pending: waiting.pending });
    memory.putArtifact({ ...change, expectedVersion: change.version, status: "adopted" });
    const [card] = projectAgentRuns(memory, task.id);
    assert.equal(card.decisions[0].status, "resolved");
    assert.equal((card.decisions[0].refs as {version:number}[])[0].version, change.version + 1);
  } finally { memory.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("concurrent calls to the same tool retain exactly their own step receipts", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-run-concurrent-")), memory = new MemoryStore(directory);
  try {
    const task = memory.createTask("同时查看两类对象"), context = memory.beginExecution(task.id), run = new RunPresentation(memory, context, { goal: task.goal });
    run.event("operation.started", { id: "q1", name: "live_query" }); run.event("operation.started", { id: "q2", name: "live_query" });
    run.tool("live_query", {}, { items: [{ name: "first" }] }, "q1");
    run.event("operation.completed", { id: "q1", name: "live_query" });
    assert.equal(projectAgentRuns(memory, task.id)[0].steps.find(step => step.id === "q2")?.status, "running");
    run.tool("live_query", {}, { items: [{ name: "second" }] }, "q2");
    run.event("operation.completed", { id: "q2", name: "live_query" });
    assert.equal(projectAgentRuns(memory, task.id)[0].steps.length, 2);
  } finally { memory.close(); rmSync(directory, { recursive: true, force: true }); }
});

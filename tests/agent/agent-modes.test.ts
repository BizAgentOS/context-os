import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { freezeAgentTurn, modeTools, assertAgentTool } from "../../src/agent/agent-modes.ts";
import { RunPresentation } from "../../src/agent/run-presentation.ts";
import { agentModePrompt } from "../../src/agent/agent-prompts.ts";

test("a frozen mode denies guessed old tools and stays fixed when the caller changes its input", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-mode-")), memory = new MemoryStore(directory);
  try {
    const session = memory.createSession(), context = memory.beginExecution(session.taskId);
    const input = { mode: "qa" as "build" | "qa" }, turn = freezeAgentTurn(memory, context, input);
    input.mode = "build";
    assert.equal(turn.mode, "qa");
    assert.throws(() => assertAgentTool(memory, context, turn, "change_propose"), /模式/);
    assert.throws(() => assertAgentTool(memory, context, turn, "snapshot_query"), /模式/);
    assert.throws(() => assertAgentTool(memory, context, turn, "foundation_propose"), /模式/);
    const build = freezeAgentTurn(memory, context, { mode: "build" });
    assertAgentTool(memory, context, build, "change_propose");
    for (const name of ["change_adopt", "change_reject", "profile_update", "page_complete", "task_ask"]) assert.throws(() => assertAgentTool(memory, context, build, name), /模式/);
    assert.deepEqual(modeTools("build", ["change_propose", "foundation_propose", "change_adopt"].map(name => ({ name, description: name, mutates: true, inputSchema: {} }))).map(tool => tool.name), ["change_propose"]);
    memory.pauseTask(context.taskId);
    assert.throws(() => assertAgentTool(memory, context, build, "pending_list"), /停止|运行|状态|任务/);
  } finally { memory.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("interactive prompts and skills describe the unified tools, without retired mutation paths", () => {
  const prompt = agentModePrompt("build");
  const names = [...prompt.matchAll(/`([a-z]+_[a-z_]+)`/g)].map(match => match[1]);
  assert.deepEqual(modeTools("build", names.map(name => ({ name, description: "", mutates: false, inputSchema: {} }))).map(tool => tool.name).sort(), [...new Set(names)].sort());
  for (const skill of ["ontology-modeling", "api-ontology-mapping", "company-foundation-ontology"]) {
    const text = readFileSync(new URL(`../../config/skills/${skill}/SKILL.md`, import.meta.url), "utf8");
    assert.match(text, /change_propose/);
    assert.doesNotMatch(text, /foundation_propose|live_propose|ontology_propose|ontology_snapshot_check|task_ask|page_complete|profile_update/);
  }
});

test("continuation freezes the real saved run and rejects another session's receipt", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-mode-continue-")), memory = new MemoryStore(directory);
  try {
    const session = memory.createSession(), context = memory.beginExecution(session.taskId);
    new RunPresentation(memory, context, { goal: "核对真实业务目标" }).finish({ status: "stopped" });
    const artifact = memory.listArtifacts("agent_run")[0]; memory.endExecution(context);
    const next = memory.beginExecution(session.taskId);
    const turn = freezeAgentTurn(memory, next, { mode: "build", continuationRunId: artifact.id });
    assert.equal(turn.continuation?.goal, "核对真实业务目标");
    assert.equal(turn.continuation?.runRef.id, artifact.id);
    const other = memory.createSession(), foreign = memory.beginExecution(other.taskId);
    assert.throws(() => freezeAgentTurn(memory, foreign, { mode: "build", continuationRunId: artifact.id }), /会话/);
    assert.throws(() => freezeAgentTurn(memory, next, { mode: "build", continuationRunId: artifact.id, savedChanges: ["invented"] }), /Unrecognized|不支持|未知/);
  } finally { memory.close(); rmSync(directory, { recursive: true, force: true }); }
});

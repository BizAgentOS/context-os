import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentApplication } from "../../src/agent/app.ts";
import { AgentChangeTools } from "../../src/agent/agent-change-tools.ts";
import { freezeAgentTurn } from "../../src/agent/agent-modes.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";
import type { Artifact, Data } from "../../src/agent/contracts.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { requestDecision } from "../../src/agent/decision-requests.ts";
import { RunPresentation, projectAgentRuns } from "../../src/agent/run-presentation.ts";
import { z } from "zod";
import { identityWorkspace } from "./identity-fixture.ts";

test("unified Agent proposals enforce provenance, evidence and withdrawal ownership", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-agent-changes-")), app = new AgentApplication(directory, undefined, new Set(), false);
  try {
    seedFoundation(app.memory, app.foundation, { enterprise: "测试企业", concepts: [{ id: "task", name: "任务", description: "任务记录" }] });
    const session = app.memory.createSession(), context = app.memory.beginExecution(session.taskId);
    const turn = freezeAgentTurn(app.memory, context, { mode: "build" }), service = new AgentChangeTools(app.memory, app.changes, app.pendingCenter, app.live);
    const input = { operationId: "name", type: "naming", baseline: app.changes.currentBaseline(), subject: { target: "concept", id: "task", name: "工作任务" }, evidence: "用户明确要求使用工作任务名称" };
    await assert.rejects(service.execute("change_propose", { ...input, origin: "human" }, context, turn));
    await assert.rejects(service.execute("change_propose", { ...input, evidence: "" }, context, turn));
    const result = await service.execute("change_propose", input, context, turn) as {change:Artifact};
    assert.equal(result.change.content.origin, "agent");
    assert.equal(result.change.status, "adopted", "wording can apply through the host's explicit wording-only path");
    assert.equal((app.foundation.read().adopted!.content.concepts as any[])[0].name, "工作任务");
    await assert.rejects(service.execute("change_adopt", { id: result.change.id }, context, turn), /模式/);
    await assert.rejects(service.execute("change_reject", { id: result.change.id }, context, turn), /模式/);
    const foreign = await app.changes.propose({ operationId: "human-description", origin: "human", type: "description", baseline: app.changes.currentBaseline(), subject: { target: "concept", id: "task", description: "人工补充的任务说明" } });
    await assert.rejects(service.execute("change_withdraw", { operationId: "withdraw-foreign", id: foreign.change.id, version: foreign.change.version, reason: "不需要" }, context, turn), /自己|本会话/);
    assert.equal(app.changes.read(foreign.change.id).status, "proposed");
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("stopping during verification revokes the late write while preserving the proposal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-agent-stop-check-")), app = new AgentApplication(directory, undefined, new Set(), false);
  try {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    app.changes.registerHandler("data_issue", { subject: z.object({ scope: z.string() }), prepare: async () => { entered(); await gate; return { verification: { result: "passed", metrics: { rows: 1 }, notes: [], inputs: {} }, apply: () => ({}) }; } });
    const session = app.memory.createSession(), context = app.memory.beginExecution(session.taskId), turn = freezeAgentTurn(app.memory, context, { mode: "build" });
    const service = new AgentChangeTools(app.memory, app.changes, app.pendingCenter, app.live);
    const proposed = await service.execute("change_propose", { operationId: "issue", type: "data_issue", subject: { scope: "任务来源" }, baseline: app.changes.currentBaseline(), evidence: "来源有一行需核对" }, context, turn) as {change:Artifact};
    const verifying = service.execute("change_verify", { operationId: "check", id: proposed.change.id, version: proposed.change.version }, context, turn);
    await started; app.memory.pauseTask(context.taskId); release();
    await assert.rejects(verifying, /停止|任务|运行/);
    assert.equal(app.changes.read(proposed.change.id).version, proposed.change.version);
    assert.equal(app.changes.read(proposed.change.id).status, "proposed");
    app.memory.endExecution(context);
    const resumed = app.memory.beginExecution(session.taskId), resumedTurn = freezeAgentTurn(app.memory, resumed, { mode: "build" });
    const withdrawn = await service.execute("change_withdraw", { operationId: "withdraw-own", id: proposed.change.id, version: proposed.change.version, reason: "先核对来源" }, resumed, resumedTurn) as Artifact;
    assert.equal(withdrawn.content.disposition, "withdrawn");
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("provider-owned pending items bind a decision without pretending they are ontology changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-agent-provider-")), app = new AgentApplication(directory, undefined, new Set(), false);
  try {
    let active = true;
    const item = () => ({ id: "provider-choice", version: active ? 1 : 2, category: "adjudication" as const, title: "名称冲突", origin: "agent", source: "文档", sources: [], objects: [], evidence: "两个文档名称不同", verification: null, impact: "选择要保留的名称", status: active ? "awaiting_choice" : "resolved", createdAt: new Date().toISOString(), stale: false, actions: { verify: false, adopt: false, reject: false, analyze: active } });
    app.pendingCenter.register({ list: () => active ? [item()] : [], read: id => id === "provider-choice" ? item() : null });
    const session = app.memory.createSession(), context = app.memory.beginExecution(session.taskId);
    const turn = freezeAgentTurn(app.memory, context, { mode: "build", pendingRef: { id: "provider-choice", version: 1 } }, app.pendingCenter);
    assert.equal(turn.pendingRef?.id, "provider-choice");
    const run = new RunPresentation(app.memory, context, { goal: "核对名称" });
    const waiting = requestDecision(app.memory, context, { question: "保留哪个名称？", reason: "资料冲突", refs: [{ id: "provider-choice", version: 1 }] }, app.pendingCenter);
    run.finish({ status: "waiting", pending: waiting.pending });
    assert.equal(projectAgentRuns(app.memory, context.taskId, app.pendingCenter)[0].decisions[0].status, "pending");
    active = false;
    assert.equal(projectAgentRuns(app.memory, context.taskId, app.pendingCenter)[0].decisions[0].status, "resolved");
    app.memory.endExecution(context);
    const next = app.memory.beginExecution(session.taskId);
    assert.throws(() => freezeAgentTurn(app.memory, next, { mode: "build", pendingRef: { id: "provider-choice", version: 1 } }, app.pendingCenter), /版本|状态/);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a relationship follows propose, verify, readonly query preview and a real decision card", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-agent-preview-")), app = new AgentApplication(directory, undefined, new Set(), false);
  try {
    const workspace = new Workspace(app.memory);
    workspace.upload("projects.csv", "project_id,title\nP1,客户项目\nP2,内部项目\n");
    workspace.upload("tasks.csv", "task_id,project_id,title\nT1,P1,交付\nT2,P2,测试\n");
    await app.snapshots.sync({ operationId: "sync" });
    const candidate = await app.programBuilds.build({ operationId: "build", autoAdopt: false });
    const latest = app.programBuilds.overview().candidate!, checked = await app.programBuilds.check({ id: latest.id, version: latest.version });
    await app.programBuilds.adopt({ id: checked.id, version: checked.version, operationId: "entities", selection: { entities: (checked.content.diff as Data).addedConcepts, relations: [], merges: [] } });
    const model = app.live.overview().models.find(model => model.status === "adopted")!;
    const datasets = app.snapshots.datasets(), dataset = (name: string) => datasets.find(item => String(item.content.name).includes(name))!;
    const from = dataset("tasks"), to = dataset("projects");
    const taskType = (app.live.projectModel(model).content.types as any[]).find(type => app.snapshots.bindingDataset(type.sourceId, type.capability)?.id === from.id);
    const session = app.memory.createSession(), context = app.memory.beginExecution(session.taskId), turn = freezeAgentTurn(app.memory, context, { mode: "build" });
    const service = new AgentChangeTools(app.memory, app.changes, app.pendingCenter, app.live);
    const proposed = await service.execute("change_propose", { operationId: "relation", type: "relation", baseline: app.changes.currentBaseline(), subject: { from: { datasetId: from.id, column: "project_id" }, to: { datasetId: to.id, column: "project_id" } }, evidence: "任务的项目编号引用项目目录，两个项目均唯一" }, context, turn) as {change:Artifact};
    assert.equal(proposed.change.status, "proposed");
    const verified = await service.execute("change_verify", { id: proposed.change.id, version: proposed.change.version, operationId: "verify" }, context, turn) as Artifact;
    assert.equal(verified.status, "verified");
    const base = app.changes.currentBaseline();
    const preview = await service.execute("change_preview_query", { id: verified.id, version: verified.version, query: { type: taskType.name, id: "T1", relation: "$proposed" } }, context, turn) as any;
    assert.equal(preview.before.status, "unavailable");
    assert.equal(preview.after.status, "available", JSON.stringify(preview));
    assert.equal(preview.after.result.items[0].$id, "P1");
    assert.equal(preview.adopted, false);
    assert.deepEqual(app.changes.currentBaseline(), base, "preview does not change the working ontology");
    assert.equal(app.changes.read(verified.id).status, "verified");
    requestDecision(app.memory, context, { question: "采用任务所属项目关系吗？", reason: "两条任务均匹配唯一项目，预览已核对", refs: [{ id: verified.id, version: verified.version }] }, app.pendingCenter);
    assert.equal(app.memory.getTask(context.taskId).status, "waiting");
    assert.equal(app.changes.read(verified.id).status, "verified");
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("query preview compares the same snapshots when an unrelated source synchronizes between reads", { timeout: 20000 }, async t => {
  const workspace = await identityWorkspace(), app = workspace.service.app;
  try {
    const session = app.memory.createSession(), context = app.memory.beginExecution(session.taskId), turn = freezeAgentTurn(app.memory, context, { mode: "build" });
    const tools = new AgentChangeTools(app.memory, app.changes, app.pendingCenter, app.live);
    const from = app.snapshots.bindingDataset(workspace.sources.accounts.id, "accounts")!, to = app.snapshots.bindingDataset(workspace.sources.people.id, "people")!;
    const proposed = await tools.execute("change_propose", { operationId: "account-person", type: "relation", baseline: app.changes.currentBaseline(), subject: { from: { datasetId: from.id, column: "email" }, to: { datasetId: to.id, column: "email" } }, evidence: "账号邮箱可引用人员邮箱" }, context, turn) as { change: Artifact };
    const verified = await tools.execute("change_verify", { id: proposed.change.id, version: proposed.change.version, operationId: "verify" }, context, turn) as Artifact;
    const original = app.live.query.bind(app.live); let first = true;
    t.mock.method(app.live, "query", async (...args: Parameters<typeof app.live.query>) => {
      const result = await original(...args);
      if (first) { first = false; workspace.rows.staff[0].phone = "changed-between-queries"; await app.snapshots.sync({ operationId: "interleaved-sync" }); }
      return result;
    });
    const result = await tools.execute("change_preview_query", { id: verified.id, version: verified.version, query: { type: "外部人员", id: "H1" } }, context, turn) as any;
    assert.equal(result.before.result.items[0].电话, "10001");
    assert.equal(result.after.result.items[0].电话, "10001", "both sides replay the same working snapshot, including unrelated query sources");
    assert.equal(result.changed, false);
    assert.equal(result.before.result.readMode, "active_snapshot");
    assert.equal(result.adopted, false);
  } finally { await workspace.close(); }
});

test("local property previews preserve other decisions and never adopt the hypothetical value", { timeout: 20000 }, async () => {
  const w = await identityWorkspace(), app = w.service.app;
  try {
    const propertyId = app.live.readLayered(w.model.id).semantic.properties.find(item => item.entityTypeId === "staff" && item.name === "电话")!.id;
    await w.adopt("local_correction", { kind: "property", entityTypeId: "staff", objectId: "H2", propertyId, value: "10008", reason: "已核对乙", evidence: "乙提供号码" });
    const session = app.memory.createSession(), context = app.memory.beginExecution(session.taskId), turn = freezeAgentTurn(app.memory, context, { mode: "build" });
    const service = new AgentChangeTools(app.memory, app.changes, app.pendingCenter, app.live);
    const proposed = await service.execute("change_propose", { operationId: "preview-phone", type: "local_correction", baseline: app.changes.currentBaseline(),
      subject: { kind: "property", entityTypeId: "staff", objectId: "H1", propertyId, value: "10009", reason: "甲核对号码", evidence: "甲提供现用号码" }, evidence: "只纠正甲的号码" }, context, turn) as { change: Artifact };
    const checked = await service.execute("change_verify", { id: proposed.change.id, version: proposed.change.version, operationId: "verify-phone" }, context, turn) as Artifact;
    const records = app.memory.listArtifacts("property_correction");
    const result = await service.execute("change_preview_query", { id: checked.id, version: checked.version, query: { type: "外部人员" } }, context, turn) as any;
    assert.deepEqual(result.before.result.items.map((item: any) => item.电话), ["10001", "10008"]);
    assert.deepEqual(result.after.result.items.map((item: any) => item.电话), ["10009", "10008"]);
    assert.equal(result.changed, true);
    assert.deepEqual(app.memory.listArtifacts("property_correction"), records);
    assert.equal((await app.live.query({ modelId: w.model.id, type: "外部人员", id: "H1" })).items[0].电话, "10001");
    assert.equal(app.changes.read(checked.id).status, "verified");
  } finally { await w.close(); }
});

test("local relation previews override one origin while retaining other adopted corrections", { timeout: 60000 }, async () => {
  const w = await identityWorkspace(), app = w.service.app;
  try {
    const dataset = (sourceId: string, capability: string) => app.snapshots.bindingDataset(sourceId, capability)!.id;
    await w.adopt("relation", { from: { datasetId: dataset(w.sources.staff.id, "staff"), column: "email" }, to: { datasetId: dataset(w.sources.people.id, "people"), column: "email" } });
    const relation = app.live.readLayered(w.model.id).semantic.relationTypes.find(item => item.from === "staff" && item.to === "person")!;
    await w.adopt("local_correction", { kind: "relation", entityTypeId: "staff", objectId: "H2", relationTypeId: relation.id, targetIds: ["P1"], reason: "核对乙的关联", evidence: "负责人确认" });
    const session = app.memory.createSession(), context = app.memory.beginExecution(session.taskId), turn = freezeAgentTurn(app.memory, context, { mode: "build" });
    const service = new AgentChangeTools(app.memory, app.changes, app.pendingCenter, app.live);
    const proposed = await service.execute("change_propose", { operationId: "preview-relation", type: "local_correction", baseline: app.changes.currentBaseline(),
      subject: { kind: "relation", entityTypeId: "staff", objectId: "H1", relationTypeId: relation.id, targetIds: [], reason: "甲关联错误", evidence: "核对原始登记" }, evidence: "只移除甲的关联" }, context, turn) as { change: Artifact };
    const checked = await service.execute("change_verify", { id: proposed.change.id, version: proposed.change.version, operationId: "verify-local-relation" }, context, turn) as Artifact;
    const records = app.memory.listArtifacts("relation_correction");
    const preview = (id: string) => service.execute("change_preview_query", { id: checked.id, version: checked.version, query: { type: "外部人员", id, relation: relation.name } }, context, turn) as Promise<any>;
    const own = await preview("H1"), other = await preview("H2");
    assert.deepEqual(own.before.result.items.map((item: any) => item.$id), ["P1"]);
    assert.deepEqual(own.after.result.items, []);
    assert.deepEqual(other.after.result.items.map((item: any) => item.$id), ["P1"]);
    assert.equal(other.changed, false);
    assert.deepEqual(app.memory.listArtifacts("relation_correction"), records);
    assert.deepEqual((await app.live.query({ modelId: w.model.id, type: "外部人员", id: "H1", relation: relation.name })).items.map(item => item.$id), ["P1"]);
  } finally { await w.close(); }
});

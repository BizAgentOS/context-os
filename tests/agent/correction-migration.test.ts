import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/agent/server.ts";
import { RelationCorrections } from "../../src/live/relation-corrections.ts";
import { createHeatingSources, connectHeatingSources, heatingDefinition } from "../../src/live/heating-sources.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";

const ref = (a: { id: string; version: number }) => ({ id: a.id, version: a.version });

async function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "context-os-correction-migration-"));
  const upstream = await createHeatingSources();
  const service = await createServer({ directory, automaticApi: false });
  const app = service.app;
  const foundation = seedFoundation(app.memory, app.foundation, { enterprise: "澄川热力",
    concepts: [{ id: "complaint", name: "投诉", description: "客户投诉及处理状态" }, { id: "callback", name: "回访", description: "客户对处理后的反馈" }],
    relations: [{ id: "rel_callback", name: "回访记录", from: "complaint", to: "callback", description: "投诉对应的回访" }] });
  const connections = await connectHeatingSources(app.live.sources, upstream);
  await app.snapshots.sync({ operationId: "initial" });
  const definition = heatingDefinition(connections.api.id, connections.mcp.id);
  const proposal = { ...definition, foundationRef: ref(foundation), baseModelRef: null,
    types: definition.types.map(type => ({ ...type, conceptId: type.name === "投诉" ? "complaint" : "callback" })),
    relations: definition.relations.map(relation => ({ ...relation, relationId: "rel_callback" })) };
  const candidate = await app.live.propose(proposal);
  const model = await app.live.adopt(candidate.id, candidate.version);
  const corrections = new RelationCorrections(app.memory, app.live);
  const target = { modelId: model.id, modelVersion: model.version, type: "投诉", objectId: "TS002", relation: "回访记录" };
  const proposed = await corrections.execute("propose", { operationId: "propose", target, targetIds: [], reason: "该回访不属于此投诉", evidence: "人工核对客户身份" });
  const checked = await corrections.execute("check", { operationId: "check", ...ref(proposed) });
  const correction = await corrections.execute("adopt", { operationId: "adopt", ...ref(checked) });
  return { app, upstream, connections, proposal, model, correction,
    async close() { await service.close(); await upstream.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("adopting an unrelated relation preserves an existing local correction in the new working model", async () => {
  const w = await workspace();
  try {
    const from = w.app.snapshots.bindingDataset(w.connections.mcp.id, "list_callbacks")!;
    const to = w.app.snapshots.bindingDataset(w.connections.api.id, "complaints")!;
    const { change } = await w.app.changes.propose({ operationId: "new-relation", origin: "human", type: "relation", baseline: w.app.changes.currentBaseline(),
      subject: { from: { datasetId: from.id, column: "complaintId" }, to: { datasetId: to.id, column: "id" } } });
    const checked = await w.app.changes.verify({ operationId: "check-relation", ...ref(change) });
    assert.equal(checked.status, "verified", JSON.stringify(checked.content.verification));
    const adopted = await w.app.changes.adopt({ operationId: "adopt-relation", ...ref(checked) });
    const model = (adopted.content.effect as any).modelRef;
    const result = await w.app.live.query({ modelId: model.id, modelVersion: model.version, type: "投诉", id: "TS002", relation: "回访记录" });
    assert.deepEqual(result.items, [], "adding a separate relation must not undo the human decision");
    const current = w.app.workspaceVersions.latest()!.content.composition as any;
    assert.equal(current.corrections.length, 1, "the new workspace still contains the correction");
    assert.notEqual(current.corrections[0], `${w.correction.id}@${w.correction.version}`, "the new mapping has its own correction record");
    assert.deepEqual(w.app.memory.getArtifact(w.correction.id, w.correction.version), w.correction, "the original decision stays immutable for its published consumers");
    const original = await w.app.live.query({ modelId: w.model.id, modelVersion: w.model.version, type: "投诉", id: "TS002", relation: "回访记录" });
    assert.deepEqual(original.items, [], "existing consumers of the original model still read its correction");
  } finally { await w.close(); }
});

test("a same-structure mapping adoption carries the correction into the new working version", async () => {
  const w = await workspace();
  try {
    const candidate = await w.app.live.propose({ ...w.proposal, baseModelRef: ref(w.model), rationale: "重新检查相同映射" });
    const model = await w.app.live.adopt(candidate.id, candidate.version);
    const result = await w.app.live.query({ modelId: model.id, modelVersion: model.version, type: "投诉", id: "TS002", relation: "回访记录" });
    assert.deepEqual(result.items, []);
    assert.equal((w.app.workspaceVersions.latest()!.content.composition as any).corrections.length, 1);
  } finally { await w.close(); }
});

test("a revision cannot silently discard a correction by changing its endpoint property binding", async () => {
  const w = await workspace();
  try {
    const candidate = await w.app.live.propose({ ...w.proposal, baseModelRef: ref(w.model), rationale: "修订回访属性",
      types: w.proposal.types.map(type => type.name === "回访" ? { ...type, fields: { ...type.fields, 结果: "complaintId" } } : type) });
    const before = w.app.workspaceVersions.latest();
    await assert.rejects(w.app.live.adopt(candidate.id, candidate.version), /局部纠正.*绑定|先处理.*纠正/);
    assert.deepEqual(w.app.workspaceVersions.latest(), before);
    const result = await w.app.live.query({ modelId: w.model.id, type: "投诉", id: "TS002", relation: "回访记录" });
    assert.deepEqual(result.items, []);
  } finally { await w.close(); }
});

test("a correction whose factual basis changed requires review before the next mapping is adopted", async () => {
  const w = await workspace();
  try {
    w.upstream.setOutcome("已改善");
    await w.app.snapshots.sync({ operationId: "changed-facts" });
    const candidate = await w.app.live.propose({ ...w.proposal, baseModelRef: ref(w.model), rationale: "刷新当前数据" });
    const before = w.app.workspaceVersions.latest();
    await assert.rejects(w.app.live.adopt(candidate.id, candidate.version), /纠正依赖的事实已变化/);
    assert.deepEqual(w.app.workspaceVersions.latest(), before);
    assert.deepEqual(w.app.memory.getArtifact(w.correction.id, w.correction.version), w.correction);
  } finally { await w.close(); }
});

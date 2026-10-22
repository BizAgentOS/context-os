import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentApplication } from "../../src/agent/app.ts";
import { identityWorkspace } from "./identity-fixture.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import type { Artifact, Data } from "../../src/agent/contracts.ts";
const ref = (item: Artifact) => ({ id: item.id, version: item.version });

test("a local hierarchy correction checks the complete effective graph for cycles and depth before adoption", { timeout: 120000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-local-hierarchy-")), app = new AgentApplication(directory, undefined, new Set(), false);
  try {
    new Workspace(app.memory).upload("nodes.csv", "id,parent\nA,B\nB,C\nC,\nD,\nE,\n");
    await app.snapshots.sync({ operationId: "hierarchy-source" });
    await app.programBuilds.build({ operationId: "hierarchy-entities", autoAdopt: true });
    const dataset = app.snapshots.datasets()[0];
    let n = 0;
    const verify = async (type: string, subject: Data) => {
      const operation = String(++n), proposed = await app.changes.propose({ operationId: `propose-${operation}`, origin: "human", type, baseline: app.changes.currentBaseline(), subject });
      return app.changes.verify({ ...ref(proposed.change), operationId: `verify-${operation}` });
    };
    const relationChange = await verify("relation", { from: { datasetId: dataset.id, column: "parent" }, to: { datasetId: dataset.id, column: "id" }, acyclic: true, maxDepth: 3, cardinality: "N:1" });
    assert.equal(relationChange.status, "verified", JSON.stringify(relationChange.content.verification));
    await app.changes.adopt({ ...ref(relationChange), operationId: "adopt-hierarchy" });
    const model = app.memory.listArtifacts("live_ontology").find(item => item.status === "adopted")!;
    const layered = app.live.readLayered(model.id), entity = layered.semantic.entityTypes[0], relation = layered.semantic.relationTypes[0];
    const subject = (objectId: string, targetIds: string[]) => ({ kind: "relation", entityTypeId: entity.id, objectId, relationTypeId: relation.id, targetIds, reason: "负责人核对组织层级", evidence: "逐项确认上级" });
    const valid = await verify("local_correction", subject("C", ["D"]));
    assert.equal(valid.status, "verified", JSON.stringify(valid.content.verification));
    await app.changes.adopt({ ...ref(valid), operationId: "adopt-local-parent" });
    assert.deepEqual((await app.live.query({ modelId: model.id, type: entity.name, id: "C", relation: relation.name })).items.map(item => item.$id), ["D"]);
    const saved = app.memory.listArtifacts("relation_correction");
    for (const [targets, error] of [[["A"], /循环|无环/], [["D"], /循环|无环/], [["E"], /深度|层/]] as const) {
      const failed = await verify("local_correction", subject("D", [...targets]));
      assert.equal(failed.status, "failed", JSON.stringify(failed.content.verification));
      assert.match(JSON.stringify(failed.content.verification), error);
    }
    assert.deepEqual(app.memory.listArtifacts("relation_correction"), saved);
    assert.deepEqual((await app.live.query({ modelId: model.id, type: entity.name, id: "D", relation: relation.name })).items, []);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a one-to-one local correction cannot assign an already claimed target to a second origin", { timeout: 60000 }, async () => {
  const w = await identityWorkspace(), app = w.service.app;
  try {
    const dataset = (sourceId: string, capability: string) => app.snapshots.bindingDataset(sourceId, capability)!.id;
    await w.adopt("relation", { from: { datasetId: dataset(w.sources.staff.id, "staff"), column: "email" }, to: { datasetId: dataset(w.sources.people.id, "people"), column: "email" }, cardinality: "1:1" });
    const relation = app.live.readLayered(w.model.id).semantic.relationTypes.find(item => item.from === "staff")!;
    const proposed = await app.changes.propose({ operationId: "duplicate-target", origin: "human", type: "local_correction", baseline: app.changes.currentBaseline(),
      subject: { kind: "relation", entityTypeId: "staff", objectId: "H1", relationTypeId: relation.id, targetIds: ["P2"], reason: "人工提出另一目标", evidence: "需要全局基数复验" } });
    const checked = await app.changes.verify({ ...ref(proposed.change), operationId: "verify-duplicate-target" });
    assert.equal(checked.status, "failed");
    assert.match(JSON.stringify(checked.content.verification), /基数|多个起点/);
    assert.equal(app.memory.listArtifacts("relation_correction").length, 0);
    assert.deepEqual((await app.live.query({ modelId: w.model.id, type: "外部人员", id: "H1", relation: relation.name })).items.map(item => item.$id), ["P1"]);
  } finally { await w.close(); }
});

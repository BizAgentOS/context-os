import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Artifact, Data } from "../../src/agent/contracts.ts";
import { createServer } from "../../src/agent/server.ts";
import { Workspace } from "../../src/agent/workspace.ts";

const ref = (artifact: Artifact) => ({ id: artifact.id, version: artifact.version });

test("a governed relation survives same-structure rebuilds with its semantic identity and executable binding", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-governed-rebuild-"));
  const service = await createServer({ directory, automaticApi: false });
  const { app } = service;
  try {
    const files = new Workspace(app.memory);
    files.upload("企业.csv", "企业编号,企业名称\n" + Array.from({ length: 10 }, (_, i) => `C${i},企业${i}`).join("\n") + "\n");
    files.upload("订单.csv", "订单号,企业编号\n" + Array.from({ length: 20 }, (_, i) => `O${i},C${i % 10}`).join("\n") + "\n");
    await app.programBuilds.build({ operationId: "initial", autoAdopt: false });
    const candidate = app.programBuilds.overview().candidate!;
    const checked = await app.programBuilds.check(ref(candidate));
    await app.programBuilds.adopt({ ...ref(checked), operationId: "entities-only", selection: {
      entities: (checked.content.diff as Data).addedConcepts, relations: [], merges: [],
    } });

    const adoptChange = async (type: string, subject: Data, operation: string) => {
      const proposal = await app.changes.propose({ operationId: operation, origin: "human", type,
        baseline: app.changes.currentBaseline(), subject });
      const verified = await app.changes.verify({ ...ref(proposal.change), operationId: `${operation}-check` });
      assert.equal(verified.status, "verified", JSON.stringify(verified.content.verification));
      return app.changes.adopt({ ...ref(verified), operationId: `${operation}-adopt` });
    };
    const company = (app.foundation.read().adopted!.content.concepts as Data[]).find(item => item.name === "企业")!;
    await adoptChange("naming", { target: "concept", id: company.id, name: "客户企业" }, "rename-company");
    const datasetId = (name: string) => app.snapshots.datasets().find(dataset => String(dataset.content.name).includes(name))!.id;
    const adopted = await adoptChange("relation", {
      from: { datasetId: datasetId("订单"), column: "企业编号" },
      to: { datasetId: datasetId("企业"), column: "企业编号" },
    }, "governed-relation");
    const relationId = (adopted.content.effect as Data).relationId;
    const activeModel = () => app.live.overview().models.find(model => model.status === "adopted")!;
    const before = activeModel();
    const relation = (before.content.relations as Data[]).find(item => item.relationId === relationId)!;
    const origins = await app.live.query({ modelId: before.id, modelVersion: before.version, type: relation.from, limit: 1 });
    const query = (model: Artifact) => app.live.query({ modelId: model.id, modelVersion: model.version,
      type: relation.from, id: origins.items[0].$id, relation: relation.name });
    const original = await query(before);
    assert.equal(original.items.length, 1);

    const rebuilt = await app.programBuilds.build({ operationId: "same-input", autoAdopt: true });
    assert.equal(rebuilt.content.outcome, "adopted", JSON.stringify(rebuilt.content.issues));
    assert.equal(app.programBuilds.overview().candidate, null, "unchanged inputs do not create a retirement or duplicate relation proposal");
    const retained = (app.foundation.read().adopted!.content.relations as Data[]).find(item => item.id === relationId);
    assert.ok(retained, "the adopted relation retains its semantic identity");
    assert.equal(retained.name, relation.name);
    const after = activeModel();
    assert.equal((after.content.relations as Data[]).filter(item => item.relationId === relationId).length, 1);
    assert.deepEqual((await query(after)).items, original.items, "rebuilding keeps the adopted relation executable");

    await adoptChange("naming", { target: "relation", id: relationId, name: "关联客户" }, "rename-relation");
    const afterRename = await app.programBuilds.build({ operationId: "renamed-input", autoAdopt: true });
    assert.equal(afterRename.content.outcome, "adopted", JSON.stringify(afterRename.content.issues));
    const renamedModel = activeModel();
    assert.equal((renamedModel.content.relations as Data[]).find(item => item.relationId === relationId)?.name, "关联客户");
    const renamedResult = await app.live.query({ modelId: renamedModel.id, modelVersion: renamedModel.version,
      type: relation.from, id: origins.items[0].$id, relation: "关联客户" });
    assert.deepEqual(renamedResult.items, original.items, "later naming decisions survive automatic rebinds");

    const current = app.foundation.read().adopted!;
    const governed = (current.content.relations as Data[]).find(item => item.id === relationId)!;
    const task = app.memory.createTask("补充关系说明");
    const message = app.memory.addMessage(task.id, "user", "该关系表示订单对应的客户企业。");
    const context = app.memory.beginExecution(task.id);
    try {
      const revised = app.foundation.propose({ baseVersion: current.version, enterprise: current.content.enterprise, concepts: [],
        relations: [{ id: governed.id, name: governed.name, from: governed.from, to: governed.to,
          description: message.content, evidenceRefs: ["relation-meaning"] }],
        evidence: [{ id: "relation-meaning", messageId: message.id, quote: message.content }], unknowns: [], conflicts: [],
      }, context, "relation-meaning", "company-foundation-ontology", undefined, { lockStructure: true });
      app.foundation.adopt(revised.id, revised.version);
    } finally { app.memory.endExecution(context); }
    const afterAssistant = await app.programBuilds.build({ operationId: "assistant-wording", autoAdopt: true });
    assert.equal(afterAssistant.content.outcome, "adopted", JSON.stringify(afterAssistant.content.issues));
    const finalRelation = (app.foundation.read().adopted!.content.relations as Data[]).find(item => item.id === relationId);
    assert.equal(finalRelation?.description, message.content, "the assistant can refine a governed relation without making it legacy structure");
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

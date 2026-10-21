import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentApplication } from "../../src/agent/app.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";
import type { Artifact, Data } from "../../src/agent/contracts.ts";

test("a human adjudicates a documented disagreement through verified changes without a new user quotation", async () => {
  const { FoundationAdjudication } = await import("../../src/agent/foundation-adjudication.ts");
  const directory = mkdtempSync(join(tmpdir(), "de-adjudication-")), app = new AgentApplication(directory);
  try {
    const base = seedFoundation(app.memory, app.foundation, { enterprise: "澄川仓配", concepts: [{ id: "store", name: "门店", description: "收货地点" }] });
    const item = (base.content.concepts as any[])[0];
    const foundation = app.memory.putArtifact({ ...base, expectedVersion: base.version, content: { ...base.content,
      conflicts: [{ id: "document-conflict", description: "资料给出不同说明", evidenceRefs: item.evidenceRefs,
        retained: item, proposed: { ...item, description: "接收货物并受理退货的地点" } }] } });
    const service = new FoundationAdjudication(app.memory, app.foundation, app.changes);
    app.pendingCenter.register(service.provider);
    assert.equal(service.list().total, 1);
    const before = app.memory.listArtifacts("workspace_version").length;
    const proposed = await service.propose({ operationId: "choose-document", foundationRef: { id: foundation.id, version: foundation.version },
      issue: { kind: "conflict", id: "document-conflict" }, action: "choose_proposed", reason: "业务负责人确认第二份说明适用" });
    assert.equal(service.provider.list().length, 0, "the open change replaces its source item in the pending count");
    const verified = await app.changes.verify({ operationId: "verify-choice", id: proposed.change.id, version: proposed.change.version });
    assert.equal(verified.status, "verified");
    const adopted = await app.changes.adopt({ operationId: "adopt-choice", id: verified.id, version: verified.version });
    assert.equal(adopted.status, "adopted");
    const current = app.foundation.read().adopted!;
    assert.equal((current.content.concepts as any[])[0].description, "接收货物并受理退货的地点");
    assert.equal((current.content.conflicts as any[])[0].adjudication.actor, "local-admin");
    assert.equal((current.content.conflicts as any[])[0].adjudication.reason, "业务负责人确认第二份说明适用");
    assert.equal(service.list().total, 0);
    assert.equal(app.memory.listArtifacts("workspace_version").length, before + 1);
    assert.equal((app.memory.getArtifact(foundation.id, foundation.version).content.concepts as any[])[0].description, "收货地点");
    const replay = await service.propose({ operationId: "choose-document", foundationRef: { id: foundation.id, version: foundation.version },
      issue: { kind: "conflict", id: "document-conflict" }, action: "choose_proposed", reason: "业务负责人确认第二份说明适用" });
    assert.equal(replay.change.id, proposed.change.id, "a lost propose response can be replayed after adoption");
    assert.equal(app.memory.listArtifacts("workspace_version").length, before + 1);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("independent adjudications merge once and a conflicting batch preserves every pending decision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-adjudication-batch-")), app = new AgentApplication(directory);
  try {
    const base = seedFoundation(app.memory, app.foundation, { enterprise: "澄川仓配", concepts: [{ id: "store", name: "门店", description: "收货地点" }] });
    const item = (base.content.concepts as Data[])[0];
    const foundation = app.memory.putArtifact({ ...base, expectedVersion: base.version, content: { ...base.content,
      conflicts: [{ id: "meaning", description: "收货范围有分歧", evidenceRefs: item.evidenceRefs, retained: item, proposed: { ...item, description: "收货及退货地点" } }],
      unknowns: [{ id: "region", description: "范围未明确" }, { id: "old", description: "旧问题" }] } });
    const reference = (artifact: Artifact) => ({ id: artifact.id, version: artifact.version });
    const selected: Artifact[] = [];
    for (const [kind, id, action] of [["conflict", "meaning", "choose_proposed"], ["unknown", "region", "explain"], ["unknown", "old", "close"]] as const) {
      const result = await app.adjudication.propose({ operationId: `batch-propose-${id}`, foundationRef: reference(foundation), issue: { kind, id }, action,
        reason: "业务负责人已核对", ...(action === "explain" ? { explanation: "城区范围" } : {}) });
      selected.push(await app.changes.verify({ operationId: `batch-verify-${id}`, ...reference(result.change) }));
    }
    const before = app.workspaceVersions.list().length;
    const args = { operationId: "adjudication-batch", items: selected.map(reference) };
    const result = await app.changes.batchAdopt(args);
    const current = app.foundation.read().adopted!;
    assert.equal(current.version, foundation.version + 1, "one merged foundation write");
    assert.equal(app.workspaceVersions.list().length, before + 1);
    assert.equal((current.content.concepts as Data[])[0].description, "收货及退货地点");
    assert.equal(app.adjudication.list().total, 0);
    assert.deepEqual(result.changes.map(change => change.status), ["adopted", "adopted", "adopted"]);
    assert.deepEqual(await app.changes.batchAdopt(args), result);
    assert.equal(app.workspaceVersions.list().length, before + 1);
    for (const issue of [...current.content.conflicts as Data[], ...current.content.unknowns as Data[]]) {
      assert.equal((issue.adjudication as Data).actor, "local-admin");
      assert.equal((issue.adjudication as Data).reason, "业务负责人已核对");
    }
    // Direct public change proposals still cannot decide one issue twice in a batch.
    const next = app.memory.putArtifact({ ...current, expectedVersion: current.version, content: { ...current.content, unknowns: [{ id: "new", description: "新问题" }] } });
    const duplicates: Artifact[] = [];
    for (const action of ["close", "explain"]) {
      const { change } = await app.changes.propose({ operationId: `duplicate-${action}`, origin: "human", type: "adjudication", baseline: app.changes.currentBaseline(),
        subject: { foundationRef: reference(next), issue: { kind: "unknown", id: "new" }, action, reason: "核对完成", explanation: "范围说明" } });
      duplicates.push(await app.changes.verify({ operationId: `duplicate-check-${action}`, ...reference(change) }));
    }
    const beforeConflict = app.workspaceVersions.list();
    await assert.rejects(app.changes.batchAdopt({ operationId: "conflicting-decisions", items: duplicates.map(reference) }), /同一|重复|冲突/);
    assert.deepEqual(duplicates.map(change => app.changes.read(change.id).status), ["verified", "verified"]);
    assert.deepEqual(app.workspaceVersions.list(), beforeConflict);
    assert.equal(app.adjudication.list().total, 1);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("adjudication preserves disagreement, records explanations, closes unknowns and blocks stale or impersonated decisions", async () => {
  const { FoundationAdjudication } = await import("../../src/agent/foundation-adjudication.ts");
  const directory = mkdtempSync(join(tmpdir(), "de-adjudication-actions-")), app = new AgentApplication(directory);
  try {
    const base = seedFoundation(app.memory, app.foundation, { enterprise: "澄川仓配", concepts: [{ id: "store", name: "门店", description: "收货地点" }] });
    const item = (base.content.concepts as any[])[0];
    app.memory.putArtifact({ ...base, expectedVersion: base.version, content: { ...base.content,
      conflicts: [{ id: "disagreement", description: "适用范围有分歧", evidenceRefs: item.evidenceRefs, retained: item, proposed: { ...item, description: "接收退货" } }],
      unknowns: [{ id: "explain", description: "服务范围未明确" }, { id: "close", description: "旧问题已不适用" }, { id: "stale", description: "另一未知问题" }] } });
    const service = new FoundationAdjudication(app.memory, app.foundation, app.changes);
    assert.equal(service.list({ limit: 2 }).nextOffset, 2);
    for (const [id, kind, action] of [["disagreement", "conflict", "retain_disagreement"], ["explain", "unknown", "explain"], ["close", "unknown", "close"]] as const) {
      const current = app.foundation.read().adopted!, foundationRef = { id: current.id, version: current.version };
      const input = { operationId: `choose-${id}`, foundationRef, issue: { kind, id }, action, reason: "业务负责人已核对", ...(action === "explain" ? { explanation: "仅适用于城区门店" } : {}) };
      await assert.rejects(service.propose({ ...input, actor: "someone-else" }), /actor|Unrecognized/);
      const proposed = await service.propose(input), checked = await app.changes.verify({ operationId: `verify-${id}`, id: proposed.change.id, version: proposed.change.version });
      await app.changes.adopt({ operationId: `adopt-${id}`, id: checked.id, version: checked.version });
      const saved = app.foundation.read().adopted!, issue = (saved.content[kind === "conflict" ? "conflicts" : "unknowns"] as any[]).find(i => i.id === id);
      assert.equal(issue.adjudication.action, action);
      assert.equal(issue.adjudication.actor, "local-admin");
      if (action === "retain_disagreement") { assert.equal(issue.retained.description, "收货地点"); assert.equal(issue.proposed.description, "接收退货"); }
      if (action === "explain") assert.equal(issue.adjudication.explanation, "仅适用于城区门店");
      assert.equal((saved.content.concepts as any[])[0].description, "收货地点");
    }
    assert.equal(service.list().total, 1);
    const current = app.foundation.read().adopted!;
    const proposed = await service.propose({ operationId: "choose-stale", foundationRef: { id: current.id, version: current.version }, issue: { kind: "unknown", id: "stale" }, action: "close", reason: "核对完成" });
    const checked = await app.changes.verify({ operationId: "check-stale", id: proposed.change.id, version: proposed.change.version });
    app.memory.putArtifact({ ...current, expectedVersion: current.version, content: { ...current.content, changedDuringReview: true } });
    const before = app.memory.listArtifacts("workspace_version").length;
    await assert.rejects(app.changes.adopt({ operationId: "adopt-stale", id: checked.id, version: checked.version }), /基线|变化/);
    assert.equal(app.memory.listArtifacts("workspace_version").length, before);
    assert.equal(service.list().total, 1);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

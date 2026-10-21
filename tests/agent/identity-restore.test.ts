import { test } from "node:test";
import assert from "node:assert/strict";
import { identityWorkspace, ref } from "./identity-release-fixture.ts";
import { identityWorkspace as legacyIdentityWorkspace } from "./identity-fixture.ts";
import type { Data } from "../../src/agent/contracts.ts";

test("restoring historical identity decisions creates a new working set and leaves later published decisions fixed", async () => {
  const w = await identityWorkspace();
  try {
    const excluded = await w.decide("a-bot", "no_match", null, "historical-exclusion");
    const historicalDecision = w.service.app.memory.getArtifact(excluded.content.effect.decisionRef.id, excluded.content.effect.decisionRef.version);
    const historical = (await w.manage("/api/workspace-versions")).versions[0];
    await w.decide("a-bot", "match", "P2", "later-match");
    const published = await w.publish("恢复前发布"), reader = await w.connect(published, "恢复前接入");
    const before = await w.manage("/api/workspace-versions");
    const restored = await w.govern("restore", { workspaceVersionRef: ref(historical) }, "historical-identity");
    const after = await w.manage("/api/workspace-versions");
    assert.equal(after.versions[0].number, before.versions[0].number + 1, "one adoption records one complete restored composition");
    assert.equal(after.composition.identityDecisions.length, 1);
    assert.notEqual(after.composition.identityDecisions[0], `${historicalDecision.id}@${historicalDecision.version}`, "restoration creates a decision for the new binding");
    const [id, version] = after.composition.identityDecisions[0].split("@");
    const decision = w.service.app.memory.getArtifact(id, Number(version));
    assert.deepEqual(decision.content.modelRef, restored.content.effect.modelRef);
    assert.equal(decision.content.decision, "no_match");
    assert.deepEqual(w.service.app.memory.getArtifact(historicalDecision.id, historicalDecision.version), historicalDecision);
    const current = await w.service.app.live.query({ modelId: restored.content.effect.modelRef.id, type: "账号", id: "a-bot", relation: "所属人员" });
    assert.deepEqual(current.items, []);
    assert.equal((await w.external(reader.key, "a-bot")).body.items[0].objectRef.id, "P2", "the existing release retains the later match");
    const newRelease = await w.publish("恢复后发布"), newReader = await w.connect(newRelease, "恢复后接入");
    assert.deepEqual((await w.external(newReader.key, "a-bot")).body.items, []);
  } finally { await w.close(); }
});

test("compatible model adoption carries identity decisions without rewriting their published references", async () => {
  const w = await identityWorkspace();
  try {
    const adopted = await w.decide("a-old", "match", "P1", "carry-match");
    const original = w.service.app.memory.getArtifact(adopted.content.effect.decisionRef.id, adopted.content.effect.decisionRef.version);
    const release = await w.publish("重绑前发布"), reader = await w.connect(release, "重绑前接入");
    const base = w.currentModel();
    const candidate = (await w.manage("/api/live/propose", { foundationRef: ref(w.service.app.foundation.read().adopted!), baseModelRef: ref(base),
      purpose: "重新检查相同绑定", rationale: "保留已采用身份决定", layered: w.service.app.live.readLayered(base.id, base.version) })).saved;
    const model = (await w.manage("/api/live/adopt", ref(candidate))).saved;
    const composition = (await w.manage("/api/workspace-versions")).composition;
    assert.equal(composition.identityDecisions.length, 1);
    const [id, version] = composition.identityDecisions[0].split("@");
    assert.notEqual(id, original.id);
    assert.deepEqual(w.service.app.memory.getArtifact(id, Number(version)).content.modelRef, ref(model));
    const current = await w.service.app.live.query({ modelId: model.id, type: "账号", id: "a-old", relation: "所属人员" });
    assert.equal(current.items[0].$id, "P1");
    assert.equal((await w.external(reader.key, "a-old")).body.items[0].objectRef.id, "P1");
    assert.deepEqual(w.service.app.memory.getArtifact(original.id, original.version), original);
  } finally { await w.close(); }
});

test("an identity decision adopted after restore verification invalidates the pending restore", async () => {
  const w = await identityWorkspace();
  try {
    const historical = (await w.manage("/api/workspace-versions")).versions[0];
    const change = (await w.manage("/api/changes/propose", { operationId: "restore-before-decision", origin: "human", type: "restore",
      baseline: (await w.manage("/api/changes")).baseline, subject: { workspaceVersionRef: ref(historical) } })).change;
    const verified = (await w.manage("/api/changes/verify", { operationId: "verify-restore-before-decision", ...ref(change) })).change;
    await w.decide("a-bot", "no_match", null, "intervening-decision");
    const before = await w.manage("/api/workspace-versions");
    const result = await w.request("/api/changes/adopt", { operationId: "restore-stale", ...ref(verified) });
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.code, "verification_changed");
    assert.deepEqual(await w.manage("/api/workspace-versions"), before);
  } finally { await w.close(); }
});

test("identity migration refuses a changed rule scope instead of silently reinterpreting an adopted decision", async () => {
  const w = await identityWorkspace();
  try {
    await w.decide("a-old", "match", "P1", "scope-baseline");
    const before = await w.manage("/api/workspace-versions"), model = w.currentModel();
    const rule = w.service.app.live.readLayered(model.id, model.version).bindings.identityRules.find(rule => rule.id === w.ruleId)!;
    const proposed = (await w.manage("/api/changes/propose", { operationId: "change-decided-rule", origin: "human", type: "identity_rule",
      baseline: (await w.manage("/api/changes")).baseline, subject: { id: rule.id, kind: rule.kind, left: rule.left, right: rule.right,
        relationTypeId: rule.relationTypeId, transform: { op: "trim" }, reason: "修订匹配规范", evidence: "新的匹配要求" } })).change;
    const checked = (await w.manage("/api/changes/verify", { operationId: "verify-changed-rule", ...ref(proposed) })).change;
    assert.equal(checked.status, "failed", JSON.stringify(checked.content.verification));
    assert.match(checked.content.verification.notes.join(" "), /身份决定|该决定/);
    assert.deepEqual(await w.manage("/api/workspace-versions"), before);
  } finally { await w.close(); }
});

test("new source facts prevent a stale identity decision from being carried into a refreshed binding", async () => {
  const w = await identityWorkspace();
  try {
    await w.decide("a-old", "match", "P1", "facts-baseline");
    w.upload("people.csv", "id,email,name\nP1,new@example.test,已更新姓名\nP2,shared@example.test,周\n");
    await w.service.app.snapshots.sync({ operationId: "changed-identity-facts" });
    const model = w.currentModel();
    const candidate = (await w.manage("/api/live/propose", { foundationRef: ref(w.service.app.foundation.read().adopted!), baseModelRef: ref(model),
      purpose: "重新读取人员资料", rationale: "检查当前来源", layered: w.service.app.live.readLayered(model.id, model.version) })).saved;
    const before = await w.manage("/api/workspace-versions");
    const result = await w.request("/api/live/adopt", ref(candidate));
    assert.ok(result.status >= 400, JSON.stringify(result.body));
    assert.match(result.body.error, /身份决定.*事实|身份决定.*规则/);
    assert.deepEqual(await w.manage("/api/workspace-versions"), before);
  } finally { await w.close(); }
});

test("published and restored local corrections revalidate against their historical identity decisions", async () => {
  const w = await identityWorkspace();
  try {
    const model = w.currentModel();
    const proposed = (await w.manage("/api/live/corrections/propose", { operationId: "combined-correction", target: { modelId: model.id, modelVersion: model.version,
      type: "账号", objectId: "a-bot", relation: "所属人员" }, targetIds: [], reason: "机器人不属于人员", evidence: "运维账号登记" })).saved;
    const checked = (await w.manage("/api/live/corrections/check", { operationId: "combined-check", ...ref(proposed) })).saved;
    await w.manage("/api/live/corrections/adopt", { operationId: "combined-adopt", ...ref(checked) });
    const historical = (await w.manage("/api/workspace-versions")).versions[0];
    const release = await w.publish("纠正与身份基线"), reader = await w.connect(release, "纠正接入");
    await w.decide("a-bot", "no_match", null, "later-identity-exclusion");
    const external = await w.external(reader.key, "a-bot");
    assert.equal(external.status, 200, JSON.stringify(external.body));
    assert.deepEqual(external.body.items, [], "later identity decisions cannot invalidate the old correction's fixed baseline");
    const restored = await w.govern("restore", { workspaceVersionRef: ref(historical) }, "restore-combined");
    const current = await w.service.app.live.query({ modelId: restored.content.effect.modelRef.id, type: "账号", id: "a-bot", relation: "所属人员" });
    assert.deepEqual(current.items, [], "history restores the correction and its original empty identity-decision set together");
  } finally { await w.close(); }
});

test("an identity decision on an imported pre-rule supplement survives an equivalent model adoption", async () => {
  const w = await legacyIdentityWorkspace();
  try {
    await w.adopt("identity_rule", { kind: "same_as", left: { bindingId: w.binding("staff"), columns: ["email"] },
      right: { bindingId: w.binding("person"), columns: ["email"] }, reason: "同一人员通讯来源", evidence: "已核对人员名册" });
    const content = structuredClone(w.model.content), layered = content.layered as Data;
    delete (layered.bindings as Data).identityRules;
    // Imported 041 models store adopted supplements without the later identityRules field.
    const historical = w.service.app.memory.putArtifact({ kind: "live_ontology", title: w.model.title, status: "adopted", content });
    const legacyRule = w.service.app.live.readLayered(historical.id).bindings.identityRules[0];
    await w.adopt("identity_decision", { ruleId: legacyRule.id, left: { bindingId: legacyRule.left.bindingId, recordId: "H1" },
      right: null, decision: "no_match", reason: "此邮箱已复用", evidence: "核对外部名册记录" });
    const before = await w.call("/api/live/query", { modelId: historical.id, type: "人员", id: "P1" });
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.items[0].电话, null);
    const proposal = await w.call("/api/live/propose", { foundationRef: ref(w.service.app.foundation.read().adopted!), baseModelRef: ref(historical),
      purpose: "保留旧补充来源的身份决定", rationale: "同结构重新绑定", layered: w.service.app.live.readLayered(historical.id) });
    assert.equal(proposal.status, 200, JSON.stringify(proposal.body));
    const adopted = await w.call("/api/live/adopt", ref(proposal.body.saved));
    assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
    const after = await w.call("/api/live/query", { modelId: adopted.body.saved.id, type: "人员", id: "P1" });
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.equal(after.body.items[0].电话, null, "the earlier exclusion is retained by the equivalent binding");
    assert.equal(after.body.evidence[0].matches[0].status, "missing");
  } finally { await w.close(); }
});

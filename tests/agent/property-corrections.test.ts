import { test } from "node:test";
import assert from "node:assert/strict";
import { identityWorkspace, ref } from "./identity-fixture.ts";
import { connectLocalChanges } from "../../src/engine/local-changes.ts";
import { connectStructureChanges } from "../../src/engine/structure-changes.ts";
import { identityWorkspace as releaseWorkspace } from "./identity-release-fixture.ts";

test("a local value correction affects only its object, preserves source evidence and survives an equivalent model revision", { timeout: 20000 }, async () => {
  const w = await identityWorkspace(), app = w.service.app;
  try {
    connectLocalChanges(app.memory, app.live, app.changes);
    connectStructureChanges(app.memory, app.foundation, app.live, app.snapshots, app.changes);
    const property = app.live.readLayered(w.model.id).semantic.properties.find(item => item.entityTypeId === "staff" && item.name === "电话")!;
    const proposed = await app.changes.propose({ operationId: "correct-phone", origin: "human", type: "local_correction", baseline: app.changes.currentBaseline(), subject: { kind: "property", entityTypeId: "staff", objectId: "H1", propertyId: property.id, value: "10009", reason: "确认号码变更", evidence: "当事人核对" } });
    const verified = await app.changes.verify({ ...ref(proposed.change), operationId: "check-phone" });
    assert.equal(verified.status, "verified", JSON.stringify(verified));
    assert.equal((await app.live.query({ modelId: w.model.id, type: "外部人员", id: "H1" })).items[0].电话, "10001");
    await app.changes.adopt({ ...ref(verified), operationId: "adopt-phone" });
    const corrected = await app.live.query({ modelId: w.model.id, type: "外部人员", id: "H1" });
    assert.equal(corrected.items[0].电话, "10009");
    assert.match(JSON.stringify(corrected.evidence), /10001/);
    assert.equal((await app.live.query({ modelId: w.model.id, type: "外部人员", id: "H2" })).items[0].电话, "10002");
    const renamed = await w.adopt("property", { action: "add", property: { id: "staff_email_copy", entityTypeId: "staff", name: "办公邮箱", valueType: "string" }, binding: { entityBindingId: w.binding("staff"), column: "email" } });
    const modelRef = (renamed.content.effect as any).modelRef;
    assert.equal((await app.live.query({ modelId: modelRef.id, type: "外部人员", id: "H1" })).items[0].电话, "10009");
  } finally { await w.close(); }
});

test("published property corrections remain pinned after replacement and historical workspace restoration", { timeout: 60000 }, async () => {
  const w = await releaseWorkspace(), app = w.service.app;
  try {
    connectLocalChanges(app.memory, app.live, app.changes);
    const propertyId = app.live.readLayered(w.currentModel().id).semantic.properties.find(item => item.entityTypeId === "person" && item.name === "姓名")!.id;
    const before = await w.publish("属性原值"), beforeReader = await w.connect(before, "原值读者");
    await w.govern("local_correction", { kind: "property", entityTypeId: "person", objectId: "P1", propertyId, value: "林新", reason: "本人确认", evidence: "本人提供现用名" }, "name-first");
    const historical = app.workspaceVersions.latest()!;
    const corrected = await w.publish("属性纠正"), correctedReader = await w.connect(corrected, "纠正读者");
    const read = async (key: string) => {
      const response = await fetch(w.origin + "/v4/objects?type=" + encodeURIComponent("人员") + "&id=P1", { headers: { authorization: `Bearer ${key}` } });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json() as any).items[0];
    };
    assert.match(JSON.stringify(await read(beforeReader.key)), /林/);
    assert.doesNotMatch(JSON.stringify(await read(beforeReader.key)), /林新/);
    assert.match(JSON.stringify(await read(correctedReader.key)), /林新/);
    await w.govern("local_correction", { kind: "property", entityTypeId: "person", objectId: "P1", propertyId, value: "林再次", reason: "再次核对", evidence: "本人再次提供姓名" }, "name-second");
    assert.equal((await app.live.query({ modelId: w.currentModel().id, type: "人员", id: "P1" })).items[0].姓名, "林再次");
    assert.match(JSON.stringify(await read(correctedReader.key)), /林新/);
    await w.govern("restore", { workspaceVersionRef: ref(historical) }, "restore-name");
    assert.equal((await app.live.query({ modelId: w.currentModel().id, type: "人员", id: "P1" })).items[0].姓名, "林新");
    assert.match(JSON.stringify(await read(correctedReader.key)), /林新/);
  } finally { await w.close(); }
});

test("a model revision cannot carry an expired property correction onto changed source facts", { timeout: 20000 }, async () => {
  const w = await identityWorkspace(), app = w.service.app;
  try {
    const propertyId = app.live.readLayered(w.model.id).semantic.properties.find(item => item.entityTypeId === "staff" && item.name === "电话")!.id;
    await w.adopt("local_correction", { kind: "property", entityTypeId: "staff", objectId: "H1", propertyId, value: "10009", reason: "本人确认", evidence: "人工核对号码" });
    w.rows.staff[0].phone = "20001";
    await app.snapshots.sync({ operationId: "source-changed-after-correction" });
    const before = app.changes.currentBaseline();
    const proposal = await app.changes.propose({ operationId: "revision-after-drift", origin: "human", type: "property", baseline: before,
      subject: { action: "add", property: { id: "extra_email", entityTypeId: "staff", name: "办公邮箱", valueType: "string" }, binding: { entityBindingId: w.binding("staff"), column: "email" } } });
    const checked = await app.changes.verify({ ...ref(proposal.change), operationId: "check-revision-after-drift" });
    assert.equal(checked.status, "failed", "expired source facts must block the revision before adoption");
    assert.deepEqual(app.changes.currentBaseline(), before);
  } finally { await w.close(); }
});

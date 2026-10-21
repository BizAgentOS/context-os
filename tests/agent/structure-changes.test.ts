import { test } from "node:test";
import assert from "node:assert/strict";
import { identityWorkspace, ref } from "./identity-fixture.ts";
import { connectStructureChanges } from "../../src/engine/structure-changes.ts";
import { AgentChangeTools } from "../../src/agent/agent-change-tools.ts";
import { freezeAgentTurn } from "../../src/agent/agent-modes.ts";
import { AgentApplication } from "../../src/agent/app.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a new property stays pending, previews its actual source values, then becomes queryable only after adoption", { timeout: 20000 }, async () => {
  const w = await identityWorkspace(), app = w.service.app;
  try {
    connectStructureChanges(app.memory, app.foundation, app.live, app.snapshots, app.changes);
    const session = app.memory.createSession(), context = app.memory.beginExecution(session.taskId), turn = freezeAgentTurn(app.memory, context, { mode: "build" });
    const tools = new AgentChangeTools(app.memory, app.changes, app.pendingCenter, app.live);
    const baseline = app.changes.currentBaseline();
    const proposed = await tools.execute("change_propose", { operationId: "phone", type: "property", baseline,
      subject: { action: "add", property: { id: "work_phone", entityTypeId: "staff", name: "工作电话", description: "通讯名册中的电话", valueType: "string" }, binding: { entityBindingId: w.binding("staff"), column: "phone" } }, evidence: "员工通讯资料提供电话列" }, context, turn) as any;
    assert.equal(proposed.change.status, "proposed");
    const verified = await tools.execute("change_verify", { ...ref(proposed.change), operationId: "verify-phone" }, context, turn) as any;
    assert.equal(verified.status, "verified", JSON.stringify(verified));
    const preview = await tools.execute("change_preview_query", { ...ref(verified), query: { type: "外部人员", id: "H1", fields: ["工作电话"] } }, context, turn) as any;
    assert.equal(preview.before.status, "unavailable");
    assert.equal(preview.after.result.items[0].工作电话, "10001");
    assert.deepEqual(app.changes.currentBaseline(), baseline);
    const adopted = await app.changes.adopt({ ...ref(verified), operationId: "adopt-phone" });
    const modelRef = (adopted.content.effect as any).modelRef;
    const result = await app.live.query({ modelId: modelRef.id, type: "外部人员", id: "H1", fields: ["工作电话"] });
    assert.equal(result.items[0].工作电话, "10001");
    assert.equal(app.changes.read(verified.id).status, "adopted");
  } finally { await w.close(); }
});

test("an empty workspace can save explicit unbound semantics without inventing executable data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-empty-structure-")), app = new AgentApplication(directory, undefined, new Set(), false);
  try {
    connectStructureChanges(app.memory, app.foundation, app.live, app.snapshots, app.changes);
    for (const [type, subject] of [["entity", { action: "add", entity: { id: "contract", name: "合同", description: "待接入的业务合同" } }], ["property", { action: "add", property: { id: "contract_code", entityTypeId: "contract", name: "合同编号", valueType: "string", isIdentity: true } }]] as const) {
      const proposed = await app.changes.propose({ operationId: type, origin: "human", type, baseline: app.changes.currentBaseline(), subject });
      const checked = await app.changes.verify({ ...ref(proposed.change), operationId: `${type}-verify` });
      assert.equal(checked.status, "verified", JSON.stringify(checked));
      await app.changes.adopt({ ...ref(checked), operationId: `${type}-adopt` });
    }
    assert.equal((app.foundation.read().adopted!.content.properties as any[])[0].id, "contract_code");
    assert.equal(app.live.overview().models.length, 0, "an unbound business concept must not pretend to have queryable records");
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("an explicit null clears an optional property unit while omission preserves it", { timeout: 20000 }, async () => {
  const w = await identityWorkspace(), app = w.service.app;
  try {
    const property = app.live.readLayered(w.model.id).semantic.properties.find(item => item.entityTypeId === "staff" && item.name === "电话")!;
    await w.adopt("property", { action: "update", property: { id: property.id, unit: "分机" } });
    await w.adopt("property", { action: "update", property: { id: property.id, description: "电话号码" } });
    assert.equal(app.live.readLayered(w.model.id).semantic.properties.find(item => item.id === property.id)!.unit, "分机");
    await w.adopt("property", { action: "update", property: { id: property.id, unit: null } });
    assert.equal(app.live.readLayered(w.model.id).semantic.properties.find(item => item.id === property.id)!.unit, undefined);
  } finally { await w.close(); }
});

test("property transforms validate records beyond the sample and leave invalid edits unapplied", { timeout: 20000 }, async () => {
  const w = await identityWorkspace(), app = w.service.app;
  try {
    connectStructureChanges(app.memory, app.foundation, app.live, app.snapshots, app.changes);
    w.rows.staff.push({ id: "H3", email: "third@example.test", phone: "10003" }, { id: "H4", email: "fourth@example.test", phone: "1.5" });
    await app.snapshots.sync({ operationId: "more-phones" });
    const property = app.live.readLayered(w.model.id).semantic.properties.find(item => item.entityTypeId === "staff" && item.name === "电话")!;
    const proposed = await app.changes.propose({ operationId: "integer-phone", origin: "human", type: "property", baseline: app.changes.currentBaseline(), subject: { action: "update", property: { id: property.id, valueType: "integer" }, binding: { entityBindingId: w.binding("staff"), column: "phone", transform: { op: "cast", valueType: "integer" } } } });
    const verified = await app.changes.verify({ ...ref(proposed.change), operationId: "verify-integer" });
    assert.equal(verified.status, "failed", "1.5 in the fourth row cannot be accepted as an integer by SQL rounding");
    await assert.rejects(app.changes.adopt({ ...ref(verified), operationId: "adopt-invalid" }));
    assert.equal((await app.live.query({ modelId: w.model.id, type: "外部人员", id: "H4" })).items[0].电话, "1.5");
  } finally { await w.close(); }
});

test("wording saves entity aliases and property names without changing stable query identities", { timeout: 20000 }, async () => {
  const w = await identityWorkspace(), app = w.service.app;
  try {
    connectStructureChanges(app.memory, app.foundation, app.live, app.snapshots, app.changes);
    const property = app.live.readLayered(w.model.id).semantic.properties.find(item => item.entityTypeId === "staff" && item.name === "电话")!;
    const session = app.memory.createSession(), context = app.memory.beginExecution(session.taskId), turn = freezeAgentTurn(app.memory, context, { mode: "build" });
    const tools = new AgentChangeTools(app.memory, app.changes, app.pendingCenter, app.live);
    for (const [operationId, subject] of [["alias", { target: "concept", id: "staff", aliases: ["通讯人员"] }], ["property-name", { target: "property", id: property.id, name: "联系电话", aliases: ["工作号码"] }]] as const) {
      const result = await tools.execute("change_propose", { operationId, type: "naming", baseline: app.changes.currentBaseline(), subject, evidence: "用户指定业务用语" }, context, turn) as any;
      assert.equal(result.change.status, "adopted", JSON.stringify(result));
    }
    const result = await app.live.query({ modelId: w.model.id, type: "通讯人员", id: "H1", fields: ["联系电话"] });
    assert.equal(result.items[0].联系电话, "10001");
    const current = app.live.readLayered(w.model.id).semantic.properties.find(item => item.id === property.id)!;
    assert.equal(current.name, "联系电话");
    assert.ok(current.aliases.includes("工作号码"));
  } finally { await w.close(); }
});

test("unbound entity and properties can be explicitly bound together; deletion cannot silently cascade", { timeout: 20000 }, async () => {
  const w = await identityWorkspace(), app = w.service.app;
  try {
    connectStructureChanges(app.memory, app.foundation, app.live, app.snapshots, app.changes);
    await w.adopt("entity", { action: "add", entity: { id: "directory", name: "通讯目录", description: "独立的通讯信息" } });
    await w.adopt("property", { action: "add", property: { id: "directory_id", entityTypeId: "directory", name: "目录编号", isIdentity: true, valueType: "string" } });
    await w.adopt("property", { action: "add", property: { id: "directory_phone", entityTypeId: "directory", name: "电话", valueType: "string" } });
    const bound = await w.adopt("binding", { action: "add", kind: "entity", binding: { id: "directory_binding", entityTypeId: "directory", role: "primary", dataset: { sourceId: w.sources.staff.id, capability: "staff" }, keyColumns: ["id"] },
      properties: [{ propertyId: "directory_id", column: "id" }, { propertyId: "directory_phone", column: "phone" }] });
    const modelRef = (bound.content.effect as any).modelRef;
    assert.equal((await app.live.query({ modelId: modelRef.id, type: "通讯目录", id: "H1" })).items[0].电话, "10001");
    const proposed = await app.changes.propose({ operationId: "remove-used", origin: "human", type: "entity", baseline: app.changes.currentBaseline(), subject: { action: "remove", entity: { id: "directory" } } });
    const checked = await app.changes.verify({ ...ref(proposed.change), operationId: "verify-removal" });
    assert.equal(checked.status, "failed");
    assert.match(JSON.stringify(checked.content.verification), /依赖|属性|绑定/);
    assert.equal((await app.live.query({ modelId: modelRef.id, type: "通讯目录", id: "H1" })).items[0].电话, "10001");
    await app.programBuilds.build({ operationId: "rebuild-edited", autoAdopt: false });
    const candidate = app.programBuilds.overview().candidate!;
    assert.ok(!((candidate.content.diff as any).retiredConcepts as string[]).includes("directory"), "a later build must preserve explicitly adopted entities");
    const rechecked = await app.programBuilds.check(ref(candidate));
    const rebuilt = await app.programBuilds.adopt({ ...ref(rechecked), operationId: "adopt-rebuilt" });
    assert.equal((await app.live.query({ modelId: rebuilt.model.id, type: "通讯目录", id: "H1" })).items[0].电话, "10001");
  } finally { await w.close(); }
});

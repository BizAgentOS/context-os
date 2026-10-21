import { test } from "node:test";
import assert from "node:assert/strict";
import { identityWorkspace, ref } from "./identity-fixture.ts";

test("explicit deprecation requires named dependencies, preserves other objects and remains effective after a rebuild", { timeout: 20000 }, async () => {
  const w = await identityWorkspace(), app = w.service.app;
  try {
    const layered = app.live.readLayered(w.model.id), properties = layered.semantic.properties.filter(item => item.entityTypeId === "staff");
    const missing = await app.changes.propose({ operationId: "missing-dependencies", origin: "human", type: "deprecation", baseline: app.changes.currentBaseline(),
      subject: { target: "entity", id: "staff", reason: "此资料不再作为独立业务对象" } });
    const failed = await app.changes.verify({ ...ref(missing.change), operationId: "check-dependencies" });
    assert.equal(failed.status, "failed");
    assert.equal((await app.live.query({ modelId: w.model.id, type: "外部人员", id: "H1" })).items.length, 1);
    const dependents = [
      ...properties.map(item => ({ kind: "property", id: item.id })),
      ...layered.bindings.properties.filter(item => properties.some(property => property.id === item.propertyId)).map(item => ({ kind: "property_binding", id: item.id })),
      ...layered.bindings.entities.filter(item => item.entityTypeId === "staff").map(item => ({ kind: "entity_binding", id: item.id })),
    ];
    await w.adopt("deprecation", { target: "entity", id: "staff", dependents, reason: "已核对完整依赖，弃用外部人员实体及其绑定" });
    await assert.rejects(() => app.live.query({ modelId: w.model.id, type: "外部人员", id: "H1" }), /类型|实体|不存在/);
    assert.equal((await app.live.query({ modelId: w.model.id, type: "人员", id: "P1" })).items.length, 1);
    await app.programBuilds.build({ operationId: "after-deprecation", autoAdopt: false });
    const candidate = app.programBuilds.overview().candidate!;
    assert.ok(!(candidate.content.types as any[]).some(type => type.sourceId === w.sources.staff.id), "program discovery must honor the adopted deprecation");
  } finally { await w.close(); }
});

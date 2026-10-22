import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { LiveMemory } from "../../src/live/memory.ts";
import { migrateLegacyModel, type LegacyModel } from "../../src/semantic/model.ts";
import { Snapshots } from "../../src/data/snapshots.ts";
import { validateDefinition } from "../../src/engine/validation.ts";
import { MappingChanges } from "../../src/live/mapping-changes.ts";
import { RelationCorrections } from "../../src/live/relation-corrections.ts";

async function fixture() {
  const rows: Record<string, Record<string, string>[]> = {
    people: [{ id: "r1", tenant: "a", code: "U1", name: " Alice " }, { id: "r2", tenant: "b", code: "U1", name: " Bob " }],
    projects: [{ id: "P1", name: "引擎" }, { id: "P2", name: "连接器" }],
    members: [{ id: "M1", tenant: "a", person: "U1", project: "P1" }, { id: "M2", tenant: "a", person: "U1", project: "P2" }],
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const selected = (rows[url.pathname.slice(1)] ?? []).filter(row => Object.entries(row).every(([key, value]) => !url.searchParams.has(key) || url.searchParams.get(key) === String(value)));
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 20);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: selected.slice(offset, offset + limit), total: selected.length }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = mkdtempSync(join(tmpdir(), "context-os-layered-")), memory = new MemoryStore(directory), live = new LiveMemory(directory, memory);
  const source = await live.sources.connect({ name: "独立业务系统", protocol: "http", url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    capabilities: Object.entries(rows).map(([name, records]) => ({ name, path: `/${name}`, fields: Object.keys(records[0]), idField: "id", totalPath: "total", filters: Object.fromEntries(Object.keys(records[0]).map(key => [key, key])) })) });
  return { directory, memory, live, source, rows, async close() { memory.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); } };
}

test("legacy definitions expose stable semantic and binding layers without rewriting historical versions", async () => {
  const f = await fixture();
  try {
    const candidate = await f.live.propose({ purpose: "人员与项目", types: [
      { name: "人员", description: "租户内人员", sourceId: f.source.id, capability: "people", fields: { 租户: "tenant", 编号: "code", 姓名: "name" } },
    ], relations: [], rationale: "按实际来源绑定" });
    const model = await f.live.adopt(candidate.id, candidate.version);
    const layered = f.live.readLayered(model.id);
    assert.equal(layered.semantic.entityTypes[0].name, "人员");
    assert.equal(layered.semantic.properties.some(property => property.name === "姓名"), true);
    assert.equal(layered.bindings.entities[0].dataset.sourceId, f.source.id);
    const ids = layered.bindings;
    layered.semantic.entityTypes[0].description = "只补充业务说明";
    const prepared = await f.live.prepareDefinition({ purpose: "人员与项目", rationale: "说明修订", layered });
    assert.deepEqual((prepared.layered as any).bindings, ids);
    assert.deepEqual((await f.live.query({ modelId: model.id, type: "人员", fields: ["$id", "姓名"] })).items,
      [{ $id: "r1", 姓名: " Alice " }, { $id: "r2", 姓名: " Bob " }]);
    assert.equal(f.memory.getArtifact(model.id, model.version).version, model.version);
    const custom = structuredClone(layered), property = custom.semantic.properties.find(p => p.name === "姓名")!, oldPropertyId = property.id;
    property.id = "human-confirmed-person-name"; property.aliases = ["显示名称"]; property.valueType = "string"; property.description = "经人工确认的业务名称";
    for (const binding of custom.bindings.properties) if (binding.propertyId === oldPropertyId) binding.propertyId = property.id;
    const customCandidate = await f.live.propose({ purpose: "人员与项目", rationale: "补齐人工属性定义", layered: custom });
    const customModel = await f.live.adopt(customCandidate.id, customCandidate.version), changes = new MappingChanges(f.memory, f.live);
    const change = await changes.execute("propose", { operationId: "name-to-code", baseRef: { id: customModel.id, version: customModel.version }, reason: "用稳定编号显示", evidence: "来源编号已核对", patch: { kind: "property", type: "人员", property: "姓名", sourceField: "code" } });
    const checked = await changes.execute("check", { operationId: "check-name-to-code", id: change.id, version: change.version });
    const adopted = await changes.execute("adopt", { operationId: "adopt-name-to-code", id: checked.id, version: checked.version });
    const revised = f.live.readLayered(String((adopted.content.resultModel as any).id));
    assert.deepEqual(revised.semantic.properties.find(p => p.id === property.id), property);
    assert.equal(revised.bindings.properties.find(b => b.propertyId === property.id)!.column, "code");
  } finally { await f.close(); }
});

test("single business keys round-trip their native type independently of the adapter row id", async () => {
  const f = await fixture();
  try {
    const propose = (sourceId: string, key: string) => f.live.propose({ purpose: "业务身份", rationale: "业务身份独立于适配器行号", types: [{ name: "人员", description: "人员", sourceId, capability: "people", fields: { 姓名: "name" }, identityFields: [key] }], relations: [] });
    for (const values of [[10, 20], [true, false]]) {
      f.rows.people.forEach((row, i) => { (row as any).code = values[i]; });
      const model = await propose(f.source.id, "code"), listed = await f.live.query({ modelId: model.id, type: "人员" });
      assert.equal(typeof listed.items[0].$id, "string");
      assert.match(String(listed.items[0].$id), /^key:/);
      assert.deepEqual((await f.live.query({ modelId: model.id, type: "人员", id: String(listed.items[1].$id) })).items.map(p => p.姓名), [" Bob "]);
      assert.deepEqual((await f.live.query({ modelId: model.id, type: "人员", where: { $id: listed.items[1].$id } })).items.map(p => p.姓名), [" Bob "]);
    }
    f.rows.people.forEach((row, i) => { (row as any).code = i + 1; });
    const numericAdapter = await f.live.sources.connect({ name: "数字行号", protocol: "http", url: String(f.source.content.url), capabilities: [{ name: "people", path: "/people", fields: ["id", "tenant", "code", "name"], idField: "code", idType: "number", filters: { id: "id", code: "code" }, totalPath: "total" }] });
    const model = await propose(numericAdapter.id, "id"), listed = await f.live.query({ modelId: model.id, type: "人员" });
    assert.deepEqual((await f.live.query({ modelId: model.id, type: "人员", id: String(listed.items[0].$id) })).items.map(p => p.姓名), [" Alice "]);
  } finally { await f.close(); }
});

test("a long composite identity returned by a real source query can be read back by that same identity", async () => {
  const f = await fixture();
  try {
    f.rows.people.forEach((row, index) => {
      row.tenant = `tenant-${"x".repeat(200)}-${index}`;
      row.code = `code-${"y".repeat(100)}-${index}`;
    });
    const model = await f.live.propose({ purpose: "长复合身份", rationale: "身份编码必须可往返查询", types: [
      { name: "人员", description: "租户内人员", sourceId: f.source.id, capability: "people", fields: { 租户: "tenant", 编号: "code", 姓名: "name" }, identityFields: ["tenant", "code"] },
    ], relations: [] });
    const listed = await f.live.query({ modelId: model.id, type: "人员" });
    const id = String(listed.items[1].$id);
    assert.ok(id.length > 200);
    assert.match(id, /^composite:/);
    const selected = await f.live.query({ modelId: model.id, type: "人员", id });
    assert.deepEqual(selected.items, [listed.items[1]]);
    assert.equal(selected.coverage.complete, true);
  } finally { await f.close(); }
});

test("foreign keys to an explicitly bound adapter row column preserve composite business identities", async () => {
  const f = await fixture();
  try {
    f.rows.members.forEach((row, index) => { row.person = `r${index + 1}`; });
    const legacy: LegacyModel = { types: [
      { name: "人员", description: "租户内人员", conceptId: "person", sourceId: f.source.id, capability: "people", fields: { 适配器行号: "id", 租户: "tenant", 编号: "code", 姓名: "name" }, identityFields: ["tenant", "code"] },
      { name: "成员", description: "项目成员", conceptId: "member", sourceId: f.source.id, capability: "members", fields: { 人员行号: "person" } },
    ], relations: [{ name: "对应人员", relationId: "member-person", from: "成员", to: "人员", fromField: "人员行号", toField: "适配器行号", fromColumns: ["person"], toColumns: ["id"] }] };
    const layered = migrateLegacyModel(legacy, { capability: () => ({ idField: "id", idType: "string" }) });
    const candidate = await f.live.propose({ purpose: "行号外键与业务身份", rationale: "关系使用独立且已绑定的适配器行号", layered });
    const model = await f.live.adopt(candidate.id, candidate.version);
    const first = await f.live.query({ modelId: model.id, type: "成员", id: "M1", relation: "对应人员" });
    assert.deepEqual(first.items.map(person => person.姓名), [" Alice "]);
    assert.match(String(first.items[0].$id), /^composite:/);
    const second = await f.live.query({ modelId: model.id, type: "成员", id: "M2", relation: "对应人员" });
    assert.deepEqual(second.items.map(person => person.姓名), [" Bob "]);
    assert.notEqual(first.items[0].$id, second.items[0].$id);
    assert.deepEqual((await f.live.query({ modelId: model.id, type: "人员", id: String(second.items[0].$id) })).items, second.items);
    const unbound = structuredClone(layered), rowProperty = unbound.semantic.properties.find(property => property.name === "适配器行号")!;
    unbound.semantic.properties = unbound.semantic.properties.filter(property => property.id !== rowProperty.id);
    unbound.bindings.properties = unbound.bindings.properties.filter(binding => binding.propertyId !== rowProperty.id);
    await assert.rejects(f.live.propose({ purpose: "缺少目标业务属性", rationale: "不得把适配器行号当作复合对象编号", layered: unbound }), /无属性绑定的关系列/);
  } finally { await f.close(); }
});

test("full snapshots verify declared composite keys instead of the adapter row id", async () => {
  const f = await fixture(), snapshots = new Snapshots(f.memory, f.live, f.directory);
  try {
    await snapshots.sync({ operationId: "first" });
    const type = { name: "人员", sourceId: f.source.id, capability: "people", fields: { 租户: "tenant", 编号: "code" }, identityFields: ["code"] };
    const duplicate = await validateDefinition(snapshots, f.live, { types: [type], relations: [] });
    assert.equal(duplicate.checks.find(c => c.name === "人员：身份唯一")!.passed, false);
    const composite = await validateDefinition(snapshots, f.live, { types: [{ ...type, identityFields: ["tenant", "code"] }], relations: [] });
    assert.equal(composite.valid, true);
    f.rows.people.push({ id: "r3", tenant: "a", code: "U1", name: "duplicate" });
    await snapshots.sync({ operationId: "second" });
    const changed = await validateDefinition(snapshots, f.live, { types: [{ ...type, identityFields: ["tenant", "code"] }], relations: [] });
    assert.equal(changed.checks.find(c => c.name === "人员：身份唯一")!.metrics!.duplicates, 1);
  } finally { await snapshots.close(); await f.close(); }
});

test("a supplemental binding keeps its row scope through layered persistence and fusion", async () => {
  const f = await fixture();
  try {
    f.rows.members.splice(1);
    const candidate = await f.live.propose({ purpose: "受限补充来源", rationale: "仅租户 b 的成员记录可补充", types: [
      { name: "人员", description: "人员", sourceId: f.source.id, capability: "people", fields: { 编号: "code" }, supplements: [
        { name: "项目成员", sourceId: f.source.id, capability: "members", match: { primaryField: "编号", sourceField: "person" }, fields: { 项目编号: "project" }, rowFilter: { tenant: "b" }, rationale: "限定来源租户" },
      ] },
    ], relations: [] });
    const query = await f.live.query({ modelId: candidate.id, type: "人员", fields: ["$id", "项目编号"] });
    assert.deepEqual(query.items.map(row => row.项目编号), [null, null]);
    assert.equal(f.live.readLayered(candidate.id).bindings.entities.find(b => b.role === "supplement")!.rowFilter!.tenant, "b");
  } finally { await f.close(); }
});

test("an unrelated legacy property edit preserves composite foreign keys and their tenant isolation", async () => {
  const f = await fixture();
  try {
    f.rows.people.push({ id: "r3", tenant: "a", code: "U2", name: "Claire" });
    const legacy: LegacyModel = { types: [
      { name: "人员", description: "人员", conceptId: "person", sourceId: f.source.id, capability: "people", fields: { 租户: "tenant", 编号: "code", 姓名: "name" }, identityFields: ["tenant", "code"] },
      { name: "成员", description: "项目成员", conceptId: "member", sourceId: f.source.id, capability: "members", fields: { 租户: "tenant", 编号: "person", 项目: "project" } },
    ], relations: [{ name: "对应人员", relationId: "member-person", from: "成员", to: "人员", fromField: "租户", toField: "租户", fromColumns: ["tenant", "person"], toColumns: ["tenant", "code"] }] };
    const layered = migrateLegacyModel(legacy, { capability: () => ({ idField: "id", idType: "string" }) });
    const candidate = await f.live.propose({ purpose: "复合外键", rationale: "租户和业务编号共同关联", layered });
    const model = await f.live.adopt(candidate.id, candidate.version), changes = new MappingChanges(f.memory, f.live);
    const change = await changes.execute("propose", { operationId: "unrelated", baseRef: { id: model.id, version: model.version }, reason: "调整显示列", evidence: "显示源记录编号", patch: { kind: "property", type: "成员", property: "项目", sourceField: "id" } });
    const checked = await changes.execute("check", { operationId: "check-unrelated", id: change.id, version: change.version });
    const adopted = await changes.execute("adopt", { operationId: "adopt-unrelated", id: checked.id, version: checked.version });
    const revisedId = String((adopted.content.resultModel as any).id);
    assert.deepEqual((await f.live.query({ modelId: revisedId, type: "成员", id: "M1", relation: "对应人员" })).items.map(p => p.姓名), [" Alice "]);
    assert.deepEqual(f.live.readLayered(revisedId).bindings.relations[0].fromColumns, ["tenant", "person"]);
    await assert.rejects(changes.execute("propose", { operationId: "invalid-single", baseRef: adopted.content.resultModel, reason: "旧编辑器不能降维", evidence: "复合关系", patch: { kind: "relation", type: "成员", relation: "对应人员", fromField: "租户", toField: "租户" } }), /单列编辑入口/);
  } finally { await f.close(); }
});

test("legacy edits reject ambiguous shared source aliases for single and composite relationships without saving a change", async () => {
  for (const composite of [false, true]) {
    const f = await fixture();
    try {
      const legacy: LegacyModel = {
        types: [
          { name: "人员", description: "人员", conceptId: "person", sourceId: f.source.id, capability: "people", fields: { 租户: "tenant", 编号: "code", 姓名: "name" }, ...(composite ? { identityFields: ["tenant", "code"] } : {}) },
          { name: "成员", description: "项目成员", conceptId: "member", sourceId: f.source.id, capability: "members", fields: { 租户: "tenant", 创建人: "person", 负责人: "person", 项目: "project" } },
        ],
        relations: ["创建人员", "负责人员"].map((name, index) => ({
          name, relationId: `member-person-${index}`, from: "成员", to: "人员", fromField: composite ? "租户" : index ? "负责人" : "创建人", toField: composite ? "租户" : "编号",
          fromColumns: composite ? ["tenant", "person"] : ["person"], toColumns: composite ? ["tenant", "code"] : ["code"],
        })),
      };
      const layered = migrateLegacyModel(legacy, { capability: () => ({ idField: "id", idType: "string" }) });
      const candidate = await f.live.propose({ purpose: "关联列别名核查", rationale: "两个业务角色暂共用一个来源列", layered });
      const model = await f.live.adopt(candidate.id, candidate.version), changes = new MappingChanges(f.memory, f.live);
      const before = f.live.readLayered(model.id, model.version);
      const query = { modelId: model.id, type: "成员", id: "M1", relation: "创建人员" };
      const beforeObjects = (await f.live.query(query)).items;
      assert.equal(beforeObjects.length, composite ? 1 : 2);
      await assert.rejects(changes.execute("propose", {
        operationId: `ambiguous-${composite ? "composite" : "single"}`, baseRef: { id: model.id, version: model.version },
        reason: "只修改负责人映射", evidence: "创建人映射应继续保留", patch: { kind: "property", type: "成员", property: "负责人", sourceField: "project" },
      }), /多个业务属性共享关联源列/);
      assert.deepEqual(changes.list(), []);
      assert.deepEqual(f.live.readLayered(model.id, model.version), before);
      assert.deepEqual((await f.live.query(query)).items, beforeObjects);
    } finally { await f.close(); }
  }
});

test("composite identities isolate tenants and link tables return many-to-many objects with transformations", async () => {
  const f = await fixture(), snapshots = new Snapshots(f.memory, f.live, f.directory);
  try {
    await snapshots.sync({ operationId: "membership-snapshot" });
    f.live.snapshotCheck = definition => validateDefinition(snapshots, f.live, definition) as never;
    const legacy: LegacyModel = { types: [
      { name: "人员", description: "租户内人员", conceptId: "person", sourceId: f.source.id, capability: "people", fields: { 租户: "tenant", 编号: "code", 姓名: "name" }, identityFields: ["tenant", "code"] },
      { name: "项目", description: "项目", conceptId: "project", sourceId: f.source.id, capability: "projects", fields: { 名称: "name" } },
    ], relations: [{ name: "参与项目", relationId: "membership", from: "人员", to: "项目", fromField: "租户", toField: "$id",
      fromColumns: ["tenant", "code"], toColumns: ["id"], linkTable: { sourceId: f.source.id, capability: "members", fromColumns: ["tenant", "person"], toColumns: ["project"] } }] };
    const layered = migrateLegacyModel(legacy, { capability: () => ({ idField: "id", idType: "string" }) });
    const property = layered.semantic.properties.find(p => p.name === "姓名")!;
    layered.bindings.properties.find(b => b.propertyId === property.id)!.transform = { op: "trim" };
    const candidate = await f.live.propose({ purpose: "成员关系", rationale: "中间表明确参与项目", layered });
    const model = await f.live.adopt(candidate.id, candidate.version);
    const people = await f.live.query({ modelId: model.id, type: "人员" });
    assert.deepEqual(people.items.map(p => p.姓名), ["Alice", "Bob"]);
    assert.notEqual(people.items[0].$id, people.items[1].$id);
    assert.match(String(people.items[0].$id), /^composite:/);
    assert.deepEqual((await f.live.query({ modelId: model.id, type: "人员", id: String(people.items[1].$id) })).items.map(p => p.姓名), ["Bob"]);
    const projects = await f.live.query({ modelId: model.id, type: "人员", id: String(people.items[0].$id), relation: "参与项目" });
    assert.deepEqual(projects.items.map(p => p.$id), ["P1", "P2"]);
    assert.equal(projects.coverage.complete, true);
    assert.equal(projects.reads.some(r => r.capability === "members"), true);
    const corrections = new RelationCorrections(f.memory, f.live);
    const correction = await corrections.execute("propose", { operationId: "membership-correction", target: { modelId: model.id, modelVersion: model.version, type: "人员", objectId: String(people.items[0].$id), relation: "参与项目" }, targetIds: ["P2"], reason: "只保留连接器项目", evidence: "人工核对参与范围" });
    const checkedCorrection = await corrections.execute("check", { operationId: "check-membership", id: correction.id, version: correction.version });
    await corrections.execute("adopt", { operationId: "adopt-membership", id: checkedCorrection.id, version: checkedCorrection.version });
    assert.deepEqual((await f.live.query({ modelId: model.id, type: "人员", id: String(people.items[0].$id), relation: "参与项目" })).items.map(p => p.$id), ["P2"]);
    assert.deepEqual((await f.live.query({ modelId: model.id, type: "人员", id: String(people.items[1].$id), relation: "参与项目" })).items, []);
    f.rows.members.push({ id: "M3", tenant: "a", person: "U1", project: "P404" });
    await snapshots.sync({ operationId: "orphan-membership" });
    const partial = await f.live.query({ modelId: model.id, type: "人员", id: String(people.items[0].$id), relation: "参与项目" }, () => {}, false);
    assert.deepEqual(partial.items.map(row => row.$id), ["P1", "P2"]);
    assert.equal(partial.coverage.complete, false);
    assert.equal(partial.coverage.unmatchedTargets, 1);
    const scoped = structuredClone(layered);
    scoped.bindings.entities.find(b => b.entityTypeId === "person")!.rowFilter = { tenant: "a" };
    const scopedCandidate = await f.live.propose({ purpose: "租户 a", rationale: "限定绑定范围", layered: scoped });
    assert.deepEqual((await f.live.query({ modelId: scopedCandidate.id, type: "人员" })).items.map(p => p.姓名), ["Alice"]);
    await assert.rejects(f.live.query({ modelId: scopedCandidate.id, type: "人员", where: { 租户: "b" } }), /行过滤范围/);
    scoped.bindings.properties.find(b => b.propertyId === property.id)!.transform = { op: "parse_date", format: "YYYY-MM-DD" };
    await assert.rejects(f.live.propose({ purpose: "错误日期转换", rationale: "不能把姓名解释为日期", layered: scoped }), /日期/);
  } finally { await snapshots.close(); await f.close(); }
});

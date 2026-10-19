import { test } from "node:test";
import assert from "node:assert/strict";
import {
  migrateLegacyModel,
  projectLegacyModel,
  reconcileLayeredModel,
  parseLayeredModel,
  type LegacyModel,
} from "../../src/semantic/model.ts";

test("legacy migration preserves stable concepts, relations and property names while wording changes leave bindings intact", () => {
  const legacy: LegacyModel = {
    types: [
      { name: "任务", description: "团队任务", conceptId: "task", sourceId: "work", capability: "tasks", fields: { 标题: "title", 负责人: "owner" }, supplements: [{ name: "补充任务", sourceId: "extra", capability: "tasks", match: { primaryField: "$id", sourceField: "task_id" }, fields: { 标题: "subject", 耗时: "hours" }, rationale: "按任务编号对应" }] },
      { name: "人员", description: "项目成员", conceptId: "person", sourceId: "work", capability: "people", fields: { 姓名: "name" } },
    ],
    relations: [{ name: "任务负责人", relationId: "assigned_to", from: "任务", to: "人员", fromField: "负责人", toField: "$id" }],
  };
  const options = { capability: (_sourceId: string, capability: string) => ({ idField: capability === "tasks" ? "task_id" : "person_id", idType: "string" as const }) };
  const migrated = migrateLegacyModel(legacy, options);
  assert.deepEqual(migrated.semantic.entityTypes.map((item) => item.id), ["task", "person"]);
  assert.equal(migrated.semantic.relationTypes[0].id, "assigned_to");
  assert.deepEqual(migrated.bindings.entities.map((item) => item.role), ["primary", "supplement", "primary"]);
  const implicitId = migrated.semantic.properties.find((item) => item.entityTypeId === "task" && item.name === "$id")!;
  assert.deepEqual(migrated.semantic.entityTypes[0].identityKeys, [implicitId.id]);
  assert.equal(implicitId.valueType, "string");
  assert.equal(migrated.semantic.properties.find((item) => item.name === "耗时")!.valueType, "unknown");
  const updated = structuredClone(legacy);
  updated.types[0].description = "文档补充的任务含义";
  updated.types[0].supplements![0].rationale = "文档补充的匹配说明";
  const remigrated = migrateLegacyModel(updated, options);
  assert.deepEqual(remigrated.semantic.properties.map((item) => item.id), migrated.semantic.properties.map((item) => item.id));
  assert.deepEqual(remigrated.bindings.properties, migrated.bindings.properties);
  assert.deepEqual(remigrated.bindings.entities.map((item) => item.id), migrated.bindings.entities.map((item) => item.id));
  const projected = projectLegacyModel(migrated);
  assert.deepEqual(projected.types[0].fields, legacy.types[0].fields);
  assert.deepEqual(projected.types[0].supplements, legacy.types[0].supplements);
  assert.equal(projected.relations[0].relationId, "assigned_to");
  assert.equal(projected.relations[0].fromField, "负责人");
  assert.equal(projected.relations[0].toField, "$id");
});

test("composite identities and link tables retain both endpoint key dimensions in the compatibility projection", () => {
  const model = migrateLegacyModel({
    types: [
      { conceptId: "line", name: "订单行", description: "", sourceId: "sales", capability: "lines", fields: { 单号: "order_id", 行号: "line_no", 标题: "title" }, identityFields: ["order_id", "line_no"] },
      { conceptId: "tag", name: "标签", description: "", sourceId: "sales", capability: "tags", fields: { 编号: "tag_id" } },
    ],
    relations: [{ relationId: "tagged", name: "订单行标签", from: "订单行", to: "标签", fromField: "单号", toField: "编号", fromColumns: ["order_id", "line_no"], toColumns: ["tag_id"], linkTable: { sourceId: "sales", capability: "line_tags", fromColumns: ["order", "line"], toColumns: ["tag"] } }],
  }, { capability: (_source, cap) => ({ idField: cap === "tags" ? "tag_id" : "row_id", idType: "string" }) });
  assert.equal(model.semantic.entityTypes[0].identityKeys.length, 2);
  assert.deepEqual(model.bindings.entities[0].keyColumns, ["order_id", "line_no"]);
  assert.equal(model.bindings.relations[0].kind, "link_table");
  const projection = projectLegacyModel(model);
  assert.deepEqual(projection.types[0].identityFields, ["order_id", "line_no"]);
  assert.deepEqual(projection.relations[0].fromColumns, ["order_id", "line_no"]);
  assert.deepEqual(projection.relations[0].linkTable, { sourceId: "sales", capability: "line_tags", fromColumns: ["order", "line"], toColumns: ["tag"] });
  const invalid = structuredClone(model);
  invalid.bindings.relations[0].fromColumns = ["order"];
  assert.throws(() => parseLayeredModel(invalid), /中间表列与两端身份维度不一致/);
});

test("two business aliases of an identity source column do not create two conflicting identity properties", () => {
  const migrated = migrateLegacyModel({ types: [{ conceptId: "task", name: "任务", description: "", sourceId: "work", capability: "tasks", fields: { 编号: "id", 原始编号: "id" }, supplements: [{ name: "详情", sourceId: "extra", capability: "details", match: { primaryField: "$id", sourceField: "task_id" }, fields: { 描述: "detail" }, rationale: "编号匹配" }] }], relations: [] }, { capability: () => ({ idField: "id", idType: "string" }) });
  assert.equal(migrated.semantic.entityTypes[0].identityKeys.length, 1);
  assert.equal(migrated.semantic.properties.filter((item) => item.isIdentity).length, 1);
  assert.equal(projectLegacyModel(migrated).types[0].supplements![0].match.primaryField, "$id");
});

function simpleModel() {
  return migrateLegacyModel({ types: [{ conceptId: "task", name: "任务", description: "", sourceId: "work", capability: "tasks", fields: { 编号: "id", 标题: "title" } }], relations: [] }, { capability: () => ({ idField: "id", idType: "string" }) });
}

test("layered validation rejects dangling references, cross-entity properties, implicit self references and duplicate source values", () => {
  const original = simpleModel();
  const dangling = structuredClone(original);
  dangling.bindings.properties[0].propertyId = "missing";
  assert.throws(() => parseLayeredModel(dangling), /属性绑定必须引用同实体/);
  const wrongEntity = structuredClone(original);
  wrongEntity.semantic.properties[0].entityTypeId = "another-entity";
  assert.throws(() => parseLayeredModel(wrongEntity), /属性所属实体不存在/);
  const self = structuredClone(original);
  self.semantic.relationTypes.push({ id: "blocks", name: "阻塞", aliases: [], description: "", from: "task", to: "task", direction: "directed", cardinality: "N:N", allowSelf: false });
  assert.throws(() => parseLayeredModel(self), /自引用关系必须明确允许/);
  const duplicates = structuredClone(original);
  duplicates.bindings.properties.push({ ...duplicates.bindings.properties[1], id: "second-title-value", column: "alternative_title" });
  assert.throws(() => parseLayeredModel(duplicates), /同一实体绑定的属性只能有一个源列/);
});

test("finite transforms are explicit and the compatibility projection cannot silently discard them", () => {
  const model = simpleModel();
  model.bindings.properties[1].transform = { op: "trim" };
  assert.throws(() => projectLegacyModel(model), /不能忽略属性转换/);
  assert.deepEqual(projectLegacyModel(model, { allowTransforms: true }).types[0].propertyTransforms, { 标题: { op: "trim" } });
  assert.throws(() => parseLayeredModel({ ...model, injected: "not-model-data" }), /Unrecognized key/);
  assert.throws(() => parseLayeredModel({ ...model, bindings: { ...model.bindings, properties: [{ ...model.bindings.properties[0], transform: { op: "javascript", code: "anything" } }] } }));
  assert.throws(() => parseLayeredModel({ ...model, bindings: { ...model.bindings, properties: [{ ...model.bindings.properties[0], transform: { op: "parse_date", format: "locale-dependent" } }] } }));
  assert.throws(() => parseLayeredModel({ ...model, bindings: { ...model.bindings, properties: [{ ...model.bindings.properties[0], transform: { op: "cast", valueType: "date" } }] } }));
});

test("existing model size limits remain defaults and can be explicitly configured", () => {
  const legacy: LegacyModel = { types: Array.from({ length: 21 }, (_, index) => ({ conceptId: `entity-${index}`, name: `实体 ${index}`, description: "", sourceId: "work", capability: `records-${index}`, fields: {} })), relations: [] };
  assert.throws(() => migrateLegacyModel(legacy), /Too big/);
  assert.equal(migrateLegacyModel(legacy, { limits: { maxEntityTypes: 21 } }).semantic.entityTypes.length, 21);
  const model = simpleModel();
  const primary = model.bindings.entities[0];
  for (let index = 0; index < 4; index++) model.bindings.entities.push({ id: `supplement-${index}`, entityTypeId: primary.entityTypeId, role: "supplement", dataset: { sourceId: `extra-${index}`, capability: "records" }, keyColumns: ["task_id"], match: { primaryPropertyId: "$id", sourceColumn: "task_id" } });
  assert.throws(() => parseLayeredModel(model), /补充绑定超出配置上限/);
  assert.equal(parseLayeredModel(model, { maxSupplementsPerEntity: 4 }).bindings.entities.length, 5);
});

test("legacy supplements with the same source and match remain distinct and survive a wording-only update", () => {
  const legacy: LegacyModel = { types: [{ conceptId: "task", name: "任务", description: "", sourceId: "work", capability: "tasks", fields: { 编号: "id" }, supplements: ["附来源一", "附来源二", "附来源三"].map((name) => ({ name, sourceId: "extra", capability: "details", match: { primaryField: "$id", sourceField: "task_id" }, fields: { 描述: "detail" }, rationale: "按编号对应" })) }], relations: [] };
  const options = { capability: () => ({ idField: "id", idType: "string" as const }) };
  const migrated = migrateLegacyModel(legacy, options);
  const supplements = migrated.bindings.entities.filter((binding) => binding.role === "supplement");
  assert.equal(new Set(supplements.map((binding) => binding.id)).size, 3);
  assert.deepEqual(projectLegacyModel(migrated).types[0].supplements!.map((binding) => binding.name), ["附来源一", "附来源二", "附来源三"]);
  legacy.types[0].supplements![1].name = "改为业务名称";
  legacy.types[0].supplements![1].rationale = "补充匹配说明";
  assert.deepEqual(migrateLegacyModel(legacy, options).bindings.entities.map((binding) => binding.id), migrated.bindings.entities.map((binding) => binding.id));
});

test("old models without semantic IDs retain distinct types on one dataset and multiple relationships on identical columns", () => {
  const legacy: LegacyModel = {
    types: ["对象甲", "对象乙"].map(name => ({ name, description: "旧类型", sourceId: "shared", capability: "records", fields: { 编号: "id", 关联: "other_id" } })),
    relations: ["负责人", "创建人"].map(name => ({ name, from: "对象甲", to: "对象乙", fromField: "关联", toField: "编号" })),
  };
  const options = { capability: () => ({ idField: "id", idType: "string" as const }) };
  const migrated = migrateLegacyModel(legacy, options);
  assert.equal(new Set(migrated.semantic.entityTypes.map(item => item.id)).size, 2);
  assert.equal(new Set(migrated.semantic.relationTypes.map(item => item.id)).size, 2);
  assert.deepEqual(projectLegacyModel(migrated).relations.map(item => item.name), ["负责人", "创建人"]);
  legacy.types[0].name = "对象甲新名称";
  for (const relation of legacy.relations) { relation.from = "对象甲新名称"; relation.name += "新名称"; }
  const renamed = migrateLegacyModel(legacy, options);
  assert.deepEqual(renamed.semantic.entityTypes.map(item => item.id), migrated.semantic.entityTypes.map(item => item.id));
  assert.deepEqual(renamed.semantic.relationTypes.map(item => item.id), migrated.semantic.relationTypes.map(item => item.id));
  assert.deepEqual(renamed.bindings, migrated.bindings);
});

test("rebuilding an existing binding preserves human semantic IDs and metadata while applying explicit binding changes", () => {
  const previous = simpleModel();
  const property = previous.semantic.properties.find(item => item.name === "标题")!;
  const generatedId = property.id;
  property.id = "human-title-property";
  property.description = "人维护的业务标题";
  property.aliases = ["任务名称"];
  property.valueType = "enum";
  property.enumValues = [{ value: "A", description: "一类" }];
  property.unit = "业务单位";
  const binding = previous.bindings.properties.find(item => item.propertyId === generatedId)!;
  binding.id = "human-title-binding";
  binding.propertyId = property.id;
  previous.semantic.entityTypes[0].kind = "activity";
  previous.semantic.entityTypes[0].aliases = ["工作事项"];
  const next = simpleModel();
  next.semantic.entityTypes[0].description = "新文档补充的说明";
  next.bindings.properties.find(item => item.propertyId === generatedId)!.column = "renamed_title";
  next.bindings.properties.find(item => item.propertyId === generatedId)!.transform = { op: "trim" };
  next.bindings.entities[0].rowFilter = { tenant: "a" };
  const reconciled = reconcileLayeredModel(previous, next);
  const retained = reconciled.semantic.properties.find(item => item.name === "标题")!;
  assert.equal(retained.id, "human-title-property");
  assert.equal(retained.description, "人维护的业务标题");
  assert.equal(retained.valueType, "enum");
  assert.deepEqual(retained.enumValues, [{ value: "A", description: "一类" }]);
  assert.deepEqual(retained.aliases, ["任务名称"]);
  assert.equal(retained.unit, "业务单位");
  assert.equal(reconciled.semantic.entityTypes[0].kind, "activity");
  assert.deepEqual(reconciled.semantic.entityTypes[0].aliases, ["工作事项"]);
  assert.equal(reconciled.semantic.entityTypes[0].description, "新文档补充的说明");
  assert.deepEqual(reconciled.bindings.properties.find(item => item.propertyId === retained.id), { id: "human-title-binding", propertyId: "human-title-property", entityBindingId: previous.bindings.entities[0].id, column: "renamed_title", transform: { op: "trim" } });
  assert.deepEqual(reconciled.bindings.entities[0].rowFilter, { tenant: "a" });
});

test("reconciliation remaps identity, supplement matches and relation endpoints to retained binding identities", () => {
  const legacy: LegacyModel = { types: [{ conceptId: "task", name: "任务", description: "任务", sourceId: "work", capability: "tasks", fields: { 编号: "id", 上级: "parent" }, supplements: [{ name: "详情", sourceId: "extra", capability: "details", match: { primaryField: "编号", sourceField: "task_id" }, fields: { 说明: "detail" }, rationale: "编号匹配", rowFilter: { tenant: "a" } }] }], relations: [{ relationId: "parent", name: "上级任务", from: "任务", to: "任务", fromField: "上级", toField: "编号" }] };
  const options = { capability: () => ({ idField: "id", idType: "string" as const }) };
  const previous = migrateLegacyModel(legacy, options);
  const identity = previous.semantic.properties.find(item => item.name === "编号")!;
  const oldPropertyId = identity.id, oldPrimaryId = previous.bindings.entities[0].id;
  identity.id = "human-identity";
  previous.semantic.entityTypes[0].identityKeys = [identity.id];
  previous.bindings.entities[0].id = "human-primary";
  previous.bindings.entities[1].match!.primaryPropertyId = identity.id;
  for (const binding of previous.bindings.properties) {
    if (binding.propertyId === oldPropertyId) binding.propertyId = identity.id;
    if (binding.entityBindingId === oldPrimaryId) binding.entityBindingId = "human-primary";
  }
  previous.semantic.relationTypes[0].inverseName = "子任务";
  previous.semantic.relationTypes[0].acyclic = true;
  previous.bindings.relations[0].id = "human-parent-binding";
  previous.bindings.relations[0].fromBindingId = "human-primary";
  previous.bindings.relations[0].toBindingId = "human-primary";
  const reconciled = reconcileLayeredModel(previous, migrateLegacyModel(legacy, options));
  assert.deepEqual(reconciled.semantic.entityTypes[0].identityKeys, ["human-identity"]);
  assert.equal(reconciled.bindings.entities[1].match!.primaryPropertyId, "human-identity");
  assert.equal(reconciled.bindings.relations[0].id, "human-parent-binding");
  assert.equal(reconciled.bindings.relations[0].fromBindingId, "human-primary");
  assert.equal(reconciled.semantic.relationTypes[0].inverseName, "子任务");
  assert.equal(reconciled.semantic.relationTypes[0].acyclic, true);
  assert.deepEqual(projectLegacyModel(reconciled).types[0].supplements![0].rowFilter, { tenant: "a" });
});

import { createHash } from "node:crypto";
import { z } from "zod";

const name = z.string().trim().min(1).max(200);
const description = z.string().trim().max(4000).default("");
const scalar = z.union([z.string(), z.number().finite(), z.boolean()]);
const columns = z.array(name).max(20);
const dataset = z.object({ sourceId: name, capability: name }).strict();
const valueType = z.enum(["unknown", "string", "integer", "decimal", "boolean", "date", "datetime", "enum", "reference"]);
export const transformSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("none") }).strict(),
  z.object({ op: z.literal("trim") }).strict(),
  z.object({ op: z.literal("lowercase") }).strict(),
  z.object({ op: z.literal("cast"), valueType: z.enum(["string", "integer", "decimal", "boolean"]) }).strict(),
  z.object({ op: z.literal("parse_date"), format: z.enum(["ISO8601", "YYYY-MM-DD", "YYYY/MM/DD"]) }).strict(),
]);
export type PropertyTransform = z.infer<typeof transformSchema>;
const entityType = z.object({
  id: name, name, aliases: z.array(name).max(100).default([]), description,
  identityKeys: columns.default([]), kind: z.enum(["record", "activity"]).default("record"),
}).strict();
const property = z.object({
  id: name, entityTypeId: name, name, aliases: z.array(name).max(100).default([]), description,
  valueType: valueType.default("unknown"), unit: name.optional(),
  enumValues: z.array(z.object({ value: scalar, description: z.string().trim().max(1500).optional() }).strict()).max(1000).optional(),
  isIdentity: z.boolean().default(false),
}).strict();
const relationType = z.object({
  id: name, name, aliases: z.array(name).max(100).default([]), description,
  from: name, to: name, direction: z.enum(["directed", "undirected"]).default("directed"),
  cardinality: z.enum(["1:1", "N:1", "1:N", "N:N"]).default("N:1"),
  allowSelf: z.boolean().default(false), acyclic: z.boolean().optional(), maxDepth: z.number().int().min(1).max(10).optional(), inverseName: name.optional(),
}).strict();
const entityBinding = z.object({
  id: name, entityTypeId: name, name: name.optional(), role: z.enum(["primary", "supplement"]), dataset,
  keyColumns: columns.default([]), rowFilter: z.record(name, scalar).optional(),
  match: z.object({ primaryPropertyId: name, sourceColumn: name }).strict().optional(),
  rationale: z.string().trim().max(2000).optional(),
}).strict();
const propertyBinding = z.object({
  id: name, propertyId: name, entityBindingId: name, column: name,
  transform: transformSchema.default({ op: "none" }),
}).strict();
const relationBindingBase = z.object({
  id: name, relationTypeId: name, fromBindingId: name, toBindingId: name,
  fromColumns: columns.min(1), toColumns: columns.min(1),
});
const relationBinding = z.discriminatedUnion("kind", [
  relationBindingBase.extend({ kind: z.literal("foreign_key") }).strict(),
  relationBindingBase.extend({ kind: z.literal("link_table"), dataset }).strict(),
]);
const identityEnd = z.object({ bindingId: name, columns: columns.min(1) }).strict();
export const identityRuleSchema = z.object({
  id: name, kind: z.enum(["same_as", "belongs_to"]), left: identityEnd, right: identityEnd,
  transform: transformSchema.default({ op: "none" }), relationTypeId: name.optional(), legacy: z.boolean().default(false),
  reason: z.string().trim().min(1).max(2000), evidence: z.string().trim().min(1).max(4000),
}).strict();
export type IdentityRule = z.infer<typeof identityRuleSchema>;

export interface ModelLimits { maxEntityTypes: number; maxRelationTypes: number; maxSupplementsPerEntity: number }
export const DEFAULT_MODEL_LIMITS: Readonly<ModelLimits> = Object.freeze({ maxEntityTypes: 20, maxRelationTypes: 40, maxSupplementsPerEntity: 3 });

/** The semantic IDs are independent of artifact versions and display wording. */
export function createLayeredModelSchema(config: Partial<ModelLimits> = {}) {
  const limits = { ...DEFAULT_MODEL_LIMITS, ...config };
  for (const value of Object.values(limits))
    if (!Number.isInteger(value) || value < 0) throw new Error("模型规模配置必须为非负整数");
  return z.object({
    schemaVersion: z.literal(1),
    semantic: z.object({
      entityTypes: z.array(entityType).max(limits.maxEntityTypes),
      properties: z.array(property), relationTypes: z.array(relationType).max(limits.maxRelationTypes),
    }).strict(),
    bindings: z.object({ entities: z.array(entityBinding), properties: z.array(propertyBinding), relations: z.array(relationBinding), identityRules: z.array(identityRuleSchema).max(100).default([]) }).strict(),
  }).strict().superRefine((model, ctx) => {
    const fail = (message: string, path: (string | number)[] = []) => ctx.addIssue({ code: "custom", message, path });
    const unique = (entries: { id: string }[], path: string[]) => {
      const seen = new Set<string>();
      entries.forEach((entry, index) => { if (seen.has(entry.id)) fail("对象标识重复", [...path, index, "id"]); seen.add(entry.id); });
    };
    for (const [key, entries] of Object.entries(model.semantic)) unique(entries, ["semantic", key]);
    for (const [key, entries] of Object.entries(model.bindings)) unique(entries, ["bindings", key]);
    const entities = new Map(model.semantic.entityTypes.map((item) => [item.id, item]));
    const properties = new Map(model.semantic.properties.map((item) => [item.id, item]));
    const relations = new Map(model.semantic.relationTypes.map((item) => [item.id, item]));
    const bindings = new Map(model.bindings.entities.map((item) => [item.id, item]));
    for (const entity of entities.values()) {
      if (new Set(entity.identityKeys).size !== entity.identityKeys.length) fail("身份属性不能重复");
      for (const id of entity.identityKeys) {
        const item = properties.get(id);
        if (!item || item.entityTypeId !== entity.id || !item.isIdentity) fail("身份键必须引用本实体的身份属性");
      }
      const attached = model.bindings.entities.filter((item) => item.entityTypeId === entity.id);
      if (attached.filter((item) => item.role === "primary").length > 1) fail("实体类型至多一个主绑定");
      if (attached.filter((item) => item.role === "supplement").length > limits.maxSupplementsPerEntity) fail("补充绑定超出配置上限");
      if (attached.some((item) => item.role === "supplement") && !attached.some((item) => item.role === "primary")) fail("补充绑定需要主绑定");
    }
    for (const item of properties.values()) {
      if (!entities.has(item.entityTypeId)) fail("属性所属实体不存在");
      if (item.isIdentity && !entities.get(item.entityTypeId)?.identityKeys.includes(item.id)) fail("身份属性必须列入实体身份键");
      if (item.valueType === "enum" && !item.enumValues?.length) fail("枚举属性需要枚举取值");
      if (item.enumValues && new Set(item.enumValues.map((entry) => JSON.stringify(entry.value))).size !== item.enumValues.length) fail("枚举取值不能重复");
    }
    for (const item of relations.values()) {
      if (!entities.has(item.from) || !entities.has(item.to)) fail("关系端点实体不存在");
      if (item.from === item.to && !item.allowSelf) fail("自引用关系必须明确允许自引用");
      if (item.acyclic && item.direction !== "directed") fail("无环约束需要有向关系");
    }
    for (const item of bindings.values()) {
      const entity = entities.get(item.entityTypeId);
      if (!entity) { fail("实体绑定引用的实体不存在"); continue; }
      if (new Set(item.keyColumns).size !== item.keyColumns.length) fail("身份源列不能重复");
      if (item.role === "primary") {
        if (item.match) fail("主绑定不能声明补充匹配");
        if (item.keyColumns.length !== entity.identityKeys.length) fail("主绑定键列与复合身份维度不一致");
        entity.identityKeys.forEach((id, index) => {
          if (!model.bindings.properties.some((binding) => binding.entityBindingId === item.id && binding.propertyId === id && binding.column === item.keyColumns[index])) fail("主绑定身份列必须对应身份属性绑定");
        });
      } else if (item.match) {
        const matchProperty = properties.get(item.match.primaryPropertyId);
        if (item.match.primaryPropertyId !== "$id" && (!matchProperty || matchProperty.entityTypeId !== entity.id)) fail("补充匹配必须引用同实体属性");
        if (item.keyColumns.length !== 1 || item.keyColumns[0] !== item.match.sourceColumn) fail("补充匹配列与键列不一致");
      } else if (item.keyColumns.length !== entity.identityKeys.length || !item.keyColumns.length) fail("补充绑定需要明确匹配键");
    }
    const boundProperties = new Set<string>();
    for (const item of model.bindings.properties) {
      const property = properties.get(item.propertyId), binding = bindings.get(item.entityBindingId);
      if (!property || !binding || property.entityTypeId !== binding.entityTypeId) fail("属性绑定必须引用同实体的属性和实体绑定");
      const key = JSON.stringify([item.entityBindingId, item.propertyId]);
      if (boundProperties.has(key)) fail("同一实体绑定的属性只能有一个源列");
      boundProperties.add(key);
    }
    for (const item of model.bindings.relations) {
      const relation = relations.get(item.relationTypeId), from = bindings.get(item.fromBindingId), to = bindings.get(item.toBindingId);
      if (!relation || !from || !to || from.entityTypeId !== relation.from || to.entityTypeId !== relation.to) { fail("关系绑定端点与语义端点不一致"); continue; }
      if (item.kind === "foreign_key" && item.fromColumns.length !== item.toColumns.length) fail("外键两端维度不一致");
      if (item.kind === "link_table" && (item.fromColumns.length !== from.keyColumns.length || item.toColumns.length !== to.keyColumns.length)) fail("中间表列与两端身份维度不一致");
    }
    for (const rule of model.bindings.identityRules) {
      const left = bindings.get(rule.left.bindingId), right = bindings.get(rule.right.bindingId);
      if (!left || !right || left.id === right.id) { fail("身份规则需要两个不同的有效实体绑定"); continue; }
      if (rule.left.columns.length !== rule.right.columns.length) fail("身份规则两端匹配列维度不一致");
      if (rule.kind === "same_as" && (left.role !== "supplement" || right.role !== "primary" || left.entityTypeId !== right.entityTypeId)) fail("同一身份规则需要同实体的补充绑定接入主绑定");
      if (rule.kind === "belongs_to") {
        const relation = relations.get(rule.relationTypeId ?? "");
        if (left.role !== "primary" || right.role !== "primary" || left.entityTypeId === right.entityTypeId || !relation || relation.from !== left.entityTypeId || relation.to !== right.entityTypeId) fail("归属规则需要不同实体主绑定及对应关系");
      }
    }
  });
}
export const layeredModelSchema = createLayeredModelSchema();
export type LayeredModel = z.infer<typeof layeredModelSchema>;
export function parseLayeredModel(input: unknown, limits: Partial<ModelLimits> = {}): LayeredModel {
  const model = createLayeredModelSchema(limits).parse(input);
  for (const binding of model.bindings.entities.filter(binding => binding.role === "supplement" && binding.match)) {
    const primary = model.bindings.entities.find(item => item.role === "primary" && item.entityTypeId === binding.entityTypeId);
    if (!primary || model.bindings.identityRules.some(rule => rule.kind === "same_as" && rule.left.bindingId === binding.id && rule.right.bindingId === primary.id)) continue;
    const column = binding.match!.primaryPropertyId === "$id" ? primary.keyColumns[0] : model.bindings.properties.find(item => item.entityBindingId === primary.id && item.propertyId === binding.match!.primaryPropertyId)?.column;
    if (!column) continue;
    model.bindings.identityRules.push({ id: stable("identity_rule", binding.id, primary.id), kind: "same_as", left: { bindingId: binding.id, columns: [binding.match!.sourceColumn] }, right: { bindingId: primary.id, columns: [column] }, transform: { op: "none" }, legacy: true, reason: "迁移已有明确采用的补充绑定", evidence: binding.rationale || "已有补充绑定" });
  }
  return model;
}

export interface LegacySupplement {
  name: string; sourceId: string; capability: string;
  match: { primaryField: string; sourceField: string }; fields: Record<string, string>; rationale: string;
  propertyTransforms?: Record<string, PropertyTransform>;
  rowFilter?: Record<string, string | number | boolean>;
}
export interface LegacyType {
  id?: string; conceptId?: string; name: string; description: string; sourceId: string; capability: string;
  fields: Record<string, string>; supplements?: LegacySupplement[]; identityFields?: string[]; rowFilter?: Record<string, string | number | boolean>;
  propertyTransforms?: Record<string, PropertyTransform>;
}
export interface LegacyRelation {
  id?: string; relationId?: string; name: string; from: string; to: string; fromField: string; toField: string;
  fromColumns?: string[]; toColumns?: string[];
  linkTable?: { sourceId: string; capability: string; fromColumns: string[]; toColumns: string[] };
}
export interface LegacyModel { types: LegacyType[]; relations: LegacyRelation[] }
export interface MigrationOptions {
  capability?: (sourceId: string, capability: string) => { idField: string; idType?: "string" | "number" };
  limits?: Partial<ModelLimits>;
}
const stable = (prefix: string, ...parts: string[]) => `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;

/** No source row identifier is inferred from a column name; the caller supplies its source contract. */
export function migrateLegacyModel(legacy: LegacyModel, options: MigrationOptions = {}): LayeredModel {
  const model: LayeredModel = { schemaVersion: 1, semantic: { entityTypes: [], properties: [], relationTypes: [] }, bindings: { entities: [], properties: [], relations: [], identityRules: [] } };
  const byName = new Map<string, { type: LegacyType; id: string; bindingId: string; idField?: string }>();
  const entityOccurrences = new Map<string, number>();
  for (const type of legacy.types) {
    if (byName.has(type.name)) throw new Error("旧类型名称重复，不能确定语义引用");
    const cap = options.capability?.(type.sourceId, type.capability);
    const signature = JSON.stringify([type.sourceId, type.capability]);
    const occurrence = entityOccurrences.get(signature) ?? 0;
    if (!type.conceptId && !type.id) entityOccurrences.set(signature, occurrence + 1);
    const id = type.conceptId ?? type.id ?? stable("entity", signature, String(occurrence));
    const bindingId = stable("entity_binding", id, type.sourceId, type.capability, "primary");
    const keyColumns = type.identityFields ?? (cap ? [cap.idField] : []);
    const entity: LayeredModel["semantic"]["entityTypes"][number] = { id, name: type.name, aliases: [], description: type.description, identityKeys: [], kind: "record" };
    model.semantic.entityTypes.push(entity);
    model.bindings.entities.push({ id: bindingId, entityTypeId: id, role: "primary", dataset: { sourceId: type.sourceId, capability: type.capability }, keyColumns: [...keyColumns], ...(type.rowFilter ? { rowFilter: type.rowFilter } : {}) });
    byName.set(type.name, { type, id, bindingId, idField: cap?.idField });
    const properties = new Map<string, string>();
    const addProperty = (key: string, column: string, sourceBindingId: string, identity: boolean, transform: PropertyTransform = { op: "none" }) => {
      let propertyId = properties.get(key);
      if (!propertyId) {
        propertyId = stable("property", id, key);
        properties.set(key, propertyId);
        model.semantic.properties.push({ id: propertyId, entityTypeId: id, name: key, aliases: [], description: "", valueType: identity && column === cap?.idField ? cap.idType === "number" ? "decimal" : cap.idType === "string" ? "string" : "unknown" : "unknown", isIdentity: identity });
      }
      if (identity && !entity.identityKeys.includes(propertyId)) entity.identityKeys.push(propertyId);
      model.bindings.properties.push({ id: stable("property_binding", propertyId, sourceBindingId, column), propertyId, entityBindingId: sourceBindingId, column, transform });
      return propertyId;
    };
    const identityNames = keyColumns.map((column) => Object.keys(type.fields).find((key) => type.fields[key] === column) ?? (keyColumns.length === 1 ? "$id" : column));
    for (const [key, column] of Object.entries(type.fields)) addProperty(key, column, bindingId, identityNames.includes(key), type.propertyTransforms?.[key]);
    // identityKeys must follow source key order, including keys hidden by the old $id projection.
    entity.identityKeys = keyColumns.map((column) => {
      const key = identityNames[keyColumns.indexOf(column)];
      const existing = properties.get(key);
      return existing ?? addProperty(key, column, bindingId, true);
    });
    const supplementOccurrences = new Map<string, number>();
    for (const supplement of type.supplements ?? []) {
      const signature = JSON.stringify([supplement.sourceId, supplement.capability, supplement.match.primaryField, supplement.match.sourceField]);
      const occurrence = supplementOccurrences.get(signature) ?? 0;
      supplementOccurrences.set(signature, occurrence + 1);
      const supplementId = stable("entity_binding", id, signature, String(occurrence));
      const matchId = supplement.match.primaryField === "$id" ? "$id" : properties.get(supplement.match.primaryField);
      if (!matchId) throw new Error("旧附来源匹配起点不存在");
      model.bindings.entities.push({ id: supplementId, entityTypeId: id, name: supplement.name, role: "supplement", dataset: { sourceId: supplement.sourceId, capability: supplement.capability }, keyColumns: [supplement.match.sourceField], match: { primaryPropertyId: matchId, sourceColumn: supplement.match.sourceField }, rationale: supplement.rationale, ...(supplement.rowFilter ? { rowFilter: supplement.rowFilter } : {}) });
      const rightColumn = supplement.match.primaryField === "$id" ? cap?.idField : type.fields[supplement.match.primaryField];
      if (rightColumn) model.bindings.identityRules.push({ id: stable("identity_rule", supplementId, bindingId), kind: "same_as", left: { bindingId: supplementId, columns: [supplement.match.sourceField] }, right: { bindingId, columns: [rightColumn] }, transform: { op: "none" }, legacy: true, reason: "迁移已有明确采用的补充绑定", evidence: supplement.rationale || "已有补充绑定" });
      for (const [key, column] of Object.entries(supplement.fields)) addProperty(key, column, supplementId, false, supplement.propertyTransforms?.[key]);
    }
  }
  const relationOccurrences = new Map<string, number>();
  for (const relation of legacy.relations) {
    const from = byName.get(relation.from), to = byName.get(relation.to);
    if (!from || !to) throw new Error("旧关系端点不存在");
    const resolveColumn = (entry: NonNullable<typeof from>, field: string) => field === "$id" ? entry.idField ?? entry.type.identityFields?.[0] : entry.type.fields[field];
    const fromColumns = relation.fromColumns ?? [resolveColumn(from, relation.fromField)];
    const toColumns = relation.toColumns ?? [resolveColumn(to, relation.toField)];
    if (fromColumns.some((column) => !column) || toColumns.some((column) => !column)) throw new Error("旧关系列不能确定，请提供来源身份契约");
    const signature = JSON.stringify([from.id, to.id, fromColumns, toColumns]);
    const occurrence = relationOccurrences.get(signature) ?? 0;
    if (!relation.relationId && !relation.id) relationOccurrences.set(signature, occurrence + 1);
    const id = relation.relationId ?? relation.id ?? stable("relation", signature, String(occurrence));
    model.semantic.relationTypes.push({ id, name: relation.name, aliases: [], description: "", from: from.id, to: to.id, direction: "directed", cardinality: relation.linkTable ? "N:N" : "N:1", allowSelf: from.id === to.id });
    const base = { id: stable("relation_binding", id, from.bindingId, to.bindingId, JSON.stringify(relation.linkTable ?? { fromColumns, toColumns })), relationTypeId: id, fromBindingId: from.bindingId, toBindingId: to.bindingId };
    model.bindings.relations.push(relation.linkTable ? { ...base, kind: "link_table", dataset: { sourceId: relation.linkTable.sourceId, capability: relation.linkTable.capability }, fromColumns: relation.linkTable.fromColumns, toColumns: relation.linkTable.toColumns } : { ...base, kind: "foreign_key", fromColumns: fromColumns as string[], toColumns: toColumns as string[] });
  }
  return parseLayeredModel(model, options.limits);
}

/** Compatibility projection. Execution must explicitly opt in to applying finite transforms. */
export function projectLegacyModel(input: LayeredModel, options: { allowTransforms?: boolean; limits?: Partial<ModelLimits> } = {}): LegacyModel {
  const model = parseLayeredModel(input, options.limits);
  const entities = new Map(model.semantic.entityTypes.map((item) => [item.id, item]));
  const entityBindings = new Map(model.bindings.entities.map((item) => [item.id, item]));
  const properties = new Map(model.semantic.properties.map((item) => [item.id, item]));
  const fieldMap = (bindingId: string) => {
    const fields: Record<string, string> = Object.create(null), propertyTransforms: Record<string, PropertyTransform> = Object.create(null);
    for (const binding of model.bindings.properties.filter((item) => item.entityBindingId === bindingId)) {
      const property = properties.get(binding.propertyId)!;
      if (property.name === "$id") continue;
      if (Object.hasOwn(fields, property.name)) throw new Error("旧接口不能表示同名属性的多个源列");
      fields[property.name] = binding.column;
      if (binding.transform.op !== "none") {
        if (!options.allowTransforms) throw new Error("旧接口不能忽略属性转换，请启用转换执行");
        propertyTransforms[property.name] = binding.transform;
      }
    }
    return { fields: { ...fields }, ...(Object.keys(propertyTransforms).length ? { propertyTransforms: { ...propertyTransforms } } : {}) };
  };
  const types: LegacyType[] = [];
  for (const entity of entities.values()) {
    const primary = model.bindings.entities.find((item) => item.entityTypeId === entity.id && item.role === "primary");
    if (!primary) continue;
    if (types.some((item) => item.name === entity.name)) throw new Error("旧接口不能表示同名实体");
    const supplements: LegacySupplement[] = [];
    for (const binding of model.bindings.entities.filter((item) => item.entityTypeId === entity.id && item.role === "supplement")) {
      if (!binding.match) throw new Error("旧接口不能表示复合身份附来源匹配");
      const matchProperty = properties.get(binding.match.primaryPropertyId);
      const primaryField = binding.match.primaryPropertyId === "$id" || matchProperty?.name === "$id" ? "$id" : matchProperty!.name;
      supplements.push({ name: binding.name ?? `${binding.dataset.sourceId}/${binding.dataset.capability}`, ...binding.dataset, match: { primaryField, sourceField: binding.match.sourceColumn }, ...fieldMap(binding.id), rationale: binding.rationale ?? "", ...(binding.rowFilter ? { rowFilter: binding.rowFilter } : {}) });
    }
    types.push({ name: entity.name, description: entity.description, conceptId: entity.id, ...primary.dataset, ...fieldMap(primary.id), identityFields: [...primary.keyColumns], ...(primary.rowFilter ? { rowFilter: primary.rowFilter } : {}), ...(supplements.length ? { supplements } : {}) });
  }
  const fieldFor = (bindingId: string, column: string) => {
    const binding = entityBindings.get(bindingId)!;
    const propertyBinding = model.bindings.properties.find((item) => item.entityBindingId === bindingId && item.column === column);
    if (propertyBinding) return properties.get(propertyBinding.propertyId)!.name;
    if (binding.keyColumns.length === 1 && binding.keyColumns[0] === column) return "$id";
    throw new Error("旧接口不能表示无属性绑定的关系列");
  };
  const relations: LegacyRelation[] = [];
  for (const binding of model.bindings.relations) {
    const semantic = model.semantic.relationTypes.find((item) => item.id === binding.relationTypeId)!;
    const from = entities.get(semantic.from)!, to = entities.get(semantic.to)!;
    const fromBinding = entityBindings.get(binding.fromBindingId)!, toBinding = entityBindings.get(binding.toBindingId)!;
    if (fromBinding.role !== "primary" || toBinding.role !== "primary") throw new Error("旧接口不能表示附来源关系端点");
    const fromColumns = binding.kind === "link_table" ? fromBinding.keyColumns : binding.fromColumns;
    const toColumns = binding.kind === "link_table" ? toBinding.keyColumns : binding.toColumns;
    relations.push({ name: semantic.name, relationId: semantic.id, from: from.name, to: to.name, fromField: fieldFor(fromBinding.id, fromColumns[0]), toField: fieldFor(toBinding.id, toColumns[0]), fromColumns: [...fromColumns], toColumns: [...toColumns], ...(binding.kind === "link_table" ? { linkTable: { ...binding.dataset, fromColumns: [...binding.fromColumns], toColumns: [...binding.toColumns] } } : {}) });
  }
  return { types, relations };
}

/** Rebind existing semantic objects without replacing their human-maintained identity or meaning. */
export function reconcileLayeredModel(previousInput: LayeredModel, nextInput: LayeredModel): LayeredModel {
  const previous = parseLayeredModel(previousInput), next = parseLayeredModel(nextInput);
  const propertyIds = new Map<string, string>();
  next.semantic.properties = next.semantic.properties.map(property => {
    const prior = previous.semantic.properties.find(item => item.entityTypeId === property.entityTypeId && item.id === property.id)
      ?? previous.semantic.properties.find(item => item.entityTypeId === property.entityTypeId && item.name === property.name);
    propertyIds.set(property.id, prior?.id ?? property.id);
    return prior ? { ...prior, name: property.name, entityTypeId: property.entityTypeId, isIdentity: property.isIdentity } : property;
  });
  next.semantic.entityTypes = next.semantic.entityTypes.map(entity => {
    const prior = previous.semantic.entityTypes.find(item => item.id === entity.id);
    return { ...entity, ...(prior ? { aliases: prior.aliases, kind: prior.kind } : {}), identityKeys: entity.identityKeys.map(id => propertyIds.get(id) ?? id) };
  });
  next.semantic.relationTypes = next.semantic.relationTypes.map(relation => {
    const prior = previous.semantic.relationTypes.find(item => item.id === relation.id);
    return prior ? { ...prior, name: relation.name, from: relation.from, to: relation.to, description: relation.description || prior.description } : relation;
  });

  const bindingIds = new Map<string, string>(), usedBindings = new Set<string>();
  next.bindings.entities = next.bindings.entities.map(binding => {
    const prior = previous.bindings.entities.find(item => !usedBindings.has(item.id) && item.id === binding.id && item.entityTypeId === binding.entityTypeId)
      ?? previous.bindings.entities.find(item => !usedBindings.has(item.id) && item.entityTypeId === binding.entityTypeId && item.role === binding.role && item.dataset.sourceId === binding.dataset.sourceId && item.dataset.capability === binding.dataset.capability);
    if (prior) usedBindings.add(prior.id);
    const id = prior?.id ?? binding.id;
    bindingIds.set(binding.id, id);
    return { ...binding, id, ...(binding.match ? { match: { ...binding.match, primaryPropertyId: propertyIds.get(binding.match.primaryPropertyId) ?? binding.match.primaryPropertyId } } : {}) };
  });
  next.bindings.properties = next.bindings.properties.map(binding => {
    const propertyId = propertyIds.get(binding.propertyId) ?? binding.propertyId;
    const entityBindingId = bindingIds.get(binding.entityBindingId) ?? binding.entityBindingId;
    const prior = previous.bindings.properties.find(item => item.propertyId === propertyId && item.entityBindingId === entityBindingId);
    return { ...binding, id: prior?.id ?? binding.id, propertyId, entityBindingId };
  });
  const usedRelations = new Set<string>();
  next.bindings.relations = next.bindings.relations.map(binding => {
    const fromBindingId = bindingIds.get(binding.fromBindingId) ?? binding.fromBindingId;
    const toBindingId = bindingIds.get(binding.toBindingId) ?? binding.toBindingId;
    const prior = previous.bindings.relations.find(item => !usedRelations.has(item.id) && item.relationTypeId === binding.relationTypeId && item.kind === binding.kind && item.fromBindingId === fromBindingId && item.toBindingId === toBindingId);
    if (prior) usedRelations.add(prior.id);
    return { ...binding, id: prior?.id ?? binding.id, fromBindingId, toBindingId };
  });
  const currentRules = new Map(next.bindings.identityRules.map(rule => [rule.id, rule]));
  for (const rule of previous.bindings.identityRules) {
    if (!next.bindings.entities.some(binding => binding.id === rule.left.bindingId) || !next.bindings.entities.some(binding => binding.id === rule.right.bindingId)) continue;
    for (const [id, candidate] of currentRules) if (candidate.kind === rule.kind && candidate.left.bindingId === rule.left.bindingId && candidate.right.bindingId === rule.right.bindingId) currentRules.delete(id);
    currentRules.set(rule.id, rule);
  }
  next.bindings.identityRules = [...currentRules.values()].map(rule => ({ ...rule,
    left: { ...rule.left, bindingId: bindingIds.get(rule.left.bindingId) ?? rule.left.bindingId },
    right: { ...rule.right, bindingId: bindingIds.get(rule.right.bindingId) ?? rule.right.bindingId } }));
  return parseLayeredModel(next);
}

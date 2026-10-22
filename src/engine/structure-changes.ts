import { z } from "zod";
import { namingSubject, descriptionSubject, prepareWordingEdits } from "./wording-changes.ts";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { FoundationService } from "../agent/foundation.ts";
import type { LiveMemory } from "../live/memory.ts";
import type { Snapshots } from "../data/snapshots.ts";
import { layeredModelSchema, parseLayeredModel, type LayeredModel } from "../semantic/model.ts";
import { prepareCorrectionMigration } from "../live/correction-migration.ts";
import { prepareIdentityDecisionMigration } from "../live/identity-migration.ts";
import { quote } from "../data/executor/engine.ts";
import { transformed } from "../semantic/query-sql.ts";
import { verifySnapshotRelation } from "./relation-verification.ts";
import { ChangeConflict, type OntologyChanges } from "./changes.ts";
import { fingerprint } from "./release-diff.ts";
import { jsonData } from "../live/sources.ts";

const ref = (artifact: Artifact) => ({ id: artifact.id, version: artifact.version });
const propertySchema = layeredModelSchema.shape.semantic.shape.properties.element;
const semanticProperty = (value: Data) => propertySchema.parse(Object.fromEntries(Object.keys(propertySchema.shape).filter(key => value[key] !== undefined).map(key => [key, value[key]])));
const propertyBindingSchema = layeredModelSchema.shape.bindings.shape.properties.element;
const action = z.enum(["add", "update", "remove"]);
const itemPatch = z.object({ id: z.string().trim().min(1).max(100) }).catchall(z.unknown());
const propertySubject = z.object({ action, property: itemPatch,
  binding: propertyBindingSchema.omit({ id: true, propertyId: true }).optional() }).strict();
const entitySubject = z.object({ action, entity: itemPatch }).strict();
const bindingSubject = z.object({ action, kind: z.enum(["entity", "property", "relation"]), binding: itemPatch,
  properties: z.array(propertyBindingSchema.omit({ id: true, entityBindingId: true })).max(100).optional() }).strict();
const rows = (value: unknown): Data[] => Array.isArray(value) ? structuredClone(value) : [];
const literal = (value: unknown) => typeof value === "number" ? String(value) : typeof value === "boolean" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;

/** Fixed semantic IDs and source references, shared by the editor and Agent proposals. */
export function readStructure(memory: MemoryStore, foundation: FoundationService, live: LiveMemory): LayeredModel {
  const adopted = foundation.read().adopted;
  const model = memory.listArtifacts("live_ontology").find(item => item.status === "adopted");
  if (model) {
    const layered = live.readLayered(model.id);
    for (const item of rows(adopted?.content.concepts)) if (!layered.semantic.entityTypes.some(entity => entity.id === item.id))
      layered.semantic.entityTypes.push({ id: String(item.id), name: String(item.name), aliases: (item.aliases ?? []) as string[], description: String(item.description), identityKeys: (item.identityKeys ?? []) as string[], kind: item.kind === "activity" ? "activity" : "record" });
    for (const item of rows(adopted?.content.properties)) if (!layered.semantic.properties.some(property => property.id === item.id)) layered.semantic.properties.push(semanticProperty(item));
    layered.semantic.metricReferences = layeredModelSchema.shape.semantic.shape.metricReferences.parse(adopted?.content.metricReferences ?? []);
    return parseLayeredModel(layered);
  }
  return parseLayeredModel({ schemaVersion: 1, semantic: {
    entityTypes: rows(adopted?.content.concepts).map(item => ({ id: item.id, name: item.name, aliases: item.aliases ?? [], description: item.description, identityKeys: item.identityKeys ?? [], kind: item.kind ?? "record" })),
    properties: rows(adopted?.content.properties).map(semanticProperty),
    metricReferences: adopted?.content.metricReferences ?? [],
    relationTypes: rows(adopted?.content.relations).map(item => ({ id: item.id, name: item.name, aliases: item.aliases ?? [], description: item.description, from: item.from, to: item.to, allowSelf: item.from === item.to })),
  }, bindings: { entities: [], properties: [], relations: [], identityRules: [] } });
}

export function connectStructureChanges(memory: MemoryStore, foundation: FoundationService, live: LiveMemory, snapshots: Snapshots, changes: OntologyChanges) {
  for (const type of ["naming", "description"] as const) changes.registerHandler(type, { subject: type === "naming" ? namingSubject : descriptionSubject,
    prepare: async change => { const prepared = await prepareWordingEdits(memory, foundation, live, changes, [change]); return { ...prepared, apply: () => prepared.apply()[0] }; } });
  const schemas = { property: propertySubject, entity: entitySubject, binding: bindingSubject };
  for (const type of ["property", "entity", "binding"] as const) changes.registerHandler(type, { subject: schemas[type], prepare: async change => {
    const subject = schemas[type].parse(change.content.subject), existingBase = foundation.read().adopted;
    const base: Artifact = existingBase ?? { id: `foundation_${fingerprint(change.id).slice(0, 24)}`, version: 0, kind: "foundation", title: "工作本体", status: "adopted", createdAt: "",
      content: { enterprise: { name: "未设置企业", evidenceRefs: [] }, concepts: [], relations: [], properties: [], evidence: [], unknowns: [], conflicts: [], profileRef: null, adoptedVersion: null, checks: { valid: true } } };
    const model = memory.listArtifacts("live_ontology").find(item => item.status === "adopted");
    const layered = readStructure(memory, foundation, live);
    const patch = <T extends { id: string }>(items: T[], update: Record<string, unknown> & { id: string }, schema: z.ZodType<T>) => {
      const index = items.findIndex(item => item.id === update.id);
      if (subject.action === "add" && index >= 0) throw new Error("对象标识已存在，请使用修改操作");
      if (subject.action !== "add" && index < 0) throw new Error("要修改的对象不存在");
      if (subject.action === "remove") { items.splice(index, 1); return; }
      const merged = { ...(index >= 0 ? items[index] : {}), ...update } as Record<string, unknown>;
      if (type === "property" && subject.action === "update" && update.unit === null) delete merged.unit;
      const parsed = schema.parse(merged);
      if (index >= 0) items[index] = parsed; else items.push(parsed);
    };
    if ("entity" in subject) {
      const id = subject.entity.id;
      if (subject.action === "remove" && (layered.semantic.properties.some(item => item.entityTypeId === id) || layered.semantic.relationTypes.some(item => item.from === id || item.to === id) || layered.bindings.entities.some(item => item.entityTypeId === id)))
        throw new Error("实体仍有属性、关系或来源绑定依赖，请先显式处理这些依赖");
      patch(layered.semantic.entityTypes, subject.entity, layeredModelSchema.shape.semantic.shape.entityTypes.element);
    } else if ("property" in subject) {
      const previous = layered.semantic.properties.find(item => item.id === subject.property.id);
      if (previous && subject.property.entityTypeId && previous.entityTypeId !== subject.property.entityTypeId) throw new Error("不能将已有属性移动到另一实体");
      if (subject.action === "remove" && (layered.bindings.properties.some(item => item.propertyId === subject.property.id) || layered.bindings.entities.some(item => item.match?.primaryPropertyId === subject.property.id)))
        throw new Error("属性仍有绑定或身份匹配依赖，请先显式处理这些依赖");
      patch(layered.semantic.properties, subject.property, propertySchema);
      for (const entity of layered.semantic.entityTypes) {
        const retained = entity.identityKeys.filter(id => layered.semantic.properties.some(item => item.id === id && item.isIdentity));
        entity.identityKeys = [...new Set([...retained, ...layered.semantic.properties.filter(item => item.entityTypeId === entity.id && item.isIdentity).map(item => item.id)])];
      }
      if (subject.binding) {
        if (subject.action === "remove") throw new Error("移除属性不能同时添加绑定");
        const propertyId = subject.property.id;
        const existing = layered.bindings.properties.find(item => item.propertyId === propertyId && item.entityBindingId === subject.binding!.entityBindingId);
        const binding = { ...subject.binding, id: existing?.id ?? `property_binding_${fingerprint({ propertyId, entityBindingId: subject.binding.entityBindingId }).slice(0, 24)}`, propertyId };
        if (existing) Object.assign(existing, binding); else layered.bindings.properties.push(binding);
      }
    } else {
      const schema = subject.kind === "entity" ? layeredModelSchema.shape.bindings.shape.entities.element : subject.kind === "property" ? propertyBindingSchema : layeredModelSchema.shape.bindings.shape.relations.element;
      const key = subject.kind === "entity" ? "entities" : subject.kind === "property" ? "properties" : "relations";
      if (subject.kind === "entity" && subject.action === "update" && layered.bindings.identityRules.some(item => item.left.bindingId === subject.binding.id || item.right.bindingId === subject.binding.id))
        throw new Error("该绑定参与已采用的身份规则，请通过身份规则变更明确处理范围");
      if (subject.action === "remove" && subject.kind === "entity" && (layered.bindings.properties.some(item => item.entityBindingId === subject.binding.id) || layered.bindings.relations.some(item => item.fromBindingId === subject.binding.id || item.toBindingId === subject.binding.id) || layered.bindings.identityRules.some(item => item.left.bindingId === subject.binding.id || item.right.bindingId === subject.binding.id)))
        throw new Error("来源绑定仍有属性、关系或身份规则依赖，请先显式处理这些依赖");
      patch(layered.bindings[key] as Array<{ id: string }>, subject.binding, schema);
      if (subject.properties) {
        if (subject.kind !== "entity" || subject.action === "remove") throw new Error("只有新增或修改实体绑定可以声明属性映射");
        for (const property of subject.properties) {
          if (layered.bindings.properties.some(item => item.entityBindingId === subject.binding.id && item.propertyId === property.propertyId)) throw new Error("属性映射已存在，请单独修改，不能隐式覆盖");
          layered.bindings.properties.push({ ...property, entityBindingId: subject.binding.id, id: `property_binding_${fingerprint({ propertyId: property.propertyId, entityBindingId: subject.binding.id }).slice(0, 24)}` });
        }
      }
    }
    const uniqueNames = (items: Array<{ name: string }>) => new Set(items.map(item => item.name.trim().toLowerCase())).size === items.length;
    if (!uniqueNames(layered.semantic.entityTypes) || layered.semantic.entityTypes.some(entity => !uniqueNames(layered.semantic.properties.filter(item => item.entityTypeId === entity.id)))) throw new Error("同类对象名称重复");
    parseLayeredModel(layered);
    const oldConcepts = rows(base.content.concepts);
    const governedEntities = new Set("entity" in subject ? [subject.entity.id] : "property" in subject ? layered.semantic.properties.filter(item => item.id === subject.property.id).map(item => item.entityTypeId)
      : subject.kind === "entity" ? layered.bindings.entities.filter(item => item.id === subject.binding.id).map(item => item.entityTypeId)
        : subject.kind === "property" ? layered.semantic.properties.filter(property => layered.bindings.properties.some(binding => binding.id === subject.binding.id && binding.propertyId === property.id)).map(item => item.entityTypeId) : []);
    const concepts = layered.semantic.entityTypes.map(item => ({ ...oldConcepts.find(prior => prior.id === item.id), ...item, origin: oldConcepts.find(prior => prior.id === item.id)?.origin ?? "human", governed: oldConcepts.find(prior => prior.id === item.id)?.governed === true || governedEntities.has(item.id), evidenceRefs: oldConcepts.find(prior => prior.id === item.id)?.evidenceRefs ?? [] }));
    const properties = layered.semantic.properties.map(item => {
      const saved = { ...rows(base.content.properties).find(prior => prior.id === item.id), ...item };
      if ("property" in subject && subject.property.id === item.id && subject.property.unit === null) delete saved.unit;
      return saved;
    });
    const virtual: Artifact = { ...base, version: base.version + 1, content: { ...base.content, concepts: jsonData(concepts), properties: jsonData(properties) } };
    const definition = layered.bindings.entities.some(binding => binding.role === "primary")
      ? await live.prepareDefinitionAgainst({ layered, foundationRef: ref(virtual), baseModelRef: model ? ref(model) : null, purpose: model?.content.purpose ?? "明确编辑的业务本体", rationale: String(change.content.evidence ?? "结构编辑") }, virtual)
      : undefined;
    if (model && !definition) throw new Error("不能隐式移除最后一个可执行绑定，请使用明确的弃用操作");
    const captured: Record<string, string> = {};
    for (const binding of layered.bindings.entities) {
      const dataset = snapshots.bindingDataset(binding.dataset.sourceId, binding.dataset.capability);
      if (!dataset?.content.activeVersion || dataset.content.materialization === "live") throw new Error("结构复验需要已同步快照，请先同步来源");
      captured[dataset.id] = String(dataset.content.activeVersion);
    }
    let checkedRecords = 0, invalidValues = 0, validIdentities = true;
    const affectedProperties = layered.bindings.properties.filter(binding => "property" in subject ? binding.propertyId === subject.property.id
      : "entity" in subject ? layered.semantic.properties.find(item => item.id === binding.propertyId)?.entityTypeId === subject.entity.id
        : subject.kind === "entity" ? binding.entityBindingId === subject.binding.id : subject.kind === "property" && binding.id === subject.binding.id);
    for (const mappedProperty of affectedProperties) {
      const binding = layered.bindings.entities.find(item => item.id === mappedProperty.entityBindingId)!;
      const dataset = snapshots.bindingDataset(binding.dataset.sourceId, binding.dataset.capability)!;
      const column = transformed(quote(mappedProperty.column), mappedProperty.transform), property = layered.semantic.properties.find(item => item.id === mappedProperty.propertyId)!;
      const sqlType = ({ integer: "BIGINT", decimal: "DOUBLE", boolean: "BOOLEAN", date: "DATE", datetime: "TIMESTAMP" } as Record<string, string>)[property.valueType];
      const numeric = `TRY_CAST(${column} AS DOUBLE)`;
      const typeCompatible = property.valueType === "string" ? `typeof(${column}) IN ('VARCHAR','CHAR')`
        : ["integer", "decimal"].includes(property.valueType) ? `regexp_matches(typeof(${column}), '^(U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|DECIMAL|DOUBLE|FLOAT|REAL)')`
          : property.valueType === "boolean" ? `typeof(${column}) = 'BOOLEAN'` : "true";
      const invalid = property.valueType === "enum" ? `${column} NOT IN (${property.enumValues!.map(item => literal(item.value)).join(",")})`
        : property.valueType === "integer" ? `${numeric} IS NULL OR NOT isfinite(${numeric}) OR ${numeric} <> trunc(${numeric})`
          : sqlType ? `TRY_CAST(${column} AS ${sqlType}) IS NULL` : "false";
      const filter = Object.entries(binding.rowFilter ?? {}).map(([key, value]) => `${quote(key)} = ${literal(value)}`).join(" AND ") || "true";
      const checked = await snapshots.query([{ datasetId: dataset.id, snapshotId: captured[dataset.id] }], `SELECT count(*) AS total, count(${column}) AS transformed_values, count(*) FILTER (WHERE ${column} IS NOT NULL AND (NOT (${typeCompatible}) OR (${invalid}))) AS invalid FROM ${quote(snapshots.table(dataset.id))} WHERE ${filter}`, { limit: 1 });
      checkedRecords += Number(checked.rows[0].total); invalidValues += Number(checked.rows[0].invalid);
    }
    const affectedBindings = layered.bindings.entities.filter(binding => binding.role === "primary" && ("kind" in subject && subject.kind === "entity" && subject.binding.id === binding.id || "entity" in subject && subject.entity.id === binding.entityTypeId));
    for (const binding of affectedBindings) {
      if (!binding.keyColumns.length) throw new Error("实体主绑定需要明确身份列");
      const dataset = snapshots.bindingDataset(binding.dataset.sourceId, binding.dataset.capability)!;
      const key = binding.keyColumns.map(quote), filter = Object.entries(binding.rowFilter ?? {}).map(([column, value]) => `${quote(column)} = ${literal(value)}`).join(" AND ") || "true";
      const filled = key.map(column => `${column} IS NOT NULL AND trim(CAST(${column} AS VARCHAR)) <> ''`).join(" AND ");
      const checked = await snapshots.query([{ datasetId: dataset.id, snapshotId: captured[dataset.id] }], `SELECT count(*) AS total, count(*) FILTER (WHERE ${filled}) AS filled, count(DISTINCT (${key.join(",")})) AS unique_keys FROM ${quote(snapshots.table(dataset.id))} WHERE ${filter}`, { limit: 1 });
      const result = checked.rows[0];
      validIdentities &&= Number(result.total) === Number(result.filled) && Number(result.total) === Number(result.unique_keys);
    }
    const relationChecks = [];
    const affectedRelations = layered.bindings.relations.filter(binding => "kind" in subject && (subject.kind === "relation" && binding.id === subject.binding.id || subject.kind === "entity" && [binding.fromBindingId, binding.toBindingId].includes(subject.binding.id)));
    for (const binding of affectedRelations) {
      const from = layered.bindings.entities.find(item => item.id === binding.fromBindingId)!, to = layered.bindings.entities.find(item => item.id === binding.toBindingId)!;
      const relation = layered.semantic.relationTypes.find(item => item.id === binding.relationTypeId)!;
      if (binding.kind !== "foreign_key" || binding.fromColumns.length !== 1 || binding.toColumns.length !== 1 || from.rowFilter || to.rowFilter || !["N:1", "1:1"].includes(relation.cardinality)) throw new Error("此关系绑定需要独立的复合、筛选或中间表复验，不能用普通外键检查代替");
      const checked = await verifySnapshotRelation(snapshots, { from: { datasetId: snapshots.bindingDataset(from.dataset.sourceId, from.dataset.capability)!.id, column: binding.fromColumns[0] }, to: { datasetId: snapshots.bindingDataset(to.dataset.sourceId, to.dataset.capability)!.id, column: binding.toColumns[0] }, cardinality: relation.cardinality as "N:1" | "1:1", acyclic: relation.acyclic, maxDepth: relation.maxDepth });
      relationChecks.push({ id: binding.id, ...checked });
    }
    const complete = Object.keys(captured).every(id => (snapshots.dataset(id).content.coverage as Data | undefined)?.complete === true);
    const failed = invalidValues > 0 || !validIdentities || relationChecks.some(check => check.result === "failed");
    const corrections = definition ? await prepareCorrectionMigration(memory, live, definition) : undefined, identities = definition ? await prepareIdentityDecisionMigration(memory, live, definition) : undefined;
    const assertCurrent = () => {
      if (fingerprint(changes.currentBaseline()) !== fingerprint(change.content.baseline)) throw new ChangeConflict("stale_baseline", "结构编辑基线已变化，请重新复验");
      for (const [id, version] of Object.entries(captured)) if (snapshots.dataset(id).content.activeVersion !== version || snapshots.dataset(id).content.materialization === "live") throw new ChangeConflict("verification_changed", "结构复验的来源快照已变化");
      for (const [id, version] of Object.entries((definition?.connections ?? {}) as Data)) {
        const connection = memory.getArtifact(id);
        if (connection.status !== "ready" || connection.version !== version) throw new ChangeConflict("verification_changed", "来源定义或权限已变化");
      }
    };
    assertCurrent();
    return { verification: { result: failed ? "failed" as const : !complete || relationChecks.some(check => check.result === "review") ? "review" as const : "passed" as const,
      metrics: { checkedRecords, invalidValues, validIdentities, complete, bound: layered.bindings.entities.length > 0 }, notes: [...(invalidValues ? ["来源包含不符合属性类型的值"] : []), ...(!validIdentities ? ["身份列存在空值或重复，不能唯一定位对象"] : []), ...(!complete ? ["来源覆盖不完整，需核对已保存范围"] : []), ...relationChecks.flatMap(check => check.notes)],
      inputs: { snapshots: captured, baseline: change.content.baseline, facts: rows(definition?.checks).map(check => check.factsFingerprint), relationChecks: jsonData(relationChecks) } }, previewDefinition: definition, previewFoundation: virtual,
      apply: () => {
        assertCurrent();
        if (failed) throw new Error("结构复验失败");
        const semantic = existingBase ? memory.putArtifact({ ...base, expectedVersion: base.version, content: virtual.content })
          : memory.createArtifact(virtual.id, { kind: "foundation", title: virtual.title, status: "adopted", content: virtual.content });
        const mapped = definition ? memory.putArtifact({ kind: "live_ontology", title: model?.title ?? "业务对象映射", status: "adopted", content: { ...definition, foundationRef: ref(semantic) } }) : null;
        if (mapped) { corrections!(mapped); identities!(mapped); }
        return { foundationRef: ref(semantic), modelRef: mapped ? ref(mapped) : null, targetId: "property" in subject ? subject.property.id : "entity" in subject ? subject.entity.id : subject.binding.id };
      } };
  } });
}

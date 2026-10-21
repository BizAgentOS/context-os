import type { Artifact, Data, Repository } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { LiveMemory, SnapshotPins } from "./memory.ts";
import { pinKey } from "./memory.ts";
import type { IdentityDecisionPins } from "./identity.ts";
import type { ReadMode } from "./reading-contract.ts";
import { parseLayeredModel, type LayeredModel } from "../semantic/model.ts";
import { fingerprint } from "../engine/release-diff.ts";
import { jsonData } from "./sources.ts";

/** Host-only preview records are never accepted from a public query payload. */
export type PropertyCorrectionPins = boolean | ReadonlySet<string> | { readonly records: readonly Artifact[] };
export interface PropertyCorrectionReading {
  readMode?: ReadMode; pins?: SnapshotPins; fixedSemantic?: boolean; modelDefinition?: Data;
  preparedFoundation?: Artifact; identityDecisionPins?: IdentityDecisionPins; assertActive?: () => void;
}
const reference = (item: Artifact) => ({ id: item.id, version: item.version });
export const propertyCorrectionKey = (content: Data) => fingerprint([content.entityTypeId, content.objectId, content.propertyId]);

export function propertyCorrectionsForModel(repo: Repository, model: Artifact, pins: PropertyCorrectionPins = true): Artifact[] {
  if (pins === false) return [];
  const records = pins === true ? repo.listArtifacts("property_correction") : "records" in pins ? pins.records : [...pins].map(pin => {
    const split = pin.lastIndexOf("@"), version = Number(pin.slice(split + 1));
    if (split < 1 || !Number.isSafeInteger(version) || version < 1) throw new Error("属性纠正固定版本无效");
    return repo.getArtifact(pin.slice(0, split), version);
  });
  return records.filter(item => {
    const target = item.content.modelRef as Data | undefined;
    return item.kind === "property_correction" && item.status === "adopted" && target?.id === model.id && target.version === model.version;
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/** Display wording is excluded; every input that can change object membership or the property's value is retained. */
export function propertyCorrectionScope(layered: LayeredModel, entityTypeId: string, propertyId: string) {
  const entity = layered.semantic.entityTypes.find(item => item.id === entityTypeId);
  const property = layered.semantic.properties.find(item => item.id === propertyId && item.entityTypeId === entityTypeId);
  if (!entity || !property) throw new Error("纠正对应的实体或属性已移除");
  const properties = layered.bindings.properties.filter(item => item.propertyId === propertyId);
  const entities = layered.bindings.entities.filter(item => item.entityTypeId === entityTypeId).map(({ name, rationale, ...item }) => item);
  const ids = new Set(entities.map(item => item.id));
  const identityRules = layered.bindings.identityRules.filter(item => ids.has(item.left.bindingId) || ids.has(item.right.bindingId))
    .map(({ reason, evidence, ...item }) => item);
  return fingerprint({ entityTypeId, identityKeys: entity.identityKeys, propertyId, valueType: property.valueType, enumValues: property.enumValues ?? null,
    entities, properties, identityRules });
}

export function assertPropertyCorrectionValue(property: LayeredModel["semantic"]["properties"][number], value: unknown) {
  if (property.isIdentity) throw new Error("身份键不能用属性值纠正修改，请使用身份治理");
  if (value === null) return;
  const valid = property.valueType === "unknown" ? ["string", "number", "boolean"].includes(typeof value)
    : property.valueType === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
    : property.valueType === "decimal" ? typeof value === "number" && Number.isFinite(value)
    : property.valueType === "boolean" ? typeof value === "boolean"
    : property.valueType === "enum" ? property.enumValues?.some(item => item.value === value)
    : property.valueType === "date" ? typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
    : property.valueType === "datetime" ? typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))
    : typeof value === "string";
  if (!valid) throw new Error("纠正值与属性类型或枚举范围不一致");
}

export async function capturePropertyCorrection(live: LiveMemory, model: Artifact, content: Data, options: PropertyCorrectionReading = {}) {
  const active = options.assertActive ?? (() => {});
  active();
  const projected = options.modelDefinition ?? (options.fixedSemantic ? model.content : live.projectModel(model).content);
  const layered = parseLayeredModel(projected.layered ?? live.readLayered(model.id, options.fixedSemantic ? model.version : undefined));
  const entity = layered.semantic.entityTypes.find(item => item.id === content.entityTypeId);
  const property = layered.semantic.properties.find(item => item.id === content.propertyId && item.entityTypeId === entity?.id);
  if (!entity || !property) throw new Error("需要当前实体的稳定属性编号");
  assertPropertyCorrectionValue(property, content.value);
  const result = await live.query({ modelId: model.id, modelVersion: model.version, type: entity.name, id: String(content.objectId), fields: ["$id", property.name], limit: 2,
    ...(options.readMode ? { readMode: options.readMode } : {}) }, active, false, projected, options.fixedSemantic ?? false,
    options.readMode === "release_pinned" ? options.pins : undefined,
    options.pins ? { readMode: options.readMode ?? "active_snapshot", pins: options.pins } : undefined,
    options.identityDecisionPins, options.preparedFoundation, false);
  active();
  if (result.items.length !== 1 || String(result.items[0].$id) !== content.objectId || !result.coverage.complete)
    throw new Error("纠正对象不存在、不唯一或读取不完整，请使用规范对象编号");
  const evidence = result.evidence?.find(item => String(item.objectId) === content.objectId)?.properties[property.name];
  if (!evidence || evidence.evidence.some(item => !item.eligible) || result.evidence?.some(item => item.matches.some(match => match.status === "unavailable" || match.coverage && !match.coverage.complete)))
    throw new Error("属性依据不可用或读取不完整，不能形成纠正基线");
  const facts = jsonData({ objectId: content.objectId, value: evidence.value, status: evidence.status, blockers: evidence.blockers,
    evidence: evidence.evidence.map(item => ({ sourceId: item.sourceId, recordId: item.recordId, field: item.field, value: item.value,
      transformedValue: item.transformedValue ?? null, eligible: item.eligible })) });
  const scope = propertyCorrectionScope(layered, entity.id, property.id);
  return { fingerprint: fingerprint({ scope, facts }), scope, snapshot: jsonData({ facts, evidence, reading: { readMode: result.readMode, versions: result.versions, sources: result.sources } }),
    entityName: entity.name, propertyName: property.name };
}

/** Validation replays the original facts with the caller's exact snapshot and identity pins; it never writes. */
export async function validatePropertyCorrections(live: LiveMemory, model: Artifact, records: Artifact[], options: PropertyCorrectionReading = {}): Promise<Artifact[]> {
  for (const record of records) {
    const captured = await capturePropertyCorrection(live, model, record.content, options);
    if (captured.scope !== record.content.scope || captured.fingerprint !== record.content.fingerprint)
      throw new Error("属性纠正依赖的事实或绑定已变化，请重新复验该纠正");
  }
  return records;
}

const migrationState = (repo: Repository, model: Artifact) => ({
  records: propertyCorrectionsForModel(repo, model).map(reference),
  datasets: repo.listArtifacts("data_dataset").map(reference).sort((a, b) => a.id.localeCompare(b.id)),
  sources: repo.listArtifacts("source_connection").map(item => ({ ...reference(item), status: item.status })).sort((a, b) => a.id.localeCompare(b.id)),
  decisions: repo.listArtifacts("identity_decision").filter(item => (item.content.modelRef as Data | undefined)?.id === model.id).map(reference).sort((a, b) => a.id.localeCompare(b.id)),
});

/** Read and verify before a model write, then carry a small proof for the synchronous commit guard. */
export async function preparePropertyCorrectionMigration(repo: Repository, live: LiveMemory, definition: Data): Promise<Data | null> {
  const model = repo.listArtifacts("live_ontology").find(item => item.status === "adopted");
  if (!model) return null;
  const records = propertyCorrectionsForModel(repo, model);
  if (!records.length) return null;
  const state = migrationState(repo, model), layered = parseLayeredModel(definition.layered);
  for (const record of records) if (propertyCorrectionScope(layered, String(record.content.entityTypeId), String(record.content.propertyId)) !== record.content.scope)
    throw new Error("结构变更会改变已采用属性纠正的范围，请先明确处理该纠正");
  const pins: SnapshotPins = {};
  for (const dataset of repo.listArtifacts("data_dataset")) if (dataset.content.activeVersion && dataset.content.materialization !== "live")
    pins[pinKey(String(dataset.content.sourceId), String(dataset.content.capability))] = String(dataset.content.activeVersion);
  await validatePropertyCorrections(live, model, records, { readMode: "active_snapshot", pins });
  if (fingerprint(state) !== fingerprint(migrationState(repo, model))) throw new Error("属性纠正复验期间的来源或决定已变化，请重新复验");
  return jsonData({ modelRef: reference(model), state });
}

const installed = new WeakSet<MemoryStore>();
/** A model commit must carry each decision without changing its scope; history keeps the old pinned version. */
export function connectPropertyCorrectionMigration(memory: MemoryStore) {
  if (installed.has(memory)) return;
  installed.add(memory);
  const previous = memory.beforeCommit;
  memory.beforeCommit = written => {
    const models = written.filter(item => item.kind === "live_ontology" && item.status === "adopted");
    for (const model of models) {
      if (model.content.restoredWorkspace) continue; // Restore explicitly chooses historical governance pins.
      const layered = parseLayeredModel(model.content.layered);
      const older = memory.listArtifacts("live_ontology").find(item => item.status === "adopted" && item.id !== model.id);
      if (!older) continue;
      const records = propertyCorrectionsForModel(memory, older);
      if (records.length) {
        const proof = model.content.propertyCorrectionMigration as Data | undefined;
        if (!proof || fingerprint(proof.modelRef) !== fingerprint(reference(older)) || fingerprint(proof.state) !== fingerprint(migrationState(memory, older)))
          throw new Error("模型采用缺少当前属性纠正的事实复验，或复验后来源已变化");
      }
      for (const correction of records) {
        if (propertyCorrectionScope(layered, String(correction.content.entityTypeId), String(correction.content.propertyId)) !== correction.content.scope)
          throw new Error("结构变更会改变已采用属性纠正的范围，请先明确处理该纠正");
        memory.putArtifact({ ...correction, expectedVersion: correction.version, content: { ...correction.content, modelRef: reference(model), migratedFrom: reference(correction) } });
      }
    }
    previous?.(written);
  };
}

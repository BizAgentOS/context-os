import type { Artifact, Data, Repository } from "../agent/contracts.ts";
import type { LiveMemory, SnapshotPins } from "./memory.ts";
import { pinKey } from "./memory.ts";
import { captureRelation, relationKey, type CorrectionTarget } from "./relation-corrections.ts";
import { jsonData } from "./sources.ts";
import { projectLegacyModel, type LayeredModel } from "../semantic/model.ts";
import { fingerprint } from "../engine/release-diff.ts";

const rows = (value: unknown): Data[] => Array.isArray(value) ? value : [];
const reference = (artifact: Artifact) => ({ id: artifact.id, version: artifact.version });
const definitionOf = (content: Data): Data => content.layered
  ? jsonData({ ...content, ...projectLegacyModel(content.layered as unknown as LayeredModel, { allowTransforms: true }) })
  : content;
const activeCorrections = (repo: Repository, model: Artifact) => repo.listArtifacts("relation_correction").filter(record => {
  const target = record.content.target as Data;
  return record.status === "adopted" && target.modelId === model.id && target.modelVersion === model.version;
});

/** Prepare outside the adopting transaction; the returned callback only copies verified decisions synchronously. */
export async function prepareCorrectionMigration(repo: Repository, live: LiveMemory, content: Data): Promise<(newModel: Artifact) => void> {
  const base = repo.listArtifacts("live_ontology").find(model => model.status === "adopted");
  if (!base) return () => {};
  const records = activeCorrections(repo, base);
  if (!records.length) return () => {};
  const nextDefinition = definitionOf(content);
  const dependencies = new Map<string, Artifact>();
  const track = (artifact: Artifact) => { dependencies.set(artifact.id, artifact); return artifact; };
  track(base);
  const typeSignature = (type: Data, definition: Data) => {
    const sourceId = String(type.sourceId), capability = String(type.capability);
    const connection = track(repo.getArtifact(sourceId));
    if (connection.status !== "ready") throw new Error("局部纠正依赖的来源已停用，请先处理纠正");
    const cap = live.sources.pinnedCapability(sourceId, capability, Number((definition.connections as Data)[sourceId])).cap;
    const supplements = rows(type.supplements).map(supplement => {
      const source = track(repo.getArtifact(String(supplement.sourceId)));
      if (source.status !== "ready") throw new Error("局部纠正依赖的附来源已停用，请先处理纠正");
      return { sourceId: supplement.sourceId, capability: supplement.capability, fields: supplement.fields, match: supplement.match,
        rowFilter: supplement.rowFilter ?? {}, propertyTransforms: supplement.propertyTransforms ?? {} };
    }).sort((a, b) => fingerprint(a).localeCompare(fingerprint(b)));
    return { conceptId: type.conceptId ?? type.name, sourceId, capability, identityFields: type.identityFields ?? [cap.idField], idType: cap.idType,
      fields: type.fields, rowFilter: type.rowFilter ?? {}, propertyTransforms: type.propertyTransforms ?? {}, supplements };
  };
  const relationScope = (relation: Data, definition: Data) => {
    const types = rows(definition.types);
    const from = types.find(type => type.name === relation.from), to = types.find(type => type.name === relation.to);
    if (!from || !to) throw new Error("局部纠正对应的实体已丢失，请先处理纠正");
    return { from: typeSignature(from, definition), to: typeSignature(to, definition),
      fromField: relation.fromField, toField: relation.toField, fromColumns: relation.fromColumns ?? null, toColumns: relation.toColumns ?? null,
      linkTable: relation.linkTable ?? null };
  };
  const migrated: Array<{ record: Artifact; relation: Data }> = [];
  for (const record of records) {
    const target = record.content.target as unknown as CorrectionTarget;
    const original = definitionOf((record.content.modelDefinition ?? base.content) as Data);
    const relation = rows(original.relations).find(item => item.from === target.type && item.name === target.relation);
    const next = relation && rows(nextDefinition.relations).find(item => relation.relationId
      ? item.relationId === relation.relationId
      : item.from === relation.from && item.to === relation.to && item.name === relation.name);
    if (!relation || !next || fingerprint(relationScope(relation, original)) !== fingerprint(relationScope(next, nextDefinition)))
      throw new Error("变更会修改或删除已采用局部纠正的关系、端点或属性绑定；请先处理该纠正后再采用");
    const pins: SnapshotPins = {};
    const bindings = rows(original.types).flatMap(type => [type, ...rows(type.supplements)]);
    for (const item of rows(original.relations)) if (item.linkTable) bindings.push(item.linkTable as Data);
    for (const binding of bindings) {
      const sourceId = String(binding.sourceId), capability = String(binding.capability);
      const dataset = live.snapshots?.bindingDataset?.(sourceId, capability);
      track(repo.getArtifact(sourceId));
      if (dataset) {
        track(dataset);
        if (dataset.content.materialization !== "live" && dataset.content.activeVersion)
          pins[pinKey(sourceId, capability)] = String(dataset.content.activeVersion);
      }
    }
    const captured = await captureRelation(live, target, record.content.targetIds as string[], () => {},
      { readMode: "active_snapshot", pins, fixedSemantic: false, modelDefinition: original });
    if (captured.fingerprint !== record.content.fingerprint) throw new Error("局部纠正依赖的事实已变化，请先重新核对该纠正后再采用");
    migrated.push({ record, relation: next });
  }
  return newModel => {
    if (newModel.kind !== "live_ontology" || newModel.status !== "adopted") throw new Error("纠正只能迁入已采用的执行绑定");
    for (const artifact of dependencies.values()) {
      const current = repo.getArtifact(artifact.id);
      if (current.version !== artifact.version || current.status !== artifact.status) throw new Error("纠正依赖已变化，请重新复验");
    }
    if (fingerprint(activeCorrections(repo, base).map(reference)) !== fingerprint(records.map(reference))) throw new Error("局部纠正决定已变化，请重新复验");
    for (const { record, relation } of migrated) {
      const target = { ...(record.content.target as unknown as CorrectionTarget), modelId: newModel.id, modelVersion: newModel.version,
        type: String(relation.from), relation: String(relation.name) };
      repo.putArtifact({ kind: "relation_correction", title: record.title, status: "adopted", content: jsonData({ ...record.content,
        target, targetKey: relationKey(target), modelDefinition: newModel.content,
        snapshot: { ...(record.content.snapshot as Data), relation, modelDefinition: newModel.content },
        migratedFrom: reference(record), adoptedAt: new Date().toISOString(),
      }) });
    }
  };
}

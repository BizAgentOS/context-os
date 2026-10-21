import { z } from "zod";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { FoundationService } from "../agent/foundation.ts";
import type { LiveMemory } from "../live/memory.ts";
import type { OntologyChanges, PreparedChange } from "./changes.ts";
import { ChangeConflict } from "./changes.ts";
import { parseLayeredModel, projectLegacyModel } from "../semantic/model.ts";
import { prepareCorrectionMigration } from "../live/correction-migration.ts";
import { prepareIdentityDecisionMigration } from "../live/identity-migration.ts";
import { readStructure } from "./structure-changes.ts";
import { jsonData } from "../live/sources.ts";
import { fingerprint } from "./release-diff.ts";

const kind = z.enum(["entity", "property", "relation", "entity_binding", "property_binding", "relation_binding", "identity_rule"]);
const name = z.string().trim().min(1).max(200);
export const explicitDeprecationSubject = z.object({ target: kind, id: name,
  dependents: z.array(z.object({ kind, id: name }).strict()).max(200).default([]), reason: z.string().trim().min(1).max(2000) }).strict();
const ref = (item: Artifact) => ({ id: item.id, version: item.version });
const rows = (value: unknown): Data[] => Array.isArray(value) ? structuredClone(value) : [];

/** Every removed dependency is named by the proposal. Validation rejects an incomplete set instead of cascading. */
export async function prepareExplicitDeprecation(memory: MemoryStore, foundation: FoundationService, live: LiveMemory, changes: OntologyChanges, change: Artifact): Promise<PreparedChange> {
  const subject = explicitDeprecationSubject.parse(change.content.subject), baseline = changes.currentBaseline();
  const base = foundation.read().adopted, model = baseline.modelRef && memory.getArtifact(baseline.modelRef.id, baseline.modelRef.version);
  if (!base) throw new Error("没有可弃用的已采用本体定义");
  const layered = readStructure(memory, foundation, live);
  const groups = { entity: layered.semantic.entityTypes, property: layered.semantic.properties, relation: layered.semantic.relationTypes,
    entity_binding: layered.bindings.entities, property_binding: layered.bindings.properties, relation_binding: layered.bindings.relations, identity_rule: layered.bindings.identityRules };
  const selected = [{ kind: subject.target, id: subject.id }, ...subject.dependents];
  if (new Set(selected.map(item => `${item.kind}:${item.id}`)).size !== selected.length) throw new Error("弃用范围不能重复");
  const removed = selected.map(item => {
    const list = groups[item.kind] as Array<{ id: string }>, index = list.findIndex(value => value.id === item.id);
    if (index < 0) throw new Error("所选弃用项不存在，请重新读取工作版");
    return { kind: item.kind, item: list.splice(index, 1)[0] };
  });
  // Removing an identity property also explicitly removes it from the containing entity's identity key.
  for (const entity of layered.semantic.entityTypes) entity.identityKeys = entity.identityKeys.filter(id => layered.semantic.properties.some(property => property.id === id));
  try { parseLayeredModel(layered); }
  catch { throw new Error("弃用项仍有未声明的属性、关系、身份规则或数据绑定依赖；请列出完整依赖后重新提议"); }
  const sourceBindings = removed.filter(item => item.kind === "entity_binding").map(item => (item.item as unknown as { dataset: { sourceId: string; capability: string } }).dataset);
  const entry = jsonData({ changeRef: ref(change), target: subject.target, id: subject.id, reason: subject.reason, removed, sourceBindings });
  const virtual: Artifact = { ...base, version: base.version + 1, content: { ...base.content,
    concepts: rows(base.content.concepts).filter(item => layered.semantic.entityTypes.some(entity => entity.id === item.id)),
    relations: rows(base.content.relations).filter(item => layered.semantic.relationTypes.some(relation => relation.id === item.id)),
    properties: rows(base.content.properties).filter(item => layered.semantic.properties.some(property => property.id === item.id)),
    deprecations: [...rows(base.content.deprecations), entry] } };
  const definition = layered.bindings.entities.some(item => item.role === "primary")
    ? await live.prepareDefinitionAgainst({ layered, foundationRef: ref(virtual), baseModelRef: model ? ref(model) : null,
      purpose: model?.content.purpose ?? "工作本体", rationale: subject.reason }, virtual)
    : jsonData({ ...(model?.content ?? {}), layered, ...projectLegacyModel(layered, { allowTransforms: true }), foundationRef: ref(virtual), connections: {}, purpose: "已显式弃用的执行绑定", rationale: subject.reason });
  const corrections = await prepareCorrectionMigration(memory, live, definition), identities = await prepareIdentityDecisionMigration(memory, live, definition);
  const assertCurrent = () => {
    if (fingerprint(changes.currentBaseline()) !== fingerprint(baseline)) throw new ChangeConflict("verification_changed", "弃用基线已变化，请重新复验");
    if (model) live.assertModel(model.id, model.version);
  };
  assertCurrent();
  return { verification: { result: "passed", metrics: { removed: selected.length, entities: layered.semantic.entityTypes.length, bindings: layered.bindings.entities.length },
    inputs: jsonData({ baseline, removed, sourceBindings }), notes: ["只弃用所列对象与明确依赖；历史定义、来源数据和旧发布版本保留。"] },
    previewDefinition: definition, previewFoundation: virtual, apply: () => {
      assertCurrent();
      const adopted = memory.putArtifact({ ...base, expectedVersion: base.version, content: virtual.content });
      const mapped = memory.putArtifact({ kind: "live_ontology", title: model?.title ?? "工作本体绑定", status: "adopted", content: { ...definition, foundationRef: ref(adopted) } });
      corrections(mapped); identities(mapped);
      return jsonData({ foundationRef: ref(adopted), modelRef: ref(mapped), deprecated: selected });
    } };
}

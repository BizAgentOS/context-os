import { z } from "zod";
import { verifyLocalRelationConstraints } from "./local-relation-constraints.ts";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { LiveMemory } from "../live/memory.ts";
import { capturePropertyCorrection, connectPropertyCorrectionMigration, propertyCorrectionKey, propertyCorrectionsForModel } from "../live/property-corrections.ts";
import { activeCorrection, captureRelation, relationKey } from "../live/relation-corrections.ts";
import { objectIdLimit } from "../semantic/values.ts";
import { ChangeConflict, type OntologyChanges } from "./changes.ts";
import { fingerprint } from "./release-diff.ts";
import { jsonData } from "../live/sources.ts";

const name = z.string().trim().min(1).max(200);
const common = { entityTypeId: name, objectId: z.string().trim().min(1).max(objectIdLimit), reason: z.string().trim().min(1).max(2000), evidence: z.string().trim().min(1).max(4000) };
export const localCorrectionSubject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("property"), ...common, propertyId: name, value: z.union([z.string().max(10000), z.number().finite(), z.boolean(), z.null()]) }).strict(),
  z.object({ kind: z.literal("relation"), ...common, relationTypeId: name, targetIds: z.array(z.string().trim().min(1).max(objectIdLimit)).max(20) }).strict(),
]);
const ref = (artifact: Artifact | null) => artifact ? { id: artifact.id, version: artifact.version } : null;

export function connectLocalChanges(memory: MemoryStore, live: LiveMemory, changes: OntologyChanges) {
  connectPropertyCorrectionMigration(memory);
  changes.registerHandler("local_correction", { subject: localCorrectionSubject, prepare: async (change, assertActive = () => {}) => {
    assertActive();
    const subject = localCorrectionSubject.parse(change.content.subject), baseline = changes.currentBaseline();
    const workspace = () => ref(memory.listArtifacts("workspace_version").sort((a, b) => Number(b.content.number) - Number(a.content.number))[0] ?? null);
    const workspaceRef = workspace();
    if (!baseline.modelRef) throw new Error("局部纠正需要已采用的对象映射");
    const model = memory.getArtifact(baseline.modelRef.id, baseline.modelRef.version), layered = live.readLayered(model.id);
    const entity = layered.semantic.entityTypes.find(item => item.id === subject.entityTypeId);
    if (!entity) throw new Error("纠正实体不存在");
    const assertBaseline = () => {
      assertActive();
      if (fingerprint(changes.currentBaseline()) !== fingerprint(baseline)) throw new ChangeConflict("verification_changed", "纠正依赖的本体已变化，请重新复验");
      if (fingerprint(workspace()) !== fingerprint(workspaceRef)) throw new ChangeConflict("verification_changed", "纠正读取期间数据快照或治理决定已变化，请重新复验");
      live.assertModel(model.id, model.version);
    };
    if (subject.kind === "property") {
      const captured = await capturePropertyCorrection(live, model, jsonData(subject), { assertActive: assertBaseline });
      const previous = () => propertyCorrectionsForModel(memory, model).find(item => propertyCorrectionKey(item.content) === propertyCorrectionKey(jsonData(subject))) ?? null;
      const prior = previous();
      assertBaseline();
      const content = jsonData({ ...subject, modelRef: ref(model), scope: captured.scope, fingerprint: captured.fingerprint, snapshot: captured.snapshot,
        changeRef: ref(change), responsible: "local-admin", adoptedAt: new Date().toISOString(), previous: ref(prior) });
      const hypothetical: Artifact = { id: prior?.id ?? `preview:${change.id}`, version: (prior?.version ?? 0) + 1,
        kind: "property_correction", title: `${captured.entityName} ${subject.objectId} · ${captured.propertyName}`, status: "adopted", createdAt: new Date().toISOString(), content };
      const properties = [...propertyCorrectionsForModel(memory, model).filter(item => propertyCorrectionKey(item.content) !== propertyCorrectionKey(content)), hypothetical];
      return { previewDefinition: live.projectModel(model).content, previewCorrections: { properties }, verification: { result: "passed", metrics: { objects: 1, properties: 1, targets: 0 },
        inputs: jsonData({ baseline, workspaceRef, prior: ref(prior), scope: captured.scope, factsFingerprint: captured.fingerprint }),
        notes: ["仅替换该对象的属性值，保留原始来源依据；不修改源系统。"] }, apply: () => {
        assertBaseline();
        if (fingerprint(ref(previous())) !== fingerprint(ref(prior))) throw new ChangeConflict("verification_changed", "该属性已有新的纠正决定，请重新复验");
        const saved = memory.putArtifact({ ...(prior ? { id: prior.id, expectedVersion: prior.version } : {}), kind: hypothetical.kind,
          title: hypothetical.title, status: "adopted", content });
        return jsonData({ correctionRef: ref(saved), modelRef: ref(model) });
      } };
    }
    const relation = layered.semantic.relationTypes.find(item => item.id === subject.relationTypeId && item.from === subject.entityTypeId);
    if (!relation) throw new Error("纠正关系不属于所选实体");
    if (new Set(subject.targetIds).size !== subject.targetIds.length) throw new Error("目标对象编号重复");
    if (["1:1", "N:1"].includes(relation.cardinality) && subject.targetIds.length > 1) throw new Error("纠正目标数量超过关系基数约束");
    const target = { modelId: model.id, modelVersion: model.version, type: entity.name, objectId: subject.objectId, relation: relation.name };
    const captured = await captureRelation(live, target, subject.targetIds, assertBaseline);
    const previous = () => activeCorrection(memory, target, relation.id, model.content), prior = previous();
    assertBaseline();
    const content = jsonData({ target, targetKey: relationKey(target), modelDefinition: captured.modelDefinition, targetIds: subject.targetIds,
      base: ref(prior), reason: subject.reason, evidence: subject.evidence, evidenceKind: "submitted_rationale", responsible: "local-admin",
      condition: "model_and_source_snapshot_unchanged", fingerprint: captured.fingerprint, snapshot: captured,
      scope: "internal_local_relation", changeRef: ref(change), decision: { actor: "local-admin", at: new Date().toISOString() } });
    const hypothetical: Artifact = { id: `preview:${change.id}`, version: 1, kind: "relation_correction", title: `${entity.name} ${subject.objectId} → ${relation.name}`,
      status: "adopted", createdAt: new Date().toISOString(), content };
    const relations = [...memory.listArtifacts("relation_correction").filter(item => {
      const target = item.content.target as Data;
      return item.status === "adopted" && target.modelId === model.id && target.modelVersion === model.version && item.id !== prior?.id;
    }), hypothetical];
    const constraints = await verifyLocalRelationConstraints(memory, live, model, relation, subject.targetIds, relations, assertBaseline);
    return { previewDefinition: live.projectModel(model).content, previewCorrections: { relations }, verification: { result: "passed", metrics: { objects: 1, properties: 0, targets: subject.targetIds.length, ...constraints.metrics },
      inputs: jsonData({ baseline, workspaceRef, prior: ref(prior), factsFingerprint: captured.fingerprint, ...constraints.inputs }), notes: ["仅替换该对象的关系目标集合；保留原关系及读取依据，不修改源系统。"] }, apply: () => {
      assertBaseline();
      if (fingerprint(ref(previous())) !== fingerprint(ref(prior))) throw new ChangeConflict("verification_changed", "该关系已有新的纠正决定，请重新复验");
      if (prior) memory.putArtifact({ ...prior, expectedVersion: prior.version, status: "superseded" });
      const saved = memory.putArtifact({ kind: hypothetical.kind, title: hypothetical.title, status: "adopted", content });
      return jsonData({ correctionRef: ref(saved), modelRef: ref(model) });
    } };
  } });
}

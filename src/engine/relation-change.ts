import { prepareCorrectionMigration } from "../live/correction-migration.ts";
import { prepareIdentityDecisionMigration } from "../live/identity-migration.ts";
import { parseLayeredModel } from "../semantic/model.ts";
import { relationSubjectSchema, type RelationSubject } from "./relation-verification.ts";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { FoundationService } from "../agent/foundation.ts";
import type { LiveMemory } from "../live/memory.ts";
import type { Snapshots } from "../data/snapshots.ts";
import { ChangeConflict, OntologyChanges } from "./changes.ts";
import { fingerprint } from "./release-diff.ts";
import { confirmedRelationWording } from "./naming-relation-labels.ts";

const ref = (a: Artifact) => ({ id: a.id, version: a.version });
const rows = (x: unknown): Data[] => Array.isArray(x) ? structuredClone(x) : [];

export function connectRelationChanges(memory: MemoryStore, foundation: FoundationService, live: LiveMemory, snapshots: Snapshots, changes: OntologyChanges) {
  const prepare = async (selected: Artifact[], measured?: Awaited<ReturnType<OntologyChanges["checkRelation"]>>[]) => {
    const subjects = selected.map(change => relationSubjectSchema.parse(change.content.subject));
    const verifications: Awaited<ReturnType<OntologyChanges["checkRelation"]>>[] = [];
    for (const [index, subject] of subjects.entries()) verifications.push(measured?.[index] ?? await changes.checkRelation(subject));
    const base = foundation.read().adopted, model = memory.listArtifacts("live_ontology").find(a => a.status === "adopted");
    if (!base || !model) throw new Error("请先构建并采用端点实体，再采用关系");
    if (verifications.some(verification => verification.result === "failed")) throw new Error("关系复验失败");
    const projected = live.projectModel(model);
    const types = rows(projected.content.types);
    const resolve = (end: RelationSubject["from"]) => {
      const matches = types.filter(type => snapshots.bindingDataset(String(type.sourceId), String(type.capability))?.id === end.datasetId);
      if (matches.length !== 1) throw new Error("关系端点没有唯一的主实体绑定，请先核对实体映射");
      const type = matches[0], fields = type.fields as Data;
      let property = Object.entries(fields).find(([, value]) => value === end.column)?.[0];
      const idField = live.sources.capability(String(type.sourceId), String(type.capability)).cap.idField;
      if ((type.identityFields as string[] | undefined)?.length === 1 && (type.identityFields as string[])[0] === end.column || !type.identityFields && idField === end.column) property ??= "$id";
      if (!property) throw new Error("关系端点字段未绑定为实体属性，请先修订属性绑定");
      return { type, property };
    };
    const relations = rows(projected.content.relations), semanticRelations = rows(base.content.relations), relationIds: string[] = [];
    for (const subject of subjects) {
      const from = resolve(subject.from), to = resolve(subject.to);
      const relationId = `relation_${fingerprint({ method: "foreign_key", ...subject }).slice(0, 24)}`;
      if (relations.some(r => r.from === from.type.name && r.to === to.type.name && r.fromField === from.property && r.toField === to.property))
        throw new ChangeConflict("batch_conflict", "工作版或选中批次已经包含同一关系，请逐项处理");
      const concepts = rows(base.content.concepts);
      const evidenceRefs = [...new Set(concepts.filter(c => c.id === from.type.conceptId || c.id === to.type.conceptId).flatMap(c => (c.evidenceRefs ?? []) as string[]))];
      const wording = confirmedRelationWording(memory, subject);
      const name = wording ? String(wording.name) : `${from.property === "$id" ? "关联" : from.property} → ${String(to.type.name)}`;
      semanticRelations.push({ id: relationId, name, origin: "human", governed: true, from: from.type.conceptId, to: to.type.conceptId,
        description: wording ? String(wording.description) : `按 ${subject.from.column} 与 ${subject.to.column} 的已复验对应关系关联`, ...(wording ? { aliases: wording.aliases } : {}), evidenceRefs });
      relations.push({ name, from: from.type.name, to: to.type.name, fromField: from.property, toField: to.property, relationId,
        fromColumns: [subject.from.column], toColumns: [subject.to.column] });
      relationIds.push(relationId);
    }
    const virtual: Artifact = { ...base, version: base.version + 1, content: { ...base.content, relations: semanticRelations } };
    const definition = await live.prepareDefinitionAgainst({ foundationRef: ref(virtual), baseModelRef: ref(model), purpose: model.content.purpose,
      types, relations, rationale: selected.map(change => String(change.content.evidence ?? "人工复验并采用关系")).join("；") }, virtual);
    const layered = parseLayeredModel(definition.layered);
    for (const [index, subject] of subjects.entries()) {
      const relation = layered.semantic.relationTypes.find(item => item.id === relationIds[index])!;
      relation.cardinality = subject.cardinality ?? "N:1";
      if (subject.acyclic !== undefined) relation.acyclic = subject.acyclic;
      if (subject.acyclic) relation.maxDepth = subject.maxDepth ?? 10;
    }
    definition.layered = layered as unknown as Data;
    const migrateCorrections = await prepareCorrectionMigration(memory, live, definition);
    const migrateIdentities = await prepareIdentityDecisionMigration(memory, live, definition);
    const assertCurrent = () => {
      for (const verification of verifications) for (const [id, version] of Object.entries(verification.inputs.snapshots as Data)) {
        const dataset = snapshots.dataset(id);
        if (dataset.content.activeVersion !== version || dataset.content.materialization === "live")
          throw new ChangeConflict("verification_changed", "关系依赖的快照已变化，请重新复验");
      }
      for (const [id, version] of Object.entries(definition.connections as Data)) {
        const connection = memory.getArtifact(id);
        if (connection.version !== version || connection.status !== "ready")
          throw new ChangeConflict("verification_changed", "关系依赖的来源权限或定义已变化，请重新复验");
      }
    };
    assertCurrent();
    return { verifications, previewDefinition: definition, previewFoundation: virtual, apply: () => {
      assertCurrent();
      const adopted = memory.putArtifact({ ...base, expectedVersion: base.version, content: virtual.content });
      const mapped = memory.putArtifact({ kind: "live_ontology", title: model.title, status: "adopted", content: { ...definition, foundationRef: ref(adopted) } });
      migrateCorrections(mapped);
      migrateIdentities(mapped);
      return relationIds.map(relationId => ({ foundationRef: ref(adopted), modelRef: ref(mapped), relationId }));
    } };
  };
  changes.registerHandler("relation", { subject: relationSubjectSchema, prepare: async change => {
    // Keep failed measurements available to the decision workflow even without adopted endpoints.
    const verification = await changes.checkRelation(relationSubjectSchema.parse(change.content.subject));
    if (verification.result === "failed") return { verification, apply: () => { throw new Error("关系复验失败"); } };
    const unavailable = (message: string) => ({ verification: { ...verification, result: "failed" as const, notes: [...verification.notes, message] }, apply: () => { throw new Error(message); } });
    if (!foundation.read().adopted || !memory.listArtifacts("live_ontology").some(model => model.status === "adopted"))
      return unavailable("请先构建并采用端点实体，再采用关系");
    try {
      const prepared = await prepare([change], [verification]);
      return { verification: prepared.verifications[0], previewDefinition: prepared.previewDefinition, previewFoundation: prepared.previewFoundation, apply: () => prepared.apply()[0] };
    } catch (error) {
      if (error instanceof ChangeConflict && error.code === "batch_conflict") return unavailable(error.message);
      throw error;
    }
  } });
  changes.registerBatchHandler({
    accepts: selected => selected.every(change => change.content.type === "relation" && !change.content.owner),
    prepare: async (selected, verified) => {
      const prepared = await prepare(selected);
      if (prepared.verifications.some((current, index) => fingerprint(current.inputs) !== fingerprint(verified[index].verification.inputs) || fingerprint(current.metrics) !== fingerprint(verified[index].verification.metrics)))
        throw new ChangeConflict("verification_changed", "合并关系期间来源事实已变化，请重新复验");
      return prepared.apply;
    },
  });
}

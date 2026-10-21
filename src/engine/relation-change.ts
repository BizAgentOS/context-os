import { prepareCorrectionMigration } from "../live/correction-migration.ts";
import { z } from "zod";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { FoundationService } from "../agent/foundation.ts";
import type { LiveMemory } from "../live/memory.ts";
import type { Snapshots } from "../data/snapshots.ts";
import { OntologyChanges } from "./changes.ts";
import { fingerprint } from "./release-diff.ts";

const column = z.object({ datasetId: z.string().min(1), column: z.string().min(1) }).strict();
const subjectSchema = z.object({ from: column, to: column }).strict();
const ref = (a: Artifact) => ({ id: a.id, version: a.version });
const rows = (x: unknown): Data[] => Array.isArray(x) ? structuredClone(x) : [];

export function connectRelationChanges(memory: MemoryStore, foundation: FoundationService, live: LiveMemory, snapshots: Snapshots, changes: OntologyChanges) {
  changes.registerHandler("relation", { subject: subjectSchema, prepare: async change => {
    const subject = subjectSchema.parse(change.content.subject), verification = await changes.checkRelation(subject);
    const base = foundation.read().adopted, model = memory.listArtifacts("live_ontology").find(a => a.status === "adopted");
    const unavailable = (message: string) => ({ verification: { ...verification, result: "failed" as const, notes: [...verification.notes, message] }, apply: () => { throw new Error(message); } });
    if (!base || !model) return unavailable("请先构建并采用端点实体，再采用关系");
    if (verification.result === "failed") return unavailable("关系复验失败");
    const projected = live.projectModel(model);
    const types = rows(projected.content.types);
    const resolve = (end: z.infer<typeof column>) => {
      const matches = types.filter(type => snapshots.bindingDataset(String(type.sourceId), String(type.capability))?.id === end.datasetId);
      if (matches.length !== 1) throw new Error("关系端点没有唯一的主实体绑定，请先核对实体映射");
      const type = matches[0], fields = type.fields as Data;
      let property = Object.entries(fields).find(([, value]) => value === end.column)?.[0];
      const idField = live.sources.capability(String(type.sourceId), String(type.capability)).cap.idField;
      if ((type.identityFields as string[] | undefined)?.length === 1 && (type.identityFields as string[])[0] === end.column || !type.identityFields && idField === end.column) property ??= "$id";
      if (!property) throw new Error("关系端点字段未绑定为实体属性，请先修订属性绑定");
      return { type, property };
    };
    const from = resolve(subject.from), to = resolve(subject.to);
    const relationId = `relation_${fingerprint({ method: "foreign_key", ...subject }).slice(0, 24)}`;
    const relations = rows(projected.content.relations);
    if (relations.some(r => r.from === from.type.name && r.to === to.type.name && r.fromField === from.property && r.toField === to.property))
      return unavailable("工作版已经包含同一关系");
    const concepts = rows(base.content.concepts);
    const evidenceRefs = [...new Set(concepts.filter(c => c.id === from.type.conceptId || c.id === to.type.conceptId).flatMap(c => (c.evidenceRefs ?? []) as string[]))];
    const name = `${from.property === "$id" ? "关联" : from.property} → ${String(to.type.name)}`;
    const semantic = { id: relationId, name, origin: "human", governed: true, from: from.type.conceptId, to: to.type.conceptId,
      description: `按 ${subject.from.column} 与 ${subject.to.column} 的已复验对应关系关联`, evidenceRefs };
    const virtual: Artifact = { ...base, version: base.version + 1, content: { ...base.content, relations: [...rows(base.content.relations), semantic] } };
    const definition = await live.prepareDefinitionAgainst({ foundationRef: ref(virtual), baseModelRef: ref(model), purpose: model.content.purpose,
      types, relations: [...relations, { name, from: from.type.name, to: to.type.name, fromField: from.property, toField: to.property, relationId,
        fromColumns: [subject.from.column], toColumns: [subject.to.column] }], rationale: String(change.content.evidence ?? "人工复验并采用关系") }, virtual);
    const migrateCorrections = await prepareCorrectionMigration(memory, live, definition);
    return { verification, apply: () => {
      const adopted = memory.putArtifact({ ...base, expectedVersion: base.version, content: virtual.content });
      const mapped = memory.putArtifact({ kind: "live_ontology", title: model.title, status: "adopted", content: { ...definition, foundationRef: ref(adopted) } });
      migrateCorrections(mapped);
      return { foundationRef: ref(adopted), modelRef: ref(mapped), relationId };
    } };
  } });
}

import { z } from "zod";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { FoundationService } from "../agent/foundation.ts";
import type { LiveMemory } from "../live/memory.ts";
import { projectLegacyModel, parseLayeredModel } from "../semantic/model.ts";
import { prepareCorrectionMigration } from "../live/correction-migration.ts";
import { prepareIdentityDecisionMigration } from "../live/identity-migration.ts";
import { ChangeConflict, type OntologyChanges } from "./changes.ts";
import { fingerprint } from "./release-diff.ts";
import { jsonData } from "../live/sources.ts";
import { changeEvidenceRefs, wordingEvidence } from "../agent/change-evidence.ts";

const target = z.enum(["concept", "relation", "property"]), id = z.string().min(1).max(200), name = z.string().trim().min(1).max(200);
export const namingSubject = z.object({ target, id, name: name.optional(), aliases: z.array(name).max(100).optional(), evidenceRefs: changeEvidenceRefs }).strict().refine(value => value.name !== undefined || value.aliases !== undefined, "名称或别名至少填写一项");
export const descriptionSubject = z.object({ target, id, description: z.string().trim().min(1).max(4000), evidenceRefs: changeEvidenceRefs }).strict();
const ref = (artifact: Artifact) => ({ id: artifact.id, version: artifact.version });
const rows = (value: unknown): Data[] => Array.isArray(value) ? structuredClone(value) : [];

/** Wording shares one patch compiler for single and batch decisions. Execution bindings stay fixed. */
export async function prepareWordingEdits(memory: MemoryStore, foundation: FoundationService, live: LiveMemory, changes: OntologyChanges, selected: Artifact[]) {
  const base = foundation.read().adopted;
  if (!base) throw new Error("没有可编辑的已采用本体");
  const invalid = (note: string, metrics: { targetExists: boolean; nameUnique: boolean; changesContent: boolean }) => {
    if (selected.length !== 1) throw new ChangeConflict("batch_conflict", note);
    return { verification: { result: "failed" as const, metrics, notes: [note], inputs: { foundationRef: ref(base) } },
      apply: (): Data[] => { throw new Error(note); } };
  };
  const model = memory.listArtifacts("live_ontology").find(item => item.status === "adopted");
  const layered = model ? live.readLayered(model.id) : undefined;
  const content = structuredClone(base.content);
  const properties = new Map(rows(content.properties).map(item => [item.id, item]));
  for (const item of layered?.semantic.properties ?? []) properties.set(item.id, { ...properties.get(item.id), ...item });
  content.properties = jsonData([...properties.values()]);
  const touched = new Set<string>();
  const evidenceChecks: ReturnType<typeof wordingEvidence>[] = [];
  const conflictIds: string[] = [];
  const programEvidence = new Set([...rows(content.concepts), ...rows(content.relations), ...rows(content.properties)]
    .map(item => item.programEvidenceId).filter(Boolean));
  for (const change of selected) {
    const subject = (change.content.type === "naming" ? namingSubject : descriptionSubject).parse(change.content.subject);
    const key = subject.target === "concept" ? "concepts" : subject.target === "relation" ? "relations" : "properties";
    const item = (content[key] as Data[]).find(item => item.id === subject.id);
    if (!item) return invalid("要编辑的对象不存在", { targetExists: false, nameUnique: true, changesContent: false });
    const before = structuredClone(item);
    const citations = wordingEvidence(memory, subject.evidenceRefs, String((content.enterprise as Data).name));
    evidenceChecks.push(citations);
    const evidence = content.evidence as Data[];
    for (const entry of citations.evidence) {
      const existing = evidence.find(item => item.id === entry.id);
      if (existing && fingerprint(existing) !== fingerprint(entry)) throw new Error("已有证据不可改写，请使用新的证据标识");
      if (!existing) evidence.push(jsonData(entry));
      if (entry.kind === "document") content.documentVersions = { ...content.documentVersions as Data, [entry.sourceId!]: entry.sourceVersion! };
    }
    const addsEvidence = citations.evidence.some(entry => !((item.evidenceRefs ?? []) as string[]).includes(entry.id));
    if (citations.evidence.length) item.evidenceRefs = [...new Set([...(item.evidenceRefs ?? []) as string[], ...citations.evidence.map(entry => entry.id)])];
    let changed = false;
    for (const [field, value] of Object.entries(subject).filter(([field]) => !["target", "id", "evidenceRefs"].includes(field))) {
      const identity = `${key}:${subject.id}:${field}`;
      if (touched.has(identity)) throw new ChangeConflict("batch_conflict", "选中变更重复修改同一对象字段");
      touched.add(identity);
      if (fingerprint(item[field] ?? null) !== fingerprint(value)) changed = true;
      if (field === "name" && value !== item.name) item.aliases = [...new Set([...(item.aliases ?? []) as string[], String(item.name)])];
      item[field] = value;
    }
    if (!changed && !addsEvidence) return invalid("与已采用内容相同，没有变化", { targetExists: true, nameUnique: true, changesContent: false });
    const programOnly = before.origin === "program" && ((before.evidenceRefs ?? []) as string[]).every(id => programEvidence.has(id));
    const externalMeaningChange = (before.name !== item.name || before.description !== item.description) && !programOnly
      && citations.evidence.some(entry => ["document", "web", "knowledge", "api"].includes(entry.kind))
      && !citations.evidence.some(entry => entry.kind === "user-statement" && !(base.content.evidence as Data[]).some(old => old.id === entry.id));
    if (externalMeaningChange) {
      const proposed = structuredClone(item), conflictId = `wording-${fingerprint({ key, before, proposed }).slice(0, 24)}`;
      const conflicts = content.conflicts as Data[];
      if (!conflicts.some(conflict => conflict.id === conflictId)) conflicts.push({ id: conflictId, targetKind: subject.target,
        description: `资料对「${before.name}」给出不同含义，需要核对。`, evidenceRefs: proposed.evidenceRefs ?? [], retained: before, proposed });
      conflictIds.push(conflictId);
      // Saving the differing source interpretation does not adopt its business meaning.
      for (const field of Object.keys(item)) delete item[field];
      Object.assign(item, before);
    }
  }
  for (const key of ["concepts", "relations", "properties"]) {
    const seen = new Set<string>();
    for (const item of rows(content[key])) {
      const scope = key === "properties" ? item.entityTypeId : key === "relations" ? item.from : "all";
      for (const wording of [item.name, ...(item.aliases ?? []) as string[]]) {
        const identity = `${scope}:${String(wording).trim().toLowerCase()}`;
        // Repeating a primary name in its own aliases is harmless; another object's wording is ambiguous.
        if (seen.has(identity) && rows(content[key]).some(other => other.id !== item.id && (key !== "properties" || other.entityTypeId === item.entityTypeId) && (key !== "relations" || other.from === item.from) && [other.name, ...(other.aliases ?? []) as string[]].some(value => String(value).trim().toLowerCase() === String(wording).trim().toLowerCase())))
          return invalid("合并后的名称或别名重复，请逐项修订", { targetExists: true, nameUnique: false, changesContent: true });
        seen.add(identity);
      }
    }
  }
  const virtual: Artifact = { ...base, version: base.version + 1, content };
  let definition: Data | undefined;
  if (model && layered) {
    for (const [objects, key] of [[layered.semantic.entityTypes, "concepts"], [layered.semantic.relationTypes, "relations"], [layered.semantic.properties, "properties"]] as const) {
      for (const item of objects) {
        const current = (content[key] as Data[]).find(entry => entry.id === item.id);
        if (current) Object.assign(item, { name: current.name, aliases: current.aliases ?? [], description: current.description });
      }
    }
    parseLayeredModel(layered);
    definition = jsonData({ ...live.projectModel(model).content, ...projectLegacyModel(layered, { allowTransforms: true }), layered, foundationRef: ref(virtual) });
    if (!model.content.layered) definition = await live.prepareDefinitionAgainst({ ...definition, baseModelRef: ref(model) }, virtual);
  }
  const migrateCorrections = definition && !model?.content.layered ? await prepareCorrectionMigration(memory, live, definition) : undefined;
  const migrateIdentities = definition && !model?.content.layered ? await prepareIdentityDecisionMigration(memory, live, definition) : undefined;
  const assertCurrent = () => {
    if (fingerprint(changes.currentBaseline()) !== fingerprint({ foundationRef: ref(base), modelRef: model ? ref(model) : null })) throw new ChangeConflict("stale_baseline", "本体基线已变化，请重新复验");
    for (const citations of evidenceChecks) citations.assertCurrent();
  };
  assertCurrent();
  return { verification: { result: "passed" as const, metrics: { targetExists: true, nameUnique: true, changesContent: true, evidenceCount: evidenceChecks.reduce((count, citations) => count + citations.evidence.length, 0), pendingAdjudications: conflictIds.length }, notes: conflictIds.length ? ["已保存双方依据与待裁决分歧，保留原有生效含义"] : [], inputs: { foundationRef: ref(base), evidence: evidenceChecks.map(citations => citations.fingerprint) } }, previewDefinition: definition, previewFoundation: virtual,
    apply: () => {
      assertCurrent();
      const saved = memory.putArtifact({ ...base, expectedVersion: base.version, content });
      const mapped = definition && !model?.content.layered ? memory.putArtifact({ kind: "live_ontology", title: model!.title, status: "adopted", content: { ...definition, foundationRef: ref(saved) } }) : null;
      if (mapped) { migrateCorrections!(mapped); migrateIdentities!(mapped); }
      const effect = { foundationRef: ref(saved), modelRef: mapped ? ref(mapped) : model ? ref(model) : null, conflictIds };
      return selected.map(() => effect);
    } };
}

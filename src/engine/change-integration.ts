import { prepareIdentityDecisionMigration } from "../live/identity-migration.ts";
import { prepareCorrectionMigration } from "../live/correction-migration.ts";
import { z } from "zod";
import { ownerVerificationInputs } from "./owner-verification.ts";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { FoundationService } from "../agent/foundation.ts";
import type { LiveMemory } from "../live/memory.ts";
import { MappingChanges } from "../live/mapping-changes.ts";
import { RelationCorrections } from "../live/relation-corrections.ts";
import { jsonData } from "../live/sources.ts";
import { fingerprint } from "./release-diff.ts";
import { OntologyChanges, type PreparedChange } from "./changes.ts";

const reference = z.object({ id: z.string().min(1), version: z.number().int().positive() }).strict();
const ownerSubject = z.object({ ownerRef: reference }).strict();
const ref = (a: Artifact) => ({ id: a.id, version: a.version });
const list = (value: unknown): Data[] => Array.isArray(value) ? structuredClone(value) : [];

/** Adapters keep checks in the owning service; the change service owns decisions and transactions. */
export function connectChanges(memory: MemoryStore, foundation: FoundationService, live: LiveMemory, changes: OntologyChanges) {
  const owner = async (change: Artifact): Promise<PreparedChange> => {
    const { ownerRef } = ownerSubject.parse(change.content.subject);
    const candidate = memory.getArtifact(ownerRef.id);
    if (candidate.version !== ownerRef.version) throw new Error("候选版本已变化，请重新读取变更");
    let save: (() => Artifact) | undefined;
    const readingFacts: Data[] = [];
    const capture = (commit: () => Artifact) => { save = commit; return candidate; };
    if (candidate.kind === "foundation") foundation.adopt(candidate.id, candidate.version, { commit: capture });
    else if (candidate.kind === "live_ontology") await live.adopt(candidate.id, candidate.version, capture, undefined, facts => readingFacts.push(facts));
    else if (candidate.kind === "mapping_change") await new MappingChanges(memory, live).execute("adopt", { operationId: `change:${change.id}`, ...ref(candidate) }, undefined, undefined, capture);
    else if (candidate.kind === "relation_correction") await new RelationCorrections(memory, live).execute("adopt", { operationId: `change:${change.id}`, ...ref(candidate) }, undefined, undefined, capture);
    else throw new Error("该候选类型尚未接入统一变更");
    if (!save) throw new Error("没有可提交的候选");
    return { verification: { result: "passed", metrics: { ownerValidated: true }, notes: ["已按原服务重新核对来源、权限、版本与执行结果"],
      inputs: { ...ownerVerificationInputs(memory, candidate), ...(readingFacts.length ? { readingFingerprint: fingerprint(readingFacts) } : {}) } }, apply: () => { const saved = save!(); return { ownerRef: ref(saved), ...(saved.content.resultModel ? { modelRef: saved.content.resultModel } : {}) }; } };
  };
  for (const type of ["entity", "property", "binding", "local_correction", "deprecation"]) changes.registerHandler(type, { subject: ownerSubject, prepare: owner });
  for (const type of ["naming", "description"] as const) changes.registerHandler(type, {
    subject: z.object({ target: z.enum(["concept", "relation"]), id: z.string().min(1), [type === "naming" ? "name" : "description"]: z.string().trim().min(1).max(type === "naming" ? 200 : 1500) }).strict(),
    prepare: async change => {
      const subject = change.content.subject as Data;
      const adopted = foundation.read().adopted;
      const key = subject.target === "concept" ? "concepts" : "relations", field = type === "naming" ? "name" : "description";
      const items = list(adopted?.content[key]);
      const target = items.find(item => item.id === subject.id);
      const unique = type !== "naming" || !items.some(item => item.id !== subject.id && String(item.name).trim().toLowerCase() === String(subject.name).trim().toLowerCase());
      const changed = !!target && target[field] !== subject[field];
      const verification = { result: target && unique && changed ? "passed" as const : "failed" as const,
        metrics: { targetExists: !!target, nameUnique: unique, changesContent: changed }, notes: target && unique && changed ? [] : ["对象不存在、名称重复或内容没有变化"],
        inputs: { foundationRef: adopted ? ref(adopted) : null } };
      if (!adopted || !target || !unique || !changed) return { verification, apply: () => { throw new Error("文字变更复验失败"); } };
      target[field] = subject[field];
      const content = { ...adopted.content, [key]: items };
      const virtual = { ...adopted, version: adopted.version + 1, content };
      const model = memory.listArtifacts("live_ontology").find(item => item.status === "adopted");
      let definition: Data | undefined;
      if (model && !model.content.layered) {
        const types = list(model.content.types), relations = list(model.content.relations);
        if (subject.target === "concept") for (const item of types.filter(item => item.conceptId === subject.id)) {
          if (type === "naming") for (const relation of relations) for (const side of ["from", "to"]) if (relation[side] === item.name) relation[side] = subject.name;
          item[field] = subject[field];
        }
        if (subject.target === "relation") for (const item of relations.filter(item => item.relationId === subject.id)) item[field] = subject[field];
        definition = await live.prepareDefinitionAgainst({ foundationRef: ref(virtual), baseModelRef: ref(model), purpose: model.content.purpose, types, relations, rationale: "统一变更中的文字修订" }, virtual);
      }
      const migrateIdentities = definition ? await prepareIdentityDecisionMigration(memory, live, definition) : undefined;
      const migrateCorrections = definition ? await prepareCorrectionMigration(memory, live, definition) : undefined;
      return { verification, apply: () => {
        if (foundation.read().adopted?.version !== adopted.version) throw new Error("本体版本已变化");
        const saved = memory.putArtifact({ ...adopted, expectedVersion: adopted.version, content });
        const mapping = definition ? memory.putArtifact({ kind: "live_ontology", title: model!.title, status: "adopted", content: { ...definition, foundationRef: ref(saved) } }) : null;
        if (mapping) { migrateCorrections!(mapping); migrateIdentities!(mapping); }
        return jsonData({ foundationRef: ref(saved), modelRef: mapping ? ref(mapping) : model ? ref(model) : null });
      } };
    },
  });
  foundation.onAdopt = (candidate, save) => changes.commitOwned(candidate, save);
  live.onGovernanceAdopt = (candidate, save, readingFacts) => changes.commitOwned(candidate, save, readingFacts?.length ? { readingFingerprint: fingerprint(readingFacts) } : {});
  const previous = memory.beforeCommit;
  memory.beforeCommit = written => {
    const tracked: Artifact[] = [];
    for (const candidate of written) { const change = changes.trackOwner(candidate); if (change) tracked.push(change); }
    previous?.([...written, ...tracked]);
  };
  // Migrate pending candidates without rewriting their history or pretending an old decision was verified here.
  memory.atomic(() => { for (const kind of ["foundation", "live_ontology", "mapping_change", "relation_correction"]) for (const candidate of memory.listArtifacts(kind)) changes.trackOwner(candidate); });
}

import { namingSubject, descriptionSubject, prepareWordingEdits } from "./wording-changes.ts";
import { z } from "zod";
import { ownerVerificationInputs } from "./owner-verification.ts";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { FoundationService } from "../agent/foundation.ts";
import type { LiveMemory } from "../live/memory.ts";
import { MappingChanges } from "../live/mapping-changes.ts";
import { RelationCorrections } from "../live/relation-corrections.ts";
import { fingerprint } from "./release-diff.ts";
import { ChangeConflict, OntologyChanges, type PreparedChange } from "./changes.ts";
import { connectWordingBatch } from "./wording-batch.ts";

const reference = z.object({ id: z.string().min(1), version: z.number().int().positive() }).strict();
const ownerSubject = z.object({ ownerRef: reference }).strict();
const ref = (a: Artifact) => ({ id: a.id, version: a.version });

/** Adapters keep checks in the owning service; the change service owns decisions and transactions. */
export function connectChanges(memory: MemoryStore, foundation: FoundationService, live: LiveMemory, changes: OntologyChanges) {
  connectWordingBatch(memory, foundation, live, changes);
  changes.registerBatchHandler({
    accepts: selected => selected.every(change => change.content.type === "identity_decision" && !change.content.owner),
    prepare: async (selected, prepared) => {
      const touched = new Set<string>();
      for (const change of selected) {
        const subject = change.content.subject as Data, left = subject.left as Data;
        const key = fingerprint({ rule: subject.ruleId, binding: left.bindingId, record: left.recordId });
        if (touched.has(key)) throw new ChangeConflict("batch_conflict", "选中身份决定涉及同一规则和记录，请逐项处理");
        touched.add(key);
      }
      // These decisions retain one model and modify disjoint record keys, so their synchronous writes commute.
      return () => prepared.map(item => item.apply());
    },
  });
  changes.registerBatchHandler({
    accepts: selected => selected.every(change => change.content.type === "local_correction" && (change.content.owner as Data | undefined)?.kind === "relation_correction"),
    prepare: async (selected, prepared) => {
      const touched = new Set<string>();
      for (const change of selected) {
        const owner = memory.getArtifact(String((change.content.owner as Data).id));
        const target = owner.content.target as Data, relation = (owner.content.snapshot as Data)?.relation as Data | undefined;
        const key = fingerprint({ modelId: target.modelId, modelVersion: target.modelVersion, type: target.type, objectId: target.objectId,
          relation: relation?.relationId ?? target.relation });
        if (touched.has(key)) throw new ChangeConflict("batch_conflict", "选中纠正涉及同一对象关系，请逐项处理");
        touched.add(key);
      }
      return () => prepared.map(item => item.apply());
    },
  });
  const owner = async (change: Artifact, assertActive: () => void = () => {}): Promise<PreparedChange> => {
    assertActive();
    const { ownerRef } = ownerSubject.parse(change.content.subject);
    const candidate = memory.getArtifact(ownerRef.id);
    if (candidate.version !== ownerRef.version) throw new Error("候选版本已变化，请重新读取变更");
    let save: (() => Artifact) | undefined;
    const readingFacts: Data[] = [];
    const capture = (commit: () => Artifact) => { save = commit; return candidate; };
    if (candidate.kind === "foundation") foundation.adopt(candidate.id, candidate.version, { commit: capture });
    else if (candidate.kind === "live_ontology") await live.adopt(candidate.id, candidate.version, capture, undefined, facts => readingFacts.push(facts), assertActive);
    else if (candidate.kind === "mapping_change") await new MappingChanges(memory, live).execute("adopt", { operationId: `change:${change.id}`, ...ref(candidate) }, undefined, assertActive, capture);
    else if (candidate.kind === "relation_correction") await new RelationCorrections(memory, live).execute("adopt", { operationId: `change:${change.id}`, ...ref(candidate) }, undefined, assertActive, capture);
    else throw new Error("该候选类型尚未接入统一变更");
    assertActive();
    if (!save) throw new Error("没有可提交的候选");
    return { verification: { result: "passed", metrics: { ownerValidated: true }, notes: ["已按原服务重新核对来源、权限、版本与执行结果"],
      inputs: { ...ownerVerificationInputs(memory, candidate), ...(readingFacts.length ? { readingFingerprint: fingerprint(readingFacts) } : {}) } }, apply: () => { assertActive(); const saved = save!(); return { ownerRef: ref(saved), ...(saved.content.resultModel ? { modelRef: saved.content.resultModel } : {}) }; } };
  };
  for (const kind of ["foundation", "live_ontology", "mapping_change", "relation_correction"])
    changes.registerOwnerHandler(kind, { subject: ownerSubject, prepare: owner });
  for (const type of ["entity", "property", "binding", "local_correction", "deprecation"]) changes.registerHandler(type, { subject: ownerSubject, prepare: owner });
  for (const type of ["naming", "description"] as const) changes.registerHandler(type, {
    subject: type === "naming" ? namingSubject : descriptionSubject,
    prepare: async change => {
      const prepared = await prepareWordingEdits(memory, foundation, live, changes, [change]);
      return { ...prepared, apply: () => prepared.apply()[0] };
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

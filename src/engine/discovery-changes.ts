import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { FoundationService } from "../agent/foundation.ts";
import type { LiveMemory } from "../live/memory.ts";
import type { Snapshots } from "../data/snapshots.ts";
import type { ProgramBuilds } from "./program-builds.ts";
import type { OntologyChanges } from "./changes.ts";
import type { DiscoveryReview, SuggestedLink } from "./helix-discovery.ts";
import { fingerprint } from "./release-diff.ts";
import { jsonData } from "../live/sources.ts";
import { connectDiscoveryDecisions } from "./discovery-decisions.ts";

const rows = (value: unknown): Data[] => Array.isArray(value) ? value : [];
const unresolved = (change: Artifact) => ["proposed", "verified", "failed"].includes(change.status);
const subjectKey = (type: string, subject: Data) => {
  if (type === "relation") return fingerprint({ type, from: subject.from, to: subject.to, acyclic: subject.acyclic ?? false, cardinality: subject.cardinality ?? "N:1", maxDepth: subject.maxDepth ?? null });
  if (type === "identity_rule") return fingerprint({ type, kind: subject.kind, left: subject.left, right: subject.right, transform: subject.transform ?? { op: "none" } });
  return fingerprint({ type, subject });
};

/** Durable discovery is the recovery source. Derived proposals may be retried after an adopted transaction. */
export function connectDiscoveryChanges(memory: MemoryStore, foundation: FoundationService, live: LiveMemory, snapshots: Snapshots, engine: ProgramBuilds, changes: OntologyChanges) {
  connectDiscoveryDecisions(memory, foundation, live, snapshots, changes);
  let dirty = true, running: Promise<void> | undefined;
  const sync = async () => {
    const model = memory.listArtifacts("live_ontology").find(m => m.status === "adopted");
    const candidate = memory.listArtifacts("engine_candidate").find(c => c.content.discovery && ["candidate", "checked", "adopted"].includes(c.status));
    if (!model || !candidate) return;
    const discovery = candidate.content.discovery as Data, layered = live.readLayered(model.id, model.version);
    const binding = (datasetId: string) => layered.bindings.entities.find(b => b.role === "primary" && snapshots.bindingDataset(b.dataset.sourceId, b.dataset.capability)?.id === datasetId);
    const existingRelation = (from: Data, to: Data) => {
      const a = binding(String(from.datasetId)), b = binding(String(to.datasetId));
      return layered.bindings.relations.find(r => r.fromBindingId === a?.id && r.toBindingId === b?.id && r.fromColumns.length === 1 && r.toColumns.length === 1 && r.fromColumns[0] === from.column && r.toColumns[0] === to.column);
    };
    const propose = async (type: string, subject: Data, evidence: string, observed?: { matchRate: number; targetUnique: boolean }) => {
      const key = subjectKey(type, subject);
      const existing = memory.listArtifacts("ontology_change").find(c => c.content.origin === "program" && !c.content.owner && subjectKey(String(c.content.type), c.content.subject as Data) === key && ["proposed", "verified", "failed", "adopted", "rejected"].includes(c.status));
      if (existing && unresolved(existing)) { changes.rebaseProgramProposal(existing.id); return; }
      if (existing?.status === "adopted") return;
      const baseline = changes.currentBaseline();
      await changes.propose({ operationId: `discovery:${fingerprint({ key, baseline, signature: discovery.signature }).slice(0, 48)}`, origin: "program", type, baseline, subject, evidence, ...(observed ? { observed } : {}) });
    };
    for (const link of (discovery.links ?? []) as unknown as SuggestedLink[]) {
      const from = { datasetId: link.fromDatasetId, column: link.fromColumn }, to = { datasetId: link.toDatasetId, column: link.toColumn };
      if (!binding(from.datasetId) || !binding(to.datasetId) || existingRelation(from, to)) continue;
      const hierarchy = from.datasetId === to.datasetId && /parent|manager|blocked_by|上级|父|汇报|阻塞/i.test(from.column);
      await propose("relation", { from, to, ...(hierarchy ? { acyclic: true, maxDepth: 10 } : {}) },
        `全量快照：${link.fromColumn} → ${link.toColumn}，${link.matchedRows}/${link.totalRows} 条非空记录匹配；采用前需核对业务关系。`);
    }
    for (const review of (discovery.reviews ?? []) as unknown as DiscoveryReview[]) {
      if (review.kind === "value_overlap" && review.from && review.to) {
        const a = binding(review.from.datasetId), b = binding(review.to.datasetId);
        if (!a || !b || a.id === b.id) continue;
        const account = (id: string) => {
          const dataset = snapshots.dataset(id), names = String(dataset.content.name);
          return /users?|accounts?|账号|账户/i.test(names);
        };
        const person = (id: string) => /people|person|employee|staff|人员|员工/i.test(String(snapshots.dataset(id).content.name));
        const belongs = account(review.from.datasetId) && person(review.to.datasetId) || account(review.to.datasetId) && person(review.from.datasetId);
        const reverse = belongs && account(review.to.datasetId);
        const left = reverse ? b : a, right = reverse ? a : b;
        const subject = { kind: belongs ? "belongs_to" : "same_as", left: { bindingId: left.id, columns: [reverse ? review.to.column : review.from.column] },
          right: { bindingId: right.id, columns: [reverse ? review.from.column : review.to.column] }, transform: { op: review.caseInsensitive ? "lowercase" : "none" },
          reason: "来源字段值重合，需明确核对身份含义", evidence: "程序全量快照重合发现；详细读数见本变更依据" };
        await propose("identity_rule", jsonData(subject), review.text, { matchRate: Number(review.totalRows) ? Number(review.matchedRows) / Number(review.totalRows) : 0, targetUnique: true });
      } else if (review.kind === "implied_link" && review.from && review.to && review.path?.length === 4) {
        const endpoint = (x: { datasetId: string; column: string }) => ({ datasetId: x.datasetId, column: x.column });
        const from = endpoint(review.from), to = endpoint(review.to), relation = existingRelation(from, to);
        if (!relation) continue;
        const path = review.path.map(endpoint);
        await propose("deprecation", { relationId: relation.relationTypeId, from, to, path }, review.text,
          { matchRate: Number(review.totalRows) ? Number(review.matchedRows) / Number(review.totalRows) : 0, targetUnique: true });
      } else if (review.kind === "activity") {
        const entity = rows(discovery.entities).find(e => e.id === review.entities[0]), mapped = entity && binding(String(entity.anchorDatasetId));
        if (!mapped || layered.semantic.entityTypes.find(e => e.id === mapped.entityTypeId)?.kind === "activity") continue;
        await propose("data_issue", { classification: "activity", datasetId: String(entity!.anchorDatasetId), entityTypeId: mapped.entityTypeId }, review.text);
      }
    }
  };
  const flush = (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      while (dirty) {
        dirty = false;
        try {
          await sync();
          const recovery = memory.listArtifacts("discovery_recovery")[0];
          if (recovery?.status === "pending") memory.putArtifact({ ...recovery, expectedVersion: recovery.version, status: "completed", content: {} });
        } catch (error) {
          // The principal adoption has already committed. Preserve its success and retry from durable discovery.
          const recovery = memory.listArtifacts("discovery_recovery")[0];
          memory.putArtifact({ ...(recovery ? { id: recovery.id, expectedVersion: recovery.version } : {}), kind: "discovery_recovery", title: "发现提议待恢复", status: "pending", content: { message: (error as Error).message } });
          dirty = false;
        }
      }
    })().finally(() => { running = undefined; });
    return running;
  };
  engine.onDiscovery = () => { dirty = true; return flush(); };
  const previous = memory.beforeCommit;
  memory.beforeCommit = written => {
    previous?.(written);
    if (written.some(a => a.kind === "engine_candidate" || ["foundation", "live_ontology", "ontology_change"].includes(a.kind) && a.status === "adopted")) {
      dirty = true;
      queueMicrotask(() => { void flush(); });
    }
  };
  queueMicrotask(() => { void flush(); });
}

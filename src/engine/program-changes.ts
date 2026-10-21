import { ownerVerificationInputs } from "./owner-verification.ts";
import { z } from "zod";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import { OntologyChanges } from "./changes.ts";
import { ProgramBuilds, structuralDelta, type Selection, type AdoptedBuild } from "./program-builds.ts";
import { fingerprint } from "./release-diff.ts";
import { jsonData } from "../live/sources.ts";

const rows = (x: unknown): Data[] => Array.isArray(x) ? x : [];
const schema = z.object({ candidateRef: z.object({ id: z.string(), version: z.number().int().positive() }), selection: z.object({
  entities: z.array(z.string()), relations: z.array(z.string()), merges: z.array(z.string()), retired: z.array(z.string()).optional(),
}).nullable() });

export function connectProgramChanges(memory: MemoryStore, engine: ProgramBuilds, changes: OntologyChanges) {
  const track = (candidate: Artifact): Artifact[] => {
    if (candidate.kind !== "engine_candidate" || !["candidate", "checked"].includes(candidate.status) || memory.getArtifact(candidate.id).version !== candidate.version) return [];
    const content = candidate.content, delta = structuralDelta(content.diff as Data);
    const discovery = content.discovery as Data | undefined, linkRelations = discovery?.linkRelations as Data | undefined;
    const items: Artifact[] = [];
    for (const [kind, keys] of Object.entries(delta)) for (const key of keys) {
      const type = kind === "entities" ? "entity" : kind === "relations" ? "relation" : kind === "retired" ? "deprecation" : "binding";
      const selection = { entities: [], relations: [], merges: [], retired: [], [kind]: [key] };
      const relation = rows(content.modelRelations).find(r => r.relationId === key);
      const link = rows(discovery?.links).find(l => linkRelations?.[String(l.id)] === key);
      const mapping = rows(content.types).find(t => t.conceptId === key);
      const merged = rows(content.types).flatMap(type => rows(type.supplements).map(supplement => ({ type, supplement }))).find(({ type, supplement }) => `${String(type.name)} ← ${String(supplement.name)}` === key);
      const mergeMatch = merged?.supplement.match as Data | undefined;
      const memberDataset = merged ? memory.listArtifacts("data_dataset").find(dataset =>
        (dataset.content.connectionId === merged.supplement.sourceId || dataset.content.sourceId === merged.supplement.sourceId) && dataset.content.capability === merged.supplement.capability) : undefined;
      const member = memberDataset ? rows(discovery?.entities).flatMap(entity => rows(entity.members)).find(item => item.datasetId === memberDataset.id) : undefined;
      const identity = link ? { method: "foreign_key", from: { datasetId: link.fromDatasetId, column: link.fromColumn }, to: { datasetId: link.toDatasetId, column: link.toColumn } }
        : mapping ? { method: "entity", sourceId: mapping.sourceId, capability: mapping.capability }
          : merged ? { method: "identity_merge", from: { sourceId: merged.supplement.sourceId, capability: merged.supplement.capability, column: mergeMatch?.sourceField },
              to: { sourceId: merged.type.sourceId, capability: merged.type.capability, column: (merged.type.fields as Data)[String(mergeMatch?.primaryField)] } }
          : relation ? { method: "foreign_key", from: relation.from, to: relation.to, fromField: relation.fromField, toField: relation.toField }
            : { method: kind, key };
      const observed = link ? { matchRate: Number(link.totalRows) ? Number(link.matchedRows) / Number(link.totalRows) : 0, targetUnique: true }
        : member ? { matchRate: Number(member.rows) ? Number(member.matched) / Number(member.rows) : 0, targetUnique: true } : undefined;
      const semantic = [...rows(content.concepts), ...rows(content.relations)].find(item => item.id === key);
      const historical = memory.listArtifacts("foundation").find(item => item.status === "adopted");
      const retired = [...rows(historical?.content.concepts), ...rows(historical?.content.relations)].find(item => item.id === key);
      const label = String(semantic?.name ?? retired?.name ?? mapping?.name ?? key);
      items.push(changes.trackProgram(candidate, { type, key, label, selection, identity: jsonData(identity), observed }));
    }
    if (!items.length) items.push(changes.trackProgram(candidate, { type: "binding", key: "刷新既有定义与绑定", selection: null as unknown as Data,
      identity: { method: "refresh", candidateId: candidate.id } }));
    return items;
  };
  const selected = (items: Artifact[], selection?: Selection) => items.filter(item => {
    if (!selection) return true;
    const choice = (item.content.subject as Data).selection as Data | null;
    return choice && ["entities", "relations", "merges", "retired"].some(key => (choice[key] as string[] | undefined)?.some(id => ((selection as unknown as Data)[key] as string[] | undefined)?.includes(id)));
  });
  const finish = (candidate: Artifact, selection: Selection | undefined, save: () => AdoptedBuild) => {
    const result = save();
    engine.continueCandidate(candidate, selection);
    return result;
  };
  engine.onAdopt = (candidate, selection, save) => changes.commitProgram(selected(track(candidate), selection), () => finish(candidate, selection, save));
  changes.registerOwnerHandler("engine_candidate", { subject: schema, prepare: async change => {
    const args = schema.parse(change.content.subject), candidate = memory.getArtifact(args.candidateRef.id);
    if (candidate.version !== args.candidateRef.version) throw new Error("程序候选已变化，请重新读取变更");
    // Stored candidates from before explicit discovery decisions still use this owner adapter.
    const discovery = candidate.content.discovery as Data | undefined;
    const linkRelations = discovery?.linkRelations as Data | undefined;
    for (const link of rows(discovery?.links)) {
      const relationId = linkRelations?.[String(link.id)];
      if (!relationId || args.selection && !args.selection.relations.includes(String(relationId))) continue;
      const checked = await changes.checkRelation({ from: { datasetId: String(link.fromDatasetId), column: String(link.fromColumn) }, to: { datasetId: String(link.toDatasetId), column: String(link.toColumn) } });
      if (checked.result !== "passed") throw new Error(`旧程序关系需要重新提出并复验：${checked.notes.join("；")}`);
    }
    let save: (() => AdoptedBuild) | undefined;
    let actualChecks: Data = {};
    await engine.adopt({ ...args.candidateRef, operationId: `change:${change.id}`, ...(args.selection ? { selection: args.selection } : {}) }, undefined,
      commit => { save = commit; return { status: "adopted", candidate, foundation: candidate, model: candidate }; }, facts => { actualChecks = facts; });
    if (!save) throw new Error("程序候选没有可提交的内容");
    return { verification: { result: "passed", metrics: { ...(change.content.observed as Data ?? {}), selectedItems: args.selection ? Object.values(args.selection).flat().length : 0 },
      notes: ["已用工作版与选中结构重新编译，核对来源、身份、绑定与实际数据"],
      inputs: { ...ownerVerificationInputs(memory, candidate), actualChecks, candidateRef: args.candidateRef, snapshotInputs: candidate.content.snapshotInputs ?? null, selection: jsonData(args.selection), fingerprint: fingerprint(candidate.content.sourceVersions) } },
      apply: () => { const result = finish(candidate, args.selection ?? undefined, save!); return { candidateRef: { id: result.candidate.id, version: result.candidate.version },
        foundationRef: { id: result.foundation.id, version: result.foundation.version }, modelRef: { id: result.model.id, version: result.model.version } }; } };
  } });
  const previous = memory.beforeCommit;
  memory.beforeCommit = written => {
    for (const candidate of [...written]) track(candidate);
    for (const candidate of [...written]) if (candidate.kind === "engine_candidate" && candidate.status === "superseded") changes.supersedeOwner(candidate.id);
    previous?.(written);
  };
  memory.atomic(() => { for (const candidate of memory.listArtifacts("engine_candidate")) track(candidate); });
}

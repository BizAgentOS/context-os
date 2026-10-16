import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { OntologyMember, OntologyNote, SuggestedEntity, SuggestedLink } from "./helix-discovery.ts";

interface Discovery {
  summary: string; entities: SuggestedEntity[]; links: SuggestedLink[]; notes: OntologyNote[];
  unplaced: string[]; unplacedNames?: string[];
  entityConcepts?: Record<string, string>; linkRelations?: Record<string, string>;
}

/** The program discovery behind an adopted foundation, as the ontology page and assistant read it. */
export interface HelixProjection {
  summary: string;
  stats: { tables: number; sources: number; entities: number; links: number };
  notes: { kind: OntologyNote["kind"]; text: string }[];
  unplaced: string[];
  candidateRef: { id: string; version: number };
  concepts: Record<string, Data>;
}

const issueTargets = (issue: Data) => {
  const details = (issue.details ?? {}) as Data;
  return { entity: details.entity as string | undefined, link: details.link as string | undefined };
};

/** Latest adopted program build for this foundation; documents may have added later foundation versions. */
function adoptedBuild(memory: MemoryStore, foundation: Artifact) {
  return memory.listArtifacts("engine_candidate")
    .filter(item => item.status === "adopted" && ((item.content.adoption as Data | undefined)?.foundationRef as Data | undefined)?.id === foundation.id)
    .filter(item => Number(((item.content.adoption as Data).foundationRef as Data).version) <= foundation.version)
    .sort((a, b) => Number(((b.content.adoption as Data).foundationRef as Data).version) - Number(((a.content.adoption as Data).foundationRef as Data).version))[0];
}

export function helixProjection(memory: MemoryStore, foundation: Artifact): HelixProjection | null {
  const build = adoptedBuild(memory, foundation);
  const discovery = build?.content.discovery as unknown as Discovery | undefined;
  if (!build || !discovery?.entityConcepts) return null;
  const entityConcepts = discovery.entityConcepts, linkRelations = discovery.linkRelations ?? {};
  const issues = (build.content.issues ?? []) as Data[];
  const datasetName = new Map<string, string>();
  for (const entity of discovery.entities) for (const m of entity.members) datasetName.set(m.datasetId, m.datasetName);
  const entityName = (id: string) => discovery.entities.find(e => e.id === id)?.name ?? id;

  const concepts: Record<string, Data> = {};
  for (const entity of discovery.entities) {
    const conceptId = entityConcepts[entity.id];
    if (!conceptId) continue;
    const member = (m: OntologyMember) => ({
      datasetName: m.datasetName, source: m.source, rows: m.rows, matched: m.matched, key: m.key,
      anchor: m.datasetId === entity.anchorDatasetId,
      via: m.via ? { column: m.via.column, targetDataset: datasetName.get(m.via.targetDatasetId) ?? m.via.targetDatasetId, targetColumn: m.via.targetColumn } : null,
    });
    const links = discovery.links.filter(l => l.from === entity.id || l.to === entity.id).map(l => {
      const out = l.from === entity.id, other = out ? l.to : l.from;
      return {
        id: l.id, name: l.name, direction: out ? "out" : "in",
        other: { name: entityName(other), conceptId: entityConcepts[other] ?? null },
        from: { dataset: datasetName.get(l.fromDatasetId) ?? l.fromDatasetId, column: l.fromColumn },
        to: { dataset: datasetName.get(l.toDatasetId) ?? l.toDatasetId, column: l.toColumn },
        matchedRows: l.matchedRows, totalRows: l.totalRows, evidence: l.evidence, caseInsensitive: l.caseInsensitive,
        relationId: linkRelations[l.id] ?? null, executable: !!linkRelations[l.id],
      };
    });
    const linkIds = new Set(links.map(l => l.id));
    concepts[conceptId] = {
      entity: { id: entity.id, name: entity.name, kind: entity.kind, key: entity.key, rows: entity.rows,
        properties: entity.properties, members: entity.members.map(member) },
      links,
      notes: discovery.notes.filter(n => n.entities?.includes(entity.id) || n.links?.some(id => linkIds.has(id))).map(n => ({ kind: n.kind, text: n.text })),
      issues: issues.filter(issue => { const t = issueTargets(issue); return t.entity === entity.id || (t.link && linkIds.has(t.link)); })
        .map(issue => ({ code: issue.code, severity: issue.severity, message: issue.message })),
    } as unknown as Data;
  }
  const members = discovery.entities.flatMap(e => e.members);
  return {
    summary: discovery.summary,
    stats: { tables: new Set([...members.map(m => m.datasetId), ...discovery.unplaced]).size, sources: new Set(members.map(m => m.source)).size,
      entities: discovery.entities.length, links: discovery.links.length },
    notes: discovery.notes.map(n => ({ kind: n.kind, text: n.text })),
    unplaced: discovery.unplacedNames ?? discovery.unplaced,
    candidateRef: { id: build.id, version: build.version },
    concepts,
  };
}

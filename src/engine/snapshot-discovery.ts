import type { Artifact } from "../agent/contracts.ts";
import type { DatasetContent, Snapshots } from "../data/snapshots.ts";
import { suggestOntology, type Resource, type SourceInfo, type SuggestedOntology } from "./helix-discovery.ts";
import { fingerprint } from "./release-diff.ts";

/** Helix discovery input from ADE snapshot datasets: each source system is one connection or one upload. */
export function discoveryInput(datasets: Artifact[], sources: (id: string) => Artifact | undefined) {
  const resources: Resource[] = [], infos = new Map<string, SourceInfo>();
  for (const dataset of datasets) {
    const c = dataset.content as unknown as DatasetContent;
    if (!c.activeVersion || !c.profile) continue;
    const source = sources(c.sourceId);
    const upload = source?.kind === "source";
    if (!upload && source) infos.set(source.id, { id: source.id, name: c.capability, data: { kind: String(source.content.protocol ?? "http"),
      ...(source.content.discovery ? { discovery: source.content.discovery as SourceInfo["data"]["discovery"] } : {}) } });
    resources.push({ id: dataset.id, name: c.name, data: { activeVersion: c.activeVersion, profile: c.profile, ...(upload ? {} : { sourceId: c.sourceId }) } });
  }
  return { datasets: resources, sources: [...infos.values()],
    // Any change to which snapshot each dataset reads invalidates a confirmation of the old suggestion.
    signature: fingerprint(resources.map(r => [r.id, r.data.activeVersion])) };
}

export async function discoverFromSnapshots(snapshots: Snapshots, sources: (id: string) => Artifact | undefined, datasetIds?: string[]): Promise<SuggestedOntology> {
  const datasets = snapshots.datasets().filter(d => !datasetIds || datasetIds.includes(d.id));
  return suggestOntology((ids, sql, options) => snapshots.query(ids, sql, options), discoveryInput(datasets, sources));
}

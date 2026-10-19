import type { Data, Repository } from "./contracts.ts";

/** One workspace projection, shared by all three pages. Local CSV adapters are aliases. */
export function sourceSummary(repo: Repository) {
  const files = repo.listArtifacts("source");
  const connections = repo.listArtifacts("source_connection");
  const canonical = new Map(connections.map(a => [a.id, String((a.content.localSource as Data | undefined)?.id ?? a.id)]));
  const datasets = repo.listArtifacts("data_dataset");
  const adopted = repo.listArtifacts("live_ontology").find(a => a.status === "adopted");
  const types = (adopted?.content.types ?? []) as Data[];
  const sources = [...files, ...connections.filter(a => !a.content.localSource)].map(source => {
    const aliases = new Set([source.id, ...connections.filter(a => canonical.get(a.id) === source.id).map(a => a.id)]);
    const sets = datasets.filter(a => aliases.has(String(a.content.sourceId)) || aliases.has(String(a.content.connectionId)));
    const caps = (source.content.capabilities ?? []) as Data[];
    const category = source.kind === "source"
      ? source.content.format === "csv" ? "table" : "document"
      : caps.some(c => !c.contentKind || c.contentKind === "records") ? "table"
        : caps.some(c => c.contentKind === "knowledge") ? "document" : "metric";
    const entityRefs = types.filter(type => [type, ...((type.supplements ?? []) as Data[])].some(binding => aliases.has(String(binding.sourceId)))).map(type => ({ id: String(type.conceptId ?? type.name), name: String(type.name) }));
    const cutoffs = sets.map(a => {
      if (a.content.materialization === "live" || !a.content.activeVersion) return null;
      try { return String(repo.getArtifact(String(a.content.activeVersion)).content.syncedAt); }
      catch { return null; }
    });
    const times = cutoffs.filter((v): v is string => v !== null).sort();
    const syncTimes = sets.map(a => a.content.lastSync).filter((v): v is string => typeof v === "string").sort();
    const rows = sets.length ? cutoffs.every(Boolean) ? sets.reduce((n, a) => n + Number((a.content.profile as Data | null)?.rows ?? 0), 0) : null
      : source.kind === "source" && category === "table" ? ((source.content.rows ?? []) as unknown[]).length : null;
    const size = category === "table" ? { value: rows, unit: "行" }
      : category === "document" && source.kind === "source" ? { value: String(source.content.raw ?? "").length, unit: "字" }
        : { value: null, unit: category === "metric" ? "项指标" : "份文档" };
    return {
      id: source.id, title: source.title, version: source.version, category,
      protocol: source.content.origin === "feishu" || source.content.adapter === "feishu" ? "feishu" : source.kind === "source" ? "file" : String(source.content.protocol ?? "http"),
      status: source.status !== "ready" || source.content.parseError ? "unavailable" : sets.some(a => a.content.pendingVersion) ? "pending_structure" : "ready",
      size, dataAsOf: sets.length ? cutoffs.every(Boolean) ? times[0] : null : source.kind === "source" ? source.createdAt : null,
      dataRange: times.length ? { earliest: times[0], latest: times.at(-1)! } : null,
      lastSyncedAt: syncTimes.at(-1) ?? null,
      entityRefs, datasets: sets.length,
      readMode: category === "document" && source.kind === "source" ? "uploaded_file" : category !== "table" ? "on_demand" : sets.some(a => a.content.materialization === "live") ? "live" : sets.some(a => a.content.activeVersion) ? "active_snapshot" : source.kind === "source" ? "uploaded_file" : "not_synced",
      file: source.kind === "source",
    };
  });
  return { sources, total: sources.length, counts: {
    table: sources.filter(s => s.category === "table").length,
    document: sources.filter(s => s.category === "document").length,
    metric: sources.filter(s => s.category === "metric").length,
  } };
}

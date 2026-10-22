import {sourceTextLength} from "./source-content.ts";
import type { Artifact, Data, Repository } from "./contracts.ts";
import {tableRowCount} from "../data/table-rows.ts";

/** One workspace projection, shared by all three pages. Local CSV adapters are aliases. */
export function sourceSummary(repo: Repository) {
  const files = repo.listArtifacts("source",{content:"compact"}).filter(item=>item.status!=='removed');
  const connections = repo.listArtifacts("source_connection").filter(item=>item.status!=='removed');
  const canonical = new Map(connections.map(a => [a.id, String((a.content.localSource as Data | undefined)?.id ?? a.id)]));
  const datasets = repo.listArtifacts("data_dataset");
  const syncIssues=repo.listArtifacts('sync_issue').filter(item=>item.status==='open');
  const adopted = repo.listArtifacts("live_ontology").find(a => a.status === "adopted");
  const types = (adopted?.content.types ?? []) as Data[];
  const entries = [...files, ...connections.filter(a => !a.content.localSource)].flatMap<{ source: Artifact; table: Data | null }>(source => {
    const tables = source.content.adapter === "database" ? source.content.databaseTables as Data[] : [];
    return tables?.length ? tables.map(table => ({ source, table })) : [{ source, table: null }];
  });
  const sources = entries.map(({ source, table }) => {
    const capability = table ? `${table.schema}.${table.table}` : null;
    const aliases = new Set([source.id, ...connections.filter(a => canonical.get(a.id) === source.id).map(a => a.id)]);
    const sets = datasets.filter(a => (aliases.has(String(a.content.sourceId)) || aliases.has(String(a.content.connectionId))) && (!capability || a.content.capability === capability));
    const caps = (source.content.capabilities ?? []) as Data[];
    const category = source.kind === "source"
      ? source.content.format === "csv" ? "table" : "document"
      : source.content.adapter === "database" || caps.some(c => !c.contentKind || c.contentKind === "records") ? "table"
        : caps.some(c => c.contentKind === "knowledge") ? "document" : "metric";
    const entityRefs = types.filter(type => [type, ...((type.supplements ?? []) as Data[])].some(binding => aliases.has(String(binding.sourceId)) && (!capability || binding.capability === capability))).map(type => ({ id: String(type.conceptId ?? type.name), name: String(type.name) }));
    const problems=syncIssues.filter(item=>aliases.has(String(item.content.sourceId))&&(!capability||item.content.capability===capability)).map(item=>({id:item.id,version:item.version,title:item.title,reasons:((item.content.reasons??[]) as Data[]).map(reason=>({code:reason.code,message:reason.message})),candidate:!!item.content.snapshotId}));
    const cutoffs = sets.map(a => {
      if (a.content.materialization === "live" || !a.content.activeVersion) return null;
      try { return String(repo.getArtifact(String(a.content.activeVersion)).content.syncedAt); }
      catch { return null; }
    });
    const times = cutoffs.filter((v): v is string => v !== null).sort();
    const syncTimes = sets.map(a => a.content.lastSync).filter((v): v is string => typeof v === "string").sort();
    const rows = sets.length ? cutoffs.every(Boolean) ? sets.reduce((n, a) => n + Number((a.content.profile as Data | null)?.rows ?? 0), 0) : null
      : source.kind === "source" && category === "table" ? tableRowCount(source) : null;
    const size = category === "table" ? { value: rows, unit: "行" }
      : category === "document" && source.kind === "source" ? { value: sourceTextLength(source), unit: "字" }
        : { value: null, unit: category === "metric" ? "项指标" : "份文档" };
    return {
      id: capability ? `${source.id}:${capability}` : source.id, title: capability ?? source.title, version: source.version, category,
      ...(source.content.adapter === "database" ? { sourceId: source.id, connectionId: source.id, connectionTitle: source.title, capability, estimatedRows: table?.estimatedRows ?? null } : {}),
      protocol: source.content.origin === "feishu" || source.content.adapter === "feishu" ? "feishu" : source.kind === "source" ? "file" : String(source.content.protocol ?? "http"),
      status: source.status !== "ready" || source.content.parseError || problems.some(item=>!item.candidate) ? "unavailable" : sets.some(a => a.content.pendingVersion) ? "pending_structure" : "ready",
      problems,
      size, dataAsOf: sets.length ? cutoffs.every(Boolean) ? times[0] : null : source.kind === "source" ? source.createdAt : null,
      dataRange: times.length ? { earliest: times[0], latest: times.at(-1)! } : null,
      lastSyncedAt: syncTimes.at(-1) ?? null,
      entityRefs, datasets: sets.length,
      readMode: category === "document" && source.kind === "source" ? "uploaded_file" : category !== "table" ? "on_demand" : sets.some(a => a.content.materialization === "live") ? "live" : sets.some(a => a.content.activeVersion) ? "active_snapshot" : source.kind === "source" ? "uploaded_file" : "not_synced",
      file: source.kind === "source",
      ...(source.content.parseParameters ? {fileFormat:source.content.fileFormat,parseParameters:source.content.parseParameters} : {}),
    };
  });
  return { sources, total: sources.length, counts: {
    table: sources.filter(s => s.category === "table").length,
    document: sources.filter(s => s.category === "document").length,
    metric: sources.filter(s => s.category === "metric").length,
  } };
}

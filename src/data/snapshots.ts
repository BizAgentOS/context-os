import { z } from "zod";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { LiveMemory } from "../live/memory.ts";
import type { Capability } from "../live/sources.ts";
import { jsonData } from "../live/sources.ts";
import { fingerprint } from "../engine/release-diff.ts";
import type { ColumnProfile, ExecutionInput, SnapshotProfile } from "./executor/engine.ts";
import { Executor } from "./executor/jobs.ts";
import { incomingDir, snapshotFile } from "./executor/paths.ts";

const identifier = z.string().trim().min(1).max(200);
const syncInput = z.object({ operationId: identifier, sourceIds: z.array(identifier).max(100).optional() }).strict();
const acceptInput = z.object({ id: identifier, version: z.number().int().positive(), operationId: identifier }).strict();
const policyInput = z.object({ id: identifier, version: z.number().int().positive(), materialization: z.enum(["snapshot", "live"]) }).strict();
const previewInput = z.object({ datasetId: identifier, snapshotId: identifier.optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(50) }).strict();
export interface SnapshotIssue { code: string; severity: "error" | "warning" | "info"; message: string; sourceId?: string; capability?: string; details?: Data }
export interface DatasetContent {
  sourceId: string; sourceVersion: number; connectionId: string | null; capability: string; name: string; idField: string | null;
  materialization: "snapshot" | "live"; activeVersion: string | null; pendingVersion: string | null; versions: string[];
  profile: SnapshotProfile | null; coverage: { rows: number; total: number | null; complete: boolean } | null; lastSync: string | null;
}
const SCOPE = "workspace";
const PAGE = 100;
const RETAINED = 5;
const now = () => new Date().toISOString();
const maxRows = () => Math.max(1, Number(process.env.ADE_SNAPSHOT_MAX_ROWS) || 1_000_000);
const shape = (p: SnapshotProfile | null) => JSON.stringify((p?.columns ?? []).map(c => [c.name, c.type]));

/** Snapshot sync owns materialized data versions; ontology, release and consumer services only pin and read them. */
export class Snapshots {
  readonly executor: Executor;
  private memory: MemoryStore;
  private live: LiveMemory;
  private root: string;
  private running = new Map<string, Promise<Artifact>>();
  private closing = false;

  constructor(memory: MemoryStore, live: LiveMemory, stateDir: string) {
    this.memory = memory; this.live = live; this.root = join(stateDir, "data");
    this.executor = new Executor(this.root);
    for (const job of this.memory.listArtifacts("data_sync")) {
      if (["queued", "running"].includes(job.status)) this.memory.putArtifact({ ...job, expectedVersion: job.version, status: "interrupted", content: { ...job.content, finishedAt: now(), outcome: "interrupted",
        issues: [...(job.content.issues as Data[] ?? []), { code: "restart", severity: "warning", message: "服务重启中断同步。已完成的快照保留；重新同步会重新读取来源。" }] } });
    }
  }

  overview() { return { datasets: this.datasets(), jobs: this.memory.listArtifacts("data_sync").slice(0, 20) }; }
  datasets() { return this.memory.listArtifacts("data_dataset"); }
  dataset(id: string) {
    const a = this.memory.getArtifact(id);
    if (a.kind !== "data_dataset") throw new Error("数据集不存在");
    return a;
  }
  /** Table name a dataset has inside snapshot queries. */
  table(datasetId: string) { return "d_" + datasetId.replaceAll("-", ""); }

  start(args: unknown): Artifact {
    if (this.closing) throw new Error("数据同步服务正在关闭");
    const parsed = syncInput.parse(args);
    const input = { ...parsed, ...(parsed.sourceIds ? { sourceIds: [...new Set(parsed.sourceIds)].sort() } : {}) };
    const inputHash = fingerprint(input);
    const prior = this.memory.listArtifacts("data_sync").find(job => job.content.operationId === input.operationId);
    if (prior) { if (prior.content.inputHash !== inputHash) throw new Error("同一操作标识不能用于不同同步范围"); return prior; }
    if (this.memory.listArtifacts("data_sync").some(job => ["queued", "running"].includes(job.status))) throw new Error("已有数据同步正在运行，请完成后重试");
    const sources = this.selectedSources(input.sourceIds);
    const job = this.memory.putArtifact({ kind: "data_sync", title: "同步数据快照", status: "queued", content: jsonData({ operationId: input.operationId, inputHash, sourceIds: input.sourceIds,
      sourceVersions: Object.fromEntries(sources.map(s => [s.id, s.version])), progress: [], issues: [], outcome: "pending" }) });
    const running = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.execute(job.id, sources));
    this.running.set(job.id, running);
    void running.finally(() => this.running.delete(job.id));
    return job;
  }

  async sync(args: unknown): Promise<Artifact> {
    const job = this.start(args);
    return this.running.get(job.id) ?? this.memory.getArtifact(job.id);
  }

  async close() {
    this.closing = true;
    await Promise.allSettled(this.running.values());
    await this.executor.stop();
  }

  /** Promote a pending schema version after the user has seen the change. */
  accept(args: unknown) {
    const input = acceptInput.parse(args);
    const replay = this.memory.listArtifacts("data_dataset").find(a => a.id === input.id && (a.content.acceptedBy as string[] | undefined)?.includes(input.operationId));
    if (replay) return replay;
    const current = this.versioned(input), c = current.content as unknown as DatasetContent;
    if (!c.pendingVersion) throw new Error("没有待确认的结构变化");
    const snapshot = this.memory.getArtifact(c.pendingVersion);
    return this.memory.putArtifact({ ...current, content: jsonData({ ...c, activeVersion: c.pendingVersion, pendingVersion: null, profile: snapshot.content.profile, coverage: snapshot.content.coverage,
      acceptedBy: [...((current.content.acceptedBy as string[] | undefined) ?? []), input.operationId].slice(-20) }) });
  }

  setPolicy(args: unknown) {
    const input = policyInput.parse(args), current = this.versioned(input);
    return this.memory.putArtifact({ ...current, content: jsonData({ ...current.content, materialization: input.materialization }) });
  }

  async preview(args: unknown) {
    const input = previewInput.parse(args), dataset = this.dataset(input.datasetId), c = dataset.content as unknown as DatasetContent;
    const snapshotId = input.snapshotId ?? c.activeVersion;
    if (!snapshotId || !c.versions.includes(snapshotId) && snapshotId !== c.pendingVersion) throw new Error("该数据集没有这个快照版本");
    const result = await this.executor.run({ mode: "query", scope: SCOPE, inputs: [{ table: "t", version: snapshotId }], sql: "SELECT * FROM t", offset: input.offset, limit: input.limit });
    return { rows: result.rows, total: result.profile.rows, snapshot: { id: snapshotId, status: snapshotId === c.activeVersion ? "current" : snapshotId === c.pendingVersion ? "pending" : "historical" } };
  }

  /** Execution inputs for datasets, at their active version unless a snapshot is pinned. */
  inputs(refs: Array<string | { datasetId: string; snapshotId: string }>): Array<ExecutionInput & { datasetId: string }> {
    return refs.map(item => {
      const datasetId = typeof item === "string" ? item : item.datasetId;
      let dataset: Artifact;
      try { dataset = this.dataset(datasetId); } catch { throw new Error(`数据集不存在：${datasetId}`); }
      const c = dataset.content as unknown as DatasetContent, version = typeof item === "string" ? c.activeVersion : item.snapshotId;
      if (!version || !c.versions.includes(version) && version !== c.pendingVersion) throw new Error(`数据集 ${c.name} 没有可用快照`);
      return { datasetId, table: this.table(datasetId), version, aliases: [c.name] };
    });
  }

  async query(refs: Array<string | { datasetId: string; snapshotId: string }>, sql: string, options: { limit?: number; offset?: number; persist?: string } = {}) {
    const inputs = this.inputs(refs);
    const result = await this.executor.run({ mode: "query", scope: SCOPE, inputs: inputs.map(({ datasetId: _, ...input }) => input), sql, limit: options.limit, offset: options.offset,
      ...(options.persist ? { persist: true, version: options.persist } : {}) });
    return { ...result, inputs: inputs.map(i => ({ datasetId: i.datasetId, snapshotId: i.version })) };
  }

  private versioned(input: { id: string; version: number }) {
    const current = this.dataset(input.id);
    if (current.version !== input.version) throw new Error("数据集版本已变化，请重新读取");
    return { ...current, expectedVersion: current.version };
  }

  private selectedSources(ids?: string[]) {
    const sources = [...this.live.sources.list().filter(s => s.status === "ready" && !s.content.localSource),
      ...this.memory.listArtifacts("source").filter(s => s.status === "ready" && s.content.format === "csv")];
    if (!ids) return sources;
    const selected = ids.map(id => sources.find(s => s.id === id));
    if (selected.some(s => !s)) throw new Error("所选来源不存在、已停用或不是结构化记录来源");
    return selected as Artifact[];
  }

  private update(id: string, patch: (content: Data) => Data, status = "running") {
    const job = this.memory.getArtifact(id);
    if (!["queued", "running"].includes(job.status)) throw new Error("同步已停止");
    return this.memory.putArtifact({ ...job, expectedVersion: job.version, status, content: jsonData(patch(job.content)) });
  }

  private async execute(id: string, sources: Artifact[]): Promise<Artifact> {
    const issues: SnapshotIssue[] = [];
    try {
      this.update(id, c => ({ ...c, startedAt: now() }));
      for (const source of sources) {
        const caps = source.kind === "source" ? [null] : (source.content.capabilities as unknown as Capability[]).filter(cap => !cap.contentKind || cap.contentKind === "records");
        for (const cap of caps) {
          const capability = cap?.name ?? "records";
          const existing = this.find(source.id, capability);
          if (existing && (existing.content as unknown as DatasetContent).materialization === "live") {
            this.update(id, c => ({ ...c, progress: [...c.progress as Data[], { sourceId: source.id, capability, status: "skipped", message: "该数据集设为实时读取，不生成快照" }] }));
            continue;
          }
          try {
            const outcome = await this.syncOne(source, cap, issues);
            this.update(id, c => ({ ...c, progress: [...c.progress as Data[], { sourceId: source.id, capability, status: outcome.status, rows: outcome.rows, datasetId: outcome.datasetId }] }));
          } catch (error) {
            if (this.memory.getArtifact(id).status !== "running") throw error;
            issues.push({ code: "source_sync_failed", severity: "error", sourceId: source.id, capability, message: (error as Error).message });
            this.update(id, c => ({ ...c, progress: [...c.progress as Data[], { sourceId: source.id, capability, status: "failed", message: (error as Error).message }] }));
          }
        }
      }
      return this.update(id, c => ({ ...c, issues: [...c.issues as Data[], ...jsonData(issues) as unknown as Data[]], finishedAt: now(),
        outcome: !sources.length ? "empty" : issues.some(i => i.severity === "error") ? "needs_attention" : "synced" }), "completed");
    } catch (error) {
      const job = this.memory.getArtifact(id);
      if (!["queued", "running"].includes(job.status)) return job;
      return this.memory.putArtifact({ ...job, expectedVersion: job.version, status: "failed", content: jsonData({ ...job.content, outcome: "failed", finishedAt: now(),
        issues: [...job.content.issues as Data[], ...issues, { code: "sync_failed", severity: "error", message: (error as Error).message }] }) });
    }
  }

  private find(sourceId: string, capability: string) {
    return this.datasets().find(d => d.content.sourceId === sourceId && d.content.capability === capability);
  }

  /** Reads one capability completely (up to the row cap) into JSON lines, ingests it, then decides the dataset pointers. */
  private async syncOne(source: Artifact, cap: Capability | null, issues: SnapshotIssue[]) {
    const capability = cap?.name ?? "records", snapshotId = randomUUID();
    const dir = incomingDir(this.root, SCOPE), file = join(dir, `${snapshotId}.jsonl`);
    await mkdir(dir, { recursive: true });
    let rows = 0, total: number | null = null, complete = true;
    try {
      const out = createWriteStream(file);
      const write = async (row: Data) => { if (!out.write(JSON.stringify(row) + "\n")) await once(out, "drain"); };
      if (!cap) {
        // CSV cells stay text, so identities such as 001 keep their form.
        const all = (source.content.rows as Data[]) ?? [], limit = maxRows();
        for (const row of all.slice(0, limit)) await write(row);
        rows = Math.min(all.length, limit); total = all.length; complete = all.length <= limit;
      } else {
        const limit = maxRows();
        for (let offset = 0; offset < limit;) {
          const page = await this.live.sources.readRecords(source.id, cap.name, {}, offset, Math.min(PAGE, limit - offset), source.version);
          for (const row of page.items) await write(row);
          rows += page.items.length; offset += page.items.length; total = page.coverage.total;
          if (!page.items.length || (total !== null && offset >= total) || (total === null && page.items.length < PAGE)) break;
        }
        complete = total === null ? rows < limit : rows >= total;
      }
      out.end(); await once(out, "finish");
      if (!complete) issues.push({ code: "snapshot_capacity", severity: "warning", sourceId: source.id, capability, message: `已读取 ${rows} 行，达到单次快照上限；快照不代表全量数据。`, details: { rows, total, limit: maxRows() } });
      const result = await this.executor.run({ mode: "ingest", scope: SCOPE, version: snapshotId, file: `${snapshotId}.jsonl` });
      return this.register(source, cap, snapshotId, result.profile, { rows, total, complete }, issues);
    } finally { await rm(file, { force: true }); }
  }

  private register(source: Artifact, cap: Capability | null, snapshotId: string, profile: SnapshotProfile, coverage: DatasetContent["coverage"] & {}, issues: SnapshotIssue[]) {
    const capability = cap?.name ?? "records", syncedAt = now();
    const connection = cap ? source.id : this.live.sources.list().find(c => (c.content.localSource as Data | undefined)?.id === source.id)?.id ?? null;
    let discard = false;
    const result = this.memory.atomic(() => {
      const prior = this.find(source.id, capability), c = prior?.content as unknown as DatasetContent | undefined;
      const base = { sourceId: source.id, sourceVersion: source.version, connectionId: connection, capability, name: cap ? `${source.title} · ${cap.name}` : source.title, idField: cap?.idField ?? null };
      if (c?.profile && c.profile.fingerprint === profile.fingerprint && !c.pendingVersion) {
        discard = true;
        this.memory.putArtifact({ ...prior!, expectedVersion: prior!.version, content: jsonData({ ...c, ...base, lastSync: syncedAt }) });
        return { status: "unchanged", rows: profile.rows, datasetId: prior!.id };
      }
      const drift = !!c?.profile && shape(c.profile) !== shape(profile);
      // Snapshots are immutable and keyed by their Parquet file name.
      this.memory.createArtifact(snapshotId, { kind: "data_snapshot", title: base.name, status: "ready", content: jsonData({ datasetSourceId: source.id, capability, file: `${snapshotId}.parquet`, profile, coverage, sourceVersion: source.version, syncedAt }) });
      if (c?.profile) issues.push(...quality(c.profile, profile, source.id, capability));
      if (drift) issues.push({ code: "schema_drift", severity: "warning", sourceId: source.id, capability, message: "字段结构变化：新版本待确认，当前已采用的版本继续提供读取。",
        details: { before: JSON.parse(shape(c!.profile)), after: JSON.parse(shape(profile)) } });
      if (!profile.rows) issues.push({ code: "empty_snapshot", severity: "warning", sourceId: source.id, capability, message: "来源当前没有记录；已保存空快照。" });
      const versions = [snapshotId, ...(c?.versions ?? [])];
      const content: DatasetContent = { ...base, materialization: c?.materialization ?? "snapshot", versions,
        activeVersion: drift ? c!.activeVersion : snapshotId, pendingVersion: drift ? snapshotId : null,
        profile: drift ? c!.profile : profile, coverage: drift ? c!.coverage : coverage, lastSync: syncedAt };
      const dataset = this.memory.putArtifact({ ...(prior ? { id: prior.id, expectedVersion: prior.version } : {}), kind: "data_dataset", title: base.name, status: "ready", content: jsonData(content) });
      return { status: drift ? "pending" : "updated", rows: profile.rows, datasetId: dataset.id };
    });
    if (discard) void rm(snapshotFile(this.root, SCOPE, snapshotId), { force: true });
    else void this.prune(result.datasetId);
    return result;
  }

  /** Keeps the newest versions and every version a release pins; files of other versions are removed. */
  private async prune(datasetId: string) {
    const dataset = this.dataset(datasetId), c = dataset.content as unknown as DatasetContent;
    const pinned = new Set(this.memory.listArtifacts("data_release").flatMap(r => ((r.content.snapshots as Data[] | undefined) ?? []).map(s => String(s.snapshotId))));
    const keep = new Set([...c.versions.slice(0, RETAINED), c.activeVersion, c.pendingVersion].filter(Boolean) as string[]);
    const dropped = c.versions.filter(v => !keep.has(v) && !pinned.has(v));
    if (!dropped.length) return;
    this.memory.putArtifact({ ...dataset, expectedVersion: dataset.version, content: jsonData({ ...c, versions: c.versions.filter(v => !dropped.includes(v)) }) });
    for (const v of dropped) await rm(snapshotFile(this.root, SCOPE, v), { force: true });
  }
}

export function quality(before: SnapshotProfile, after: SnapshotProfile, sourceId: string, capability: string): SnapshotIssue[] {
  const issues: SnapshotIssue[] = [], prior = new Map<string, ColumnProfile>(before.columns.map(c => [c.name, c]));
  for (const col of after.columns) {
    const old = prior.get(col.name);
    if (!old) continue;
    if (old.primaryKey && !col.primaryKey && after.rows > 0) issues.push({ code: "uniqueness_lost", severity: "warning", sourceId, capability, message: `字段 ${col.name} 原本唯一非空，新快照中出现重复或空值。`, details: { column: col.name } });
    const was = before.rows ? old.nulls / before.rows : 0, is = after.rows ? col.nulls / after.rows : 0;
    if (is - was >= 0.1) issues.push({ code: "null_rate_increased", severity: "warning", sourceId, capability, message: `字段 ${col.name} 空值率从 ${Math.round(was * 100)}% 升至 ${Math.round(is * 100)}%。`, details: { column: col.name, before: was, after: is } });
  }
  return issues;
}

import { retrySourceRead } from "./source-retry.ts";
import { snapshotWatermark, validateIncrement, type Watermark } from "./snapshot-increment.ts";
import { readSnapshotPages, finishSnapshotPages } from "./snapshot-pages.ts";
import { policyFor, qualityBreaks } from "./sync-policy.ts";
import {tableRows,tableRowCount} from "./table-rows.ts";
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
import { lit, quote, type ColumnProfile, type ExecutionInput, type SnapshotProfile } from "./executor/engine.ts";
import { Executor, type ExecutionOptions } from "./executor/jobs.ts";
import { incomingDir, snapshotFile } from "./executor/paths.ts";

const identifier = z.string().trim().min(1).max(200);
const syncInput = z.object({ operationId: identifier, sourceIds: z.array(identifier).max(100).optional(), full: z.boolean().optional() }).strict();
const acceptInput = z.object({ id: identifier, version: z.number().int().positive(), operationId: identifier }).strict();
const policyInput = z.object({ id: identifier, version: z.number().int().positive(), materialization: z.enum(["snapshot", "live"]) }).strict();
const previewInput = z.object({ datasetId: identifier, snapshotId: identifier.optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(50) }).strict();
export interface SnapshotIssue { code: string; severity: "error" | "warning" | "info"; message: string; sourceId?: string; capability?: string; details?: Data }
export interface DatasetContent {
  sourceId: string; sourceVersion: number; connectionId: string | null; capability: string; name: string; idField: string | null;
  materialization: "snapshot" | "live"; activeVersion: string | null; pendingVersion: string | null; versions: string[];
  watermark?: Watermark | null; observedFields?: string[]; excludedFields?: string[];
  profile: SnapshotProfile | null; coverage: { rows: number; total: number | null; complete: boolean } | null; lastSync: string | null;
  /** Column differences of the pending version, shown to the user before confirming it. */
  pendingReasons?: Data[];
  pendingChanges?: { column: string; before: string | null; after: string | null }[];
}
const SCOPE = "workspace";
const PAGE = 100;
const RETAINED = 5;
const now = () => new Date().toISOString();
const maxRows = () => Math.max(1, Number(process.env.ADE_SNAPSHOT_MAX_ROWS) || 1_000_000);
const shape = (p: SnapshotProfile | null) => JSON.stringify((p?.columns ?? []).map(c => [c.name, c.type]));
const columnChanges = (before: SnapshotProfile, after: SnapshotProfile) => {
  const a = new Map(before.columns.map(c => [c.name, c.type])), b = new Map(after.columns.map(c => [c.name, c.type]));
  return [...new Set([...a.keys(), ...b.keys()])].filter(k => a.get(k) !== b.get(k)).map(column => ({ column, before: a.get(column) ?? null, after: b.get(column) ?? null }));
};

/** Snapshot sync owns materialized data versions; ontology, release and consumer services only pin and read them. */
export class Snapshots {
  readonly executor: Executor;
  private memory: MemoryStore;
  private live: LiveMemory;
  private root: string;
  private running = new Map<string, Promise<Artifact>>();
  private closing = false;
  private sourceRuns = new Map<string, Promise<void>>();
  private activeSources = 0;
  private sourceWaiters: Array<() => void> = [];
  /** Called when a sync outside a program build, or an accepted schema change, gives sources new current data. */
  onChanged?: (sourceIds: string[], key: string) => void;

  constructor(memory: MemoryStore, live: LiveMemory, stateDir: string) {
    this.memory = memory; this.live = live; this.root = join(stateDir, "data");
    this.executor = new Executor(this.root);
    live.snapshots = this;
    for (const job of this.memory.listArtifacts("data_sync")) {
      if (["queued", "running"].includes(job.status)) this.memory.putArtifact({ ...job, expectedVersion: job.version, status: "interrupted", content: { ...job.content, finishedAt: now(), outcome: "interrupted",
        issues: [...(job.content.issues as Data[] ?? []), { code: "restart", severity: "warning", message: "服务重启中断同步。已完成的快照保留；恢复同步从最后成功分页继续。" }] } });
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
    const sources = this.selectedSources(input.sourceIds);
    const job = this.memory.putArtifact({ kind: "data_sync", title: "同步数据快照", status: "queued", content: jsonData({ operationId: input.operationId, inputHash, sourceIds: input.sourceIds,
      full: input.full === true, sourceVersions: Object.fromEntries(sources.map(s => [s.id, s.version])), progress: [], issues: [], outcome: "pending" }) });
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
  accept(args: unknown, decision?: { issueId: string; issueVersion: number; reason: string }) {
    const input = acceptInput.parse(args);
    const replay = this.memory.listArtifacts("data_dataset").find(a => a.id === input.id && (a.content.acceptedBy as string[] | undefined)?.includes(input.operationId));
    if (replay) return replay;
    const current = this.versioned(input), { pendingChanges: _, pendingReasons: __, ...c } = current.content as unknown as DatasetContent;
    if (!c.pendingVersion) throw new Error("没有待确认的结构变化");
    const snapshot = this.memory.getArtifact(c.pendingVersion);
    const issue = this.memory.listArtifacts("sync_issue").find(item => item.status === "open" && (item.content.datasetRef as Data | null)?.id === current.id && item.content.snapshotId === c.pendingVersion);
    const quality = ((current.content.pendingReasons ?? issue?.content.reasons ?? []) as Data[]).some(reason => reason.code !== "schema_drift");
    if (quality && (!decision || !decision.reason.trim())) throw new Error("请在数据问题待处理中填写理由并确认新快照");
    if (decision && (!issue || issue.id !== decision.issueId || issue.version !== decision.issueVersion)) throw new Error("数据问题已经变化，请重新读取");
    const accepted = this.memory.atomic(() => {
      const source = this.memory.getArtifact(c.sourceId);
      if (source.status !== "ready" || source.content.adapter !== "database" && source.version !== snapshot.content.sourceVersion) throw new Error("来源版本或授权已变化，请重新同步");
      const connection = source.content.adapter === "database" ? this.live.sources.databases.acceptSchema(source.id, c.capability, Number(snapshot.content.sourceVersion),
        (snapshot.content.profile as unknown as SnapshotProfile).columns) : source.kind === "source_connection"
        ? this.live.sources.acceptSnapshotSchema(source.id, c.capability, source.version, (snapshot.content.profile as unknown as SnapshotProfile).columns) : null;
      const dataset = this.memory.putArtifact({ ...current, content: jsonData({ ...c, watermark: snapshot.content.watermark ?? null, observedFields: snapshot.content.observedFields, excludedFields: snapshot.content.excludedFields, ...(connection ? { sourceVersion: connection.version } : {}), activeVersion: c.pendingVersion, pendingVersion: null, profile: snapshot.content.profile, coverage: snapshot.content.coverage,
        acceptedBy: [...((current.content.acceptedBy as string[] | undefined) ?? []), input.operationId].slice(-20) }) });
      if (issue) this.memory.putArtifact({ ...issue, expectedVersion: issue.version, status: "accepted", content: { ...issue.content, decision: "accept", reason: decision?.reason ?? "已确认字段结构变化", actor: "local-admin", decidedAt: now() } });
      return dataset;
    });
    this.onChanged?.([c.sourceId], c.pendingVersion);
    return accepted;
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
    const inputs = this.inputs(refs).filter((input, i, all) => all.findIndex(other => other.datasetId === input.datasetId) === i);
    const result = await this.executor.run({ mode: "query", scope: SCOPE, inputs: inputs.map(({ datasetId: _, ...input }) => input), sql, limit: options.limit, offset: options.offset,
      ...(options.persist ? { persist: true, version: options.persist } : {}) });
    return { ...result, inputs: inputs.map(i => ({ datasetId: i.datasetId, snapshotId: i.version })) };
  }

  /** Runs over explicit snapshot versions, such as derived pipeline outputs that are not datasets of their own. */
  async run(inputs: ExecutionInput[], sql: string, options: { limit?: number; persist?: string } = {}) {
    return this.executor.run({ mode: "query", scope: SCOPE, inputs, sql, limit: options.limit, ...(options.persist ? { persist: true, version: options.persist } : {}) });
  }

  /** A bounded read uses the shared queue and does not profile or materialize the whole result. */
  async read(inputs: ExecutionInput[], sql: string, options: ExecutionOptions & { limit?: number; offset?: number } = {}) {
    return this.executor.run({ mode: "read", scope: SCOPE, inputs, sql, limit: options.limit, offset: options.offset }, options);
  }

  /**
   * Records of a locked snapshot with a source read's contract: exact filters, id order, paging and coverage.
   * The SQL is generated here; fixed reads share the same queue, deadlines and cancellation as semantic queries.
   */
  async readPinned(snapshotId: string, cap: Capability, binding: { sourceId: string; connectionVersion: number }, where: Data, offset: number, limit: number, options: ExecutionOptions = {}) {
    const snapshot = this.memory.getArtifact(snapshotId);
    if (snapshot.kind !== "data_snapshot") throw new Error("锁定的数据快照不存在");
    const profile = snapshot.content.profile as unknown as SnapshotProfile, types = new Map(profile.columns.map(c => [c.name, c.type]));
    const numeric = (name: string) => /INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC/.test(types.get(name) ?? "");
    const conditions = Object.entries(where).map(([field, value]) => {
      if (!types.has(field)) return "FALSE";
      if (value === null) return `${quote(field)} IS NULL`;
      if (typeof value === "number") return numeric(field) ? `${quote(field)} = ${value}` : `CAST(${quote(field)} AS VARCHAR) = ${lit(String(value))}`;
      if (typeof value === "boolean") return `CAST(${quote(field)} AS VARCHAR) = ${lit(String(value))}`;
      return `CAST(${quote(field)} AS VARCHAR) = ${lit(String(value))}`;
    });
    const select = cap.fields.map(f => types.has(f) ? quote(f) : `NULL AS ${quote(f)}`).join(", ");
    const order = types.has(cap.idField) ? ` ORDER BY ${quote(cap.idField)}` : "";
    const result = await this.read([{ table: "t", version: snapshotId }],
      `SELECT ${select} FROM t${conditions.length ? " WHERE " + conditions.join(" AND ") : ""}${order}`, { ...options, limit, offset });
    // DuckDB returns BIGINT and DECIMAL as text; restore numbers so identity types match the source contract.
    const items = result.rows.map(row => Object.fromEntries(cap.fields.map(f => {
      const v = row[f] as unknown;
      return [f, v !== null && v !== undefined && numeric(f) && Number.isFinite(Number(v)) ? Number(v) : v ?? null];
    }))) as Data[];
    const snapshotTotal = result.total, sourceComplete = (snapshot.content.coverage as Data | undefined)?.complete === true;
    return { items, coverage: { offset, shown: items.length, total: sourceComplete ? snapshotTotal : null,
      complete: sourceComplete && offset === 0 && items.length === snapshotTotal, sourceComplete, snapshotTotal },
      provenance: { sourceId: binding.sourceId, connectionVersion: binding.connectionVersion, capability: cap.name, readAt: String(snapshot.content.syncedAt), historicalReplay: true, snapshotId } };
  }

  /** The snapshot dataset an execution binding reads: a connection itself, or the CSV a connection serves. */
  bindingDataset(connectionId: string, capability: string) {
    let origin = connectionId;
    try { origin = String((this.memory.getArtifact(connectionId).content.localSource as Data | undefined)?.id ?? connectionId); } catch { return undefined; }
    return this.find(origin, capability);
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

  private async sourceSlot<T>(sourceId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.sourceRuns.get(sourceId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; }); this.sourceRuns.set(sourceId, tail);
    await previous;
    if (this.activeSources >= 3) await new Promise<void>(resolve => this.sourceWaiters.push(resolve));
    else this.activeSources++;
    try { return await action(); }
    finally { const next = this.sourceWaiters.shift(); if (next) next(); else this.activeSources--; release(); if (this.sourceRuns.get(sourceId) === tail) this.sourceRuns.delete(sourceId); }
  }
  private syncIssue(source: Artifact, capability: string, reasons: Data[], dataset?: Artifact, snapshotId?: string) {
    for (const prior of this.memory.listArtifacts("sync_issue").filter(item => item.status === "open" && item.content.sourceId === source.id && item.content.capability === capability && (dataset || !item.content.snapshotId)))
      this.memory.putArtifact({ ...prior, expectedVersion: prior.version, status: "superseded" });
    return this.memory.putArtifact({ kind: "sync_issue", title: source.title + " · 数据待核对", status: "open", content: jsonData({ sourceId: source.id, sourceVersion: source.version, capability, reasons,
      datasetRef: dataset ? { id: dataset.id, version: dataset.version } : null, snapshotId: snapshotId ?? null }) });
  }
  private async execute(id: string, sources: Artifact[]): Promise<Artifact> {
    const issues: SnapshotIssue[] = [];
    try {
      this.update(id, c => ({ ...c, startedAt: now() }));
      await Promise.all(sources.map(source => this.sourceSlot(source.id, async () => {
        const caps = source.kind === "source" ? [null] : (source.content.capabilities as unknown as Capability[]).filter(cap => !cap.contentKind || cap.contentKind === "records");
        for (const cap of caps) {
          const capability = cap?.name ?? "records";
          const existing = this.find(source.id, capability);
          if (existing && (existing.content as unknown as DatasetContent).materialization === "live") {
            this.update(id, c => ({ ...c, progress: [...c.progress as Data[], { sourceId: source.id, capability, status: "skipped", message: "该数据集设为实时读取，不生成快照" }] }));
            continue;
          }
          try {
            const outcome = await this.syncOne(source, cap, issues, this.memory.getArtifact(id).content.full === true);
            this.update(id, c => ({ ...c, progress: [...c.progress as Data[], { sourceId: source.id, capability, status: outcome.status, rows: outcome.rows, datasetId: outcome.datasetId }] }));
          } catch (error) {
            if (this.memory.getArtifact(id).status !== "running") throw error;
            issues.push({ code: "source_sync_failed", severity: "error", sourceId: source.id, capability, message: (error as Error).message });
            this.syncIssue(source, capability, [{ code: "source_sync_failed", message: (error as Error).message }]);
            this.update(id, c => ({ ...c, progress: [...c.progress as Data[], { sourceId: source.id, capability, status: "failed", message: (error as Error).message }] }));
          }
        }
      })));
      const done = this.update(id, c => ({ ...c, issues: [...c.issues as Data[], ...jsonData(issues) as unknown as Data[]], finishedAt: now(),
        outcome: !sources.length ? "empty" : issues.some(i => i.severity === "error") || (c.progress as Data[]).some(item => item.status === "pending") ? "needs_attention" : "synced" }), "completed");
      // A program build syncs its own inputs; only other syncs ask for a rebuild.
      const changed = [...new Set((done.content.progress as Data[]).filter(p => p.status === "updated").map(p => String(p.sourceId)))];
      if (changed.length && !String(done.content.operationId).startsWith("build:")) this.onChanged?.(changed, id);
      return done;
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
  private async syncOne(source: Artifact, cap: Capability | null, issues: SnapshotIssue[], full: boolean) {
    const capability = cap?.name ?? "records", database = source.content.adapter === "database";
    let snapshotId = randomUUID();
    const prior = this.find(source.id, capability), previous = prior?.content as unknown as DatasetContent | undefined;
    const settings = policyFor(this.memory, source), field = settings.incrementalField;
    const incremental = !full && cap && (database || cap.incrementalParam) && previous?.coverage?.complete && previous.watermark?.field === field
      ? { field: previous.watermark.field, since: previous.watermark.value } : undefined;
    let filename = `${snapshotId}.${database ? "parquet" : "jsonl"}`;
    const dir = incomingDir(this.root, SCOPE); let file = join(dir, filename);
    await mkdir(dir, { recursive: true });
    let rows = 0, total: number | null = null, complete = true;
    const out = cap ? null : createWriteStream(file);
    let paged: Awaited<ReturnType<typeof readSnapshotPages>> | undefined, finished = false;
    try {
      const write = async (row: Data) => { if (!out!.write(JSON.stringify(row) + "\n")) await once(out!, "drain"); };
      if (!cap) {
        // CSV cells stay text, so identities such as 001 keep their form.
        const limit = maxRows();total = tableRowCount(source);
        for await (const row of tableRows(source,this.memory)) {if(rows>=limit)break;await write(row);rows++;}
        complete = rows === total;
      } else if (database) {
        const result = await retrySourceRead(async () => { await rm(file, { force: true }); return this.live.sources.databases.snapshot(source.id, cap.name, source.version, maxRows(), file, incremental); });
        rows = result.rows; total = result.total; complete = result.complete;
      } else {
        paged = await readSnapshotPages(this.memory, this.live.sources, this.root, source, cap, maxRows(), previous?.activeVersion ?? null, incremental, previous?.profile?.rows ? previous.observedFields ?? previous.profile.columns.map(column => column.name) : undefined, previous?.excludedFields);
        file = paged.file; filename = paged.filename; rows = paged.rows; total = paged.total; complete = paged.complete;
      }
      if (out) { out.end(); await once(out, "finish"); }
      if (!complete) issues.push({ code: "snapshot_capacity", severity: "warning", sourceId: source.id, capability, message: `已读取 ${rows} 行，达到单次快照上限；快照不代表全量数据。`, details: { rows, total, limit: maxRows() } });
      if (incremental && !complete) throw new Error("增量读取未覆盖全部更新，保留上一版数据；请提高同步容量后重试");
      let result;
      if (!rows && previous?.activeVersion) {
        result = await this.executor.run({ mode: "query", scope: SCOPE, inputs: [{ table: "old", version: previous.activeVersion }],
          sql: `SELECT * FROM old${incremental ? "" : " WHERE false"}`, persist: true, version: snapshotId });
      } else if (!rows && !database) {
        const fields = cap?.fields ?? source.content.columns as string[];
        const projection = fields.map(field => `CAST(NULL AS ${cap?.idField === field && cap.idType === "number" ? "DOUBLE" : "VARCHAR"}) AS ${quote(field)}`).join(", ");
        result = await this.executor.run({ mode: "query", scope: SCOPE, inputs: [], sql: `SELECT ${projection || "NULL AS __ade_empty"} WHERE false`, persist: true, version: snapshotId });
      } else result = await this.executor.run({ mode: "ingest", scope: SCOPE, version: snapshotId, file: filename });
      if (incremental && rows) {
        await validateIncrement(this.executor, snapshotId, previous!.watermark!);
        if (shape(result.profile) !== shape(previous!.profile)) throw new Error("增量字段结构变化，请执行全量同步核对新结构");
        const key = result.profile.columns.find(column => column.name === cap!.idField);
        if (!key || key.nulls || key.distinct !== rows) throw new Error("增量身份键为空或重复，保留上一版数据等待核对");
        const delta = snapshotId; snapshotId = randomUUID();
        try {
          result = await this.executor.run({ mode: "query", scope: SCOPE, inputs: [{ table: "old", version: previous!.activeVersion! }, { table: "delta", version: delta }],
            sql: `SELECT * FROM old WHERE NOT EXISTS (SELECT 1 FROM delta WHERE old.${quote(cap!.idField)} = delta.${quote(cap!.idField)}) UNION ALL BY NAME SELECT * FROM delta`, persist: true, version: snapshotId });
        } finally { await rm(snapshotFile(this.root, SCOPE, delta), { force: true }); }
      }
      if (incremental) { rows = result.profile.rows; total = rows; complete = true; }
      const uploaded = !cap ? this.live.sources.list().find(connection => connection.status === "ready" && (connection.content.localSource as Data | undefined)?.id === source.id) : undefined;
      const identityField = cap?.idField ?? previous?.idField ?? ((uploaded?.content.capabilities as Data[] | undefined)?.[0]?.idField as string | undefined) ?? null;
      const blanks = identityField && result.profile.columns.some(column => column.name === identityField) && settings.qualityThresholds.checkIdentity ? await this.executor.run({ mode: "read", scope: SCOPE, inputs: [{ table: "t", version: snapshotId }],
        sql: `SELECT COUNT(*) AS n FROM t WHERE TRIM(CAST(${quote(identityField)} AS VARCHAR)) = ''`, limit: 1 }) : null;
      const blankIdentities = blanks ? Number(blanks.rows[0].n) : 0;
      const watermark = complete ? await snapshotWatermark(this.executor, snapshotId, result.profile, field) : null;
      if (field && !watermark && rows) issues.push({ code: "incremental_unavailable", severity: "warning", sourceId: source.id, capability, message: "更新时间字段含空值或非时间、数值内容，本次采用全量结果，后续仍全量读取。" });
      const registered = this.register(source, cap, snapshotId, result.profile, { rows, total, complete }, issues, prior, watermark, incremental ? "incremental" : "full", identityField, blankIdentities, paged?.observedFields ?? result.profile.columns.map(column => column.name), paged?.excludedFields ?? []);
      finished = true; return registered;
    } finally { if (!finished) await rm(snapshotFile(this.root, SCOPE, snapshotId), { force: true }); out?.destroy(); if (paged) { await finishSnapshotPages(this.memory, paged, finished ? "completed" : "invalid"); } else if (!cap || database) await rm(file, { force: true }); }
  }

  private register(source: Artifact, cap: Capability | null, snapshotId: string, profile: SnapshotProfile, coverage: DatasetContent["coverage"] & {}, issues: SnapshotIssue[], expected: Artifact | undefined, watermark: Watermark | null, syncMode: "full" | "incremental", idField: string | null, blankIdentities: number, observedFields: string[], excludedFields: string[]) {
    const capability = cap?.name ?? "records", syncedAt = now();
    const connection = cap ? source.id : this.live.sources.list().find(c => (c.content.localSource as Data | undefined)?.id === source.id)?.id ?? null;
    let discard = false;
    const result = this.memory.atomic(() => {
      const currentSource = this.memory.getArtifact(source.id);
      if (currentSource.status !== "ready" || currentSource.version !== source.version) throw new Error("来源版本或授权在同步期间变化，未采用读取结果，请重新同步");
      const prior = this.find(source.id, capability), c = prior?.content as unknown as DatasetContent | undefined;
      if (prior?.id !== expected?.id || prior?.version !== expected?.version) throw new Error("数据集在同步期间变化，未采用读取结果，请重试");
      const base = { sourceId: source.id, sourceVersion: source.version, connectionId: connection, capability, name: cap ? `${source.title} · ${cap.name}` : source.title, idField };
      if (c?.profile && c.profile.fingerprint === profile.fingerprint && fingerprint(c.coverage) === fingerprint(coverage) && !c.pendingVersion) {
        discard = true;
        for (const issue of this.memory.listArtifacts("sync_issue").filter(item => item.status === "open" && item.content.sourceId === source.id && item.content.capability === capability)) this.memory.putArtifact({ ...issue, expectedVersion: issue.version, status: "resolved", content: { ...issue.content, resolvedSnapshot: c.activeVersion } });
        this.memory.putArtifact({ ...prior!, expectedVersion: prior!.version, content: jsonData({ ...c, ...base, watermark, observedFields, excludedFields, lastSync: syncedAt, syncMode }) });
        return { status: "unchanged", rows: profile.rows, datasetId: prior!.id };
      }
      // Parquet disambiguates case-insensitive column collisions; source schema checks use the original field names.
      const missingDeclared = profile.rows ? cap?.fields.filter(field => !observedFields.includes(field)) ?? [] : [];
      const drift = !!c?.profile && shape(c.profile) !== shape(profile) || missingDeclared.length > 0;
      const breaks = qualityBreaks(c?.profile ?? null, profile, idField, policyFor(this.memory, source));
      if (blankIdentities) breaks.push({ code: "identity_blank", message: "身份键存在空字符串，等待核对", details: { field: idField, count: blankIdentities } });
      if (drift) breaks.push({ code: "schema_drift", message: "字段结构变化，当前数据继续服务，等待确认", details: { before: JSON.parse(shape(c?.profile ?? null)), after: JSON.parse(shape(profile)) } });
      const blocked = breaks.length > 0;
      // Snapshots are immutable and keyed by their Parquet file name.
      this.memory.createArtifact(snapshotId, { kind: "data_snapshot", title: base.name, status: "ready", content: jsonData({ datasetSourceId: source.id, capability, file: `${snapshotId}.parquet`, profile, coverage, sourceVersion: source.version, syncedAt, watermark, syncMode, observedFields, excludedFields }) });
      if (c?.profile) issues.push(...quality(c.profile, profile, source.id, capability));
      if (drift) issues.push({ code: "schema_drift", severity: "warning", sourceId: source.id, capability, message: "字段结构变化：新版本待确认，当前已采用的版本继续提供读取。",
        details: { before: JSON.parse(shape(c?.profile ?? null)), after: JSON.parse(shape(profile)) } });
      if (!profile.rows) issues.push({ code: "empty_snapshot", severity: "warning", sourceId: source.id, capability, message: "来源当前没有记录；已保存空快照。" });
      const versions = [snapshotId, ...(c?.versions ?? [])];
      const content: DatasetContent = { ...base, materialization: c?.materialization ?? "snapshot", versions,
        observedFields: blocked ? c?.observedFields : observedFields, excludedFields: c?.excludedFields ?? excludedFields, watermark: blocked ? c?.watermark ?? null : watermark, activeVersion: blocked ? c?.activeVersion ?? null : snapshotId, pendingVersion: blocked ? snapshotId : null,
        profile: blocked ? c?.profile ?? null : profile, coverage: blocked ? c?.coverage ?? null : coverage, lastSync: syncedAt, ...(blocked ? { pendingReasons: jsonData(breaks) as unknown as Data[] } : {}), ...(drift ? { pendingChanges: c?.profile ? columnChanges(c.profile, profile) : missingDeclared.map(column => ({ column, before: "declared", after: null })) } : {}) };
      const dataset = this.memory.putArtifact({ ...(prior ? { id: prior.id, expectedVersion: prior.version } : {}), kind: "data_dataset", title: base.name, status: "ready", content: jsonData(content) });
      if (blocked) {
        this.syncIssue(source, capability, jsonData(breaks) as unknown as Data[], dataset, snapshotId);
        issues.push(...breaks.map(reason => ({ ...reason, severity: "warning" as const, sourceId: source.id, capability })));
      } else for (const issue of this.memory.listArtifacts("sync_issue").filter(item => item.status === "open" && item.content.sourceId === source.id && item.content.capability === capability)) this.memory.putArtifact({ ...issue, expectedVersion: issue.version, status: "resolved", content: { ...issue.content, resolvedSnapshot: snapshotId } });
      return { status: blocked ? "pending" : "updated", rows: profile.rows, datasetId: dataset.id };
    });
    if (discard) void rm(snapshotFile(this.root, SCOPE, snapshotId), { force: true });
    else void this.prune(result.datasetId);
    return result;
  }

  /** Keeps the newest versions and every version a release pins; files of other versions are removed. */
  private async prune(datasetId: string) {
    const dataset = this.dataset(datasetId), c = dataset.content as unknown as DatasetContent;
    const pinned = new Set(this.memory.listArtifacts("data_release").flatMap(r => (((r.content.definition as Data | undefined)?.snapshots as Data[] | undefined) ?? []).map(s => String(s.snapshotId))));
    const keep = new Set([...c.versions.slice(0, RETAINED), c.activeVersion, c.pendingVersion].filter(Boolean) as string[]);
    const dropped = c.versions.filter(v => !keep.has(v) && !pinned.has(v));
    if (!dropped.length) return;
    this.memory.atomic(() => {
      const saved = this.memory.putArtifact({ ...dataset, expectedVersion: dataset.version, content: jsonData({ ...c, versions: c.versions.filter(v => !dropped.includes(v)) }) });
      for (const issue of this.memory.listArtifacts("sync_issue").filter(item => item.status === "open" && (item.content.datasetRef as Data | null)?.id === dataset.id)) this.memory.putArtifact({ ...issue, expectedVersion: issue.version, content: { ...issue.content, datasetRef: { id: saved.id, version: saved.version } } });
    });
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

import { z } from "zod";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { PendingItem, PendingProvider } from "../engine/pending.ts";
import type { Snapshots } from "./snapshots.ts";
import { syncSettingsSchema, policyFor, nextRun } from "./sync-policy.ts";
import { jsonData } from "../live/sources.ts";
import { fingerprint } from "../engine/release-diff.ts";
const ref = (item: Artifact) => ({ id: item.id, version: item.version });
const configureSchema = syncSettingsSchema.extend({ sourceId: z.string().min(1), version: z.number().int().nonnegative().optional() }).strict();
const resolveSchema = z.object({ id: z.string().min(1), version: z.number().int().positive(), operationId: z.string().min(1).max(200), decision: z.enum(["accept", "retain"]), reason: z.string().trim().min(1).max(2000) }).strict();

/** Data quality decisions are source decisions, projected in the common pending center. */
export class SyncGovernance implements PendingProvider {
  private memory: MemoryStore; private snapshots: Snapshots;
  constructor(memory: MemoryStore, snapshots: Snapshots) { this.memory = memory; this.snapshots = snapshots; }
  sources() { return this.memory.listArtifacts().filter(item => item.status === "ready" && (item.kind === "source" && item.content.format === "csv" || item.kind === "source_connection" && !item.content.localSource && ((item.content.capabilities ?? []) as Data[]).some(cap => !cap.contentKind || cap.contentKind === "records"))); }
  policy(sourceId: string) { const source = this.sources().find(item => item.id === sourceId); if (!source) throw new Error("来源不存在、未获授权或没有结构化数据"); const { artifact: _, ...policy } = policyFor(this.memory, source); return policy; }
  policies() { return this.sources().map(source => this.policy(source.id)); }
  configure(input: unknown, at = new Date()) {
    const args = configureSchema.parse(input), source = this.sources().find(item => item.id === args.sourceId);
    if (!source) throw new Error("来源不存在或未获授权");
    const current = policyFor(this.memory, source);
    if (args.version !== undefined && args.version !== current.version) throw new Error("同步设置已变化，请重新读取");
    const { sourceId, version: _, ...settings } = args;
    const fields = source.kind === "source" ? source.content.columns as string[] : ((source.content.capabilities ?? []) as Data[]).flatMap(cap => cap.fields as string[] ?? []);
    if (settings.incrementalField && !fields.includes(settings.incrementalField) || settings.qualityThresholds.criticalFields.some(field => !fields.includes(field))) throw new Error("增量或关键字段不在来源合同中");
    this.memory.putArtifact({ ...(current.artifact ? { id: current.artifact.id, expectedVersion: current.artifact.version } : {}), kind: "sync_policy", title: source.title + " · 同步设置", status: "active",
      content: jsonData({ ...settings, sourceId, nextRunAt: nextRun(settings.schedule, at), updatedAt: at.toISOString() }) });
    return this.policy(sourceId);
  }
  private project(issue: Artifact): PendingItem {
    const reasons = (issue.content.reasons ?? []) as Data[], active = issue.status === "open";
    let source: Artifact | undefined; try { source = this.memory.getArtifact(String(issue.content.sourceId)); } catch { /* Retain the failure receipt when a source is unavailable. */ }
    return { id: issue.id, version: issue.version, category: "data_issue", title: issue.title, origin: "program", source: "sync", sources: [{ id: String(issue.content.sourceId), label: source?.title ?? "来源不可用" }], objects: [],
      evidence: reasons.map(reason => String(reason.message)).join("；"), verification: jsonData({ reasons }), impact: "待确认的新快照尚未生效，当前数据继续服务", status: issue.status, createdAt: issue.createdAt, stale: source?.status !== "ready",
      actions: { verify: false, adopt: false, reject: active, analyze: active }, detailRef: { kind: "sync_issue", id: issue.id, version: issue.version } };
  }
  list() { return this.memory.listArtifacts("sync_issue").filter(item => item.status === "open").map(item => this.project(item)); }
  read(id: string) { let issue: Artifact; try { issue = this.memory.getArtifact(id); } catch { return null; } return issue.kind === "sync_issue" ? this.project(issue) : null; }
  detail(id: string) { const issue = this.memory.getArtifact(id); if (issue.kind !== "sync_issue") throw new Error("数据问题不存在"); return issue; }
  resolve(input: unknown) {
    const args = resolveSchema.parse(input), signature = fingerprint(args);
    const replay = this.memory.listArtifacts("sync_decision_receipt").find(item => item.content.operationId === args.operationId);
    if (replay) { if (replay.content.signature !== signature) throw new Error("同一操作标识对应不同决定"); return replay.content.result as Data; }
    return this.memory.atomic(() => {
      const issue = this.detail(args.id); if (issue.version !== args.version || issue.status !== "open") throw new Error("数据问题版本或状态已变化");
      const datasetRef = issue.content.datasetRef as { id: string; version: number } | null;
      let dataset: Artifact | null = datasetRef ? this.snapshots.dataset(datasetRef.id) : null;
      if (dataset && (dataset.version !== datasetRef!.version || dataset.content.pendingVersion !== issue.content.snapshotId)) throw new Error("待确认数据已经变化，请重新读取");
      if (args.decision === "accept") {
        if (!dataset) throw new Error("同步失败没有可确认的快照，请修复来源并重新同步");
        const source = this.memory.getArtifact(String(issue.content.sourceId));
        if (source.status !== "ready" || source.content.adapter !== "database" && source.version !== issue.content.sourceVersion) throw new Error("来源版本或授权已变化，请重新同步");
        dataset = this.snapshots.accept({ ...ref(dataset), operationId: `sync-issue:${args.operationId}` }, { issueId: issue.id, issueVersion: issue.version, reason: args.reason });
      } else if (dataset) {
        const { pendingChanges: _, pendingReasons: __, ...content } = dataset.content;
        dataset = this.memory.putArtifact({ ...dataset, expectedVersion: dataset.version, content: { ...content, pendingVersion: null } });
      }
      const currentIssue = this.detail(issue.id);
      const saved = currentIssue.status === "accepted" ? currentIssue : this.memory.putArtifact({ ...issue, expectedVersion: issue.version, status: args.decision === "accept" ? "accepted" : "retained", content: { ...issue.content, decision: args.decision, reason: args.reason, actor: "local-admin", decidedAt: new Date().toISOString() } });
      const result = jsonData({ issue: saved, dataset });
      this.memory.putArtifact({ kind: "sync_decision_receipt", title: "数据问题决定回执", status: "saved", content: { operationId: args.operationId, signature, result } });
      return result;
    });
  }
}

export class SyncScheduler {
  private memory: MemoryStore; private snapshots: Snapshots; private governance: SyncGovernance;
  private timer?: ReturnType<typeof setInterval>; private pending?: Promise<void>; private closed = false;
  constructor(memory: MemoryStore, snapshots: Snapshots, governance: SyncGovernance) { this.memory = memory; this.snapshots = snapshots; this.governance = governance; }
  start() { if (this.timer || this.closed) return; this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 30000).unref(); void this.tick().catch(() => {}); }
  tick(at = new Date()): Promise<void> {
    if (this.closed) return Promise.resolve(); if (this.pending) return this.pending;
    const work = async () => {
      // Legacy sources did not opt into a historical schedule. Start their default
      // daily clock when scheduling is first enabled, and persist that decision.
      for (const source of this.governance.sources()) {
        const policy = policyFor(this.memory, source);
        if (policy.artifact) continue;
        this.memory.putArtifact({ kind: "sync_policy", title: source.title + " · 同步设置", status: "active", content: jsonData({
          sourceId: source.id, schedule: policy.schedule, incrementalField: policy.incrementalField, qualityThresholds: policy.qualityThresholds,
          nextRunAt: nextRun(policy.schedule, source.content.schedule ? new Date(source.createdAt) : at), initializedAt: at.toISOString() }) });
      }
      const policies = this.governance.policies();
      const recoveries: Array<{ operationId: string; sourceIds: string[] }> = [];
      for (const policy of policies.filter(policy => policy.schedule.mode !== "manual")) {
        const current = policyFor(this.memory, this.memory.getArtifact(policy.sourceId));
        const previous = current.artifact?.content.scheduledJobRef as Data | undefined;
        if (!previous) continue;
        let job: Artifact; try { job = this.memory.getArtifact(String(previous.id)); } catch { continue; }
        if (job.status !== "interrupted") continue;
        const args = { operationId: `schedule-resume:${job.id}`, sourceIds: [policy.sourceId] }, resumed = this.snapshots.start(args);
        this.memory.putArtifact({ ...current.artifact!, expectedVersion: current.artifact!.version, content: { ...current.artifact!.content, scheduledJobRef: ref(resumed), resumedAt: at.toISOString() } });
        recoveries.push(args);
      }
      await Promise.all(recoveries.map(args => this.snapshots.sync(args)));
      const due = this.governance.policies().filter(policy => policy.nextRunAt && new Date(policy.nextRunAt) <= at);
      if (!due.length) return;
      for (const policy of due) {
        const source = this.memory.getArtifact(policy.sourceId), current = policyFor(this.memory, source);
        const operationId = `schedule:${source.id}:${policy.nextRunAt}`;
        const job = this.snapshots.start({ operationId, sourceIds: [source.id] });
        this.memory.putArtifact({ ...(current.artifact ? { id: current.artifact.id, expectedVersion: current.artifact.version } : {}), kind: "sync_policy", title: source.title + " · 同步设置", status: "active",
          content: jsonData({ schedule: policy.schedule, incrementalField: policy.incrementalField, qualityThresholds: policy.qualityThresholds, sourceId: source.id, nextRunAt: nextRun(policy.schedule, at), lastScheduledAt: at.toISOString(), scheduledJobRef: ref(job) }) });
      }
      await Promise.all(due.map(policy => this.snapshots.sync({ operationId: `schedule:${policy.sourceId}:${policy.nextRunAt}`, sourceIds: [policy.sourceId] })));
    };
    this.pending = work().finally(() => { this.pending = undefined; }); return this.pending;
  }
  async close() { this.closed = true; if (this.timer) clearInterval(this.timer); await this.pending; }
}

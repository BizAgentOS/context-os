import { z } from "zod";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import { FoundationService } from "../agent/foundation.ts";
import type { LiveMemory } from "../live/memory.ts";
import { snapshotPinsForRelease, identityDecisionPinsForRelease } from "../live/release-pins.ts";
import { captureIdentityDecision, identityDecisionsForModel } from "../live/identity.ts";
import type { DatasetContent, Snapshots } from "../data/snapshots.ts";
import { OntologyDatasets } from "../live/ontology-datasets.ts";
import { consumerGrant } from "../live/consumer-views.ts";
import { jsonData } from "../live/sources.ts";
import { fingerprint, releaseDiff } from "./release-diff.ts";
import { quote as quoteId } from "../data/executor/engine.ts";

const name = z.string().trim().min(1).max(200);
const ref = z.object({ id: name, version: z.number().int().positive() }).strict();
const reference = (a: Artifact) => ({ id: a.id, version: a.version });
const ids = z.array(name).max(120).refine(a => new Set(a).size === a.length, "选择不能重复");
const publishSchema = z.object({ operationId: name, checkRef: ref, name, notes: z.string().trim().max(4000).default("") }).strict();
const connectSchema = z.object({ operationId: name, name, releaseRef: ref, conceptIds: ids.min(1), relationIds: ids, business: z.object({ grants: z.array(consumerGrant).min(1).max(20) }).strict().optional(), agentEnabled: z.boolean().default(false) }).strict();
const upgradeSchema = z.object({ operationId: name, connectionRef: ref, releaseRef: ref }).strict();
const revokeSchema = z.object({ operationId: name, connectionRef: ref }).strict();
interface Issue { code: string; severity: "error" | "warning"; message: string }
export interface ReleaseSnapshot { sourceId: string; capability: string; datasetId: string; snapshotId: string; fingerprint: string; rows: number; syncedAt: string; coverage?: DatasetContent["coverage"] }
/** The pins a release's consumers read through. */
export const releasePins = snapshotPinsForRelease;

/** Publication owns version/connection lifecycle; existing v4 services own all external reads. */
export class Releases {
  private memory: MemoryStore;
  private live: LiveMemory;
  private datasets: OntologyDatasets;
  constructor(memory: MemoryStore, live: LiveMemory) {
    this.memory = memory; this.live = live; this.datasets = new OntologyDatasets(memory, live);
  }

  /** The working version this release pins. Recorded by WorkspaceVersions on every adoption (FEATURE_041 T041-02). */
  private latestWorkspace() {
    return this.memory.listArtifacts("workspace_version").sort((a, b) => Number((b.content as Data).number ?? 0) - Number((a.content as Data).number ?? 0))[0] ?? null;
  }

  private working() {
    const { current, adopted } = new FoundationService(this.memory).read();
    const models = this.memory.listArtifacts("live_ontology");
    const storedModel = models.find(a => a.status === "adopted") ?? null;
    const model = storedModel ? this.live.projectModel(storedModel) : null;
    const issues: Issue[] = [];
    const pending: Artifact[] = [];
    if (current && current.status !== "adopted") pending.push(current);
    const latestCandidate = models.find(a => a.status === "candidate");
    if (latestCandidate && (!model || models.indexOf(latestCandidate) < models.indexOf(storedModel!))) pending.push(latestCandidate);
    pending.push(...this.memory.listArtifacts("mapping_change").filter(a => ["candidate", "checked"].includes(a.status)));
    pending.push(...this.memory.listArtifacts("engine_build").filter(a => ["queued", "running"].includes(a.status)));
    const engineCandidate = this.memory.listArtifacts("engine_candidate").find(a => ["candidate", "checked"].includes(a.status)
      && fingerprint(a.content.baseFoundationRef) === fingerprint(current ? reference(current) : null)
      && fingerprint(a.content.baseModelRef) === fingerprint(model ? reference(model) : null));
    if (engineCandidate) pending.push(engineCandidate);
    const changes = this.memory.listArtifacts("ontology_change");
    const governedOwners = new Set(changes.map(change => String((change.content.owner as Data | undefined)?.id ?? "")).filter(Boolean));
    // A candidate represented by individual changes is counted by those decisions, including explicit rejections.
    for (let index = pending.length - 1; index >= 0; index--) if (governedOwners.has(pending[index].id)) pending.splice(index, 1);
    pending.push(...changes.filter(change => ["proposed", "verified", "failed"].includes(change.status)));
    if (!adopted || !(adopted.content.concepts as Data[] | undefined)?.length) issues.push({ code: "no_adopted_foundation", severity: "error", message: "请先构建并采用至少一个本体概念。" });
    // Pending work is not part of this release by construction (only adopted state is read), so it informs rather than blocks.
    if (pending.length) issues.push({ code: "pending_changes", severity: "warning", message: `仍有 ${pending.length} 项未采用的本体或映射修订，不包含在本次发布中。` });
    if (model) {
      try { this.live.assertModel(model.id, model.version); }
      catch (error) { issues.push({ code: "mapping_unavailable", severity: "error", message: error instanceof Error ? error.message : "已采用映射不可用" }); }
      const f = model.content.foundationRef as Data | undefined;
      if (!adopted || f?.id !== adopted.id || (!model.content.layered && f.version !== adopted.version)) issues.push({ code: "mapping_foundation_mismatch", severity: "error", message: "当前映射尚未绑定当前已采用本体，请先更新映射。" });
    }
    const sourceIds = Object.keys((model?.content.connections ?? {}) as Data).sort();
    const sourceState = sourceIds.map(id => {
      try { const a = this.memory.getArtifact(id); return { id, version: a.version, status: a.status }; }
      catch { return { id, version: null, status: "missing" }; }
    });
    const sourceAccess: Array<{ sourceId: string; strategy: string; uploadRef?: Data }> = sourceIds.map(sourceId => {
      try {
        const source = this.memory.getArtifact(sourceId);
        const uploadRef = source.content.localSource as Data | undefined;
        return { sourceId, strategy: uploadRef ? "uploaded_snapshot" : "on_demand", ...(uploadRef ? { uploadRef } : {}) };
      } catch { return { sourceId, strategy: "unavailable" }; }
    });
    for (const source of sourceAccess) if (source.uploadRef) {
      const id = String(source.uploadRef.id);
      try { const a = this.memory.getArtifact(id); sourceState.push({ id, version: a.version, status: a.status }); }
      catch { sourceState.push({ id, version: null, status: "missing" }); }
    }
    // Bindings with an active snapshot are pinned to it; others stay on demand and are labelled so.
    const store = this.live.snapshots as Snapshots | undefined, snapshots: ReleaseSnapshot[] = [];
    const bindings = ((model?.content.types ?? []) as Data[]).flatMap(t => [t, ...((t.supplements ?? []) as Data[])]);
    for (const relation of (model?.content.relations ?? []) as Data[]) if (relation.linkTable) bindings.push(relation.linkTable as Data);
    for (const b of bindings) {
      const sourceId = String(b.sourceId), capability = String(b.capability);
      if (snapshots.some(s => s.sourceId === sourceId && s.capability === capability)) continue;
      const dataset = store?.bindingDataset(sourceId, capability), c = dataset?.content as unknown as DatasetContent | undefined;
      if (!dataset || !c?.activeVersion || c.materialization === "live") continue;
      if (c.pendingVersion) issues.push({ code: "pending_schema", severity: "error", message: `「${c.name}」有待确认的结构变化，请先在数据页确认或改为实时读取。` });
      const snapshot = this.memory.getArtifact(c.activeVersion);
      const coverage = snapshot.content.coverage as unknown as DatasetContent["coverage"];
      if (coverage?.complete !== true) issues.push({ code: "snapshot_incomplete", severity: "warning", message: `「${c.name}」来源覆盖不完整：快照只保存 ${coverage?.rows ?? c.profile?.rows ?? 0} / ${coverage?.total ?? "未知"} 行；发布仅提供这部分数据，不能视为全量。` });
      snapshots.push({ sourceId, capability, datasetId: dataset.id, snapshotId: c.activeVersion, fingerprint: String(c.profile?.fingerprint ?? ""), rows: c.profile?.rows ?? 0, syncedAt: String(snapshot.content.syncedAt), coverage: coverage ?? null });
    }
    const allPinned = bindings.length > 0 && bindings.every(b => snapshots.some(s => s.sourceId === b.sourceId && s.capability === b.capability));
    for (const access of sourceAccess) if (snapshots.some(s => s.sourceId === access.sourceId)) access.strategy = bindings.filter(b => b.sourceId === access.sourceId).every(b => snapshots.some(s => s.sourceId === b.sourceId && s.capability === b.capability)) ? "snapshot" : "snapshot_and_on_demand";
    const policySources = new Set([...sourceIds, ...sourceAccess.flatMap(s => s.uploadRef ? [String(s.uploadRef.id)] : [])]);
    const policies = this.memory.listArtifacts("source_policy").filter(a => policySources.has(String(a.content.sourceId)));
    const concepts = (adopted?.content.concepts ?? []) as Data[];
    const relations = (adopted?.content.relations ?? []) as Data[];
    const unresolved = ((adopted?.content.unknowns ?? []) as unknown[]).length + ((adopted?.content.conflicts ?? []) as unknown[]).length;
    if (unresolved) issues.push({ code: "semantic_uncertainty", severity: "warning", message: `已采用定义仍有 ${unresolved} 项未知或冲突；结构检查不证明业务含义正确。` });
    // Adopted local corrections are governance decisions: they ride in the working version and are pinned by each release.
    const corrections = model ? this.memory.listArtifacts("relation_correction")
      .filter(a => a.status === "adopted" && (a.content.target as Data).modelId === model.id && (a.content.target as Data).modelVersion === model.version)
      .map(a => ({ id: a.id, version: a.version, target: a.content.target, targetIds: a.content.targetIds, fingerprint: a.content.fingerprint, reason: a.content.reason }))
      .sort((a, b) => a.id.localeCompare(b.id)) : [];
    const identityDecisions = model ? identityDecisionsForModel(this.memory, model)
      .map(decision => ({ ...decision.content, ...reference(decision) })).sort((a, b) => a.id.localeCompare(b.id)) : [];
    const definition = jsonData({
      enterprise: adopted?.content.enterprise ?? null,
      concepts, relations,
      model: model ? { foundationRef: adopted ? reference(adopted) : model.content.foundationRef, purpose: model.content.purpose, types: model.content.types, relations: model.content.relations, ...(model.content.layered ? { layered: model.content.layered } : {}), connections: model.content.connections } : null,
      sourcePolicies: policies.sort((a, b) => String(a.content.sourceId).localeCompare(String(b.content.sourceId))).map(a => ({ ...a.content, policyRef: reference(a) })),
      sourceAccess,
      snapshots,
      corrections,
      identityDecisions,
      accessPolicy: { facts: "per_source_strategy", snapshot: snapshots.length ? "pinned" : "none", consistency: allPinned ? "pinned_snapshot" : "not_atomic", historicalReplay: allPinned },
    });
    const workspace = this.latestWorkspace();
    const workspaceVersion = workspace ? { id: workspace.id, version: workspace.version, number: Number((workspace.content as Data).number) } : null;
    const currentRelease = this.memory.listArtifacts("data_release")[0] ?? null;
    const refs = { foundationRef: adopted ? reference(adopted) : null, modelRef: model ? reference(model) : null };
    const pendingRefs = pending.map(a => ({ ...reference(a), kind: a.kind, status: a.status, title: a.title }));
    return {
      ...refs, definition, pending: pendingRefs, issues, workspaceVersion,
      inputHash: fingerprint({ ...refs, definition, pending: pendingRefs, sourceState, workspaceVersion, baseReleaseRef: currentRelease ? reference(currentRelease) : null }),
      summary: { concepts: concepts.length, relations: relations.length, types: ((model?.content.types ?? []) as Data[]).length, sources: sourceIds.length, snapshots: snapshots.length, rows: snapshots.reduce((n, s) => n + s.rows, 0) },
      diff: releaseDiff(currentRelease?.content.definition ?? {}, definition),
      baseReleaseRef: currentRelease ? reference(currentRelease) : null,
    };
  }

  overview() {
    const releases = this.memory.listArtifacts("data_release");
    const connections = this.memory.listArtifacts("release_connection").map(a => this.connectionState(a));
    const checks = this.memory.listArtifacts("release_check");
    const working = this.working();
    return { working, currentRelease: releases[0] ?? null, releases, connections, latestCheck: checks.find(a => a.content.inputHash === working.inputHash) ?? null, names: this.names() };
  }
  /** Readable titles of sources and datasets, so definition diffs can show names instead of ids. */
  private names() {
    return Object.fromEntries([...this.memory.listArtifacts("source"), ...this.memory.listArtifacts("source_connection"), ...this.memory.listArtifacts("data_dataset")]
      .map(a => [a.id, String(a.kind === "data_dataset" ? a.content.name : a.title)]));
  }
  read(input: unknown) {
    const r = ref.parse(input), a = this.memory.getArtifact(r.id, r.version);
    if (a.kind !== "data_release" || a.status !== "published") throw new Error("发布版本不存在");
    return a;
  }
  compare(input: unknown) {
    const args = z.object({ from: ref, to: ref }).strict().parse(input);
    const from = this.read(args.from), to = this.read(args.to);
    return { from: { ...reference(from), name: from.title }, to: { ...reference(to), name: to.title },
      diff: releaseDiff(from.content.definition, to.content.definition), names: this.names() };
  }
  /** Row-level differences of each pinned dataset between a release and another release or the working version. */
  async dataDiff(input: unknown) {
    const args = z.object({ from: ref.optional(), to: ref.optional() }).strict().parse(input);
    const store = this.live.snapshots as Snapshots | undefined;
    const fromRelease = args.from ? this.read(args.from) : this.memory.listArtifacts("data_release")[0] ?? null;
    const target = args.to ? this.read(args.to).content : this.working();
    const before = (((fromRelease?.content.definition as Data | undefined)?.snapshots ?? []) as unknown) as ReleaseSnapshot[];
    const after = (((target.definition as Data).snapshots ?? []) as unknown) as ReleaseSnapshot[];
    const connections = (((target.definition as Data).model as Data | null)?.connections ?? {}) as Record<string, number>;
    const name = (datasetId: string) => { try { return String(this.memory.getArtifact(datasetId).content.name); } catch { return datasetId; } };
    const datasets: Data[] = [];
    for (const s of after) {
      const prior = before.find(b => b.datasetId === s.datasetId);
      const base = { datasetId: s.datasetId, name: name(s.datasetId), sourceId: s.sourceId, capability: s.capability, fromSnapshot: prior?.snapshotId ?? null, toSnapshot: s.snapshotId, rowsBefore: prior?.rows ?? null, rowsAfter: s.rows };
      if (!prior) { datasets.push({ ...base, status: "added" }); continue; }
      if (prior.snapshotId === s.snapshotId) { datasets.push({ ...base, status: "unchanged", added: 0, removed: 0, changed: 0, samples: [] }); continue; }
      if (!store) continue;
      const { cap } = this.live.sources.pinnedCapability(s.sourceId, s.capability, connections[s.sourceId]);
      const key = (alias: string) => `SELECT CAST(${alias}.${quoteId(cap.idField)} AS VARCHAR) AS k, hash(${alias}) AS h FROM ${alias}`;
      const joined = `(${key("a")}) x FULL OUTER JOIN (${key("b")}) y ON x.k = y.k`;
      const inputs = [{ table: "a", version: prior.snapshotId }, { table: "b", version: s.snapshotId }];
      try {
        const counts = (await store.run(inputs, `SELECT count(*) FILTER (WHERE x.k IS NULL) AS added, count(*) FILTER (WHERE y.k IS NULL) AS removed, count(*) FILTER (WHERE x.k IS NOT NULL AND y.k IS NOT NULL AND x.h <> y.h) AS changed FROM ${joined}`, { limit: 1 })).rows[0];
        const samples = (await store.run(inputs, `SELECT kind, k FROM (SELECT coalesce(y.k, x.k) AS k, CASE WHEN x.k IS NULL THEN 'added' WHEN y.k IS NULL THEN 'removed' ELSE 'changed' END AS kind,
          row_number() OVER (PARTITION BY CASE WHEN x.k IS NULL THEN 'added' WHEN y.k IS NULL THEN 'removed' ELSE 'changed' END ORDER BY coalesce(y.k, x.k)) AS n
          FROM ${joined} WHERE x.k IS NULL OR y.k IS NULL OR x.h <> y.h) WHERE n <= 5 ORDER BY kind, k`, { limit: 15 })).rows;
        datasets.push({ ...base, status: "changed", added: Number(counts.added), removed: Number(counts.removed), changed: Number(counts.changed), samples: jsonData(samples) });
      } catch (error) { datasets.push({ ...base, status: "unavailable", message: error instanceof Error ? error.message : "无法比较快照" }); }
    }
    for (const b of before) if (!after.some(s => s.datasetId === b.datasetId))
      datasets.push({ datasetId: b.datasetId, name: name(b.datasetId), sourceId: b.sourceId, capability: b.capability, fromSnapshot: b.snapshotId, toSnapshot: null, rowsBefore: b.rows, rowsAfter: null, status: "removed" });
    return { from: fromRelease ? { ...reference(fromRelease), name: fromRelease.title } : null, to: args.to ? args.to : "working", datasets: jsonData(datasets) };
  }

  async check(input: unknown) {
    const args = z.object({ inputHash: z.string().length(64) }).strict().parse(input);
    const working = this.working();
    if (args.inputHash !== working.inputHash) throw new Error("工作版本已变化，请刷新后重新检查");
    const issues = [...working.issues];
    const samples: Data[] = [];
    if (!issues.some(i => i.severity === "error") && working.modelRef) {
      const model = this.memory.getArtifact(working.modelRef.id, working.modelRef.version);
      for (const decision of identityDecisionsForModel(this.memory, model, new Set(identityDecisionPinsForRelease(working.definition)))) {
        try {
          const captured = await captureIdentityDecision(this.live, model, decision.content, {
            readMode: "release_pinned", pins: releasePins(working.definition), fixedSemantic: true, modelDefinition: working.definition.model as Data,
          });
          if (captured.fingerprint !== decision.content.fingerprint || captured.scopeFingerprint !== decision.content.scopeFingerprint)
            throw new Error("身份决定依赖的事实或规则已变化，请先重新核对");
        } catch (error) {
          issues.push({ code: "identity_decision_unavailable", severity: "error", message: error instanceof Error ? error.message : "身份决定无法复验" });
        }
      }
    }
    if (!issues.some(i => i.severity === "error") && working.modelRef) {
      for (const t of ((working.definition.model as Data).types as Data[])) {
        try {
          const fields = [...new Set(["$id", ...Object.keys(t.fields as Data), ...((t.supplements ?? []) as Data[]).flatMap(s => Object.keys(s.fields as Data))])];
          const sample = await this.live.query({ modelId: working.modelRef.id, modelVersion: working.modelRef.version, type: t.name, fields, limit: 1 }, () => {
            if (this.working().inputHash !== working.inputHash) throw new Error("检查过程中工作版本已变化");
          }, false, working.definition.model as Data, false, releasePins(working.definition), undefined, new Set(identityDecisionPinsForRelease(working.definition)));
          if (sample.evidence?.some(o => o.matches.some(m => m.status === "unavailable"))) throw new Error("附来源读取失败，请恢复连接后重新检查");
          samples.push(jsonData({ type: t.name, coverage: sample.coverage, reads: sample.reads }));
        } catch (error) { issues.push({ code: "source_check_failed", severity: "error", message: `${String(t.name)}：${error instanceof Error ? error.message : "来源读取失败"}` }); }
      }
    }
    return this.memory.atomic(() => {
      if (this.working().inputHash !== working.inputHash) throw new Error("检查过程中工作版本已变化，请重新检查");
      return this.memory.putArtifact({ kind: "release_check", title: "发布前检查", status: issues.some(i => i.severity === "error") ? "blocked" : "ready", content: jsonData({ ...working, issues, samples, checkedAt: new Date().toISOString(), checkScope: "definition_pinned_snapshot_and_bounded_source_read_not_business_truth" }) });
    });
  }

  private previous(method: string, operationId: string, input: unknown) {
    const signature = fingerprint(input);
    const receipt = this.memory.listArtifacts("release_receipt").find(a => a.content.actor === "local-admin" && a.content.method === method && a.content.operationId === operationId);
    if (receipt && receipt.content.signature !== signature) throw new Error("幂等操作标识已绑定不同请求");
    return receipt ? receipt.content.result as Data : null;
  }
  private receipt(method: string, operationId: string, input: unknown, result: unknown) {
    this.memory.putArtifact({ kind: "release_receipt", title: "发布管理操作回执", status: "saved", content: jsonData({ actor: "local-admin", method, operationId, signature: fingerprint(input), result }) });
  }
  publish(input: unknown) {
    const args = publishSchema.parse(input);
    return this.memory.atomic(() => {
      const previous = this.previous("publish", args.operationId, args);
      if (previous) return { release: this.read(previous.releaseRef), replayed: true };
      const check = this.memory.getArtifact(args.checkRef.id, args.checkRef.version);
      if (check.kind !== "release_check" || check.status !== "ready") throw new Error("需要通过发布检查的具体版本");
      const working = this.working();
      if (working.inputHash !== check.content.inputHash || working.issues.some(i => i.severity === "error")) throw new Error("工作版本或当前发布已变化，请重新检查");
      const latestCheck = this.memory.listArtifacts("release_check").find(a => a.content.inputHash === working.inputHash);
      if (latestCheck?.id !== check.id) throw new Error("已有更新的发布检查，请使用最新检查结果");
      const prior = this.memory.listArtifacts("data_release");
      if (prior.some(a => a.title === args.name)) throw new Error("发布版本名称已存在");
      const release = this.memory.putArtifact({ kind: "data_release", title: args.name, status: "published", content: jsonData({ ...working, name: args.name, notes: args.notes, sequence: prior.length + 1, contractVersion: "v4", checkRef: args.checkRef, checkedAt: check.content.checkedAt, publishedAt: new Date().toISOString() }) });
      this.receipt("publish", args.operationId, args, { releaseRef: reference(release) });
      return { release, replayed: false };
    });
  }

  private connectionRecord(input: unknown) {
    const r = ref.parse(input), a = this.memory.getArtifact(r.id);
    if (a.kind !== "release_connection" || a.version !== r.version || a.status !== "active") throw new Error("接入方状态或版本已变化，请刷新");
    return a;
  }
  private connectionState(a: Artifact) {
    const dataset = this.memory.getArtifact(String((a.content.datasetRef as Data).id));
    return { ...a, effectiveStatus: a.status === "active" && dataset.status === "active" ? "active" : "revoked" };
  }
  private createDataset(args: z.infer<typeof connectSchema>, release: Artifact, operationId: string) {
    const foundationRef = ref.parse(release.content.foundationRef);
    const modelRef = args.business ? ref.parse(release.content.modelRef) : null;
    return this.datasets.publishForRelease({ operationId, name: args.name, foundationRef, conceptIds: args.conceptIds, relationIds: args.relationIds, ...(args.business ? { business: { ...args.business, modelRef } } : {}) },
      reference(release), { fixedSemantic: true, snapshotPins: releasePins(release.content.definition as Data) });
  }
  private replayConnection(result: Data) {
    const connection = this.memory.getArtifact(String((result.connectionRef as Data).id), Number((result.connectionRef as Data).version));
    const dataset = this.memory.getArtifact(String((connection.content.datasetRef as Data).id), Number((connection.content.datasetRef as Data).version));
    const { keyHash, operationId, operationSignature, ...content } = dataset.content;
    return { connection, dataset: { ...dataset, content }, key: null, keyAvailable: false };
  }
  connect(input: unknown) {
    const args = connectSchema.parse(input);
    return this.memory.atomic(() => {
      const previous = this.previous("connect", args.operationId, args);
      if (previous) return this.replayConnection(previous);
      const release = this.read(args.releaseRef);
      const result = this.createDataset(args, release, `release-connect:${fingerprint(args.operationId)}`);
      const connection = this.memory.putArtifact({ kind: "release_connection", title: args.name, status: "active", content: jsonData({ releaseRef: args.releaseRef, datasetRef: reference(result.dataset), conceptIds: args.conceptIds, relationIds: args.relationIds, business: args.business ?? null, agentEnabled: args.agentEnabled, connectedAt: new Date().toISOString() }) });
      this.receipt("connect", args.operationId, args, { connectionRef: reference(connection) });
      return { ...result, connection };
    });
  }
  upgrade(input: unknown) {
    const args = upgradeSchema.parse(input);
    return this.memory.atomic(() => {
      const previous = this.previous("upgrade", args.operationId, args);
      if (previous) return this.replayConnection(previous);
      const current = this.connectionRecord(args.connectionRef), release = this.read(args.releaseRef);
      if (fingerprint(current.content.releaseRef) === fingerprint(args.releaseRef)) throw new Error("接入方已使用此发布版本");
      if (this.connectionState(current).effectiveStatus !== "active") throw new Error("接入数据集已撤销，不能通过升级恢复权限");
      const selection = connectSchema.parse({ operationId: args.operationId, name: current.title, releaseRef: args.releaseRef, conceptIds: current.content.conceptIds, relationIds: current.content.relationIds, ...(current.content.business ? { business: current.content.business } : {}), agentEnabled: current.content.agentEnabled ?? false });
      const result = this.createDataset(selection, release, `release-upgrade:${fingerprint(args.operationId)}`);
      this.datasets.revoke(current.content.datasetRef);
      const connection = this.memory.putArtifact({ ...current, expectedVersion: current.version, content: jsonData({ ...current.content, releaseRef: args.releaseRef, datasetRef: reference(result.dataset), previousReleaseRef: current.content.releaseRef, upgradedAt: new Date().toISOString() }) });
      this.receipt("upgrade", args.operationId, args, { connectionRef: reference(connection) });
      return { ...result, connection };
    });
  }
  revoke(input: unknown) {
    const args = revokeSchema.parse(input);
    return this.memory.atomic(() => {
      const previous = this.previous("revoke", args.operationId, args);
      if (previous) return { connection: this.memory.getArtifact(String((previous.connectionRef as Data).id), Number((previous.connectionRef as Data).version)), replayed: true };
      const current = this.connectionRecord(args.connectionRef);
      const dataset = this.memory.getArtifact(String((current.content.datasetRef as Data).id));
      if (dataset.status === "active") this.datasets.revoke(reference(dataset));
      const connection = this.memory.putArtifact({ ...current, expectedVersion: current.version, status: "revoked", content: { ...current.content, revokedAt: new Date().toISOString() } });
      this.receipt("revoke", args.operationId, args, { connectionRef: reference(connection) });
      return { connection, replayed: false };
    });
  }
  connection(input: unknown, origin: string) {
    const connection = this.connectionRecord(input);
    const spec = this.datasets.connection(connection.content.datasetRef, origin);
    const enabled = connection.content.agentEnabled === true;
    return { ...spec, connection, release: this.read(connection.content.releaseRef),
      tools: enabled ? [...spec.tools, "submit_ade_task", "read_ade_task", "cancel_ade_task"] : spec.tools,
      agent: { enabled, ...(enabled ? { submit: "/v4/agent/tasks", read: "/v4/agent/tasks/{id}", cancel: "/v4/agent/tasks/{id}/cancel", instructions: "委托 ADE 助手调查本接入方获准范围；通过任务标识查询状态和结果，可取消。委托不授予本体修改或发布权限。" } : {}) },
    };
  }
}

import { prepareCorrectionMigration } from "../live/correction-migration.ts";
import { z } from "zod";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { FoundationService } from "../agent/foundation.ts";
import type { LiveMemory } from "../live/memory.ts";
import type { Capability } from "../live/sources.ts";
import { jsonData } from "../live/sources.ts";
import { discoverLinks, entityName, fingerprint, ownKey, profileColumns, type BuildIssue, type DatasetProfile } from "./discovery.ts";
import type { DatasetContent, Snapshots } from "../data/snapshots.ts";
import { entityColumns, ontologyBundle, type Bundle, type Resource, type SuggestedOntology } from "./helix-discovery.ts";
import { discoverFromSnapshots } from "./snapshot-discovery.ts";
import { describeReport, validateDefinition } from "./validation.ts";
import { confirmedEnterpriseEvidence, isUnknownEnterprise } from "../agent/foundation-evidence.ts";
import { migrateLegacyModel, reconcileLayeredModel, type LayeredModel, type LegacyModel } from "../semantic/model.ts";

const identifier = z.string().trim().min(1).max(200);
const buildInput = z.object({ operationId: identifier, sourceIds: z.array(identifier).max(100).optional(), expectedFoundationVersion: z.number().int().nonnegative().optional(), autoAdopt: z.boolean().default(false) }).strict();
const referenceInput = z.object({ id: identifier, version: z.number().int().positive() }).strict();
const selection = z.object({
  entities: z.array(identifier).max(30).default([]),
  relations: z.array(identifier).max(40).default([]),
  merges: z.array(identifier).max(20).default([]),
  retired: z.array(identifier).max(70).optional(),
}).strict();
const adoptInput = referenceInput.extend({ operationId: identifier, selection: selection.optional() });
export type Selection = z.infer<typeof selection>;
export type AdoptedBuild = { status: "adopted"; candidate: Artifact; foundation: Artifact; model: Artifact };
type BuildInput = z.infer<typeof buildInput>;
type Ref = { id: string; version: number };
interface BuildContent {
  operationId: string; inputHash: string; sourceIds?: string[]; sourceVersions: Record<string, number>; autoAdopt: boolean;
  baseFoundationRef: Ref | null; baseModelRef: Ref | null;
  steps: Array<{ id: string; label: string; status: string; startedAt?: string; completedAt?: string; message?: string }>;
  issues: BuildIssue[]; outcome: string; candidateRef?: Ref; startedAt?: string; finishedAt?: string;
}
interface CandidateContent {
  jobId: string; baseFoundationRef: Ref | null; baseModelRef: Ref | null; sourceVersions: Record<string, number>;
  foundation: Data; concepts: Data[]; relations: Data[]; types: Data[]; modelRelations: Data[];
  issues: BuildIssue[]; coverage: Data[]; diff: Data; checks: Data;
  discovery?: Data; bundle?: Data; snapshotInputs?: Record<string, string>;
  adoption?: { operationId: string; inputVersion: number; selection?: unknown; foundationRef: Ref; modelRef: Ref };
}
const ref = (artifact: Artifact | null | undefined): Ref | null => artifact ? { id: artifact.id, version: artifact.version } : null;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const now = () => new Date().toISOString();
const dataArray = (value: unknown): Data[] => Array.isArray(value) ? structuredClone(value) as Data[] : [];
const SAMPLE_LIMIT = 100;
const MAX_CAPABILITIES = 40;
const MAX_MODEL_TYPES = 20;
const MAX_FOUNDATION_CONCEPTS = 30;

/** Structural changes a program build proposes. Only these wait for an explicit decision after the first build (R2). */
export interface StructuralDelta { entities: string[]; relations: string[]; merges: string[]; retired: string[] }
export function structuralDelta(diff: Data | undefined): StructuralDelta {
  const list = (value: unknown) => Array.isArray(value) ? value.map(String) : [];
  return { entities: list(diff?.addedConcepts), relations: list(diff?.addedRelations), merges: list(diff?.addedSupplements),
    retired: [...list(diff?.retiredConcepts), ...list(diff?.retiredRelations)] };
}
export const isStructural = (delta: StructuralDelta) => Object.values(delta).some(items => items.length > 0);

/** Deterministic build jobs share ADE's ontology and mapping services, never a model loop. */
/** A mapping follows its adopted concept's wording: documents and repairs may have renamed or described it since the mapping was built. */
function alignTypes(types: Data[], modelRelations: Data[], concepts: Data[]) {
  for (const [index, type] of types.entries()) {
    const concept = concepts.find(item => item.id === type.conceptId);
    if (!concept || (type.name === concept.name && type.description === concept.description)) continue;
    for (const relation of modelRelations) for (const end of ["from", "to"]) if (relation[end] === type.name) relation[end] = concept.name;
    types[index] = { ...type, name: concept.name, description: concept.description };
  }
}

function enterpriseIdentity(previous: Data | undefined, profile: Artifact | undefined, evidence: Data[]): Data {
  const enterprise = previous ?? { name: "未设置企业", evidenceRefs: [] };
  // A rebuild can fill an explicitly unknown identity, but never rename an established enterprise.
  if (!isUnknownEnterprise(enterprise)) return enterprise;
  const confirmed = confirmedEnterpriseEvidence(profile);
  if (!confirmed) return enterprise;
  if (!evidence.some(item => item.id === confirmed.id)) evidence.push(jsonData(confirmed));
  return { name: confirmed.quote, evidenceRefs: [confirmed.id] };
}

export class ProgramBuilds {
  onAdopt?: (candidate: Artifact, selection: Selection | undefined, save: () => AdoptedBuild) => AdoptedBuild;
  private memory: MemoryStore;
  private foundation: FoundationService;
  private live: LiveMemory;
  private snapshots?: Snapshots;
  private running = new Map<string, Promise<Artifact>>();
  private guards = new Map<string, () => void>();
  private closing = false;

  constructor(memory: MemoryStore, foundation: FoundationService, live: LiveMemory, snapshots?: Snapshots) {
    this.memory = memory; this.foundation = foundation; this.live = live; this.snapshots = snapshots;
    for (const job of this.memory.listArtifacts("engine_build")) {
      if (["queued", "running"].includes(job.status)) this.memory.putArtifact({ ...job, expectedVersion: job.version, status: "interrupted",
        content: { ...job.content, finishedAt: now(), outcome: "interrupted", issues: [...dataArray(job.content.issues), { code: "restart", severity: "warning", message: "服务重启中断构建。已保存结果可查看；重新构建会重新读取来源。" }] } });
    }
  }

  overview() {
    return { jobs: this.memory.listArtifacts("engine_build"), datasets: this.memory.listArtifacts("engine_dataset"),
      candidate: this.memory.listArtifacts("engine_candidate").find(candidate => {
        if (!["candidate", "checked"].includes(candidate.status)) return false;
        try { this.assertInputs(candidate.content as unknown as CandidateContent); return true; } catch { return false; }
      }) ?? null,
      strategies: [{ id: "on_demand", label: "按需读取" }, { id: "uploaded_snapshot", label: "上传文件快照" }] };
  }

  start(args: unknown, assertActive: () => void = () => {}): Artifact {
    if (this.closing) throw new Error("程序构建服务正在关闭");
    assertActive();
    const parsed = buildInput.parse(args);
    const input = { ...parsed, ...(parsed.sourceIds ? { sourceIds: [...new Set(parsed.sourceIds)].sort() } : {}) };
    const inputHash = fingerprint(input);
    const prior = this.memory.listArtifacts("engine_build").find(job => job.content.operationId === input.operationId);
    if (prior) { if (prior.content.inputHash !== inputHash) throw new Error("同一操作标识不能用于不同构建范围"); return prior; }
    if (this.memory.listArtifacts("engine_build").some(job => ["queued", "running"].includes(job.status))) throw new Error("已有程序构建正在运行，请完成或取消后重试");
    const base = this.foundation.read().current;
    if (input.expectedFoundationVersion !== undefined && (base?.version ?? 0) !== input.expectedFoundationVersion) throw new Error("本体工作版本已变化，请重新查看后构建");
    const sources = this.selectedSources(input);
    const job = this.memory.putArtifact({ kind: "engine_build", title: "程序构建本体", status: "queued", content: jsonData({
      operationId: input.operationId, inputHash, sourceIds: input.sourceIds, autoAdopt: input.autoAdopt, sourceVersions: Object.fromEntries(sources.map(source => [source.id, source.version])),
      baseFoundationRef: ref(base), baseModelRef: ref(this.activeModel()), outcome: "pending",
      issues: base && base.status !== "adopted" ? [{code: "pending_foundation_review", severity: "warning", message: "已有尚未采用的本体修订。本次读取仅生成并检查候选，需用户明确采用后才更新工作版本。"}] : [], steps: [
        { id: "read", label: "读取来源与字段", status: "queued" }, { id: "discover", label: "发现对象和待核对关联", status: "queued" }, { id: "compile", label: "生成并检查候选", status: "queued" },
      ],
    }) });
    // Defer I/O until start() has returned the durable job to the UI.
    const running = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.execute(job.id, sources));
    this.running.set(job.id, running);
    this.guards.set(job.id, assertActive);
    void running.finally(() => { this.running.delete(job.id); this.guards.delete(job.id); });
    return job;
  }

  async build(args: unknown, assertActive: () => void = () => {}): Promise<Artifact> {
    const job = this.start(args, assertActive);
    return this.running.get(job.id) ?? this.memory.getArtifact(job.id);
  }

  async idle() { while (this.running.size) await Promise.all([...this.running.values()]); }
  async close() {
    this.closing = true;
    for (const id of this.running.keys()) {
      const job = this.memory.getArtifact(id);
      if (["queued", "running"].includes(job.status)) this.cancel({id, version: job.version});
    }
    await this.idle();
  }

  cancel(args: unknown) {
    const input = referenceInput.parse(args), job = this.memory.getArtifact(input.id);
    if (job.kind !== "engine_build" || job.version !== input.version) throw new Error("构建任务版本已变化，请重新读取");
    if (!["queued", "running"].includes(job.status)) return job;
    return this.memory.putArtifact({ ...job, expectedVersion: job.version, status: "cancelled", content: { ...job.content, outcome: "cancelled", finishedAt: now() } });
  }

  private selectedSources(input: BuildInput) {
    const sources = [...this.live.sources.list().filter(source => source.status === "ready" && !source.content.localSource),
      ...this.memory.listArtifacts("source").filter(source => source.status === "ready" && source.content.format === "csv")];
    if (!input.sourceIds) return sources;
    const selected = input.sourceIds.map(id => sources.find(source => source.id === id));
    if (selected.some(source => !source)) throw new Error("所选来源不存在、已停用或不是可构建的记录来源");
    return selected as Artifact[];
  }

  private activeModel() { return this.memory.listArtifacts("live_ontology").find(model => model.status === "adopted") ?? null; }
  private layers(types: Data[], relations: Data[]) {
    const migrated = migrateLegacyModel({ types, relations } as unknown as LegacyModel, { capability: (sourceId, capability) => {
      const connection = this.memory.getArtifact(sourceId);
      const cap = (connection.content.capabilities as unknown as Capability[]).find(c => c.name === capability);
      if (!cap) throw new Error("已保存来源能力不存在");
      return cap;
    } });
    const previous = this.activeModel()?.content.layered;
    return previous ? reconcileLayeredModel(previous as unknown as LayeredModel, migrated) : migrated;
  }
  private assertInputs(content: Pick<BuildContent, "sourceVersions" | "baseFoundationRef" | "baseModelRef">) {
    if (!equal(ref(this.foundation.read().current), content.baseFoundationRef)) throw new Error("本体工作版本已变化，请重新构建");
    if (!equal(ref(this.activeModel()), content.baseModelRef)) throw new Error("映射版本已变化，请重新构建");
    for (const [id, version] of Object.entries(content.sourceVersions)) {
      const source = this.memory.getArtifact(id);
      if (source.status !== "ready" || source.version !== version) throw new Error("来源版本或授权已变化，请重新构建");
    }
  }
  private assertRunning(id: string) {
    this.guards.get(id)?.();
    const job = this.memory.getArtifact(id);
    if (!["running", "queued"].includes(job.status)) throw new Error("构建已停止");
    this.assertInputs(job.content as unknown as BuildContent);
  }
  private advance(id: string, stepId: string, complete = false) {
    this.assertRunning(id);
    const job = this.memory.getArtifact(id), content = job.content as unknown as BuildContent;
    const steps = content.steps.map(step => step.id === stepId ? { ...step, status: complete ? "completed" : "running", ...(complete ? { completedAt: now() } : { startedAt: now() }) } : step);
    return this.memory.putArtifact({ ...job, expectedVersion: job.version, status: "running", content: jsonData({ ...content, startedAt: content.startedAt ?? now(), steps }) });
  }

  private async execute(id: string, sources: Artifact[]): Promise<Artifact> {
    if (this.snapshots) return this.executeSnapshots(id, sources, this.snapshots);
    try {
      this.advance(id, "read");
      const profiles: DatasetProfile[] = [], issues: BuildIssue[] = structuredClone((this.memory.getArtifact(id).content as unknown as BuildContent).issues);
      const count = sources.reduce((total, source) => total + (source.kind === "source" ? 1 : dataArray(source.content.capabilities).filter(cap => cap.contentKind === "records" || !cap.contentKind).length), 0);
      if (count > MAX_CAPABILITIES) throw new Error(`所选范围有 ${count} 个记录能力，超过单次 ${MAX_CAPABILITIES} 个的检查范围。请显式缩小来源范围；未截断或采用部分结果。`);
      for (const source of sources) {
        this.assertRunning(id);
        if (source.kind === "source") await this.inspectCsv(source, profiles, issues);
        else for (const cap of source.content.capabilities as unknown as Capability[]) {
          if (cap.contentKind && cap.contentKind !== "records") {
            issues.push({ code: "non_record_capability", severity: "info", sourceId: source.id, capability: cap.name, message: "知识片段或指标能力保留为依据入口，不自动映射成业务记录。" });
            continue;
          }
          try {
            const page = await this.live.sources.readRecords(source.id, cap.name, {}, 0, SAMPLE_LIMIT, source.version);
            this.assertRunning(id);
            const profile: DatasetProfile = { sourceId: source.id, sourceVersion: source.version, capability: cap.name, name: cap.name,
              fields: profileColumns(cap.fields, page.items), rows: page.items, rowCount: page.coverage.total, complete: page.coverage.complete,
              readAt: page.provenance.readAt, strategy: "on_demand", idField: cap.idField };
            this.addProfile(profile, profiles, issues);
          } catch (error) {
            this.assertRunning(id);
            issues.push({ code: "source_read_failed", severity: "error", sourceId: source.id, capability: cap.name, message: (error as Error).message });
          }
        }
      }
      this.advance(id, "read", true); this.advance(id, "discover");
      issues.push(...discoverLinks(profiles));
      this.advance(id, "discover", true); this.advance(id, "compile");
      this.assertRunning(id);
      const compiled = profiles.some(profile => profile.rows.length && profile.idField) ? this.compile(id, profiles, issues) : null;
      this.advance(id, "compile", true);
      const candidate = await this.finishCandidate(id, issues, compiled);
      return this.finish(id, sources, issues, candidate);
    } catch (error) { return this.fail(id, error); }
  }

  private async finishCandidate(id: string, issues: BuildIssue[], candidate: Artifact | null) {
    const content = this.memory.getArtifact(id).content as unknown as BuildContent;
    if (candidate && content.autoAdopt) {
      candidate = await this.check({ id: candidate.id, version: candidate.version }, () => this.assertRunning(id));
      this.assertRunning(id);
      const delta = structuralDelta(candidate.content.diff as Data);
      // FEATURE_041 R2 (blueprint §10.3): only the first build adopts structure by itself. Afterwards new objects,
      // relations, merges and retired structure wait for a decision; same-structure rebinds, snapshot refreshes,
      // evidence refreshes and wording changes still adopt automatically.
      if (this.foundation.read().adopted && isStructural(delta)) {
        const parts = ([["新对象", delta.entities.length], ["新关系", delta.relations.length], ["新合并", delta.merges.length], ["退役结构", delta.retired.length]] as const)
          .filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count} 项`).join("、");
        issues.push({ code: "structure_needs_review", severity: "warning",
          message: `本次构建有结构变化（${parts}），未自动采用；请核对候选后显式采用或拒绝。`,
          details: jsonData({ ...delta, candidateRef: { id: candidate.id, version: candidate.version } }) });
        return candidate;
      }
      if ((candidate.content.checks as Data).valid && !issues.some(issue => issue.code === "pending_foundation_review"))
        candidate = (await this.adopt({ id: candidate.id, version: candidate.version, operationId: `automatic:${content.operationId}` }, () => this.assertRunning(id))).candidate;
    }
    return candidate;
  }

  private finish(id: string, sources: Artifact[], issues: BuildIssue[], candidate: Artifact | null) {
    const latest = this.memory.getArtifact(id);
    return this.memory.putArtifact({ ...latest, expectedVersion: latest.version, status: "completed", content: jsonData({ ...latest.content,
      issues, finishedAt: now(), outcome: candidate?.status === "adopted" ? "adopted" : candidate ? "candidate" : sources.length ? "needs_attention" : "empty", candidateRef: candidate ? ref(candidate) : null,
      ...(sources.length ? {} : { issues: [{ code: "no_sources", severity: "info", message: "尚未接入可构建的结构化来源" }] }),
    }) });
  }

  private fail(id: string, error: unknown) {
    const job = this.memory.getArtifact(id);
    if (["cancelled", "interrupted"].includes(job.status)) return job;
    return this.memory.putArtifact({ ...job, expectedVersion: job.version, status: "failed", content: jsonData({ ...job.content,
      outcome: "failed", finishedAt: now(), issues: [...dataArray(job.content.issues), { code: "build_failed", severity: "error", message: (error as Error).message }],
    }) });
  }

  /** Full-data path: sync snapshots, run Helix discovery over them, and compile entities into ADE concepts and mappings. */
  private async executeSnapshots(id: string, sources: Artifact[], snapshots: Snapshots): Promise<Artifact> {
    try {
      this.advance(id, "read");
      const content = this.memory.getArtifact(id).content as unknown as BuildContent;
      const issues: BuildIssue[] = structuredClone(content.issues);
      for (const source of sources) for (const cap of source.kind === "source" ? [] : dataArray(source.content.capabilities))
        if (cap.contentKind && cap.contentKind !== "records") issues.push({ code: "non_record_capability", severity: "info", sourceId: source.id, capability: String(cap.name), message: "知识片段或指标能力保留为依据入口，不自动映射成业务记录。" });
      const synced = sources.length ? await snapshots.sync({ operationId: `build:${content.operationId}`, sourceIds: sources.map(s => s.id) }) : null;
      this.assertRunning(id);
      issues.push(...dataArray(synced?.content.issues).map(issue => issue as unknown as BuildIssue));
      // The selection only decides which sources are refreshed: fusion needs every synced dataset in view.
      const available = new Set(this.selectedSources({ operationId: content.operationId, autoAdopt: false }).map(s => s.id));
      const datasets = snapshots.datasets().filter(d => available.has(String(d.content.sourceId)));
      for (const d of datasets) {
        const c = d.content as unknown as DatasetContent;
        if (c.materialization === "live") issues.push({ code: "live_dataset", severity: "info", sourceId: c.sourceId, capability: c.capability, message: "该数据集设为实时读取，不参与全量发现；如需程序构建请切换为快照。" });
        else if (!c.profile?.rows) issues.push({ code: "empty_sample", severity: "error", sourceId: c.sourceId, capability: c.capability, message: "来源当前没有记录，未生成可执行对象映射；请补充记录或显式缩小构建范围。" });
        else if (c.pendingVersion) issues.push({ code: "pending_schema", severity: "warning", sourceId: c.sourceId, capability: c.capability, message: "数据集有待确认的结构变化；本次按当前已采用的快照构建。" });
      }
      const usable = datasets.filter(d => d.content.materialization !== "live" && d.content.activeVersion);
      this.advance(id, "read", true); this.advance(id, "discover");
      const source = (sid: string) => { try { return this.memory.getArtifact(sid); } catch { return undefined; } };
      const discovery = usable.length ? await discoverFromSnapshots(snapshots, source, usable.map(d => d.id)) : null;
      this.assertRunning(id);
      this.advance(id, "discover", true); this.advance(id, "compile");
      const candidate = discovery ? this.compileDiscovery(id, discovery, usable, issues) : null;
      this.advance(id, "compile", true);
      return this.finish(id, sources, issues, await this.finishCandidate(id, issues, candidate));
    } catch (error) { return this.fail(id, error); }
  }

  private async inspectCsv(source: Artifact, profiles: DatasetProfile[], issues: BuildIssue[]) {
    const rows = dataArray(source.content.rows), fields = (source.content.columns as string[]) ?? [];
    if (fields.length > 100) { issues.push({ code: "field_capacity", severity: "error", sourceId: source.id, message: "CSV 超过 100 列的执行范围，请显式缩小数据范围。未截断字段。" }); return; }
    const columns = profileColumns(fields, rows), key = ownKey(source.title, columns);
    if (!key) {
      issues.push({ code: "identity_unknown", severity: "error", sourceId: source.id, message: "CSV 没有非空唯一的身份键；请补充稳定编号或由助手协助修复，未把普通唯一字段猜作业务身份。" });
      this.addProfile({ sourceId: source.id, sourceVersion: source.version, capability: "records", name: source.title, fields: columns, rows,
        rowCount: rows.length, complete: true, readAt: now(), strategy: "uploaded_snapshot", originSourceId: source.id }, profiles, issues);
      return;
    }
    const connection = this.live.sources.connectUpload(source.id, source.version, key);
    this.addProfile({ sourceId: connection.id, sourceVersion: connection.version, capability: "records", name: source.title, fields: columns, rows,
      rowCount: rows.length, complete: true, readAt: now(), strategy: "uploaded_snapshot", idField: key, originSourceId: source.id }, profiles, issues);
  }

  private addProfile(profile: DatasetProfile, profiles: DatasetProfile[], issues: BuildIssue[]) {
    // Persist only the bounded display sample, never a second copy of an uploaded file.
    const previous = this.memory.listArtifacts("engine_dataset").find(dataset => dataset.content.sourceId === (profile.originSourceId ?? profile.sourceId) && dataset.content.capability === profile.capability);
    this.memory.putArtifact({ ...(previous ? { id: previous.id, expectedVersion: previous.version } : {}), kind: "engine_dataset", title: profile.name, status: profile.rows.length ? "ready" : "empty", content: jsonData({
      sourceId: profile.originSourceId ?? profile.sourceId, sourceVersion: profile.originSourceId ? this.memory.getArtifact(profile.originSourceId).version : profile.sourceVersion,
      connectionId: profile.sourceId, capability: profile.capability, name: profile.name, fields: profile.fields, rowCount: profile.rowCount,
      sampleCount: profile.rows.length, complete: profile.complete, readAt: profile.readAt, strategy: profile.strategy, idField: profile.idField ?? null, sample: profile.rows.slice(0, 3),
    }) });
    if (!profile.rows.length) issues.push({ code: "empty_sample", severity: "error", sourceId: profile.originSourceId ?? profile.sourceId, capability: profile.capability, message: "来源当前没有记录，未生成可执行对象映射；请补充记录或显式缩小构建范围。" });
    if (!profile.complete && profile.rows.length) issues.push({ code: "partial_sample", severity: "warning", sourceId: profile.sourceId, capability: profile.capability, message: `检查了 ${profile.rows.length} 条样本；身份和关系只在该范围验证，不代表全量数据。` });
    profiles.push(profile);
  }

  private compile(jobId: string, profiles: DatasetProfile[], issues: BuildIssue[]) {
    const job = this.memory.getArtifact(jobId), base = this.foundation.read(), active = this.activeModel();
    const previous = base.current?.content;
    const concepts = dataArray(previous?.concepts), relations = dataArray(previous?.relations), evidence = dataArray(previous?.evidence);
    const types = dataArray(active?.content.types), modelRelations = dataArray(active?.content.relations);
    const preservedConcepts = concepts.map(concept => String(concept.id)), preservedMappings = types.map(type => String(type.conceptId));
    const addedConcepts: string[] = [], addedMappings: string[] = [];
    for (const dataset of profiles) {
      if (!dataset.rows.length || !dataset.idField) continue;
      const existing = types.find(type => [type, ...dataArray(type.supplements)].some(binding => binding.sourceId === dataset.sourceId && binding.capability === dataset.capability));
      if (existing) {
        // Keep all semantic edits and mappings. Only refresh program-owned source
        // evidence when a file/connection version has actually changed.
        const retained = concepts.find(item => item.id === existing.conceptId);
        const ownedEvidence = retained?.programEvidenceId && evidence.find(item => item.id === retained.programEvidenceId);
        if (retained && ownedEvidence && ownedEvidence.sourceId === dataset.sourceId && ownedEvidence.connectionVersion !== dataset.sourceVersion) {
          const newEvidence = this.captureEvidence(dataset, jobId);
          evidence.push(newEvidence);
          retained.evidenceRefs = (retained.evidenceRefs as string[]).map(id => id === ownedEvidence.id ? String(newEvidence.id) : id);
          retained.programEvidenceId = newEvidence.id;
        }
        continue;
      }
      const identity = `source_${fingerprint([dataset.originSourceId ?? dataset.sourceId, dataset.capability]).slice(0, 24)}`;
      let concept = concepts.find(item => item.id === identity);
      if (!concept) {
        const sourceEvidence = this.captureEvidence(dataset, jobId);
        const evidenceId = String(sourceEvidence.id);
        evidence.push(sourceEvidence);
        let name = entityName(dataset.name);
        if (concepts.some(item => item.name === name)) name = `${name} · ${fingerprint([dataset.sourceId, dataset.capability]).slice(0, 6)}`;
        concept = { id: identity, name, description: `来自“${dataset.name}”的记录对象；业务含义待核对。`, evidenceRefs: [evidenceId], origin: "program", mappingStatus: "unbound", programEvidenceId: evidenceId, programSource: { sourceId: dataset.originSourceId ?? dataset.sourceId, capability: dataset.capability } };
        concepts.push(concept); addedConcepts.push(identity);
      }
      const fields = Object.fromEntries(dataset.fields.filter(field => field.name !== "$id").map(field => [field.name, field.name]));
      if (!Object.keys(fields).length) { issues.push({ code: "fields_unusable", severity: "error", sourceId: dataset.sourceId, capability: dataset.capability, message: "没有可映射字段，未创建执行映射。" }); continue; }
      types.push({ name: concept.name, description: concept.description, conceptId: concept.id, sourceId: dataset.sourceId, capability: dataset.capability, fields });
      addedMappings.push(String(concept.id));
    }
    alignTypes(types, modelRelations, concepts);
    if (concepts.length > MAX_FOUNDATION_CONCEPTS || types.length > MAX_MODEL_TYPES) throw new Error(`生成结果有 ${concepts.length} 个概念、${types.length} 个映射，超过当前 ${MAX_FOUNDATION_CONCEPTS}/${MAX_MODEL_TYPES} 的执行契约。请缩小来源范围，程序没有截断或覆盖既有定义。`);
    if (!types.length) return null;
    const profile = this.memory.listArtifacts("profile")[0];
    const enterprise = enterpriseIdentity(previous?.enterprise as Data | undefined, profile, evidence);
    const foundation = jsonData({ ...previous, enterprise, concepts, relations, evidence, unknowns: dataArray(previous?.unknowns), conflicts: dataArray(previous?.conflicts),
      adoptedVersion: base.adopted?.version ?? null, profileRef: ref(profile), documentVersions: previous?.documentVersions ?? {}, operation: { hash: fingerprint([concepts, relations, types]) },
      method: { name: "helix-program-discovery", sourceCommit: "00d7927d7c08e16c58316e006959f052427e7fa1" },
      checks: { valid: true, description: "程序核对了来源字段和实际样本。业务含义及样本外数据仍需核对。" } });
    const sourceVersions = { ...(job.content.sourceVersions as Record<string, number>), ...Object.fromEntries(profiles.map(dataset => [dataset.sourceId, dataset.sourceVersion])) };
    return this.memory.atomic(() => {
      for (const previous of this.memory.listArtifacts("engine_candidate").filter(item => ["candidate", "checked"].includes(item.status))) {
        this.memory.putArtifact({ ...previous, expectedVersion: previous.version, status: "superseded" });
      }
      return this.memory.putArtifact({ kind: "engine_candidate", title: "程序构建候选", status: "candidate", content: jsonData({
      jobId, baseFoundationRef: job.content.baseFoundationRef, baseModelRef: job.content.baseModelRef, sourceVersions, foundation, concepts, relations, types, modelRelations, layered: this.layers(types, modelRelations), issues,
      coverage: profiles.map(dataset => ({ sourceId: dataset.originSourceId ?? dataset.sourceId, capability: dataset.capability, sampledRows: dataset.rows.length, totalRows: dataset.rowCount, complete: dataset.complete, readAt: dataset.readAt })),
      diff: { addedConcepts, preservedConcepts, addedMappings, preservedMappings }, checks: { valid: false, description: "候选已生成，采用前需重新检查来源与执行映射。" },
      }) });
    });
  }

  /** A replaced CSV keeps its execution connection (and so every mapping on it); the connection moves to the new
   *  file version under the same identity column. New entities connect on their own during compilation. */
  private refreshUploads(datasets: Artifact[], issues: BuildIssue[]) {
    const uploads = new Set(datasets.map(d => String(d.content.sourceId)));
    for (const connection of this.live.sources.list()) {
      const local = connection.content.localSource as Data | undefined;
      if (connection.status !== "ready" || !local || !uploads.has(String(local.id))) continue;
      const source = this.memory.getArtifact(String(local.id));
      if (source.status !== "ready" || source.version === local.version) continue;
      const key = String((dataArray(connection.content.capabilities)[0] ?? {}).idField);
      try { this.live.sources.connectUpload(source.id, source.version, key); }
      catch (error) { issues.push({ code: "identity_unknown", severity: "error", sourceId: source.id, capability: "records", message: `「${source.title}」更新后无法沿用身份字段 ${key}：${(error as Error).message}` }); }
    }
  }

  /** ADE mapping from a Helix suggestion: entity -> concept + type, direct merges -> supplements, anchor links -> relations. */
  private compileDiscovery(jobId: string, o: SuggestedOntology, datasets: Artifact[], issues: BuildIssue[]) {
    this.refreshUploads(datasets, issues);
    const job = this.memory.getArtifact(jobId), base = this.foundation.read(), active = this.activeModel();
    const previous = base.current?.content;
    // Legacy interpretation-built structures are replaced in the new version only.
    // Program provenance and explicitly adopted relations survive later builds and wording edits.
    const priorConcepts = dataArray(previous?.concepts), priorRelations = dataArray(previous?.relations);
    const retiredConcepts = priorConcepts.filter(c => c.origin !== "program").map(c => String(c.id));
    const concepts = priorConcepts.filter(c => c.origin === "program"), keptConcepts = new Set(concepts.map(c => c.id));
    const relations = priorRelations.filter(r => (r.origin === "program" || r.governed === true) && keptConcepts.has(r.from) && keptConcepts.has(r.to));
    const retiredRelations = priorRelations.filter(r => !relations.includes(r)).map(r => String(r.id));
    const evidence = dataArray(previous?.evidence);
    const currentModel = active ? this.live.projectModel(active) : null;
    const priorTypes = dataArray(currentModel?.content.types), priorModelRelations = dataArray(currentModel?.content.relations);
    const migrating = retiredConcepts.length > 0 || retiredRelations.length > 0;
    const types = migrating ? priorTypes.filter(t => keptConcepts.has(t.conceptId)) : priorTypes;
    const keptTypes = new Set(types.map(t => t.name)), keptRelations = new Set(relations.map(r => r.id));
    const modelRelations = migrating ? priorModelRelations.filter(r => keptTypes.has(r.from) && keptTypes.has(r.to) && keptRelations.has(r.relationId)) : priorModelRelations;
    const retiredMappings = priorTypes.filter(t => !types.includes(t)).map(t => String(t.conceptId ?? t.name));
    const retiredIds = new Set([...retiredConcepts, ...retiredRelations]);
    const priorConflicts = dataArray(previous?.conflicts);
    const conflicts = migrating ? priorConflicts.filter(c => ![c.retained, c.proposed].some(item => item && retiredIds.has(String((item as Data).id)))) : priorConflicts;
    const retiredConflicts = priorConflicts.filter(c => !conflicts.includes(c)).map(c => String(c.id));
    if (migrating) issues.push({ code: "legacy_structure_replaced", severity: "info",
      message: `本候选以数据规则结果替换 ${retiredConcepts.length} 个旧解读概念、${retiredRelations.length} 条旧关系及 ${retiredMappings.length} 个旧映射。旧定义、映射和发布版本保留在历史中；程序概念的后续命名与说明修正继续保留。`,
      details: jsonData({ foundationRef: ref(base.current), modelRef: ref(active), retiredConcepts, retiredRelations, retiredMappings, retiredConflicts }) });
    const preservedConcepts = concepts.map(concept => String(concept.id)), preservedMappings = types.map(type => String(type.conceptId));
    const addedConcepts: string[] = [], addedMappings: string[] = [], addedRelations: string[] = [], addedSupplements: string[] = [];
    const byId = new Map(datasets.map(d => [d.id, d.content as unknown as DatasetContent]));
    const resources = new Map<string, Resource>(datasets.map(d => [d.id, { id: d.id, name: String(d.content.name),
      data: { activeVersion: String(d.content.activeVersion), profile: (d.content as unknown as DatasetContent).profile! } }]));
    const bundle: Bundle = ontologyBundle(o, resources);
    const { omittedEntities, anchorOnlyEntities, omittedRelationships } = bundle.capacity;
    if (omittedEntities.length) issues.push({ code: "capacity_limit", severity: "warning", message: `发现 ${omittedEntities.length} 个实体超过单次 20 个的映射范围，未纳入本次候选；请缩小来源范围后分批构建。`, details: { entities: omittedEntities } });
    if (anchorOnlyEntities.length) issues.push({ code: "capacity_limit", severity: "warning", message: `${anchorOnlyEntities.length} 个合并实体超过 10 条合并计划的范围，本次只按主来源映射。`, details: { entities: anchorOnlyEntities } });
    if (omittedRelationships.length) issues.push({ code: "capacity_limit", severity: "warning", message: `${omittedRelationships.length} 条关系超过单次 30 条的范围，未纳入本次候选。`, details: { links: omittedRelationships } });
    for (const id of o.unplaced) issues.push({ code: "identity_unknown", severity: "warning", sourceId: byId.get(id)?.sourceId, capability: byId.get(id)?.capability, message: `「${resources.get(id)?.name}」没有非空唯一的身份键，未生成对象映射；请补充稳定编号或由助手协助修复，未把普通唯一字段猜作业务身份。` });
    for (const e of o.entities.filter(e => e.kind === "activity")) issues.push({ code: "activity_stream", severity: "info", message: `${e.name}是大规模事件流，保留为分析数据，不作为对象映射。`, details: { entity: e.id } });

    // The execution connection of a snapshot dataset: an HTTP/MCP source itself, or the CSV bound with the given identity.
    const connection = (c: DatasetContent, key: string) => {
      const source = this.memory.getArtifact(c.sourceId);
      return source.kind === "source" ? this.live.sources.connectUpload(source.id, source.version, key).id : source.id;
    };
    const boundTo = (c: DatasetContent) => {
      const ids = new Set([c.sourceId, ...this.live.sources.list().filter(x => (x.content.localSource as Data | undefined)?.id === c.sourceId).map(x => x.id)]);
      return types.find(type => [type, ...dataArray(type.supplements)].some(b => ids.has(String(b.sourceId)) && b.capability === c.capability));
    };
    const typeOf = new Map<string, Data>();
    // Which concept and relation each discovered entity and link became, so the adopted ontology can show its evidence.
    const entityConcepts: Record<string, string> = {}, linkRelations: Record<string, string> = {};
    for (const t of bundle.ontology) {
      const e = o.entities.find(x => x.id === t.entityId)!, anchor = byId.get(e.anchorDatasetId)!;
      // Extend an existing mapping instead of duplicating the object: the anchor's own, or else that of a member matched directly to it.
      // Newly discovered direct merges are added to it as supplements.
      const pivot = boundTo(anchor) ? undefined : e.members.slice(1).find(m => m.via?.targetDatasetId === e.anchorDatasetId && boundTo(byId.get(m.datasetId)!));
      const existing = boundTo(pivot ? byId.get(pivot.datasetId)! : anchor);
      let sourceId = String(existing?.sourceId ?? "");
      if (!existing) {
        try { sourceId = connection(anchor, e.key); }
        catch (error) { issues.push({ code: "identity_unknown", severity: "error", sourceId: anchor.sourceId, capability: anchor.capability, message: (error as Error).message }); continue; }
      }
      const identity = `source_${fingerprint([anchor.sourceId, anchor.capability]).slice(0, 24)}`;
      let concept = existing ? concepts.find(item => item.id === existing.conceptId) : concepts.find(item => item.id === identity);
      if (!concept) {
        const sourceEvidence = this.captureEvidence(this.snapshotProfile(anchor, sourceId), jobId), evidenceId = String(sourceEvidence.id);
        evidence.push(sourceEvidence);
        let name = e.name;
        if (concepts.some(item => item.name === name)) name = `${name} · ${identity.slice(7, 13)}`;
        // Row counts change with every sync, so the stored definition omits them; snapshots carry the current count.
        concept = { id: identity, name, description: `${e.description.replace(/的 [\d,]+ 条/, "的")}业务含义待核对。`.slice(0, 1500), evidenceRefs: [evidenceId], origin: "program", mappingStatus: "unbound",
          programEvidenceId: evidenceId, programSource: { sourceId: anchor.sourceId, capability: anchor.capability } };
        concepts.push(concept); addedConcepts.push(identity);
      }
      entityConcepts[e.id] = String(concept.id);
      const fields = existing ? existing.fields as Record<string, string> : Object.fromEntries((anchor.profile?.columns ?? []).map(c => [c.name, c.name]));
      const supplements = dataArray(existing?.supplements), added = supplements.length;
      const usedProperties = new Set([Object.keys(fields), ...supplements.map(s => Object.keys(s.fields as Data))].flat().map(name => name.toLowerCase()));
      for (const m of e.members.filter(m => m.datasetId !== (pivot?.datasetId ?? e.anchorDatasetId))) {
        const member = byId.get(m.datasetId)!, why = (message: string) => issues.push({ code: "merge_not_expressible", severity: "info", sourceId: member.sourceId, capability: member.capability,
          message: `「${m.datasetName}」与${e.name}的合并${message}；本次未新增该合并的执行映射，候选计划尚未接入对象查询与发布消费。`, details: { entity: e.id, dataset: m.datasetId } });
        // The match is stated against the primary mapping: with a pivot, the anchor matches it in reverse and other members only through the anchor.
        const via = pivot ? (m.datasetId === e.anchorDatasetId ? { primary: pivot.via!.column, source: pivot.via!.targetColumn, rows: pivot.rows, matched: pivot.matched } : null)
          : m.via?.targetDatasetId === e.anchorDatasetId ? { primary: m.via.targetColumn, source: m.via.column, rows: m.rows, matched: m.matched } : null;
        if (!via) { why("经过其他数据集间接匹配，在线映射只支持与主来源直接匹配"); continue; }
        if (boundTo(member)) { why("的来源已作为其他对象的映射，未重复绑定；如需合并请由助手协助调整映射"); continue; }
        const primaryField = Object.entries(fields).find(([, column]) => column === via.primary)?.[0];
        if (!primaryField) { why(`需要主映射包含 ${via.primary} 字段`); continue; }
        if (supplements.length >= 3) { why("超过每个对象 3 个附来源的在线映射范围"); continue; }
        let memberSource: string;
        try { memberSource = connection(member, m.key); } catch (error) { why(`无法建立执行来源（${(error as Error).message}）`); continue; }
        const { cap } = this.live.sources.capability(memberSource, member.capability);
        if (!Object.hasOwn(cap.filters, via.source)) { why(`需要附来源支持按 ${via.source} 精确过滤`); continue; }
        // Name new fields relative to the retained primary, reserving all adopted property names.
        // Limit column generation to this member so another dataset cannot silently hide a collision.
        const columns = entityColumns({ ...e, anchorDatasetId: pivot?.datasetId ?? e.anchorDatasetId }, new Map([[m.datasetId, resources.get(m.datasetId)!]]));
        const memberFields = Object.fromEntries(columns.map(c => {
          let property = c.as;
          for (let n = 2; usedProperties.has(property.toLowerCase()); n++) property = `${c.as}_${n}`;
          usedProperties.add(property.toLowerCase());
          return [property, c.column];
        }));
        if (!Object.keys(memberFields).length) continue;
        supplements.push({ name: m.datasetName.slice(0, 200), sourceId: memberSource, capability: member.capability, match: { primaryField, sourceField: via.source },
          fields: memberFields, rationale: `程序发现：${via.rows} 条中 ${via.matched} 条按 ${via.source} = ${via.primary} 精确匹配。同名属性保留来源前缀，业务含义待核对。` });
      }
      if (existing) {
        const type = supplements.length > added ? { ...existing, supplements } : existing;
        if (type !== existing) { types[types.indexOf(existing)] = type; addedSupplements.push(...supplements.slice(added).map(x => `${concept.name} ← ${x.name}`)); }
        typeOf.set(e.id, type); continue;
      }
      const type: Data = { name: concept.name, description: concept.description, conceptId: concept.id, sourceId, capability: anchor.capability, fields, ...(supplements.length ? { supplements } : {}) };
      types.push(type); typeOf.set(e.id, type); addedMappings.push(String(concept.id));
    }
    for (const r of bundle.relationships) {
      const l = o.links.find(x => x.id === r.linkId)!, from = typeOf.get(l.from), to = typeOf.get(l.to);
      const fromEntity = o.entities.find(x => x.id === l.from)!, toEntity = o.entities.find(x => x.id === l.to)!;
      const skip = (message: string) => issues.push({ code: "relationship_candidate", severity: "warning", message: `${fromEntity.name}.${l.fromColumn} → ${toEntity.name}.${l.toColumn}（${l.matchedRows}/${l.totalRows} 条匹配）${message}`,
        details: { link: l.id, matchedRows: l.matchedRows, totalRows: l.totalRows, evidence: l.evidence } });
      if (!from || !to) { skip("：端点未形成对象映射，保留为待核对关联。"); continue; }
      if (l.fromDatasetId !== fromEntity.anchorDatasetId || l.toDatasetId !== toEntity.anchorDatasetId || l.caseInsensitive) { skip("：需经合并数据或忽略大小写匹配，保留为待核对候选，本次未加入执行映射；候选计划尚未接入对象查询与发布消费。"); continue; }
      const prop = (type: Data, column: string) => Object.entries(type.fields as Record<string, string>).find(([, field]) => field === column)?.[0];
      const fromField = prop(from, l.fromColumn), toField = prop(to, l.toColumn);
      const { cap } = this.live.sources.capability(String(to.sourceId), String(to.capability));
      if (!fromField || !toField || !Object.hasOwn(cap.filters, l.toColumn)) { skip("：目标来源不支持按关联字段过滤，保留为待核对关联。"); continue; }
      const kept = modelRelations.find(x => x.from === from.name && x.to === to.name && x.fromField === fromField);
      if (kept) { if (kept.relationId) linkRelations[l.id] = String(kept.relationId); continue; }
      let name = l.name;
      for (let n = 2; modelRelations.some(x => x.from === from.name && x.name === name); n++) name = `${l.name}${n}`;
      const relationId = `rel_${fingerprint([from.conceptId, l.fromColumn, to.conceptId]).slice(0, 24)}`;
      if (!relations.some(x => x.id === relationId)) {
        const fromConcept = concepts.find(c => c.id === from.conceptId)!;
        relations.push({ id: relationId, name, from: String(from.conceptId), to: String(to.conceptId), origin: "program", mappingStatus: "unbound", evidenceRefs: [(fromConcept.evidenceRefs as string[])[0]],
          description: `程序发现：${l.totalRows} 条中 ${l.matchedRows} 条的 ${l.fromColumn} 能在${toEntity.name}中找到；业务含义待核对。` });
        addedRelations.push(relationId);
      }
      const relation = relations.find(x => x.id === relationId)!;
      linkRelations[l.id] = relationId;
      modelRelations.push({ name: String(relation.name), from: String(from.name), to: String(to.name), fromField, toField, relationId });
    }
    // Discovery reviews describe observed ambiguity; they never change the executable structure.
    for (const review of o.reviews ?? []) {
      const concept = concepts.find(c => c.id === entityConcepts[review.entities[0]]);
      if (review.kind === "entity_name" && concept && concept.name !== review.originalName) continue;
      const code = { value_overlap: "possible_identity_overlap", implied_link: "relationship_pruned", entity_name: "entity_name_review" }[review.kind];
      issues.push({ code, severity: review.kind === "entity_name" ? "info" : "warning", message: review.text,
        details: jsonData({ ...review, concepts: review.entities.map(id => entityConcepts[id]).filter(Boolean) }) });
    }
    alignTypes(types, modelRelations, concepts);
    if (concepts.length > MAX_FOUNDATION_CONCEPTS || types.length > MAX_MODEL_TYPES) throw new Error(`生成结果有 ${concepts.length} 个概念、${types.length} 个映射，超过当前 ${MAX_FOUNDATION_CONCEPTS}/${MAX_MODEL_TYPES} 的执行契约。请缩小来源范围，程序没有截断或覆盖既有定义。`);
    if (!types.length) return null;
    const profile = this.memory.listArtifacts("profile")[0];
    const enterprise = enterpriseIdentity(previous?.enterprise as Data | undefined, profile, evidence);
    const unknowns = dataArray(previous?.unknowns);
    // Retired definitions keep their full evidence in history, not as dependencies of
    // this new version. Governance explanations and program provenance remain live references.
    const owners = [enterprise, ...concepts, ...relations, ...unknowns, ...conflicts,
      ...[...unknowns, ...conflicts].flatMap(item => [item.retained, item.proposed])
        .filter((item): item is Data => !!item && typeof item === "object" && !Array.isArray(item))];
    const evidenceIds = new Set(owners.flatMap(item => [
      ...(Array.isArray(item.evidenceRefs) ? item.evidenceRefs : []),
      ...(Array.isArray(item.resolvedBy) ? item.resolvedBy : []), item.programEvidenceId,
    ]).filter((id): id is string => typeof id === "string"));
    const currentEvidence = evidence.filter(item => evidenceIds.has(String(item.id)));
    const documentVersions: Record<string, number> = {};
    for (const item of currentEvidence) if (item.kind === "document" && typeof item.sourceId === "string" && typeof item.sourceVersion === "number")
      documentVersions[item.sourceId] = Math.max(documentVersions[item.sourceId] ?? 0, item.sourceVersion);
    const foundation = jsonData({ ...previous, enterprise, concepts, relations, evidence: currentEvidence, unknowns, conflicts,
      adoptedVersion: base.adopted?.version ?? null, profileRef: ref(profile), documentVersions, operation: { hash: fingerprint([concepts, relations, types, modelRelations]) },
      method: { name: "helix-program-discovery", sourceCommit: "00d7927d7c08e16c58316e006959f052427e7fa1", suggestionHash: o.hash },
      checks: { valid: true, description: "程序在全量快照上核对了身份、合并与关联。业务含义仍需核对。" } });
    const sourceVersions = { ...(job.content.sourceVersions as Record<string, number>), ...Object.fromEntries(types.flatMap(t => [t, ...dataArray(t.supplements)]).map(b => [String(b.sourceId), this.memory.getArtifact(String(b.sourceId)).version])) };
    return this.memory.atomic(() => {
      for (const prior of this.memory.listArtifacts("engine_candidate").filter(item => ["candidate", "checked"].includes(item.status)))
        this.memory.putArtifact({ ...prior, expectedVersion: prior.version, status: "superseded" });
      return this.memory.putArtifact({ kind: "engine_candidate", title: "程序构建候选", status: "candidate", content: jsonData({
        jobId, baseFoundationRef: job.content.baseFoundationRef, baseModelRef: job.content.baseModelRef, sourceVersions, foundation, concepts, relations, types, modelRelations, layered: this.layers(types, modelRelations), issues,
        coverage: datasets.map(d => { const c = d.content as unknown as DatasetContent; return { sourceId: c.sourceId, capability: c.capability, datasetId: d.id, snapshotId: c.activeVersion,
          sampledRows: c.coverage?.rows ?? c.profile?.rows ?? 0, totalRows: c.coverage?.total ?? null, complete: c.coverage?.complete ?? true, readAt: c.lastSync }; }),
        diff: { addedConcepts, preservedConcepts, addedMappings, preservedMappings, addedSupplements, addedRelations,
          retiredConcepts, retiredRelations, retiredMappings, retiredConflicts, ...(migrating ? { legacyFoundationRef: ref(base.current), legacyModelRef: ref(active) } : {}) },
        discovery: { hash: o.hash, signature: o.signature, summary: o.summary, entities: o.entities, links: o.links, notes: o.notes, unplaced: o.unplaced, reviews: o.reviews ?? [],
          unplacedNames: o.unplaced.map(id => resources.get(id)?.name ?? id), entityConcepts, linkRelations },
        bundle, snapshotInputs: Object.fromEntries(datasets.map(d => [d.id, String(d.content.activeVersion)])),
        checks: { valid: false, description: "候选已生成，采用前需重新检查来源与执行映射。" },
      }) });
    });
  }

  /** Evidence input from a snapshot: its schema and the first stored sample rows. */
  private snapshotProfile(c: DatasetContent, connectionId: string): DatasetProfile {
    const rows = (c.profile?.sample ?? []) as Data[];
    return { sourceId: connectionId, sourceVersion: this.memory.getArtifact(connectionId).version, capability: c.capability, name: c.name,
      fields: profileColumns((c.profile?.columns ?? []).map(col => col.name), rows), rows, rowCount: c.profile?.rows ?? rows.length,
      complete: c.coverage?.complete ?? true, readAt: c.lastSync ?? now(), strategy: "uploaded_snapshot" };
  }

  private captureEvidence(dataset: DatasetProfile, jobId: string): Data {
    const text = JSON.stringify({fields: dataset.fields.map(field => field.name), idField: dataset.idField, items: dataset.rows.slice(0, 3)});
    if (Buffer.byteLength(text) > 128_000) throw new Error("来源样本超过 128 KB 依据范围，请缩小字段或记录内容后重新构建");
    const quote = text.slice(0, 1500);
    return {id: `build_${fingerprint([dataset.sourceId, dataset.sourceVersion, dataset.capability, jobId]).slice(0, 24)}`,
      kind: "api", sourceId: dataset.sourceId, connectionVersion: dataset.sourceVersion, capability: dataset.capability,
      title: dataset.name, quote, capturedAt: dataset.readAt, readAt: dataset.readAt, validTime: "unknown", start: 0, end: quote.length,
      sourceHash: fingerprintRaw(text), apiSnapshot: {text, coverage: {complete: dataset.complete && dataset.rows.length <= 3, shown: Math.min(dataset.rows.length, 3), total: dataset.rowCount}}};
  }

  private candidate(args: unknown) {
    const input = referenceInput.parse(args), candidate = this.memory.getArtifact(input.id);
    if (candidate.kind !== "engine_candidate" || candidate.version !== input.version || !["candidate", "checked"].includes(candidate.status)) throw new Error("构建候选版本已变化，请重新读取");
    this.assertInputs(candidate.content as unknown as CandidateContent);
    for (const [datasetId, snapshotId] of Object.entries((candidate.content as unknown as CandidateContent).snapshotInputs ?? {}))
      if (this.snapshots?.dataset(datasetId).content.activeVersion !== snapshotId) throw new Error("数据快照已更新，请重新构建后再检查");
    return candidate;
  }

  /** Keep only the selected new structure: adopting part of a candidate recompiles the rest against the same base. */
  private prune(content: CandidateContent, selection: Selection): CandidateContent {
    const list = (value: unknown) => Array.isArray(value) ? value.map(String) : [];
    const addedEntities = new Set(list(content.diff.addedConcepts));
    const addedRelations = new Set(list(content.diff.addedRelations));
    const addedMerges = new Set(list(content.diff.addedSupplements));
    const retiring = new Set(selection.retired ?? []);
    const retired = [...list(content.diff.retiredConcepts), ...list(content.diff.retiredRelations)];
    for (const id of retiring) if (!retired.includes(id)) throw new Error(`所选退役项不在本次候选中：${id}`);
    for (const id of selection.entities) if (!addedEntities.has(id)) throw new Error(`所选对象不是本次候选新增的对象：${id}`);
    for (const id of selection.relations) if (!addedRelations.has(id)) throw new Error(`所选关系不是本次候选新增的关系：${id}`);
    for (const key of selection.merges) if (!addedMerges.has(key)) throw new Error(`所选合并不是本次候选新增的合并：${key}`);
    if (![...selection.entities, ...selection.relations, ...selection.merges, ...(selection.retired ?? [])].length)
      throw new Error("请至少选择一项结构变更，或整批采用候选");
    const keepEntities = selection.entities.length ? new Set(selection.entities) : null;
    const keepRelations = selection.relations.length ? new Set(selection.relations) : null;
    const keepMerges = selection.merges.length ? new Set(selection.merges) : null;

    const baseline = this.foundation.read().adopted?.content;
    const baselineModel = this.activeModel()?.content;
    for (const relation of dataArray(baseline?.relations))
      if ((retiring.has(String(relation.from)) || retiring.has(String(relation.to))) && !retiring.has(String(relation.id)))
        throw new Error("退役对象前需先采用其关联关系的退役变更");
    const concepts = [...content.concepts, ...dataArray(baseline?.concepts).filter(c => list(content.diff.retiredConcepts).includes(String(c.id)) && !retiring.has(String(c.id)))].filter(concept => !addedEntities.has(String(concept.id)) || keepEntities?.has(String(concept.id)));
    const keptConcepts = new Set(concepts.map(concept => String(concept.id)));
    const relations = [...content.relations, ...dataArray(baseline?.relations).filter(r => list(content.diff.retiredRelations).includes(String(r.id)) && !retiring.has(String(r.id)))].filter(relation => {
      if (!keptConcepts.has(String(relation.from)) || !keptConcepts.has(String(relation.to))) return false;
      return !addedRelations.has(String(relation.id)) || keepRelations?.has(String(relation.id));
    });
    const keptRelations = new Set(relations.map(relation => String(relation.id)));
    for (const id of selection.relations) if (!keptRelations.has(id)) throw new Error("所选关系的端点尚未采用，请先选择其新增对象");
    const types = [...content.types, ...dataArray(baselineModel?.types).filter(t => !content.types.some(candidate => candidate.conceptId === t.conceptId) && keptConcepts.has(String(t.conceptId)))].flatMap((type): Data[] => {
      if (!keptConcepts.has(String(type.conceptId))) return [];
      const supplements = dataArray(type.supplements).filter(supplement => {
        const key = `${String(type.name)} ← ${String(supplement.name)}`;
        return !addedMerges.has(key) || keepMerges?.has(key);
      });
      return [{ ...type, ...(dataArray(type.supplements).length ? { supplements } : {}) }];
    });
    if (!types.length) throw new Error("所选范围没有保留任何实体映射；请至少选择一个新增对象，或整批采用");
    const keptMerges = new Set(types.flatMap(type => dataArray(type.supplements).map(supplement => `${String(type.name)} ← ${String(supplement.name)}`)));
    for (const key of selection.merges) if (!keptMerges.has(key)) throw new Error("所选合并的主对象尚未采用，请先选择其新增对象");
    const typeNames = new Set(types.map(type => String(type.name)));
    const modelRelations = [...content.modelRelations, ...dataArray(baselineModel?.relations).filter(r => !content.modelRelations.some(candidate => candidate.relationId === r.relationId) && keptRelations.has(String(r.relationId)))].filter(relation => {
      if (!typeNames.has(String(relation.from)) || !typeNames.has(String(relation.to))) return false;
      const relationId = String(relation.relationId ?? "");
      return !relationId || !addedRelations.has(relationId) || keptRelations.has(relationId);
    });
    const evidenceIds = new Set<string>();
    for (const concept of concepts) {
      for (const id of list(concept.evidenceRefs)) evidenceIds.add(id);
      if (concept.programEvidenceId) evidenceIds.add(String(concept.programEvidenceId));
    }
    for (const relation of relations) for (const id of dataArray(relation.evidenceRefs)) evidenceIds.add(String(id));
    const evidence = [...dataArray(content.foundation.evidence), ...dataArray(baseline?.evidence).filter(e => !dataArray(content.foundation.evidence).some(candidate => candidate.id === e.id))].filter(item => evidenceIds.has(String(item.id)));
    return { ...content, concepts, relations, types, modelRelations, foundation: jsonData({ ...content.foundation, concepts, relations, evidence }) };
  }

  /** Keep an unselected structural proposal actionable against the newly adopted baseline. */
  continueCandidate(candidate: Artifact, selected?: Selection): Artifact | null {
    if (!selected) return null;
    const content = candidate.content as unknown as CandidateContent;
    const keep = (field: string, accepted: string[]) => (Array.isArray(content.diff[field]) ? content.diff[field] as string[] : []).filter(id => !accepted.includes(id));
    const diff = { ...content.diff, addedConcepts: keep("addedConcepts", selected.entities), addedRelations: keep("addedRelations", selected.relations),
      addedSupplements: keep("addedSupplements", selected.merges), retiredConcepts: keep("retiredConcepts", selected.retired ?? []), retiredRelations: keep("retiredRelations", selected.retired ?? []) };
    if (!isStructural(structuralDelta(diff))) return null;
    return this.memory.putArtifact({ kind: "engine_candidate", title: "程序构建剩余变更", status: "candidate", content: jsonData({ ...content,
      baseFoundationRef: ref(this.foundation.read().current), baseModelRef: ref(this.activeModel()), diff, continuationOf: ref(candidate),
      checks: { valid: false, description: "未选结构保留待处理；采用前会按当前工作版重新编译并复验。" } }) });
  }

  private virtualFoundation(content: CandidateContent): Artifact {
    const current = this.foundation.read().current;
    const keys = ["enterprise", "concepts", "relations", "evidence", "unknowns", "conflicts", "documentVersions", "profileRef"];
    if (current?.status === "adopted" && keys.every(key => equal(current.content[key] ?? null, content.foundation[key] ?? null))) return current;
    return { id: current?.id ?? "engine-new-foundation", version: (current?.version ?? 0) + 2, kind: "foundation", status: "adopted", title: "数据底座本体", createdAt: now(), content: content.foundation };
  }

  private async prepare(candidate: Artifact, assertActive: () => void = () => {}, override?: CandidateContent) {
    assertActive();
    const content = override ?? candidate.content as unknown as CandidateContent;
    this.assertInputs(content);
    if (content.issues.some(issue => issue.severity === "error")) throw new Error("候选包含来源或身份错误，请修复问题后重新构建");
    if (dataArray(content.foundation.conflicts).some(conflict => !conflict.resolvedBy)) throw new Error("现有工作版本存在未解决冲突，请通过助手修复后再采用");
    const foundation = this.virtualFoundation(content);
    const definition = await this.live.prepareDefinitionAgainst({ foundationRef: ref(foundation), baseModelRef: content.baseModelRef,
      purpose: "程序构建的数据底座", types: content.types, relations: content.modelRelations,
      rationale: "基于来源字段与实际数据生成；保留既有程序概念的人工与 Agent 命名修正。"
        + (Array.isArray(content.diff.retiredConcepts) && content.diff.retiredConcepts.length ? "旧解读结构已由规则结果替换，旧定义仅保留在历史版本。" : "")
        + "未决关系未自动加入执行映射。",
    }, foundation, () => { assertActive(); this.assertInputs(content); });
    assertActive();
    this.assertInputs(content);
    const migrateCorrections = await prepareCorrectionMigration(this.memory, this.live, definition);
    return { foundation, definition, migrateCorrections };
  }

  async check(args: unknown, assertActive: () => void = () => {}): Promise<Artifact> {
    assertActive();
    const candidate = this.candidate(args), content = candidate.content as unknown as CandidateContent;
    let snapshot: Awaited<ReturnType<typeof validateDefinition>> | undefined;
    try {
      // Full-data checks first; the live sample check then confirms the mapping is executable against current sources.
      if (this.snapshots && content.snapshotInputs) {
        snapshot = await validateDefinition(this.snapshots, this.live, { types: content.types, relations: content.modelRelations }, ((content.bundle as Data | undefined)?.pipelines ?? []) as never);
        assertActive();
        if (!snapshot.valid) throw new Error(describeReport(snapshot));
      }
      const prepared = await this.prepare(candidate, assertActive);
      assertActive();
      this.candidate({ id: candidate.id, version: candidate.version });
      return this.memory.putArtifact({ ...candidate, expectedVersion: candidate.version, status: "checked", content: { ...candidate.content,
        checks: jsonData({ valid: true, checkedAt: now(), description: snapshot ? describeReport(snapshot) : "当前来源、身份、映射与样本检查通过；业务含义仍需核对。", samples: prepared.definition.checks, ...(snapshot ? { snapshot } : {}) }) } });
    } catch (error) {
      assertActive();
      this.candidate({ id: candidate.id, version: candidate.version });
      return this.memory.putArtifact({ ...candidate, expectedVersion: candidate.version, status: "candidate", content: { ...candidate.content,
        checks: jsonData({ valid: false, checkedAt: now(), description: (error as Error).message, ...(snapshot ? { snapshot } : {}) }) } });
    }
  }

  async adopt(args: unknown, assertActive: () => void = () => {}, commit?: (save: () => AdoptedBuild) => AdoptedBuild, inspectVerification?: (facts: Data) => void): Promise<AdoptedBuild> {
    assertActive();
    const input = adoptInput.parse(args);
    const prior = this.memory.getArtifact(input.id), priorContent = prior.content as unknown as CandidateContent;
    if (prior.kind === "engine_candidate" && prior.status === "adopted" && priorContent.adoption?.operationId === input.operationId) {
      if (priorContent.adoption.inputVersion !== input.version) throw new Error("同一采用操作标识不能用于不同候选版本");
      if (JSON.stringify(priorContent.adoption.selection ?? null) !== JSON.stringify(input.selection ?? null)) throw new Error("同一采用操作标识不能用于不同的选择范围");
      return { status: "adopted", candidate: prior, foundation: this.memory.getArtifact(priorContent.adoption.foundationRef.id, priorContent.adoption.foundationRef.version), model: this.memory.getArtifact(priorContent.adoption.modelRef.id, priorContent.adoption.modelRef.version) };
    }
    const candidate = this.candidate({ id: input.id, version: input.version });
    if (!commit && (candidate.status !== "checked" || !(candidate.content.checks as Data).valid)) throw new Error("请先检查候选，再采用工作版本");
    const content = candidate.content as unknown as CandidateContent;
    const selected = input.selection ? this.prune(content, input.selection) : content;
    if (this.snapshots && selected.snapshotInputs) {
      const checked = await validateDefinition(this.snapshots, this.live, { types: selected.types, relations: selected.modelRelations }, ((selected.bundle as Data | undefined)?.pipelines ?? []) as never);
      if (!checked.valid) throw new Error(describeReport(checked));
    }
    const prepared = await this.prepare(candidate, assertActive, selected);
    inspectVerification?.({ checks: dataArray(prepared.definition.checks).map(check => ({ type: check.type, factsFingerprint: check.factsFingerprint })) });
    const save = () => this.memory.atomic(() => {
      assertActive();
      this.candidate({ id: input.id, version: input.version });
      const activeJob = this.memory.getArtifact(content.jobId);
      if (["cancelled", "interrupted", "failed"].includes(activeJob.status)) throw new Error("构建任务已停止，不能继续采用");
      const current = this.foundation.read().current;
      let adopted = current;
      if (!current || prepared.foundation.version !== current.version) {
        const draft = this.memory.putArtifact({ ...(current ? { id: current.id, expectedVersion: current.version } : {}), kind: "foundation", status: "candidate", title: current?.title ?? "数据底座本体", content: prepared.foundation.content });
        adopted = this.foundation.adopt(draft.id, draft.version);
      }
      const model = this.memory.putArtifact({ kind: "live_ontology", status: "adopted", title: "程序构建的数据底座", content: { ...prepared.definition, foundationRef: jsonData(ref(adopted)), programBuildId: content.jobId } });
      prepared.migrateCorrections(model);
      const saved = this.memory.putArtifact({ ...candidate, expectedVersion: candidate.version, status: "adopted", content: { ...candidate.content, adoption: jsonData({ operationId: input.operationId, inputVersion: input.version, selection: input.selection ?? null, foundationRef: ref(adopted), modelRef: ref(model) }) } });
      const job = this.memory.getArtifact(content.jobId);
      this.memory.putArtifact({ ...job, expectedVersion: job.version, content: { ...job.content, outcome: "adopted", candidateRef: jsonData(ref(saved)) } });
      return { status: "adopted" as const, candidate: saved, foundation: adopted!, model };
    });
    if (commit) return commit(save);
    return this.onAdopt ? this.onAdopt(candidate, input.selection, save) : save();
  }
}

// API evidence uses the same byte-level SHA-256 contract as FoundationApi.
import { createHash } from "node:crypto";
const fingerprintRaw = (text: string) => createHash("sha256").update(text).digest("hex");

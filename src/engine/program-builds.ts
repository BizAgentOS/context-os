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

const identifier = z.string().trim().min(1).max(200);
const buildInput = z.object({ operationId: identifier, sourceIds: z.array(identifier).max(100).optional(), expectedFoundationVersion: z.number().int().nonnegative().optional(), autoAdopt: z.boolean().default(false) }).strict();
const referenceInput = z.object({ id: identifier, version: z.number().int().positive() }).strict();
const adoptInput = referenceInput.extend({ operationId: identifier });
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
  adoption?: { operationId: string; inputVersion: number; foundationRef: Ref; modelRef: Ref };
}
const ref = (artifact: Artifact | null | undefined): Ref | null => artifact ? { id: artifact.id, version: artifact.version } : null;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const now = () => new Date().toISOString();
const dataArray = (value: unknown): Data[] => Array.isArray(value) ? structuredClone(value) as Data[] : [];
const SAMPLE_LIMIT = 100;
const MAX_CAPABILITIES = 40;
const MAX_MODEL_TYPES = 20;
const MAX_FOUNDATION_CONCEPTS = 30;

/** Deterministic build jobs share ADE's ontology and mapping services, never a model loop. */
export class ProgramBuilds {
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
    if (concepts.length > MAX_FOUNDATION_CONCEPTS || types.length > MAX_MODEL_TYPES) throw new Error(`生成结果有 ${concepts.length} 个概念、${types.length} 个映射，超过当前 ${MAX_FOUNDATION_CONCEPTS}/${MAX_MODEL_TYPES} 的执行契约。请缩小来源范围，程序没有截断或覆盖既有定义。`);
    if (!types.length) return null;
    const profile = this.memory.listArtifacts("profile")[0];
    const enterprise = previous?.enterprise ?? { name: "未设置企业", evidenceRefs: [] };
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
      jobId, baseFoundationRef: job.content.baseFoundationRef, baseModelRef: job.content.baseModelRef, sourceVersions, foundation, concepts, relations, types, modelRelations, issues,
      coverage: profiles.map(dataset => ({ sourceId: dataset.originSourceId ?? dataset.sourceId, capability: dataset.capability, sampledRows: dataset.rows.length, totalRows: dataset.rowCount, complete: dataset.complete, readAt: dataset.readAt })),
      diff: { addedConcepts, preservedConcepts, addedMappings, preservedMappings }, checks: { valid: false, description: "候选已生成，采用前需重新检查来源与执行映射。" },
      }) });
    });
  }

  /** ADE mapping from a Helix suggestion: entity -> concept + type, direct merges -> supplements, anchor links -> relations. */
  private compileDiscovery(jobId: string, o: SuggestedOntology, datasets: Artifact[], issues: BuildIssue[]) {
    const job = this.memory.getArtifact(jobId), base = this.foundation.read(), active = this.activeModel();
    const previous = base.current?.content;
    const concepts = dataArray(previous?.concepts), relations = dataArray(previous?.relations), evidence = dataArray(previous?.evidence);
    const types = dataArray(active?.content.types), modelRelations = dataArray(active?.content.relations);
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
      const fields = existing ? existing.fields as Record<string, string> : Object.fromEntries((anchor.profile?.columns ?? []).map(c => [c.name, c.name]));
      const supplements = dataArray(existing?.supplements), added = supplements.length;
      for (const m of e.members.filter(m => m.datasetId !== (pivot?.datasetId ?? e.anchorDatasetId))) {
        const member = byId.get(m.datasetId)!, why = (message: string) => issues.push({ code: "merge_not_expressible", severity: "info", sourceId: member.sourceId, capability: member.capability,
          message: `「${m.datasetName}」与${e.name}的合并${message}；合并结果保留在候选中，按快照执行时使用。`, details: { entity: e.id, dataset: m.datasetId } });
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
        const memberFields = Object.fromEntries(entityColumns(e, resources).filter(c => c.datasetId === m.datasetId && !Object.hasOwn(fields, c.as)).map(c => [c.as, c.column]));
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
      if (l.fromDatasetId !== fromEntity.anchorDatasetId || l.toDatasetId !== toEntity.anchorDatasetId || l.caseInsensitive) { skip("：需经合并数据或忽略大小写匹配，在线映射暂不表达，按快照执行时使用。"); continue; }
      const prop = (type: Data, column: string) => Object.entries(type.fields as Record<string, string>).find(([, field]) => field === column)?.[0];
      const fromField = prop(from, l.fromColumn), toField = prop(to, l.toColumn);
      const { cap } = this.live.sources.capability(String(to.sourceId), String(to.capability));
      if (!fromField || !toField || !Object.hasOwn(cap.filters, l.toColumn)) { skip("：目标来源不支持按关联字段过滤，保留为待核对关联。"); continue; }
      if (modelRelations.some(x => x.from === from.name && x.to === to.name && x.fromField === fromField)) continue;
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
      modelRelations.push({ name: String(relation.name), from: String(from.name), to: String(to.name), fromField, toField, relationId });
    }
    if (concepts.length > MAX_FOUNDATION_CONCEPTS || types.length > MAX_MODEL_TYPES) throw new Error(`生成结果有 ${concepts.length} 个概念、${types.length} 个映射，超过当前 ${MAX_FOUNDATION_CONCEPTS}/${MAX_MODEL_TYPES} 的执行契约。请缩小来源范围，程序没有截断或覆盖既有定义。`);
    if (!types.length) return null;
    const profile = this.memory.listArtifacts("profile")[0];
    const enterprise = previous?.enterprise ?? { name: "未设置企业", evidenceRefs: [] };
    const foundation = jsonData({ ...previous, enterprise, concepts, relations, evidence, unknowns: dataArray(previous?.unknowns), conflicts: dataArray(previous?.conflicts),
      adoptedVersion: base.adopted?.version ?? null, profileRef: ref(profile), documentVersions: previous?.documentVersions ?? {}, operation: { hash: fingerprint([concepts, relations, types, modelRelations]) },
      method: { name: "helix-program-discovery", sourceCommit: "00d7927d7c08e16c58316e006959f052427e7fa1", suggestionHash: o.hash },
      checks: { valid: true, description: "程序在全量快照上核对了身份、合并与关联。业务含义仍需核对。" } });
    const sourceVersions = { ...(job.content.sourceVersions as Record<string, number>), ...Object.fromEntries(types.flatMap(t => [t, ...dataArray(t.supplements)]).map(b => [String(b.sourceId), this.memory.getArtifact(String(b.sourceId)).version])) };
    return this.memory.atomic(() => {
      for (const prior of this.memory.listArtifacts("engine_candidate").filter(item => ["candidate", "checked"].includes(item.status)))
        this.memory.putArtifact({ ...prior, expectedVersion: prior.version, status: "superseded" });
      return this.memory.putArtifact({ kind: "engine_candidate", title: "程序构建候选", status: "candidate", content: jsonData({
        jobId, baseFoundationRef: job.content.baseFoundationRef, baseModelRef: job.content.baseModelRef, sourceVersions, foundation, concepts, relations, types, modelRelations, issues,
        coverage: datasets.map(d => { const c = d.content as unknown as DatasetContent; return { sourceId: c.sourceId, capability: c.capability, datasetId: d.id, snapshotId: c.activeVersion,
          sampledRows: c.coverage?.rows ?? c.profile?.rows ?? 0, totalRows: c.coverage?.total ?? null, complete: c.coverage?.complete ?? true, readAt: c.lastSync }; }),
        diff: { addedConcepts, preservedConcepts, addedMappings, preservedMappings, addedSupplements, addedRelations },
        discovery: { hash: o.hash, signature: o.signature, summary: o.summary, entities: o.entities, links: o.links, notes: o.notes, unplaced: o.unplaced },
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

  private virtualFoundation(content: CandidateContent): Artifact {
    const current = this.foundation.read().current;
    const keys = ["enterprise", "concepts", "relations", "evidence", "unknowns", "conflicts", "documentVersions", "profileRef"];
    if (current?.status === "adopted" && keys.every(key => equal(current.content[key] ?? null, content.foundation[key] ?? null))) return current;
    return { id: current?.id ?? "engine-new-foundation", version: (current?.version ?? 0) + 2, kind: "foundation", status: "adopted", title: "数据底座本体", createdAt: now(), content: content.foundation };
  }

  private async prepare(candidate: Artifact, assertActive: () => void = () => {}) {
    assertActive();
    const content = candidate.content as unknown as CandidateContent;
    this.assertInputs(content);
    if (content.issues.some(issue => issue.severity === "error")) throw new Error("候选包含来源或身份错误，请修复问题后重新构建");
    if (dataArray(content.foundation.conflicts).some(conflict => !conflict.resolvedBy)) throw new Error("现有工作版本存在未解决冲突，请通过助手修复后再采用");
    const foundation = this.virtualFoundation(content);
    const definition = await this.live.prepareDefinitionAgainst({ foundationRef: ref(foundation), baseModelRef: content.baseModelRef,
      purpose: "程序构建的数据底座", types: content.types, relations: content.modelRelations,
      rationale: "基于来源字段与实际样本生成；保留现有人工与 Agent 定义。未决关系未自动加入执行映射。",
    }, foundation, () => { assertActive(); this.assertInputs(content); });
    assertActive();
    this.assertInputs(content);
    return { foundation, definition };
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

  async adopt(args: unknown, assertActive: () => void = () => {}): Promise<{ status: "adopted"; candidate: Artifact; foundation: Artifact; model: Artifact }> {
    assertActive();
    const input = adoptInput.parse(args);
    const prior = this.memory.getArtifact(input.id), priorContent = prior.content as unknown as CandidateContent;
    if (prior.kind === "engine_candidate" && prior.status === "adopted" && priorContent.adoption?.operationId === input.operationId) {
      if (priorContent.adoption.inputVersion !== input.version) throw new Error("同一采用操作标识不能用于不同候选版本");
      return { status: "adopted", candidate: prior, foundation: this.memory.getArtifact(priorContent.adoption.foundationRef.id, priorContent.adoption.foundationRef.version), model: this.memory.getArtifact(priorContent.adoption.modelRef.id, priorContent.adoption.modelRef.version) };
    }
    const candidate = this.candidate({ id: input.id, version: input.version });
    if (candidate.status !== "checked" || !(candidate.content.checks as Data).valid) throw new Error("请先检查候选，再采用工作版本");
    const prepared = await this.prepare(candidate, assertActive), content = candidate.content as unknown as CandidateContent;
    return this.memory.atomic(() => {
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
      const saved = this.memory.putArtifact({ ...candidate, expectedVersion: candidate.version, status: "adopted", content: { ...candidate.content, adoption: jsonData({ operationId: input.operationId, inputVersion: input.version, foundationRef: ref(adopted), modelRef: ref(model) }) } });
      const job = this.memory.getArtifact(content.jobId);
      this.memory.putArtifact({ ...job, expectedVersion: job.version, content: { ...job.content, outcome: "adopted", candidateRef: jsonData(ref(saved)) } });
      return { status: "adopted" as const, candidate: saved, foundation: adopted!, model };
    });
  }
}

// API evidence uses the same byte-level SHA-256 contract as FoundationApi.
import { createHash } from "node:crypto";
const fingerprintRaw = (text: string) => createHash("sha256").update(text).digest("hex");

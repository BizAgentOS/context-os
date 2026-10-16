import type { Artifact, Data, WriteContext } from "./contracts.ts";
import type { MemoryStore } from "./memory.ts";
import type { AgentDriver } from "./runtime.ts";
import type { AgentCapabilities } from "../capabilities/service.ts";
import type { LiveMemory } from "../live/memory.ts";
import type { FoundationService } from "./foundation.ts";
import { ProgramBuilds } from "../engine/program-builds.ts";

const ref = (artifact: Artifact | null | undefined) => artifact ? {id: artifact.id, version: artifact.version} : null;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const recordCaps = (source: Artifact): Data[] => source.kind === "source" && source.content.format === "csv" ? [{name: "records"}]
  : ((source.content.capabilities ?? []) as Data[]).filter(cap => !cap.contentKind || cap.contentKind === "records");

/** Durable connection queue. KodaX assists later repairs; first construction is programmatic. */
export class AutomaticApi {
  private memory: MemoryStore;
  private foundation: FoundationService;
  private live: LiveMemory;
  private programBuilds: ProgramBuilds;

  constructor(memory: MemoryStore, foundation: FoundationService, live: LiveMemory, _capabilities: AgentCapabilities, programBuilds?: ProgramBuilds) {
    this.memory = memory; this.foundation = foundation; this.live = live;
    this.programBuilds = programBuilds ?? new ProgramBuilds(memory, foundation, live);
    for (const job of this.jobs().filter(item => item.status === "running")) this.update(job, "queued", {error: null, recovered: true});
  }
  private jobs() {return this.memory.listArtifacts("api_build");}
  private update(job: Artifact, status: string, extra: Data = {}) {
    const current = this.memory.getArtifact(job.id);
    return this.memory.putArtifact({...current, expectedVersion: current.version, status, content: {...current.content, ...extra}});
  }
  /** `trigger` names new data for an unchanged source (a sync or accepted schema change), so it rebuilds once more. */
  enqueue(source: Artifact, trigger?: string) {
    if (!["source_connection", "source"].includes(source.kind) || source.status !== "ready" || source.content.localSource || !recordCaps(source).length) return;
    if (this.jobs().some(job => job.content.sourceId === source.id && job.content.sourceVersion === source.version && (job.content.trigger ?? null) === (trigger ?? null))) return;
    this.memory.putArtifact({kind: "api_build", title: source.title, status: "queued", content: {sourceId: source.id, sourceVersion: source.version, attempts: 0, ...(trigger ? {trigger} : {})}});
  }
  enqueueUpload(source: Artifact) { if (source.kind === "source" && source.content.format === "csv") this.enqueue(source); }
  retry() {for (const job of this.jobs().filter(item => item.status === "failed")) this.update(job, "queued", {error: null});}
  pending() {
    for (const job of this.jobs()) {
      const source = this.memory.getArtifact(String(job.content.sourceId));
      if ((source.status !== "ready" || source.version !== job.content.sourceVersion) && job.status !== "superseded") this.update(job, "superseded");
    }
    const pending = this.jobs().filter(job => job.status === "queued").at(-1);
    if (pending) return pending;
    // A document/Agent may have changed definitions. Rebind one full preserved
    // execution model, not every source in turn (which would create a loop).
    const foundationRef = ref(this.foundation.read().adopted);
    const model = this.live.overview().models.find(item => item.status === "adopted");
    if (foundationRef && model && !same(model.content.foundationRef, foundationRef)) {
      const completed = this.jobs().find(job => job.status === "completed");
      if (completed) return this.update(completed, "queued", {error: null, rebindOnly: true});
    }
    return undefined;
  }
  view(_configured: boolean) {
    const jobs = this.jobs().filter(job => {
      const source = this.memory.getArtifact(String(job.content.sourceId));
      return source.status === "ready" && source.version === job.content.sourceVersion && job.status !== "superseded";
    });
    const running = jobs.filter(job => job.status === "running").length, queued = jobs.filter(job => job.status === "queued").length;
    const failed = jobs.filter(job => job.status === "failed");
    return {status: running ? "running" : queued ? "queued" : failed.length ? "failed" : jobs.length ? "completed" : "idle",
      total: jobs.length, completed: jobs.filter(job => job.status === "completed").length, pending: running + queued,
      errors: failed.map(job => ({title: job.title, message: String(job.content.error)}))};
  }

  async run(job: Artifact, context: WriteContext, _driver: AgentDriver, safeError: (error: unknown) => string) {
    let failure: string | undefined;
    const source = this.memory.getArtifact(String(job.content.sourceId), Number(job.content.sourceVersion));
    const caps = recordCaps(source);
    const assertCurrent = () => {
      this.memory.assertWritable(context);
      const current = this.memory.getArtifact(source.id);
      if (current.status !== "ready" || current.version !== source.version) throw new Error("来源版本或授权已变化，请重新构建");
      if (source.kind === "source_connection") for (const cap of caps) this.live.sources.capability(source.id, String(cap.name), source.version);
    };
    try {
      assertCurrent();
      const attempts = Number(job.content.attempts ?? 0) + 1;
      this.update(job, "running", {attempts, error: null});
      await this.programBuilds.idle();
      assertCurrent();
      const run = await this.programBuilds.build({operationId: `api:${job.id}:${attempts}`, sourceIds: [source.id], autoAdopt: true}, assertCurrent);
      assertCurrent();
      this.update(job, "running", {engineJobRef: ref(run)});
      if (run.status !== "completed" || run.content.outcome !== "adopted") {
        const candidateRef = run.content.candidateRef as Data | undefined;
        const candidate = candidateRef ? this.memory.getArtifact(String(candidateRef.id), Number(candidateRef.version)) : undefined;
        const checks = candidate?.content.checks as Data | undefined;
        const issues = (run.content.issues ?? []) as Data[];
        const pendingReview = issues.find(issue => issue.code === "pending_foundation_review");
        throw new Error(String(pendingReview?.message ?? checks?.description ?? issues.find(issue => issue.severity === "error")?.message ?? issues[0]?.message ?? "来源当前没有可验证记录，未采用执行映射"));
      }
      const candidateRef = run.content.candidateRef as Data;
      const candidate = this.memory.getArtifact(String(candidateRef.id), Number(candidateRef.version));
      const adoption = candidate.content.adoption as Data;
      const modelRef = adoption.modelRef as Data, foundationRef = adoption.foundationRef as Data;
      const model = this.memory.getArtifact(String(modelRef.id), Number(modelRef.version));
      const foundation = this.memory.getArtifact(String(foundationRef.id), Number(foundationRef.version));
      const bindings = (model.content.types as Data[]).flatMap(type => [type, ...((type.supplements ?? []) as Data[])]);
      const boundSource = (binding: Data) => source.kind === "source_connection" ? binding.sourceId === source.id
        : (this.memory.getArtifact(String(binding.sourceId)).content.localSource as Data | undefined)?.id === source.id;
      if (caps.some(cap => !bindings.some(binding => boundSource(binding) && binding.capability === cap.name))) throw new Error("当前连接仍有记录能力未映射，不能报告全部生效");
      assertCurrent();
      this.memory.atomic(() => {
        assertCurrent();
        this.memory.attachArtifact(context.taskId, foundation); this.memory.attachArtifact(context.taskId, model);
        this.update(job, "completed", {engineJobRef: ref(run), candidateRef: ref(candidate), modelRef: ref(model), foundationRef: ref(foundation), capabilities: caps.map(cap => String(cap.name))});
        const message = `「${source.title}」已完成程序构建，${caps.length} 个记录能力已映射并可查询。待核对的业务含义与关系可在本体页交给助手修复。`;
        this.memory.addMessage(context.taskId, "assistant", message); this.memory.complete(context, [foundation.id, model.id], message);
      });
    } catch (error) {
      failure = safeError(error);
      this.update(job, "failed", {error: failure, foundationRef: ref(this.foundation.read().adopted)});
    } finally {this.memory.endExecution(context, failure);}
  }
}

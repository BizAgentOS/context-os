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
  private covers(model: Artifact, source: Artifact) {
    const bindings = (model.content.types as Data[]).flatMap(type => [type, ...((type.supplements ?? []) as Data[])]);
    const mapped = (binding: Data) => source.kind === "source_connection" ? binding.sourceId === source.id
      : (this.memory.getArtifact(String(binding.sourceId)).content.localSource as Data | undefined)?.id === source.id;
    return recordCaps(source).every(cap => bindings.some(binding => mapped(binding) && binding.capability === cap.name));
  }
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
  retry() {
    let rebindQueued = false;
    for (const job of this.jobs().filter(item => item.status === "failed")) {
      const source = this.memory.getArtifact(String(job.content.sourceId));
      if (source.status !== "ready" || source.version !== job.content.sourceVersion) { this.update(job, "superseded"); continue; }
      // One complete-model rebind recovers every source it still covers.
      if (job.content.rebindOnly && rebindQueued) continue;
      if (job.content.rebindOnly) rebindQueued = true;
      this.update(job, "queued", {error: null, rebindAttempt: null});
    }
  }
  /** Stable semantic IDs decouple wording revisions from source bindings. Compare
   * the complete foundation, including concepts which have no executable binding. */
  private bindingsStillCurrent(model: Artifact, foundation: Artifact) {
    if (!model.content.layered || !model.content.foundationRef || this.foundation.read().current?.status !== "adopted") return false;
    const foundationRef = model.content.foundationRef as Data;
    const topology = (artifact: Artifact) => ({
      concepts: (artifact.content.concepts as Data[]).map(item => String(item.id)).sort(),
      relations: (artifact.content.relations as Data[]).map(item => ({id: item.id, from: item.from, to: item.to}))
        .sort((a,b) => String(a.id).localeCompare(String(b.id))),
    });
    try {
      const previous = this.memory.getArtifact(String(foundationRef.id), Number(foundationRef.version));
      if (!same(topology(previous), topology(foundation))) return false;
      // This also checks all current source contracts; topology alone cannot
      // excuse a disabled, replaced or otherwise invalid execution binding.
      this.live.assertModel(model.id, model.version);
      return true;
    } catch { return false; }
  }
  pending() {
    for (const job of this.jobs()) {
      const source = this.memory.getArtifact(String(job.content.sourceId));
      if ((source.status !== "ready" || source.version !== job.content.sourceVersion) && job.status !== "superseded") this.update(job, "superseded");
    }
    const pending = this.jobs().filter(job => job.status === "queued").at(-1);
    if (pending) return pending;
    // A document/Agent may have changed definitions. Rebind one full preserved
    // execution model, not every source in turn (which would create a loop).
    const adoptedFoundation = this.foundation.read().adopted;
    const foundationRef = ref(adoptedFoundation);
    const model = this.memory.listArtifacts("live_ontology").find(item => item.status === "adopted");
    if (foundationRef && model && !same(model.content.foundationRef, foundationRef)) {
      if (adoptedFoundation && this.bindingsStillCurrent(model, adoptedFoundation)) return undefined;
      const baseline = { foundationRef, modelRef: ref(model) };
      if (this.jobs().some(job => job.status === "failed" && job.content.rebindOnly && same(job.content.rebindAttempt, baseline))) return undefined;
      const completed = this.jobs().find(job => job.status === "completed" && this.covers(model, this.memory.getArtifact(String(job.content.sourceId))));
      if (completed) return this.update(completed, "queued", {error: null, rebindOnly: true});
    }
    return undefined;
  }

  /** Follow an already adopted semantic revision without discovering or changing data structure. */
  private async rebind(context: WriteContext, operationId: string, assertCurrent: () => void) {
    const foundation = this.foundation.read().adopted;
    const model = this.memory.listArtifacts("live_ontology").find(item => item.status === "adopted");
    if (!foundation || !model || !model.content.foundationRef) throw new Error("没有可重新绑定的已采用本体与执行映射");
    const priorRef = model.content.foundationRef as Data;
    const prior = this.memory.getArtifact(String(priorRef.id), Number(priorRef.version));
    const shape = (artifact: Artifact) => ({ enterprise: (artifact.content.enterprise as Data).name,
      concepts: (artifact.content.concepts as Data[]).map(item => ({ id: item.id, origin: item.origin, programSource: item.programSource })).sort((a,b) => String(a.id).localeCompare(String(b.id))),
      relations: (artifact.content.relations as Data[]).map(item => ({ id: item.id, from: item.from, to: item.to })).sort((a,b) => String(a.id).localeCompare(String(b.id))) });
    if (!same(shape(prior), shape(foundation))) throw new Error("基础本体的企业身份或结构已变化，需要按数据重新构建；不能自动重绑旧映射");
    for (const conflict of foundation.content.conflicts as Data[]) {
      if (conflict.resolvedBy || !conflict.retained || !conflict.proposed) continue;
      const before = conflict.retained as Data, after = conflict.proposed as Data;
      if (["id", "from", "to", "programSource"].some(key => !same(before[key] ?? null, after[key] ?? null)))
        throw new Error("未解决冲突涉及本体结构，需要先核对；不能自动重新绑定");
    }
    let ownCandidate: string | undefined;
    const assertValid = () => {
      assertCurrent();
      if (!same(ref(this.foundation.read().current), ref(foundation)) || this.foundation.read().current?.status !== "adopted" ||
          !same(ref(this.live.overview().models.find(item => item.status === "adopted")), ref(model))) throw new Error("本体或执行映射已变化，请重新绑定");
      if (this.live.overview().models.some(item => item.status === "candidate" && item.id !== ownCandidate && item.canAdopt))
        throw new Error("已有待采用的执行映射，请先处理该候选；自动重绑不会覆盖它");
      for (const type of model.content.types as Data[]) for (const binding of [type, ...((type.supplements ?? []) as Data[])])
        this.live.sources.capability(String(binding.sourceId), String(binding.capability), Number((model.content.connections as Data)[String(binding.sourceId)]));
    };
    assertValid();
    if (same(model.content.foundationRef, ref(foundation))) return { foundation, model };
    const concepts = foundation.content.concepts as Data[], relations = foundation.content.relations as Data[];
    const types = (model.content.types as Data[]).map(type => {
      const concept = concepts.find(item => item.id === type.conceptId)!;
      return { ...type, name: concept.name, description: concept.description };
    });
    const mappedRelations = (model.content.relations as Data[]).map(relation => {
      const semantic = relations.find(item => item.id === relation.relationId)!;
      return { ...relation, name: semantic.name, from: concepts.find(item => item.id === semantic.from)!.name, to: concepts.find(item => item.id === semantic.to)!.name };
    });
    const candidate = await this.live.propose({ foundationRef: ref(foundation), baseModelRef: ref(model), purpose: model.content.purpose,
      types, relations: mappedRelations, rationale: "沿已采用本体重新核对原执行映射；保留业务冲突，不更改身份、来源、字段或关联键。" }, context, operationId, assertValid);
    ownCandidate = candidate.id;
    try {
      assertValid();
      const adopted = await this.live.adopt(candidate.id, candidate.version, save => this.memory.atomic(() => { assertValid(); return save(); }));
      return { foundation, model: adopted };
    } catch (error) {
      const pending = this.memory.getArtifact(candidate.id);
      if (pending.status === "candidate" && pending.version === candidate.version)
        this.memory.putArtifact({ ...pending, expectedVersion: pending.version, status: "discarded" });
      throw error;
    }
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
      this.update(job, "running", {attempts, error: null, ...(job.content.rebindOnly ? { rebindAttempt: { foundationRef: ref(this.foundation.read().adopted), modelRef: ref(this.live.overview().models.find(item => item.status === "adopted")) } } : {})});
      await this.programBuilds.idle();
      assertCurrent();
      if (job.content.rebindOnly) {
        const currentModel = this.live.overview().models.find(item => item.status === "adopted");
        if (!currentModel || !this.covers(currentModel, source)) throw new Error("当前连接仍有记录能力未映射，不能通过重新绑定报告全部生效");
        const rebound = await this.rebind(context, `rebind:${job.id}:${attempts}`, assertCurrent);
        assertCurrent();
        this.memory.atomic(() => {
          assertCurrent();
          if (!this.covers(rebound.model, source)) throw new Error("当前连接仍有记录能力未映射，不能报告全部生效");
          for (const prior of this.jobs().filter(item => item.id === job.id || (item.content.rebindOnly && ["failed", "queued"].includes(item.status)))) {
            const input = this.memory.getArtifact(String(prior.content.sourceId));
            if (input.status === "ready" && input.version === prior.content.sourceVersion && this.covers(rebound.model, input))
              this.update(prior, "completed", {error: null, rebindOnly: false, rebindAttempt: null, modelRef: ref(rebound.model), foundationRef: ref(rebound.foundation)});
          }
          this.memory.attachArtifact(context.taskId, rebound.foundation); this.memory.attachArtifact(context.taskId, rebound.model);
          const message = "已按当前本体重新校验并绑定原有执行映射；未解决的业务冲突继续保留。";
          this.memory.addMessage(context.taskId, "assistant", message); this.memory.complete(context, [rebound.foundation.id, rebound.model.id], message);
        });
        return;
      }
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

import type { Sql } from './database.ts';
import { StructuredCompiler, STRUCTURED_POLICY } from './structured-compiler.ts';
import { reusableMapping, verifyReusableMapping } from './mapping-reuse.ts';
import { DecisionPackages } from './decision-packages.ts';
import { loadSavedDiscovery } from './saved-discovery.ts';
import { discoveryInput, discoveryCandidateSchema, validateDiscovery, discoveryReviewIssues, type TableDecision, DiscoveryEvidenceError } from './discovery.ts';
import { getLogger } from '../observability/logger.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authorize, extractionSchema, mappingSchema, ontologySchema, type Principal } from './contracts.ts';
import { KnowledgeCore } from './service.ts';
import { fingerprint, locateEvidence, mapCsv, type SourceContent } from './sources.ts';
import type { JsonModel, ModelDiagnostic } from './model.ts';
import { BuildPlans } from './build-plans.ts';
import { planProposalSchema, sourceVersionIdsSchema } from './build-contracts.ts';
export const PROMPT_VERSION = 'knowledge-native-sources-v12-source-outcomes';
function numericUsage(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value).flatMap<[string, unknown]>(([key, v]) => {
    if (!/^[A-Za-z_]+$/.test(key)) return [];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return [[key, v]];
    const nested = numericUsage(v);
    return nested ? [[key, nested]] : [];
  });
  return entries.length ? Object.fromEntries(entries) : null;
}

const jobInput = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('reuse'),operationId:z.string().min(1).max(160),sourceVersionIds:sourceVersionIdsSchema}).strict(),
  z.object({kind:z.literal('collect'),operationId:z.string().min(1).max(160),packageId:z.string().uuid()}).strict(),
  z.object({ kind:z.literal('observe'), operationId:z.string().min(1).max(160), connectionId:z.string().uuid(), construct:z.boolean().default(false), maxRows:z.number().int().min(1).max(100000).default(10000) }).strict(),
  z.object({ kind: z.literal('discover'), operationId: z.string().min(1).max(160), sourceVersionIds: sourceVersionIdsSchema, baseOntologyId: z.string().uuid().optional(), baseRevision: z.number().int().positive().optional(), revalidateFromJobId: z.string().uuid().optional(), collectDecisions: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal('extract'), operationId: z.string().min(1).max(160), sourceVersionId: z.string().uuid(), ontologyId: z.string().uuid(), mapping: mappingSchema.optional() }).strict(),
  z.object({ kind: z.literal('plan'), operationId: z.string().min(1).max(160), sourceVersionIds: sourceVersionIdsSchema, ontologyId: z.string().uuid(), expectedRevision: z.number().int().positive(), basePlanId: z.string().uuid().optional(), autoBuild: z.boolean().default(false), collectDecisions: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal('build'), operationId: z.string().min(1).max(160), planId: z.string().uuid(), preflight: z.boolean().default(false) }).strict(),
]);
export class KnowledgeJobs {
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private stopping = false;
  private core: KnowledgeCore;
  private model?: JsonModel;
  observe?: (actor:Principal,id:string,operationId:string,maxRows:number)=>Promise<{sourceVersionIds:string[];changed:boolean}>;
  constructor(core: KnowledgeCore, model?: JsonModel) { this.core = core; this.model = model; }
  async enqueue(actor: Principal, raw: unknown) {
    authorize(actor, true); const input = jobInput.parse(raw);
    if (input.kind === 'extract' && input.mapping) {
      const source = await this.core.sourceVersion(actor, input.sourceVersionId);
      const namespace = `source.${source.source_id}`;
      if (input.mapping.namespace !== namespace || input.mapping.links.some(l => l.targetNamespace !== namespace)) throw new Error('直接映射只能使用该来源的身份空间；跨源构建请生成并审核构建计划');
    }
    if (input.kind === 'plan' && input.autoBuild) await this.core.ontology(actor, input.ontologyId, true);
    return this.core.db.transaction(sql => this.enqueueIn(sql, actor, input));
  }
  private async enqueueIn(sql: Sql, actor: Principal, raw: unknown) {
    const input = jobInput.parse(raw);
    const modelId = needsModel(input) ? this.model?.identity ?? null : null;
    const modelPolicy = needsModel(input) ? this.model?.executionPolicy ?? null : null;
    const hash = fingerprint({ actor: actor.id, input, model: modelId, modelPolicy, prompt: PROMPT_VERSION });
    const prior = (await sql.query('SELECT * FROM knowledge.jobs WHERE operation_id=$1', [input.operationId])).rows[0];
    if (prior) { if (prior.fingerprint !== hash) throw new Error('任务 operationId 输入不一致'); return prior; }
    return (await sql.query('INSERT INTO knowledge.jobs(id,operation_id,fingerprint,kind,actor_id,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *', [randomUUID(), input.operationId, hash, input.kind, actor.id, JSON.stringify({ input, modelId, modelPolicy, promptVersion: PROMPT_VERSION })])).rows[0];
  }
  async retry(actor: Principal, id: string) {
    authorize(actor, true); z.string().uuid().parse(id);
    return this.core.db.transaction(async sql => {
      const previous = (await sql.query('SELECT payload FROM knowledge.jobs WHERE id=$1', [id])).rows[0];
      const input = previous ? jobInput.parse(previous.payload.input) : null;
      if (previous && (previous.payload.promptVersion !== PROMPT_VERSION || input && needsModel(input) && (previous.payload.modelId !== (this.model?.identity ?? null) || fingerprint(previous.payload.modelPolicy ?? null) !== fingerprint(this.model?.executionPolicy ?? null)))) throw new Error('模型、超时预算或提示配置已变化；请以当前配置新建任务，旧任务保留原始输入');
      const row = (await sql.query("UPDATE knowledge.jobs SET state='queued',error=NULL,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND (state='failed' OR state='running' AND lease_until<clock_timestamp()) RETURNING *", [id])).rows[0];
      if (!row) throw new Error('任务尚在运行或已完成');
      await sql.query("UPDATE knowledge.job_attempts SET outcome='interrupted',metrics=metrics || jsonb_build_object('interruptedAt',clock_timestamp(),'usageUnknown',true) WHERE job_id=$1 AND outcome='running'", [id]);
      return row;
    });
  }
  async recreate(actor: Principal, id: string) {
    authorize(actor, true); z.string().uuid().parse(id);
    const old = (await this.core.db.pool.query('SELECT payload FROM knowledge.jobs WHERE id=$1', [id])).rows[0];
    if (!old) throw new Error('原任务不存在');
    return this.enqueue(actor, { ...old.payload.input, operationId: randomUUID() });
  }
  async revalidate(actor: Principal, id: string) {
    authorize(actor, true); z.string().uuid().parse(id);
    const old = (await this.core.db.pool.query('SELECT * FROM knowledge.jobs WHERE id=$1', [id])).rows[0];
    if (!old || old.kind !== 'discover' || old.state !== 'failed') throw new Error('仅失败的本体发现任务可复用结果校验');
    const input = jobInput.parse(old.payload.input);
    if (input.kind !== 'discover' || input.revalidateFromJobId) throw new Error('请对原始模型任务复用校验，或直接重试已有的本地校验任务');
    if (old.metrics?.events?.some((e: ModelDiagnostic) => e.kind==='analysis.staged')) throw new Error('该任务已按步骤保存候选，请按原配置重试以复用已完成步骤，不使用旧整包恢复入口');
    if (!old.metrics?.events?.some((e: ModelDiagnostic) => e.traceId)) throw new Error('原任务未保存可恢复的追踪，不能复用；不会自动调用模型');
    return this.enqueue(actor, { ...input, operationId: `revalidate:${fingerprint({ id, actor: actor.id, prompt: PROMPT_VERSION }).slice(0, 40)}`, revalidateFromJobId: id });
  }
  start() {
    if (this.timer || this.active) return;
    this.stopping = false;
    const tick = () => {
      if (this.stopping) return;
      this.active = this.once().catch(error => { getLogger().error('worker.infrastructure_failed', { component: 'knowledge.worker', ...workerFailureDetails(error) }); }).finally(() => {
        this.active = undefined;
        if (!this.stopping) this.timer = setTimeout(() => { this.timer = undefined; tick(); }, 1500);
      });
    };
    tick();
  }
  async close() {
    this.stopping = true; if (this.timer) clearTimeout(this.timer);
    await this.active; await this.model?.close();
  }
  async once() {
    const job = await this.core.db.transaction(async sql => {
      // Expired work requires explicit retry, avoiding repeated paid model calls after a crash.
      await sql.query("UPDATE knowledge.job_attempts SET outcome='interrupted',metrics=metrics || jsonb_build_object('interruptedAt',clock_timestamp(),'usageUnknown',true) WHERE outcome='running' AND id IN (SELECT lease_token FROM knowledge.jobs WHERE state='running' AND lease_until<clock_timestamp())");
      await sql.query("UPDATE knowledge.jobs SET state='failed',error='任务租约失效，请确认后重试',lease_token=NULL WHERE state='running' AND lease_until<clock_timestamp()");
      const pending = (await sql.query("SELECT * FROM knowledge.jobs WHERE state='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
      if (!pending) return null;
      const row = (await sql.query("UPDATE knowledge.jobs SET state='running',attempts=attempts+1,lease_token=$2,lease_until=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() WHERE id=$1 RETURNING *", [pending.id, randomUUID()])).rows[0];
      await sql.query("INSERT INTO knowledge.job_attempts(id,job_id,attempt,outcome,metrics) VALUES($1,$2,$3,'running',jsonb_build_object('startedAt',clock_timestamp()))", [row.lease_token, row.id, row.attempts]);
      return row;
    });
    if (!job) return;
    const started = performance.now();
    const events: ModelDiagnostic[] = [];
    let failure: string | undefined;
    const record = (event: ModelDiagnostic) => {
      event = { elapsedMs: Math.round(performance.now() - started), ...event };
      if (events.length < 200) events.push(event);
      getLogger().log(event.kind === 'job.failed' || event.kind === 'run.timed_out' ? 'error' : event.kind === 'submission.rejected' ? 'warn' : 'info', event.kind, { component: 'knowledge.job', jobId: job.id, attempt: job.attempts, ...event });
    };
    record({ at: new Date().toISOString(), kind: 'job.started' });
    if (this.model) { this.model.onDiagnostic = record; this.model.diagnosticContext = { jobId: job.id, attempt: job.attempts }; }
    const startedAt = new Date().toISOString();
    let modelCalled = false, inputBytes: number | null = null;
    const modelCalls:Array<Record<string,unknown>>=[];
    const metrics = () => ({ attempt: job.attempts, startedAt, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started), inputBytes, modelCalled, modelCalls, runId: modelCalled ? events.find(e => e.kind === 'run.started')?.runId ?? this.model?.lastRun?.runId ?? null : null, modelPolicy: job.payload.modelPolicy ?? null, usage: modelCalls.length ? null : modelCalled ? numericUsage(this.model?.lastRun?.usage) : null, cost: null, error: failure, events });
    const lease = { id: job.id as string, leaseToken: job.lease_token as string };
    const compiler=()=>new StructuredCompiler({core:this.core,job:lease,policy:{model:job.payload.modelId,budget:job.payload.modelPolicy,prompt:PROMPT_VERSION},
      cached:stage=>record({at:new Date().toISOString(),kind:'analysis.cached',status:stage}),
      generate:async(stage,task,value,schema)=>{
        if(!this.model)throw new Error('该分析阶段需要模型，当前尚未配置');
        inputBytes=(inputBytes??0)+Buffer.byteLength(JSON.stringify(value));modelCalled=true;this.model.lastRun=undefined;
        record({at:new Date().toISOString(),kind:'analysis.stage_started',status:stage});
        const call:Record<string,unknown>={stage,task,state:'running'};modelCalls.push(call);
        const outcome=()=> (this.model as JsonModel).lastRun;
        try{const output=await this.model.generate(task,value,schema);Object.assign(call,{state:'completed',runId:outcome()?.runId??null,usage:numericUsage(outcome()?.usage)});return output;}
        catch(error){Object.assign(call,{state:'failed',runId:outcome()?.runId??null,usage:numericUsage(outcome()?.usage)});throw error;}
      }});
    const heartbeat = setInterval(() => { void this.core.db.pool.query("UPDATE knowledge.jobs SET lease_until=clock_timestamp()+interval '5 minutes',metrics=$3::jsonb WHERE id=$1 AND lease_token=$2 AND state='running'", [lease.id, lease.leaseToken, JSON.stringify({ ...metrics(), finishedAt: null })]).catch(() => {}); }, 30000);
    try {
      const actor: Principal = { id: job.actor_id, role: 'editor' };
      const input = jobInput.parse(job.payload.input);
      if (job.payload.promptVersion !== PROMPT_VERSION) throw new Error('任务提示版本已变化，请创建新任务');
      if (needsModel(input) && job.payload.modelId !== (this.model?.identity ?? null)) throw new Error('模型配置已变化，请新建任务而非复用原任务');
      if (needsModel(input) && fingerprint(job.payload.modelPolicy ?? null) !== fingerprint(this.model?.executionPolicy ?? null)) throw new Error('模型运行预算已变化，请以当前配置新建任务');
      let result: unknown;
      record({ at: new Date().toISOString(), kind: 'sources.reading' });
      if (input.kind === 'reuse') {
        const template=await reusableMapping(this.core,actor,input.sourceVersionIds);
        if(template){
          const plan=await new BuildPlans(this.core).create(actor,template.ontologyId,input.sourceVersionIds,template.proposal,
            {structuredPolicy:STRUCTURED_POLICY,reusedFromPlanId:template.priorPlanId,templateHash:template.templateHash,jobId:job.id,model:null,prompt:PROMPT_VERSION},lease,template.ontologyRevision,undefined,async(sql,row)=>{
              await verifyReusableMapping(sql,template);
              row.review=template.review;
              await sql.query('UPDATE knowledge.build_plans SET review=$2::jsonb WHERE id=$1',[row.id,JSON.stringify(template.review)]);
              row.decisionPackageId=await new DecisionPackages(this.core).insertIn(sql,actor,row,'preparing');
              await this.enqueueIn(sql,actor,{kind:'collect',operationId:`package:${row.decisionPackageId}:collect`,packageId:row.decisionPackageId});
            });
          result={planId:plan.id,decisionPackageId:plan.decisionPackageId,stage:'queued_collection',reusedFromPlanId:template.priorPlanId,modelCalled:false};
        }else{
          const baseline=(await this.core.db.pool.query("SELECT id,revision FROM knowledge.ontologies WHERE status='published' ORDER BY published_at DESC LIMIT 1")).rows[0];
          const next=await this.enqueue(actor,{kind:'discover',operationId:`reuse:${job.id}:discover`,sourceVersionIds:input.sourceVersionIds,...(baseline?{baseOntologyId:baseline.id,baseRevision:baseline.revision}:{}),collectDecisions:true});
          result={stage:'queued_discovery',nextJobId:next.id,modelCalled:false,reason:'不存在同范围、同结构、同已发布本体且已构建的兼容映射'};
        }
      } else if (input.kind === 'collect') {
        const packages = new DecisionPackages(this.core), pack = await packages.get(actor,input.packageId);
        const prepared = ['superseded','archived'].includes(pack.state) ? pack : await packages.refresh(actor,pack.id,pack.revision);
        if(['superseded','archived'].includes(prepared.state)) result={decisionPackageId:prepared.id,stage:prepared.state,modelCalled:false};
        else if(prepared.summary.ontologyStatus==='published' && prepared.summary.planStatus==='approved' && !prepared.summary.systemErrors.length) {
          const built=await packages.submit(actor,prepared.id,{expectedRevision:prepared.revision,candidateHash:prepared.summary.candidateHash});
          result={decisionPackageId:built.id,stage:built.state,modelCalled:false};
        } else result = {decisionPackageId:prepared.id,stage:'awaiting_decision',modelCalled:false};
      } else if (input.kind === 'observe') {
        if (!this.observe) throw new Error('来源接入处理器未配置');
        const captured = await this.observe(actor,input.connectionId,input.operationId,input.maxRows);
        const next = input.construct && captured.changed && captured.sourceVersionIds.length ? await this.enqueue(actor,{kind:'reuse',operationId:`observation:${job.id}:reuse`,sourceVersionIds:captured.sourceVersionIds}) : null;
        result = {...captured,nextJobId:next?.id??null,stage:next?'queued_mapping_check':'observed',modelCalled:false};
      } else if (input.kind === 'discover') {
        if (!this.model && !input.revalidateFromJobId) throw new Error('尚未配置模型，不能自动生成候选本体');
        const sources = await Promise.all(input.sourceVersionIds.map(id => this.core.sourceVersion(actor, id, 10)));
        const samples = sources.map(s => {
          const content = s.content as SourceContent;
          if (content.kind !== 'pdf') return { id: s.id, sourceNamespace: `source.${s.source_id}`, ...content, nativeValues: content.kind === 'table' ? Object.fromEntries((content.rows ?? []).slice(0,10).map(row => [row[content.keyColumn!],content.nativeValues![row[content.keyColumn!]]])) : undefined, rows: content.rows?.slice(0, 10), coverage: { sampled: Math.min(10, content.rows?.length ?? 0), total: content.rowCount ?? content.rows?.length ?? 0 } };
          return { ...content, id: s.id, sourceNamespace: `source.${s.source_id}`, kind: content.kind, text: content.text?.slice(0, 16000), coverage: { characters: Math.min(16000, content.text?.length ?? 0), total: content.text?.length ?? 0 } };
        });
        const native=samples.every(s=>s.kind==='table')&&!input.revalidateFromJobId;
        if (!native && Buffer.byteLength(JSON.stringify(samples)) > 100000) throw new Error('本体样本超过单次预算，请减少来源');
        const base = input.baseOntologyId ? await this.core.ontology(actor, input.baseOntologyId) : null;
        if (base && base.revision !== input.baseRevision) throw new Error('基础草稿已变化，请重新选择');
        const prepared = native ? null : discoveryInput(samples, base?.definition ?? null);
        const modelInput = prepared?.input;
        inputBytes = native ? 0 : Buffer.byteLength(JSON.stringify(modelInput));
        if (inputBytes > 180000) throw new Error('发现证据目录超过输入预算，请减少来源');
        let raw: unknown, recoveredTraceId: string | undefined, recoveredModelId: string | null = null, catalog=prepared?.catalog??[];
        let tableDecisions:TableDecision[]=[],tableProposals:unknown[]=[];
        if(native){
          record({at:new Date().toISOString(),kind:'analysis.staged'});
          const staged=await compiler().discover(samples,base?.definition??null);raw=staged.raw;catalog=staged.catalog;tableDecisions=staged.tableDecisions;tableProposals=staged.tableProposals;
        } else if (input.revalidateFromJobId) {
          const old = (await this.core.db.pool.query('SELECT * FROM knowledge.jobs WHERE id=$1', [input.revalidateFromJobId])).rows[0];
          if (!old || old.kind !== 'discover' || old.state !== 'failed') throw new Error('原始失败任务不可用');
          const oldInput = jobInput.parse(old.payload.input);
          if (oldInput.kind !== 'discover' || fingerprint({ sources: oldInput.sourceVersionIds, base: oldInput.baseOntologyId, revision: oldInput.baseRevision }) !== fingerprint({ sources: input.sourceVersionIds, base: input.baseOntologyId, revision: input.baseRevision })) throw new Error('不能修改复用校验的原始来源或本体输入');
          const traceId = old.metrics?.events?.find((e: ModelDiagnostic) => e.traceId)?.traceId;
          if (!traceId) throw new Error('没有保存的候选追踪，不会调用模型');
          recoveredTraceId = traceId; recoveredModelId = old.payload.modelId ?? null;
          record({ at: new Date().toISOString(), kind: 'ontology.saved_candidate_revalidating', traceId });
          raw = await loadSavedDiscovery(process.env.CONTEXT_OS_KNOWLEDGE_MODEL_TRACE_DIRECTORY ?? 'local-state/model-traces', traceId, old.id, modelInput);
        } else {
          modelCalled = true; this.model!.lastRun = undefined;
          raw = await this.model!.generate('discover', modelInput, discoveryCandidateSchema);
        }
        record({ at: new Date().toISOString(), kind: 'ontology.evidence_validating' });
        const {definition:output,validation:validated}=validateDiscovery(raw,samples,catalog,base?.definition??null);
        const validation={...validated,tableDecisions,tableProposals};
        validation.issues=discoveryReviewIssues(output,validation.uncertainties,base?.definition??null,tableDecisions);
        validation.reviewRequired=validation.issues.length>0;
        const memberIds = (definition: typeof output) => [...definition.types, ...definition.types.flatMap(t => t.properties), ...definition.links].map(m => m.id);
        const oldIds = base ? memberIds(base.definition) : [], newIds = memberIds(output);
        const members = (definition: typeof output) => [...definition.types, ...definition.types.flatMap(t => t.properties), ...definition.links];
        const oldMembers = new Map(base ? members(base.definition).map(m => [m.id, fingerprint(m)]) : []);
        if (base && (await this.core.ontology(actor, base.id)).revision !== base.revision) throw new Error('基础草稿在模型运行期间已变化，请重新生成');
        if (input.revalidateFromJobId) for (const source of sources) {
          const current = (await this.core.db.pool.query('SELECT COALESCE(observed_version,active_version) AS active_version FROM knowledge.sources WHERE id=$1', [source.source_id])).rows[0];
          if (current?.active_version !== source.id) throw new Error('来源已有新版本，不能将旧候选恢复成当前版本；未调用模型');
        }
        record({ at: new Date().toISOString(), kind: 'ontology.persisting' });
        result = await this.core.draft(actor, output, undefined, lease, { validation, recoveredTraceId: recoveredTraceId ?? null, recoveredModelId, recoveredFromJobId: input.revalidateFromJobId ?? null, jobId: job.id, model: job.payload.modelId, prompt: PROMPT_VERSION, baseOntologyId: base?.id ?? null, baseRevision: base?.revision ?? null, sources: samples.map((s, index) => ({ id: s.id, sourceId: sources[index].source_id, hash: sources[index].content_hash, kind: s.kind, coverage: s.coverage })), changes: { added: newIds.filter(id => !oldIds.includes(id)), removed: oldIds.filter(id => !newIds.includes(id)), modified: members(output).filter(m => oldMembers.has(m.id) && oldMembers.get(m.id) !== fingerprint(m)).map(m => m.id) } }, undefined, input.collectDecisions ? async (sql, generated) => {
          const next = await this.enqueueIn(sql,actor,{kind:'plan',operationId:`discovery:${job.id}:plan`,ontologyId:generated.id,expectedRevision:generated.revision,sourceVersionIds:input.sourceVersionIds,collectDecisions:true});
          generated.nextJobId = next.id;
        } : undefined);
      } else if (input.kind === 'plan') {
        if (!this.model) throw new Error('尚未配置模型，不能生成构建计划');
        const ontology = await this.core.ontology(actor, input.ontologyId);
        if (ontology.revision !== input.expectedRevision) throw new Error('本体修订已变化，请重新选择');
        const sources = await Promise.all(input.sourceVersionIds.map(id => this.core.sourceVersion(actor, id, 10)));
        const samples = sources.map(source => {
          const content = source.content as SourceContent;
          if (content.kind === 'pdf' && (content.text?.length ?? 0) > 40000) throw new Error('PDF 超过首期完整候选预算，请拆分来源，不静默截断');
          return { id: source.id, sourceNamespace: `source.${source.source_id}`, ...content, ...(content.kind !== 'pdf' ? { nativeValues: content.kind === 'table' ? Object.fromEntries((content.rows ?? []).slice(0,10).map(row => [row[content.keyColumn!],content.nativeValues![row[content.keyColumn!]]])) : undefined, rows: content.rows?.slice(0, 10), coverage: { sampledRows: Math.min(10, content.rows?.length ?? 0), totalRows: content.rowCount ?? content.rows?.length ?? 0 } } : { coverage: { characters: content.text?.length ?? 0, totalCharacters: content.text?.length ?? 0 } }) };
        });
        const previous = input.basePlanId ? await new BuildPlans(this.core).get(actor, input.basePlanId) : null;
        const modelInput = { ontology: ontology.definition, sources: samples, previousProposal: previous?.proposal ?? null, discoveryIssues: ontology.discovery?.validation?.uncertainties ?? [] };
        const native=samples.every(s=>s.kind==='table');
        inputBytes = native ? 0 : Buffer.byteLength(JSON.stringify(modelInput));
        if (inputBytes > 180000) throw new Error('构建计划输入超过单次预算，请减少来源');
        let proposal;
        if(native){record({at:new Date().toISOString(),kind:'analysis.staged'});proposal=await compiler().plan(ontology.definition,samples,previous?.proposal??null,modelInput.discoveryIssues,ontology.discovery?.validation?.tableDecisions??[]);}
        else{modelCalled = true; this.model.lastRun = undefined;proposal=planProposalSchema.parse(await this.model.generate('plan', modelInput, planProposalSchema));}
        const current = await this.core.ontology(actor, input.ontologyId);
        if (current.revision !== ontology.revision) throw new Error('模型运行期间本体已变化，请重新生成计划');
        record({ at: new Date().toISOString(), kind: 'plan.persisting' });
        const plan = await new BuildPlans(this.core).create(actor, input.ontologyId, input.sourceVersionIds, proposal, { jobId: job.id, model: job.payload.modelId, prompt: PROMPT_VERSION, structuredPolicy:native?STRUCTURED_POLICY:null, basePlanId: input.basePlanId ?? null, autoBuild: input.autoBuild }, lease, ontology.revision, input.autoBuild ? PROMPT_VERSION : undefined, input.collectDecisions ? async (sql,row) => {
          row.decisionPackageId = await new DecisionPackages(this.core).insertIn(sql,actor,row,'preparing');
          await this.enqueueIn(sql,actor,{kind:'collect',operationId:`package:${row.decisionPackageId}:collect`,packageId:row.decisionPackageId});
        } : undefined);
        result = { planId: plan.id, ...(plan.continuationJobId ? { stage: 'queued_preflight', continuationJobId: plan.continuationJobId } : {}) };
        if (plan.decisionPackageId) result = {...result as Record<string,unknown>,decisionPackageId:plan.decisionPackageId,stage:'queued_collection'};
      } else if (input.kind === 'build') {
        record({ at: new Date().toISOString(), kind: 'build.started' });
        const plans = new BuildPlans(this.core);
        let current = await plans.get(actor, input.planId);
        if (input.preflight && current.status !== 'approved') {
          await plans.preflight(actor, input.planId, current.revision);
          current = await plans.get(actor, input.planId);
        }
        if (input.preflight && current.status !== 'approved') {
          result = { planId: input.planId, stage: current.preview?.automaticFailures?.length ? 'blocked_validation' : 'awaiting_decision', blockers: current.preview?.errors ?? [], modelCalled: false };
        } else {
          result = { ...await plans.build(actor, input.planId, lease), stage: 'built' };
        }
      } else {
        const source = await this.core.sourceVersion(actor, input.sourceVersionId);
        const ontology = await this.core.ontology(actor, input.ontologyId, true);
        const content = source.content as SourceContent;
        const configuration = { prompt: PROMPT_VERSION, model: input.mapping ? 'deterministic-mapping-v2' : this.model?.identity, mapping: input.mapping ?? null };
        inputBytes = Buffer.byteLength(JSON.stringify(content));
        let output: unknown;
        if (input.mapping) output = mapCsv(content, input.mapping, ontology.definition);
        else {
          if (!this.model) throw new Error('尚未配置模型；CSV 可指定字段映射，PDF 需配置模型');
          if (content.kind !== 'pdf') throw new Error('结构化数据请提供显式字段映射');
          if ((content.text?.length ?? 0) > 40000) throw new Error('第一阶段单次模型抽取最多 40000 字符，请拆分文档后接入；没有静默截断');
          const modelInput = { ontology: ontology.definition, sourceNamespace: `source.${source.source_id}`, sourceVersionId: source.id, content };
          inputBytes = Buffer.byteLength(JSON.stringify(modelInput)); modelCalled = true; this.model.lastRun = undefined;
          output = await this.model.generate('extract', modelInput, extractionSchema);
        }
        result = await this.core.commitExtraction(actor, { operationId: input.operationId, ontologyId: input.ontologyId, sourceVersionId: input.sourceVersionId, configuration, output, job: lease });
      }
      record({ at: new Date().toISOString(), kind: 'job.completed' });
      await this.core.db.pool.query("UPDATE knowledge.jobs SET state='completed',result=$3::jsonb,error=NULL,lease_until=NULL,metrics=$4::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2 AND state IN ('running','completed')", [job.id, lease.leaseToken, JSON.stringify(result), JSON.stringify(metrics())]);
    } catch (error) {
      if (error instanceof z.ZodError) record({at:new Date().toISOString(),kind:'validation.failed',issues:error.issues.map(i=>({path:i.path.map(p=>typeof p==='number'?'[]':String(p)).join('.'),code:i.code}))});
      if (error instanceof DiscoveryEvidenceError) record({ at: new Date().toISOString(), kind: 'ontology.evidence_missing', code: error.code, issues: error.missingMemberIds.map(id => ({ path: id, code: 'missing_evidence' })) });
      // Avoid persisting arbitrary provider messages that can contain credentials or request content.
      const message = error instanceof z.ZodError ? '输入或模型输出未通过结构校验' : error instanceof Error && !/key|token|authorization|bearer|https?:/i.test(error.message) ? error.message.slice(0, 500) : '任务失败，请检查配置或输入后重试';
      failure = message;
      record({ at: new Date().toISOString(), kind: 'job.failed' });
      await this.core.db.pool.query("UPDATE knowledge.jobs SET state='failed',error=$3,lease_until=NULL,metrics=$4::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2 AND state='running'", [job.id, lease.leaseToken, message, JSON.stringify(metrics())]);
    } finally {
      clearInterval(heartbeat);
      if (this.model) { this.model.onDiagnostic = undefined; this.model.diagnosticContext = undefined; }
      await this.core.db.pool.query("UPDATE knowledge.job_attempts SET outcome=CASE WHEN j.lease_token IS DISTINCT FROM $1::uuid THEN 'interrupted' WHEN j.state='completed' THEN 'completed' WHEN j.state='failed' THEN 'failed' ELSE 'interrupted' END,metrics=$2::jsonb FROM knowledge.jobs j WHERE knowledge.job_attempts.id=$1 AND j.id=knowledge.job_attempts.job_id", [lease.leaseToken, JSON.stringify(metrics())]);
    }
  }
}
function needsModel(input: z.infer<typeof jobInput>) {
  return input.kind === 'discover' && !input.revalidateFromJobId || input.kind === 'plan' || input.kind === 'extract' && !input.mapping;
}

export function workerFailureDetails(error: unknown) {
  const raw = error && typeof error === 'object' ? error as { code?: unknown; position?: unknown } : {};
  const code = typeof raw.code === 'string' && /^[A-Z0-9_]{3,32}$/.test(raw.code) ? raw.code : 'UNKNOWN';
  const reasons: Record<string, string> = {
    '42P01': '任务所需表不存在，请检查当前数据库并执行 npm run knowledge:init',
    '42703': '任务 SQL 引用了不存在的字段，请检查迁移与代码版本',
    '42883': '任务 SQL 使用了不支持的函数或类型操作',
    '42702': '任务 SQL 存在歧义字段引用',
    '42804': '任务 SQL 参数或字段类型不匹配',
    '42P08': '任务 SQL 参数推断出不一致的数据类型',
    '23514': '任务写入违反数据库检查约束',
    '42501': '数据库账号缺少任务表操作权限',
    'ECONNREFUSED': '无法连接 PostgreSQL，请检查数据库服务与端口',
    '28P01': '数据库认证失败，请检查账号密码',
    '57014': '数据库查询被取消或超过执行时限',
    'UNKNOWN': '后台任务基础设施异常，未取得可识别的数据库错误码',
  };
  return { code, reason: reasons[code] ?? '数据库或后台任务基础设施异常，请根据错误码排查', ...(typeof raw.position === 'string' && /^\d+$/.test(raw.position) ? { sqlPosition: raw.position } : {}) };
}

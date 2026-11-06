import type {Sql} from './database.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, authorize, type Principal } from './contracts.ts';
import { fingerprint } from './sources.ts';
import type { KnowledgeCore } from './service.ts';
import { BuildPlans, type PlanRow } from './build-plans.ts';

interface PackageRow { id:string; ontology_id:string; plan_id:string; revision:number; state:string; receipts:Record<string,any>; snapshot:unknown; created_at:Date; updated_at:Date; }

/** A persisted cross-stage view over existing decisions, not a partial-publication engine. */
export class DecisionPackages {
  private core: KnowledgeCore; private plans: BuildPlans;
  constructor(core: KnowledgeCore, plans = new BuildPlans(core)) { this.core = core; this.plans = plans; }
  private async row(id: string):Promise<PackageRow> {
    z.string().uuid().parse(id);
    const row = (await this.core.db.pool.query<PackageRow>('SELECT * FROM knowledge.decision_packages WHERE id=$1',[id])).rows[0];
    if (!row) throw new Error('决定包不存在'); return row;
  }
  async insertIn(sql: Sql, actor: Principal, plan: PlanRow, state='collecting') {
    const existing=(await sql.query('SELECT id FROM knowledge.decision_packages WHERE plan_id=$1',[plan.id])).rows[0];
    if(existing)return String(existing.id);
    const scope=fingerprint(plan.manifest.map(m=>m.sourceId).sort());
    const row=(await sql.query("INSERT INTO knowledge.decision_packages(id,ontology_id,plan_id,scope_key,created_by,state) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[randomUUID(),plan.ontology_id,plan.id,scope,actor.id,state])).rows[0];
    const old=(await sql.query<PackageRow>("SELECT * FROM knowledge.decision_packages WHERE scope_key=$1 AND id<>$2 AND state IN ('preparing','collecting','awaiting_decision','needs_recovery')",[scope,row.id])).rows;
    for(const previous of old){
      const snapshot=(previous.snapshot as any)?.candidateHash ? previous.snapshot : await this.summary(actor,previous);
      await sql.query("UPDATE knowledge.decision_packages SET state='superseded',superseded_by=$2,snapshot=$3::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1",[previous.id,row.id,JSON.stringify(snapshot)]);
    }
    return String(row.id);
  }
  async archive(actor: Principal,id: string,raw: unknown) {
    authorize(actor,true);z.string().uuid().parse(id);
    const input=z.object({expectedRevision:z.number().int().positive(),candidateHash:z.string().min(1),reason:z.string().trim().min(1).max(4000)}).strict().parse(raw);
    await this.core.db.transaction(async sql=>{
      const current=await this.get(actor,id);
      if(current.summary.candidateHash!==input.candidateHash)throw new Error('归档事项已变化，请刷新');
      const result=await sql.query("UPDATE knowledge.decision_packages SET state='archived',archived_by=$3,archived_at=clock_timestamp(),archive_reason=$4,snapshot=$5::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND revision=$2 AND state<>'submitting' RETURNING id",[id,input.expectedRevision,actor.id,input.reason,JSON.stringify(current.summary)]);
      if(!result.rows.length)throw new Error('决定包修订已变化或正在提交');
    });
    return this.get(actor,id);
  }
  async list(actor: Principal) { authorize(actor); return (await this.core.db.pool.query('SELECT id,ontology_id,plan_id,revision,state,receipts,superseded_by,archived_by,archived_at,archive_reason,created_at,updated_at FROM knowledge.decision_packages ORDER BY created_at DESC LIMIT 100')).rows; }
  async create(actor: Principal, raw: unknown) {
    authorize(actor,true); const {planId} = z.object({planId:z.string().uuid()}).strict().parse(raw);
    let plan:PlanRow & {staleReason?:string|null} = await this.plans.get(actor,planId);
    if (plan.staleReason) throw new Error(plan.staleReason);
    if (plan.status !== 'approved') plan = await this.plans.preflight(actor,planId,plan.revision);
    const snapshot=await this.summary(actor,{plan_id:planId,ontology_id:plan.ontology_id});
    const id = await this.core.db.transaction(async sql => {
      const id=await this.insertIn(sql,actor,plan);
      await sql.query("UPDATE knowledge.decision_packages SET snapshot=$2::jsonb WHERE id=$1 AND snapshot='{}'::jsonb",[id,JSON.stringify(snapshot)]);
      return id;
    });
    return this.get(actor,id);
  }
  private async summary(actor: Principal, row: Record<string,any>) {
    const plan = await this.plans.get(actor,row.plan_id), ontology = await this.core.ontology(actor,row.ontology_id);
    const validation = ontology.discovery?.validation, review = ontology.discovery?.review;
    const reviewed = review?.definitionHash === fingerprint(ontology.definition);
    const ontologyIssues = ontology.status === 'published' ? [] : validation
      ? validation.issues.filter((i: any) => !reviewed || !review.issueIds.includes(i.id))
      : [{ id:fingerprint({firstPublication:ontology.id,definition:ontology.definition}),kind:'first_release',question:'首次启用此业务范围，请整体确认类型、属性与关系。' }];
    const identities = (plan.preview?.identities ?? []).filter((g: any) => !g.autoContinued);
    const events = plan.preview?.events ?? [];
    const systemErrors = [...(['archived','superseded'].includes(row.state) ? ['本决定包已归档或被新批取代；保留证据，不能据此批准'] : []),...(!plan.preview ? ['预检尚未完成，请等待收集任务或刷新；不会重新调用模型'] : []),...(plan.preview?.automaticFailures ?? []),...(plan.staleReason ? [plan.staleReason] : [])];
    const facts = { ontologyId:ontology.id,ontologyRevision:ontology.revision,definition:ontology.definition,planId:plan.id,planRevision:plan.revision,
      candidateHash:plan.preview?.identityCandidateHash,ontologyIssues,identities,events,eventHash:plan.preview?.eventHash,systemErrors };
    return { ...facts,candidateHash:fingerprint(facts),identityCandidateHash:plan.preview?.identityCandidateHash,ontologyStatus:ontology.status,planStatus:plan.status,
      planErrors:plan.preview?.errors ?? [],canPublish:actor.role==='admin',note:'先处理改变本体定义的事项。编辑定义会使整计划和本批身份候选失效；批量身份只在各组内部建立对应。' };
  }
  async get(actor: Principal,id: string) {
    authorize(actor); const row = await this.row(id), summary = ['archived','superseded'].includes(row.state) && (row.snapshot as any)?.candidateHash ? row.snapshot as Awaited<ReturnType<DecisionPackages['summary']>> : await this.summary(actor,row);
    return {...row,summary,pendingDays:Math.floor((Date.now()-new Date(row.created_at).getTime())/86400000),retention:'待决定证据保留；30天提示复核，不自动批准或删除。'};
  }
  async refresh(actor: Principal,id: string,revision: number) {
    authorize(actor,true); const row = await this.row(id);
    if(row.revision!==revision||['submitting','archived','superseded'].includes(row.state))throw new Error('决定包修订变化或正在提交');
    const plan = await this.plans.get(actor,row.plan_id);
    if(plan.staleReason)throw new Error(plan.staleReason);
    if(plan.status!=='approved')await this.plans.preflight(actor,plan.id,plan.revision);
    await this.core.db.transaction(async sql=>{const snapshot=await this.summary(actor,row);const r=await sql.query("UPDATE knowledge.decision_packages SET revision=revision+1,state='collecting',snapshot=$3::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND revision=$2 RETURNING id",[id,revision,JSON.stringify(snapshot)]);if(!r.rows.length)throw new Error('决定包修订已变化');});
    return this.get(actor,id);
  }
  async submit(actor: Principal,id: string,raw: unknown) {
    authorize(actor,true);
    const input=z.object({expectedRevision:z.number().int().positive(),candidateHash:z.string().min(1),reason:z.string().trim().max(4000).default(''),
      identityDecision:z.enum(['same','separate']).optional(),overrides:z.record(z.string(),z.object({decision:z.enum(['same','separate']),reason:z.string().max(4000).optional()}).strict()).default({}),eventHash:z.string().optional()}).strict().parse(raw);
    const current=await this.get(actor,id);
    if(['archived','superseded'].includes(current.state))throw new Error('决定包已归档或被新批取代');
    if(current.revision!==input.expectedRevision||current.summary.candidateHash!==input.candidateHash)throw new Error('本体、计划或候选已变化，请刷新本批事项');
    if(current.state==='built')return current;
    if(current.summary.systemErrors.length)throw new Error('存在系统校验错误或计划失效，不能通过业务决定绕过');
    if(current.summary.ontologyStatus!=='published'&&actor.role!=='admin')throw new AccessDenied('只有管理员可以发布本体；决定包尚未提交');
    if((current.summary.ontologyIssues.length||input.identityDecision||input.eventHash)&&!input.reason)throw new Error('请填写本轮业务决定的范围和理由');
    if(input.eventHash&&input.eventHash!==current.summary.eventHash)throw new Error('重大事件指纹已变化，请刷新');
    const claimed=await this.core.db.transaction(async sql=>sql.query("UPDATE knowledge.decision_packages SET state='submitting',revision=revision+1,snapshot=$3::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND revision=$2 AND state NOT IN ('archived','superseded') AND (state<>'submitting' OR updated_at<clock_timestamp()-interval '5 minutes') RETURNING id",[id,input.expectedRevision,JSON.stringify(current.summary)]));
    if(!claimed.rows.length)throw new Error('本批正在提交或修订已变化，请刷新；中断任务五分钟后可显式恢复');
    const receipts:Record<string,any>={...current.receipts};
    const record=async(state:string)=>{await this.core.db.pool.query('UPDATE knowledge.decision_packages SET state=$2,receipts=$3::jsonb,updated_at=clock_timestamp() WHERE id=$1',[id,state,JSON.stringify(receipts)]);};
    try {
      let ontology=await this.core.ontology(actor,current.ontology_id);
      let plan:PlanRow=await this.plans.get(actor,current.plan_id);
      if(input.identityDecision&&current.summary.identities.length&&plan.status!=='approved') {
        plan=await this.plans.decideIdentityBatch(actor,plan.id,{expectedRevision:plan.revision,candidateHash:current.summary.identityCandidateHash,decision:input.identityDecision,reason:input.reason,overrides:input.overrides});
        receipts.identities={planRevision:plan.revision,decision:input.identityDecision};await record('submitting');
      }
      if(plan.status!=='approved') {
        if(input.eventHash)plan=await this.plans.save(actor,plan.id,plan.revision,plan.proposal,{...plan.review,reason:input.reason,eventAcknowledgement:input.eventHash});
        plan=await this.plans.preflight(actor,plan.id,plan.revision);
      }
      if(!plan.preview?.ready) { receipts.lastStage='awaiting_decision';await record('awaiting_decision');return this.get(actor,id); }
      if(ontology.status!=='published') {
        if(ontology.discovery?.validation&&current.summary.ontologyIssues.length) {
          await this.core.reviewDiscovery(actor,ontology.id,{expectedRevision:ontology.revision,issueIds:ontology.discovery.validation.issues.map((i:any)=>i.id),reason:input.reason});
          ontology=await this.core.ontology(actor,ontology.id);
          receipts.ontologyDecisionSaved=true;await record('submitting');
        }
        await this.core.act(actor,{kind:'PublishOntologyVersion',operationId:`package:${id}:publish:${ontology.revision}`,targetId:ontology.id,expectedRevision:ontology.revision,reason:input.reason||'沿用已保存业务决定'});
        receipts.publishedOntologyId=ontology.id;await record('submitting');
      }
      plan=await this.plans.get(actor,plan.id);
      if(plan.status!=='approved')plan=await this.plans.approve(actor,plan.id,plan.revision,true);
      receipts.approvedPlanId=plan.id;await record('submitting');
      receipts.build=await this.plans.build(actor,plan.id);receipts.lastStage='built';delete receipts.error;
      await record('built');return this.get(actor,id);
    } catch(e) {
      receipts.error='提交未完成，请查看分步回执并刷新；已发布内容和已保存决定不会被重复创建。';
      await record('needs_recovery');throw e;
    }
  }
}

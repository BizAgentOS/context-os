import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {getCostRate,calculateCost} from '@kodax-ai/kodax/llm';
import type {MemoryStore} from './memory.ts';
import type {Artifact,Data,Json} from './contracts.ts';
import type {AgentDriver,ModelSettings,RunRequest,RunOutcome} from './runtime.ts';
import {assertRole,currentActor,programActor,withActor} from '../security/actors.ts';
import {fingerprint} from '../engine/release-diff.ts';
import {jsonData} from '../live/sources.ts';

const number=z.number().finite().nonnegative();
const bound=z.object({tokens:number.int().max(1e9).nullable().default(null),usd:number.max(1e6).nullable().default(null)}).strict();
const rate=z.object({provider:z.string().min(1).max(100),model:z.string().min(1).max(200),inputPer1M:number,outputPer1M:number,cacheReadPer1M:number.optional(),cacheWritePer1M:number.optional()}).strict();
const policySchema=z.object({timeZone:z.string().refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},'时区无效').default('Asia/Shanghai'),perRun:bound.default({tokens:null,usd:null}),daily:bound.default({tokens:null,usd:null}),rates:z.array(rate).max(100).refine(items=>new Set(items.map(item=>JSON.stringify([item.provider,item.model]))).size===items.length,'同一提供商和模型的费率不能重复').default([])}).strict();
const configureSchema=policySchema.extend({operationId:z.string().trim().min(1).max(200)}).strict();
type Policy=z.infer<typeof policySchema>;
type Usage={inputTokens:number;outputTokens:number;totalTokens:number;cachedReadTokens:number;cachedWriteTokens:number;costUsd:number|null;estimatedCost:boolean};
type Sample={id:string;at:string;usage:Usage};
const money=(value:number)=>Math.round(value*1e12)/1e12;
const ref=(item:Artifact)=>({id:item.id,version:item.version});
const finite=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const sum=(samples:Sample[]):Usage=>({inputTokens:samples.reduce((n,s)=>n+s.usage.inputTokens,0),outputTokens:samples.reduce((n,s)=>n+s.usage.outputTokens,0),totalTokens:samples.reduce((n,s)=>n+s.usage.totalTokens,0),cachedReadTokens:samples.reduce((n,s)=>n+s.usage.cachedReadTokens,0),cachedWriteTokens:samples.reduce((n,s)=>n+s.usage.cachedWriteTokens,0),costUsd:samples.some(s=>s.usage.costUsd===null)?null:money(samples.reduce((n,s)=>n+s.usage.costUsd!,0)),estimatedCost:samples.some(s=>s.usage.estimatedCost)});
export class UsageLimit extends Error {readonly code='usage_limit';}

/** Provider telemetry is the accounting source. Estimates use a saved tariff, never output text length. */
export class UsageService {
  private memory:MemoryStore;private clock:()=>Date;
  constructor(memory:MemoryStore,options:{clock?:()=>Date}={}){
    this.memory=memory;this.clock=options.clock??(()=>new Date());
    for(const item of memory.listArtifacts('usage_run').filter(item=>item.status==='running'))memory.putArtifact({...item,expectedVersion:item.version,status:'interrupted',content:{...item.content,accounting:'unknown',finishedAt:this.clock().toISOString(),reservation:{tokens:0,usd:0},error:'服务重启，未收到的用量保持未知'}});
  }
  policy():Policy{return policySchema.parse(this.memory.listArtifacts('usage_policy')[0]?.content.policy??{});}
  configure(input:unknown){
    assertRole('settings');const args=configureSchema.parse(input),{operationId,...policy}=args;
    return this.memory.atomic(()=>{
      const old=this.memory.listArtifacts('usage_policy_receipt').find(item=>item.content.operationId===operationId&&item.content.actor===currentActor().id);
      if(old){if(old.content.signature!==fingerprint(args))throw new Error('同一操作标识不能配置不同预算');return policySchema.parse(old.content.policy);}
      const prior=this.memory.listArtifacts('usage_policy')[0];
      this.memory.putArtifact({...(prior?{id:prior.id,expectedVersion:prior.version}:{}),kind:'usage_policy',title:'模型用量与成本上限',status:'saved',content:jsonData({policy})});
      this.memory.putArtifact({kind:'usage_policy_receipt',title:'预算设置回执',status:'saved',content:jsonData({operationId,actor:currentActor().id,signature:fingerprint(args),policy})});
      return policy;
    });
  }
  private date(at:string,timeZone:string){return new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));}
  private readings(){return this.memory.listArtifacts('usage_run');}
  private summary(period:string,policy:Policy){
    const runs=this.readings().filter(item=>this.date(String(item.content.startedAt),policy.timeZone).startsWith(period)||((item.content.samples??[]) as unknown as Sample[]).some(sample=>this.date(sample.at,policy.timeZone).startsWith(period)));
    const samples=runs.flatMap(item=>(item.content.samples??[]) as unknown as Sample[]).filter(sample=>this.date(sample.at,policy.timeZone).startsWith(period)),usage=sum(samples);
    const unknownRuns=runs.filter(item=>item.content.accounting==='unknown').length;
    return {runs:runs.length,tokens:usage.totalTokens,inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,costUsd:unknownRuns?null:usage.costUsd,knownCostUsd:money(samples.reduce((n,s)=>n+(s.usage.costUsd??0),0)),unknownRuns,estimatedCost:usage.estimatedCost};
  }
  overview(){
    const policy=this.policy(),day=this.date(this.clock().toISOString(),policy.timeZone);
    return {policy,currency:'USD',today:this.summary(day,policy),month:this.summary(day.slice(0,7),policy),runs:this.readings().slice(0,100),limitsNote:'达到上限时停止后续模型及工具调用；上游尚未返回的请求可能已产生费用，未知用量不会记为零。'};
  }
  private usage(value:unknown,settings:ModelSettings,policy:Policy):Usage|null{
    const raw=value&&typeof value==='object'?value as Record<string,unknown>:{},inputTokens=finite(raw.inputTokens),outputTokens=finite(raw.outputTokens);
    if(inputTokens===null||outputTokens===null)return null;
    const cachedReadTokens=finite(raw.cachedReadTokens)??0,cachedWriteTokens=finite(raw.cachedWriteTokens)??0;
    const tariff=policy.rates.find(item=>item.provider===settings.provider&&item.model===settings.model)??getCostRate(settings.provider,settings.model);
    const reported=finite(raw.costUsd),cost=reported??(tariff?calculateCost(tariff,inputTokens,outputTokens,cachedReadTokens,cachedWriteTokens):null);
    return {inputTokens,outputTokens,totalTokens:Math.max(finite(raw.totalTokens)??0,inputTokens+outputTokens),cachedReadTokens,cachedWriteTokens,costUsd:cost===null?null:Math.round(cost*1e12)/1e12,estimatedCost:reported===null&&cost!==null};
  }
  private reserve(policy:Policy){
    const day=this.date(this.clock().toISOString(),policy.timeZone),today=this.summary(day,policy);
    // An in-flight request can return after midnight. Its unspent reservation still competes with new runs.
    const running=this.readings().filter(item=>item.status==='running');
    if(today.unknownRuns&&((policy.daily.tokens!==null)||(policy.daily.usd!==null)))throw new UsageLimit('本日有未确认用量，无法安全继续每日预算，请核对用量后调整预算');
    const usedTokens=today.tokens+running.reduce((n,item)=>n+Number((item.content.reservation as Data).tokens??0),0),usedUsd=today.knownCostUsd+running.reduce((n,item)=>n+Number((item.content.reservation as Data).usd??0),0);
    if(policy.daily.tokens!==null&&usedTokens>=policy.daily.tokens)throw new UsageLimit('每日 token 上限已达到或已为运行中任务预留');
    if(policy.daily.usd!==null&&(today.costUsd===null||usedUsd>=policy.daily.usd))throw new UsageLimit('每日费用上限已达到或当前费用无法确认');
    if(policy.perRun.tokens===0||policy.perRun.usd===0)throw new UsageLimit('每轮用量上限为零，未调用模型');
    return {tokens:policy.daily.tokens===null?0:Math.max(0,Math.min(policy.perRun.tokens??policy.daily.tokens,policy.daily.tokens-usedTokens)),usd:policy.daily.usd===null?0:Math.max(0,Math.min(policy.perRun.usd??policy.daily.usd,policy.daily.usd-usedUsd))};
  }
  wrap(driver:AgentDriver,settings:()=>ModelSettings,scope:string):AgentDriver{
    return {run:request=>this.run(driver,settings(),scope,request),stop:()=>driver.stop(),close:()=>driver.close(),...(driver.fork?{fork:(name:string)=>this.wrap(driver.fork!(name),settings,`${scope}/${name}`)}:{})};
  }
  private async run(driver:AgentDriver,settings:ModelSettings,scope:string,request:RunRequest):Promise<RunOutcome>{
    const policy=this.policy();
    if((policy.perRun.usd!==null||policy.daily.usd!==null)&&!policy.rates.some(rate=>rate.provider===settings.provider&&rate.model===settings.model)&&!getCostRate(settings.provider,settings.model))throw new UsageLimit('该模型没有可核对的费用费率，请先设置费率才能执行费用上限');
    const reservation=this.reserve(policy),samples:Sample[]=[],sampleIds=new Set<string>();
    let record=this.memory.putArtifact({kind:'usage_run',title:request.title.slice(0,200),status:'running',content:jsonData({scope,requestedBy:currentActor(),provider:settings.provider,model:settings.model,startedAt:this.clock().toISOString(),accounting:'pending',samples:[],usage:null,reservation})});
    let stopped:string|undefined,stopRequested=false,unknown=false;
    const save=(status=record.status,extra:Data={})=>withActor(programActor('usage-accounting'),()=>{record=this.memory.putArtifact({...record,expectedVersion:record.version,status,content:{...record.content,samples:jsonData(samples) as unknown as Json,usage:samples.length?jsonData(sum(samples)):null,...extra}});},()=>{});
    const halt=(reason:string)=>{if(stopped)return;stopped=reason;try{request.onEvent('run.budget_exceeded',{reason,usageRef:jsonData(ref(record))});}catch{/* The caller may already be revoked; incurred usage still needs accounting. */}if(!stopRequested){stopRequested=true;void driver.stop().catch(()=>{});}};
    const check=()=>{
      if(stopped)throw new UsageLimit(stopped);
      try{currentActor();}catch{halt('操作者授权已变化，已停止运行');throw new UsageLimit(stopped!);}
      const usage=sum(samples),current=this.policy(),day=this.date(this.clock().toISOString(),current.timeZone),today=this.summary(day,current);
      if(policy.daily.tokens!==null&&reservation.tokens>0&&usage.totalTokens>=reservation.tokens)halt('本轮可用 token 上限已达到，已停止运行');
      else if(policy.daily.usd!==null&&reservation.usd>0&&usage.costUsd!==null&&usage.costUsd>=reservation.usd)halt('本轮可用费用上限已达到，已停止运行');
      else if(policy.perRun.tokens!==null&&usage.totalTokens>=policy.perRun.tokens)halt('本轮 token 上限已达到，已停止运行');
      else if(policy.perRun.usd!==null&&usage.costUsd!==null&&usage.costUsd>=policy.perRun.usd)halt('本轮费用上限已达到，已停止运行');
      else if(current.daily.tokens!==null&&today.tokens>=current.daily.tokens)halt('每日 token 上限已达到，已停止运行');
      else if(current.daily.usd!==null&&today.knownCostUsd>=current.daily.usd)halt('每日费用上限已达到，已停止运行');
      if(stopped)throw new UsageLimit(stopped);
    };
    const append=(id:string,usage:Usage)=>{
      sampleIds.add(id);samples.push({id,at:this.clock().toISOString(),usage});const total=sum(samples);
      save('running',{accounting:'available',reservation:{tokens:Math.max(0,reservation.tokens-total.totalTokens),usd:Math.max(0,reservation.usd-(total.costUsd??0))}});
      try{check();}catch(error){if(!(error instanceof UsageLimit))throw error;}
    };
    const observe=(id:string,value:unknown)=>{
      if(sampleIds.has(id))return;const usage=this.usage(value,settings,policy);
      if(!usage){unknown=true;if(policy.perRun.tokens!==null||policy.daily.tokens!==null||policy.perRun.usd!==null||policy.daily.usd!==null)halt('模型没有返回可核对的用量，已停止预算运行');return;}
      append(id,usage);
    };
    try{
      const outcome=await driver.run({...request,
        authorizeTool:(name,args)=>{check();request.authorizeTool?.(name,args);},
        onTool:async(name,args,id)=>{check();return request.onTool(name,args,id);},
        onEvent:(kind,data)=>{if(kind==='run.usage')observe(String(data.sampleId??randomUUID()),data.usage);else if(kind==='run.progress'){try{check();}catch(error){if(!(error instanceof UsageLimit))throw error;}}request.onEvent(kind,data);},
      });
      const final=this.usage(outcome.usage,settings,policy),known=sum(samples);
      if(!samples.length)observe('final',outcome.usage);
      else if(final&&(['inputTokens','outputTokens','totalTokens','cachedReadTokens','cachedWriteTokens'] as const).every(key=>final[key]>=known[key])){
        // Final run telemetry may include a response whose event was not delivered. Add only the delta.
        unknown=false;
        const delta:Usage={inputTokens:final.inputTokens-known.inputTokens,outputTokens:final.outputTokens-known.outputTokens,totalTokens:final.totalTokens-known.totalTokens,cachedReadTokens:final.cachedReadTokens-known.cachedReadTokens,cachedWriteTokens:final.cachedWriteTokens-known.cachedWriteTokens,costUsd:final.costUsd===null||known.costUsd===null?null:Math.max(0,money(final.costUsd-known.costUsd)),estimatedCost:final.estimatedCost};
        if(delta.totalTokens>0||(delta.costUsd??0)>0)append('final-delta',delta);
      }
      try{check();}catch(error){if(!(error instanceof UsageLimit))throw error;}
      save(stopped?'stopped':outcome.status??'completed',{accounting:samples.length&&!unknown&&outcome.status!=='failed'?'available':'unknown',reservation:{tokens:0,usd:0},finishedAt:this.clock().toISOString(),...(stopped?{error:stopped}:{})});
      return {...outcome,...(stopped?{status:'stopped' as const,error:stopped}:{}),...(samples.length?{usage:jsonData({...sum(samples),usageRef:ref(record),currency:'USD'})}:{} )};
    }catch(error){save(stopped?'stopped':'failed',{accounting:'unknown',reservation:{tokens:0,usd:0},finishedAt:this.clock().toISOString(),...(stopped?{error:stopped}:{})});throw error;}
  }
}

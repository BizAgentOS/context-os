import {z} from 'zod';
import type {Artifact,Data} from '../agent/contracts.ts';
import type {MemoryStore} from '../agent/memory.ts';
import type {OntologyChanges} from './changes.ts';
import type {PendingItem,PendingProvider} from './pending.ts';
import {fingerprint} from './release-diff.ts';
import {jsonData} from '../live/sources.ts';
import {qaDataViewSchema,qaReference,type QaDataView} from '../agent/qa-view.ts';
import {parseLayeredModel} from '../semantic/model.ts';
import {ExternalGapFeedback} from './external-gap-feedback.ts';
import {assertRole,currentActor} from '../security/actors.ts';

export interface GapReading {id:string;tool:string;query?:Data;status:string;reason?:string;message?:string;result:Data;readAt:string}
type Replay=(question:string,dataView:QaDataView,preview?:{definition:Data;foundation?:Artifact;corrections?:{relations?:readonly Artifact[];properties?:readonly Artifact[]}},assertActive?:()=>void)=>(query:Data,usePreview?:boolean)=>Promise<Data>;
const open=new Set(['open','in_fix','fixed','reopened']);
const reasons=new Set(['missing_relation','unbound','unmatched','identity_unresolved']);
const observations:Record<string,string>={missing_relation:'当前获准本体缺少所需关系',unbound:'所需定义尚未绑定可读取的数据',unmatched:'本次读取未找到已确定的对应关系',identity_unresolved:'本次读取的身份对应尚未确定'};
const coverageMetadata=(value:unknown):Data=>{
  const safe:Data={};
  if(value&&typeof value==='object'&&!Array.isArray(value))for(const key of ['complete','total','returned','matched','unmatched','ambiguous','examined','offset','limit']){
    const field=(value as Data)[key];if(typeof field==='number'||typeof field==='boolean'||field===null)safe[key]=field;
  }
  return safe;
};
const action=qaReference.extend({operationId:z.string().min(1).max(200)}).strict();
const ref=(item:Artifact)=>({id:item.id,version:item.version});
const installed=new WeakSet<MemoryStore>();
type GapResult={gap:Artifact};
type HandoffResult=GapResult&{mode:string;dataView:QaDataView;pendingRef:{id:string;version:number};message:string};
type PreviewResult={preview:Artifact;before:Data;after:Data};
type ReaskResult=GapResult&{result:Data};

/** Gap status records a user-controlled repair and replay, never a model's claim of success. */
export class Gaps implements PendingProvider {
  private memory:MemoryStore;private changes:OntologyChanges;private replay:Replay;
  constructor(memory:MemoryStore,changes:OntologyChanges,replay:Replay){
    this.memory=memory;this.changes=changes;this.replay=replay;
    if(!installed.has(memory)){
      installed.add(memory);const previous=memory.beforeCommit;
      memory.beforeCommit=written=>{
        for(const change of written.filter(item=>item.kind==='ontology_change'&&item.status==='adopted')){
          for(const gap of memory.listArtifacts('question_gap').filter(item=>item.status==='in_fix'&&((item.content.changes??[]) as Data[]).some(link=>link.id===change.id&&link.verificationSignature===fingerprint((change.content.verification as Data)?.inputs)))){
            memory.putArtifact({...gap,expectedVersion:gap.version,status:'fixed',content:{...gap.content,fixedBy:ref(change),fixedAt:new Date().toISOString(),nextAction:'用户重新提问以确认'}});
          }
        }
        previous?.(written);
      };
    }
  }
  report(input:{question:string;dataView:QaDataView;reading:GapReading;observation:string;taskId?:string;sessionId?:string}){
    if(currentActor().kind!=='external')assertRole('gap');
    const {reading}=input;
    if(!reading.query||!reasons.has(reading.reason??''))throw new Error('该读取不是可修复的本体缺口');
    const external=input.dataView.kind==='consumer';
    if(input.dataView.kind==='consumer')new ExternalGapFeedback(this.memory).assertEnabled(input.dataView);
    const prior=this.memory.listArtifacts('question_gap').find(item=>item.content.readId===reading.id);if(prior)return prior;
    const receipt=external?{readId:reading.id,tool:reading.tool,status:reading.status,reason:reading.reason,readAt:reading.readAt,coverage:coverageMetadata(reading.result.coverage),dataView:input.dataView}:reading;
    return this.memory.putArtifact({kind:'question_gap',title:input.question.slice(0,160),status:'open',content:jsonData({question:input.question,query:reading.query,dataView:input.dataView,receipt,readId:reading.id,...(external?{external:true,metadataOnly:true}:{}),
      reason:reading.reason,objects:[(reading.query.target as Data)?.entityTypeId].filter(Boolean),observation:external?observations[reading.reason!]:input.observation,taskId:input.taskId??null,sessionId:input.sessionId??null,changes:[],createdAt:new Date().toISOString()})});
  }
  get(id:string){const item=this.memory.getArtifact(id);if(item.kind!=='question_gap')throw new Error('缺口单不存在');return item;}
  private previous<T>(method:string,args:{operationId:string}):T|undefined {
    const receipt=this.memory.listArtifacts('gap_receipt').find(item=>item.content.operationId===args.operationId);
    if(!receipt)return undefined;
    if(receipt.content.signature!==fingerprint({method,args}))throw new Error('幂等操作标识已绑定不同缺口请求');
    return structuredClone(receipt.content.result) as T;
  }
  private commit<T>(method:string,args:{operationId:string},write:()=>T):T {
    return this.memory.atomic(()=>{
      const previous=this.previous<T>(method,args);if(previous)return previous;
      const result=write();
      this.memory.putArtifact({kind:'gap_receipt',title:'缺口操作回执',status:'saved',content:jsonData({operationId:args.operationId,signature:fingerprint({method,args}),result})});
      return result;
    });
  }
  private current(input:unknown){const args=action.parse(input),gap=this.get(args.id);if(gap.version!==args.version)throw new Error('缺口单版本已变化，请刷新');return{args,gap};}
  private update(gap:Artifact,status:string,patch:Data){return this.memory.putArtifact({...gap,expectedVersion:gap.version,status,content:{...gap.content,...patch}});}
  handoff(input:unknown){
    assertRole('change');
    const args=action.parse(input);
    return this.commit<HandoffResult>('handoff',args,()=>{
    const {gap}=this.current(args);if(!['open','reopened'].includes(gap.status))throw new Error('只有未解决缺口可以转到构建');
    const saved=this.update(gap,'in_fix',{handoffOperation:args.operationId,handoffAt:new Date().toISOString()});
    return {gap:saved,mode:'build',dataView:{kind:'working'},pendingRef:ref(saved),message:`请修复缺口「${gap.content.question}」。原始查询、回执与原因见缺口单；先提出变更并复验，再重放原查询，由我采用。`};
    });
  }
  async preview(input:unknown,assertActive:()=>void=()=>{}){
    assertRole('change');
    assertActive();
    const args=action.extend({changeRef:qaReference,relationResolutions:z.array(z.object({fromRelationId:z.string().min(1).max(200),toRelationId:z.string().min(1).max(200)}).strict()).max(10).default([])}).strict().parse(input),previous=this.previous<PreviewResult>('preview',args);if(previous)return previous;
    const gap=this.get(args.id);
    if(gap.version!==args.version||gap.status!=='in_fix')throw new Error('缺口单当前不能预览修复');
    const active=()=>{assertActive();if(this.get(gap.id).version!==gap.version)throw new Error('缺口单已变化');};
    const prepared=await this.changes.preparePreview(args.changeRef,active);
    if(!prepared.definition)throw new Error('该变更没有可重放的预览定义');
    const query=(gap.content.resolvedQuery??gap.content.query) as Data,question=String(gap.content.question),view:QaDataView={kind:'working'};
    const currentModel=this.changes.currentBaseline().modelRef,existing=currentModel?parseLayeredModel(this.memory.getArtifact(currentModel.id,currentModel.version).content.layered).semantic.relationTypes:[];
    const proposed=parseLayeredModel(prepared.definition.layered).semantic.relationTypes,steps=(query.traverse??[]) as Data[];
    if(new Set(args.relationResolutions.map(item=>item.fromRelationId)).size!==args.relationResolutions.length)throw new Error('缺失关系只能指定一次对应');
    const added=proposed.filter(item=>!existing.some(before=>before.id===item.id));
    const mappings=args.relationResolutions.map(mapping=>{
      if(mapping.toRelationId!=='$proposed')return mapping;
      if(added.length!==1)throw new Error('本次预览没有唯一新增关系，请读取具体关系编号后明确选择');
      return {...mapping,toRelationId:added[0].id};
    });
    const requested=((gap.content.receipt as Data)?.result as Data|undefined)?.requestedRelation as Data|undefined;
    for(const mapping of mappings){
      const step=steps.find(step=>step.relationTypeId===mapping.fromRelationId),relation=proposed.find(item=>item.id===mapping.toRelationId);
      if(!step||existing.some(item=>item.id===mapping.fromRelationId||item.id===mapping.toRelationId)||!relation)throw new Error('只能把原查询缺失关系对应到本次预览新增关系');
      if(requested?.id===mapping.fromRelationId&&((step.direction??'out')!=='out'||relation.from!==requested.from||requested.to!==undefined&&relation.to!==requested.to))
        throw new Error('修复关系端点必须符合原始查询的起点与已指定目标');
    }
    const resolvedQuery=mappings.length?jsonData({...query,traverse:steps.map(step=>({...step,relationTypeId:mappings.find(item=>item.fromRelationId===step.relationTypeId)?.toRelationId??step.relationTypeId}))}):query;
    const replay=this.replay(question,view,{definition:prepared.definition,foundation:prepared.foundation,corrections:prepared.corrections},active);
    const before=await replay(query);active();const after=await replay(resolvedQuery,true);active();
    const current=await this.changes.preparePreview(args.changeRef,active);
    if(this.get(gap.id).version!==gap.version||fingerprint(prepared.verification.inputs)!==fingerprint(current.verification.inputs))throw new Error('预览期间缺口单或变更依赖已变化');
    return this.commit('preview',args,()=>{
    active();const preview=this.memory.putArtifact({kind:'gap_preview',title:'缺口修复查询预览',status:'recorded',content:jsonData({gapRef:ref(gap),changeRef:args.changeRef,query,resolvedQuery,relationResolutions:mappings,before,after,verificationInputs:prepared.verification.inputs})});
    return {preview,before,after};
    });
  }
  linkChange(input:unknown,assertActive:()=>void=()=>{}){
    assertRole('change');
    assertActive();
    const args=action.extend({changeRef:qaReference,previewRef:qaReference}).strict().parse(input);
    return this.commit<GapResult>('link',args,()=>{
    assertActive();
    const gap=this.get(args.id),change=this.changes.read(args.changeRef.id,args.changeRef.version),preview=this.memory.getArtifact(args.previewRef.id,args.previewRef.version);
    if(gap.version!==args.version||gap.status!=='in_fix')throw new Error('缺口单当前不能关联修复');
    if(preview.kind!=='gap_preview'||(preview.content.gapRef as Data).id!==gap.id||JSON.stringify(preview.content.changeRef)!==JSON.stringify(args.changeRef)||fingerprint(preview.content.verificationInputs)!==fingerprint((change.content.verification as Data)?.inputs))throw new Error('必须关联该变更真实重放原查询的预览');
    if(!['verified','adopted'].includes(change.status))throw new Error('修复变更尚未通过复验');
    const saved=this.update(gap,change.status==='adopted'?'fixed':'in_fix',{changes:[...((gap.content.changes??[]) as Data[]).filter(link=>link.id!==change.id),{...ref(change),verificationSignature:fingerprint(preview.content.verificationInputs)}],previewRef:ref(preview),resolvedQuery:preview.content.resolvedQuery??preview.content.query,relationResolutions:preview.content.relationResolutions??[]});
    return {gap:saved};
    });
  }
  dismiss(input:unknown){
    assertRole('change');
    const args=action.extend({reason:z.string().trim().min(1).max(2000)}).strict().parse(input);
    return this.commit<GapResult>('dismiss',args,()=>{
    const {gap}=this.current({id:args.id,version:args.version,operationId:args.operationId});
    if(!['open','reopened'].includes(gap.status))throw new Error('当前缺口不能忽略');
    return {gap:this.update(gap,'dismissed',{dismissedReason:args.reason,dismissedAt:new Date().toISOString()})};
    });
  }
  /** Only the user-facing reask endpoint calls this. It is absent from both Agent tool sets. */
  async reask(input:unknown){
    assertRole('change');
    const args=action.extend({dataView:qaDataViewSchema.optional()}).strict().parse(input),previous=this.previous<ReaskResult>('reask',args);if(previous)return previous;
    const {gap}=this.current({id:args.id,version:args.version,operationId:args.operationId});
    if(gap.status!=='fixed')throw new Error('只有已采用修复的缺口可以复问确认');
    const result=await this.replay(String(gap.content.question),args.dataView??{kind:'working'})((gap.content.resolvedQuery??gap.content.query) as Data);
    return this.commit('reask',args,()=>{
    if(this.get(gap.id).version!==gap.version)throw new Error('复问期间缺口状态已变化，请重新读取');
    const success=result.status==='available'&&!reasons.has(String(result.reason??''));
    return {gap:this.update(gap,success?'confirmed':'reopened',{reaskedAt:new Date().toISOString(),reaskReceipt:result,reaskDataView:jsonData(args.dataView??{kind:'working'})}),result};
    });
  }
  private project(gap:Artifact):PendingItem {
    return {id:gap.id,version:gap.version,category:'gap',title:gap.title,origin:'qa',source:'qa',sources:[],objects:((gap.content.objects??[]) as string[]).map(id=>({id,label:id})),evidence:String(gap.content.observation),verification:null,
      impact:'修复采用后由用户重新提问确认；不会自动改写本体',status:gap.status,createdAt:gap.createdAt,stale:false,actions:{verify:false,adopt:false,reject:['open','reopened'].includes(gap.status),analyze:['open','in_fix','reopened'].includes(gap.status)},detailRef:{kind:'gap',id:gap.id,version:gap.version}};
  }
  list(){return this.memory.listArtifacts('question_gap').filter(item=>open.has(item.status)).map(item=>this.project(item));}
  read(id:string){let item:Artifact;try{item=this.memory.getArtifact(id);}catch{return null;}return item.kind==='question_gap'?this.project(item):null;}
}

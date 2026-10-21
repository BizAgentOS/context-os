import {randomUUID} from 'node:crypto';
import {consumerResult,assertConsumerQueryScope} from '../live/consumer-semantic.ts';
import {z} from 'zod';
import type {Artifact,Data,DomainTool} from './contracts.ts';
import type {MemoryStore} from './memory.ts';
import type {FoundationService} from './foundation.ts';
import type {LiveMemory} from '../live/memory.ts';
import type {Snapshots} from '../data/snapshots.ts';
import type {WorkspaceVersions} from '../engine/workspace-versions.ts';
import type {OntologyChanges} from '../engine/changes.ts';
import {SemanticQuery,semanticQuerySchema} from '../semantic/query.ts';
import {validateQuery} from '../semantic/query-sql.ts';
import {freezeQaView,type QaView} from './qa-view.ts';
import {jsonData} from '../live/sources.ts';
import {Gaps,type GapReading} from '../engine/gaps.ts';
import {parseLayeredModel} from '../semantic/model.ts';
import {identityDecisionsForModel} from '../live/identity.ts';

const text=z.string().trim().min(1).max(200),page={offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(20).default(20)};
const directory=z.object({...page,entityTypeId:text.optional()}).strict();
const search=z.object({...page,query:z.string().trim().min(1).max(500)}).strict();
const query=semanticQuerySchema.extend({page:z.object(page).strict().default({offset:0,limit:20})});
const evidence=z.object({readId:text,objectId:text.optional(),propertyId:text.optional()}).strict();
const gap=z.object({readId:text,observation:z.string().trim().min(1).max(2000)}).strict();
const schemas={ontology_describe:directory,ontology_search:search,objects_query:query,relations_traverse:query,objects_aggregate:semanticQuerySchema,evidence_read:evidence,knowledge_query:search,gap_report:gap};
const descriptions:Record<keyof typeof schemas,string>={
  ontology_describe:'读取当前数据视图内的实体、稳定属性和关系目录；没有原始来源或待处理内容。',
  ontology_search:'按名称、别名和说明检索当前数据视图的定义，返回稳定语义编号。',
  objects_query:'用稳定实体和属性编号读取最多20个对象，可按属性过滤与排序。返回实际覆盖、版本和依据引用。',
  relations_traverse:'用稳定关系编号向前或回溯最多3跳；自引用最多10层。未知关系、未绑定和身份不确定会明确说明。',
  objects_aggregate:'对获准属性计数、求和、平均或取极值；最多1000分组。不能把冲突、未知或覆盖不足当零。',
  evidence_read:'读取本轮查询readId中已获准的属性依据；不能传任意文档、快照或来源编号。',
  knowledge_query:'只检索当前视图已采用本体引用的文档片段，不读取任意原始来源。',
  gap_report:'根据本轮实际失败读取的readId记录缺口；原因、查询和回执由服务填写，不会修改本体或治理决定。',
};
export const qaTools:DomainTool[]=Object.entries(schemas).map(([name,schema])=>({name,description:descriptions[name as keyof typeof schemas],mutates:name==='gap_report',inputSchema:z.toJSONSchema(schema)}));
export interface QaBegin {dataView?:unknown;question:string;assertActive?:()=>void;taskId?:string;sessionId?:string}
type Reading={id:string;tool:string;query?:Data;status:string;reason?:string;message?:string;result:Data;readAt:string};
const gapReasons=new Set(['missing_relation','unbound','unmatched','identity_unresolved']);

/** A single run owns its budget, immutable view and actual readings; models supply only conclusions. */
export class QaRun {
  readonly tools=qaTools;readonly view:QaView;
  private reads:Reading[]=[];private calls=0;private bytes=0;private limits=new Set<string>();
  private reportedGaps=new Map<string,{id:string;version:number;title:string;status:string}>();
  private memory:MemoryStore;private live:LiveMemory;private semantic:SemanticQuery;private gaps:Gaps;private input:QaBegin;
  constructor(memory:MemoryStore,live:LiveMemory,semantic:SemanticQuery,gaps:Gaps,view:QaView,input:QaBegin){this.memory=memory;this.live=live;this.semantic=semantic;this.gaps=gaps;this.view=view;this.input=input;}
  private active(){this.input.assertActive?.();try{this.view.assertValid();}catch(error){if(this.view.selection.kind==='consumer')throw new Error('接入授权已变化或获准来源不可读取');throw error;}}
  private directory(input:z.infer<typeof directory>){
    const semantic=this.view.layered.semantic;
    if(input.entityTypeId&&!semantic.entityTypes.some(item=>item.id===input.entityTypeId))throw new Error('实体不在当前授权范围');
    const entities=semantic.entityTypes.filter(item=>!input.entityTypeId||item.id===input.entityTypeId).map(item=>({...item,properties:semantic.properties.filter(property=>property.entityTypeId===item.id)}));
    const relations=semantic.relationTypes.filter(item=>!input.entityTypeId||item.from===input.entityTypeId||item.to===input.entityTypeId);
    return jsonData({entities:entities.slice(input.offset,input.offset+input.limit),relations:relations.slice(input.offset,input.offset+input.limit),coverage:{offset:input.offset,entities:entities.length,relations:relations.length,complete:input.offset===0&&Math.max(entities.length,relations.length)<=input.limit}});
  }
  private sanitize(result:Data):Data {
    if(this.view.selection.kind!=='consumer')return result;
    return consumerResult(result,this.view.selection.connectionRef.id);
  }
  private unavailable(reason:string,message:string,result:Data={}){return{status:'unavailable',reason,message,result};}
  private async objects(name:string,args:z.infer<typeof semanticQuerySchema>){
    const {layered,options}=this.view,scope=options.scope;
    // Check every expression before looking up hidden definitions or reading any source.
    if(scope)assertConsumerQueryScope(args,scope);
    if(!layered.semantic.entityTypes.some(item=>item.id===args.target.entityTypeId))return this.unavailable('out_of_scope','此对象类型超出当前本体范围');
    if((!this.view.model&&!options.preparedModel)||!layered.bindings.entities.some(item=>item.entityTypeId===args.target.entityTypeId&&item.role==='primary'))return this.unavailable('unbound','该实体已有定义，尚未绑定可读取的数据');
    if(name==='objects_query'&&(args.traverse.length||args.aggregate))throw new Error('请使用关系遍历或聚合工具');
    if(name==='relations_traverse'&&(!args.traverse.length||args.aggregate))throw new Error('关系遍历需要明确路径，不能混入聚合');
    if(name==='objects_aggregate'&&!args.aggregate)throw new Error('聚合需要明确指标');
    for(const step of args.traverse){
      if(!layered.semantic.relationTypes.some(item=>item.id===step.relationTypeId))return this.unavailable('missing_relation','当前本体尚无此关系类型');
      if(!layered.bindings.relations.some(item=>item.relationTypeId===step.relationTypeId))return this.unavailable('unbound','关系已有定义，尚未绑定数据');
    }
    let result:Data;
    try{result=jsonData(await this.semantic.execute(args,{...options,maxPageSize:args.aggregate?100:20,includeGroupMembers:!!args.aggregate,assertActive:()=>this.active()}));}
    catch(error){
      this.active();const message=(error as Error).message;
      if(/扩展查询需要已同步的固定快照/.test(message))return this.liveFallback(args);
      if(/身份.*(不唯一|覆盖不完整|对应)|身份决定/.test(message))return this.unavailable('identity_unresolved','身份对应未确定，不能选择任意目标');
      if(/没有主绑定|没有可执行绑定|没有快照/.test(message))return this.unavailable('unbound','当前语义范围尚无可执行绑定');
      if(this.view.selection.kind==='consumer')throw new Error('获准数据暂不可读取，请联系维护者');
      throw error;
    }
    if(Array.isArray(result.groupMembers)){
      let remaining=20;
      result.groupMembers=(result.groupMembers as Data[]).map(group=>{const all=group.items as Data[],items=all.slice(0,remaining);remaining-=items.length;return {...group,items,coverage:{...group.coverage as Data,shown:items.length,complete:(group.coverage as Data).complete===true&&items.length===all.length}};});
    }
    const coverage=result.coverage as Data,empty=!(result.items as Data[]).length;
    const incomplete=coverage.sourceComplete===false||Number(coverage.uncertainFilterRows??0)>0||((result.traversal as Data|undefined)?.truncated===true);
    const rule=args.traverse.length===1&&args.traverse[0].direction==='out'?layered.bindings.identityRules.find(rule=>rule.kind==='belongs_to'&&rule.relationTypeId===args.traverse[0].relationTypeId):undefined;
    const explicitlyExcluded=rule&&args.target.id&&this.view.model&&identityDecisionsForModel(this.memory,this.view.model,options.identityDecisionPins).some(record=>record.content.ruleId===rule.id&&record.content.decision==='no_match'&&record.content.right===null&&(record.content.left as Data).recordId===args.target.id);
    return {status:incomplete?'partial':'available',...(incomplete?{reason:'incomplete',message:'读取覆盖不足或存在未确定值，不能代表完整结果'}:empty?{reason:args.traverse.length&&!explicitlyExcluded?'unmatched':'empty',message:explicitlyExcluded?'已采用身份决定明确排除此对应':args.traverse.length?'关系已绑定，但当前范围未匹配到目标':'当前完整范围没有匹配对象'}:{}),result};
  }
  private async liveFallback(args:z.infer<typeof semanticQuerySchema>){
    if(args.aggregate||args.traverse.length||args.sort.length||args.filters.some(filter=>filter.op!=='eq'||filter.value===null||filter.value===undefined))return this.unavailable('incomplete','当前视图含实时来源；完整遍历、排序或聚合需要固定快照，尚未执行该扩展读取');
    const {layered,model,options}=this.view,{fields}=validateQuery(layered,args,options),entity=layered.semantic.entityTypes.find(item=>item.id===args.target.entityTypeId)!;
    const property=(id:string)=>layered.semantic.properties.find(item=>item.id===id)!;
    const result=await this.live.query({modelId:model!.id,modelVersion:model!.version,type:entity.name,id:args.target.id,fields:['$id',...fields.map(id=>property(id).name)],where:Object.fromEntries(args.filters.map(filter=>[property(filter.propertyId).name,filter.value])),offset:args.page.offset,limit:args.page.limit,readMode:options.readMode},()=>this.active(),options.correctionPins,options.modelDefinition,true,options.readMode==='release_pinned'?options.pins:undefined,{readMode:options.readMode!,pins:options.pins!},options.identityDecisionPins,undefined,options.propertyCorrectionPins);
    const normalized=jsonData({...result,items:result.items.map(item=>({$id:String(item.$id),values:Object.fromEntries(fields.map(id=>[id,item[property(id).name]]))})),evidence:(result.evidence??[]).map(object=>({objectId:String(object.objectId),properties:Object.fromEntries(fields.map(id=>[id,object.properties[property(id).name]]))}))});
    return {status:result.coverage.complete?'available':'partial',reason:result.coverage.complete?undefined:'incomplete',message:'按当前来源实际返回的有界记录读取；不承诺跨来源一致时点',result:normalized};
  }
  async execute(name:string,value:unknown):Promise<Data>{
    this.active();const schema=schemas[name as keyof typeof schemas];if(!schema)throw new Error('问答模式没有这项只读能力');
    if(name==='gap_report'){
      const args=gap.parse(value),read=this.reads.find(item=>item.id===args.readId);
      if(!read||!read.query||!gapReasons.has(read.reason??''))throw new Error('只能报告本轮实际读取发现的建模、绑定或身份缺口');
      if(this.view.selection.kind==='consumer')throw new Error('接入方缺口回流默认关闭');
      this.active();const saved=this.gaps.report({question:this.input.question,dataView:this.view.selection,reading:read as GapReading,observation:args.observation,taskId:this.input.taskId,sessionId:this.input.sessionId});
      this.reportedGaps.set(saved.id,{id:saved.id,version:saved.version,title:saved.title,status:saved.status});return jsonData({gap:saved});
    }
    if(++this.calls>24){this.limits.add('本轮24次读取预算已用尽，回答仅覆盖已取得结果');throw new Error('本轮读取预算已用尽');}
    let result:Data,semanticQuery:Data|undefined,status='available',reason:string|undefined,message:string|undefined;
    if(name==='ontology_describe')result=this.directory(directory.parse(value));
    else if(name==='ontology_search'){
      const args=search.parse(value),term=args.query.toLocaleLowerCase(),semantic=this.view.layered.semantic;
      const all=[...semantic.entityTypes.map(item=>({...item,kind:'entity'})),...semantic.properties.map(item=>({...item,kind:'property'})),...semantic.relationTypes.map(item=>({...item,kind:'relation'}))].filter(item=>[item.name,item.description,...item.aliases].some(value=>value.toLocaleLowerCase().includes(term)));
      result=jsonData({items:all.slice(args.offset,args.offset+args.limit),coverage:{offset:args.offset,total:all.length,complete:args.offset===0&&all.length<=args.limit}});
    }else if(name==='knowledge_query'){
      const args=search.parse(value),foundation=this.view.foundation;
      if(this.view.selection.kind==='consumer')result={items:[],coverage:{complete:true,total:0},limit:'此接入方没有授权本体文档片段'};
      else{
        const ids=foundation?[...new Set([...(foundation.content.concepts??[]) as Data[],...(foundation.content.relations??[]) as Data[],...(foundation.content.properties??[]) as Data[]].flatMap(item=>(item.evidenceRefs??[]) as string[]))]:[];
        const records=foundation?this.memory.foundationEvidenceFor(foundation.id,foundation.version,ids,args.offset,args.limit):{items:[],total:0};
        const items=records.items.filter(item=>['document','knowledge','web'].includes(String(item.kind))&&[item.title,item.quote].some(value=>String(value??'').toLocaleLowerCase().includes(args.query.toLocaleLowerCase()))).map(({id,kind,title,quote,url})=>({id,kind,title,quote,url}));
        result=jsonData({items,coverage:{offset:args.offset,scanned:records.items.length,total:records.total,complete:args.offset===0&&records.total<=args.limit},limits:['只检索已采用本体引用的片段；不是企业全文检索']});
      }
    }else if(name==='evidence_read'){
      const args=evidence.parse(value),reading=this.reads.find(item=>item.id===args.readId);if(!reading)throw new Error('依据引用不属于本轮实际读取');
      if(this.view.evidencePropertyIds&&(!args.propertyId||!this.view.evidencePropertyIds.has(args.propertyId)))throw new Error('该属性的依据未获授权');
      let records=((reading.result.evidence??[]) as Data[]).filter(item=>!args.objectId||item.objectId===args.objectId).map(item=>({objectId:item.objectId,properties:Object.fromEntries(Object.entries((item.properties??{}) as Data).filter(([id])=>!args.propertyId||args.propertyId===id))}));
      if(args.objectId&&args.propertyId){
        const returned=((reading.result.items??[]) as Data[]).find(item=>item.$id===args.objectId),property=this.view.layered.semantic.properties.find(item=>item.id===args.propertyId);
        if(!returned||!property||!Object.hasOwn((returned.values??{}) as Data,property.id))throw new Error('只能读取该次结果中对象与属性的依据');
        const entity=this.view.layered.semantic.entityTypes.find(item=>item.id===property.entityTypeId)!,{options,model}=this.view;
        const actual=await this.live.query({modelId:model!.id,modelVersion:model!.version,type:entity.name,id:args.objectId,fields:['$id',property.name],limit:1,readMode:options.readMode},()=>this.active(),options.correctionPins,options.modelDefinition,true,options.readMode==='release_pinned'?options.pins:undefined,{readMode:options.readMode!,pins:options.pins!},options.identityDecisionPins,options.preparedFoundation,options.propertyCorrectionPins);
        records=(actual.evidence??[]).map(item=>({objectId:String(item.objectId),properties:jsonData({[property.id]:item.properties[property.name]})}));
      }
      result=jsonData({kind:'authorized_evidence',readId:reading.id,evidence:records});
      if(this.view.selection.kind==='consumer')result=jsonData({kind:'authorized_evidence',readId:reading.id,evidence:records.map(item=>({objectId:item.objectId,properties:Object.fromEntries(Object.entries(item.properties).map(([id,cell])=>{const data=cell as Data;return[id,{status:data.status,value:data.value,evidence:((data.evidence??[]) as Data[]).map(value=>({value:value.value,recordId:value.recordId,readAt:value.readAt}))}];}))}))});
    }else{
      const parsed=(name==='objects_aggregate'?semanticQuerySchema:query).parse(value);semanticQuery=jsonData(parsed);
      const answer=await this.objects(name,parsed);result=answer.result;status=answer.status;reason=answer.reason;message=answer.message;
    }
    this.active();const read:Reading={id:randomUUID(),tool:name,...(semanticQuery?{query:semanticQuery}:{}),status,...(reason?{reason}:{}),...(message?{message}:{}),result,readAt:new Date().toISOString()};
    const output=jsonData({readId:read.id,status,...(reason?{reason}:{}),...(message?{message}:{}),result:this.sanitize(result),receipt:{...this.view.receipt,readAt:read.readAt}});
    const bytes=Buffer.byteLength(JSON.stringify(output));if(this.bytes+bytes>512*1024){this.limits.add('本轮512 KiB依据预算已用尽，未交付超出部分');throw new Error('本轮依据读取预算已用尽');}
    this.bytes+=bytes;this.reads.push(read);if(status==='partial'||status==='unavailable')this.limits.add(message??'当前读取范围不足');return output;
  }
  answer(conclusion:string):Data{
    this.active();if(typeof conclusion!=='string')throw new Error('回答结论必须是文本');
    if(!this.reads.length)this.limits.add('本轮尚无实际读取依据，不能视为已验证结论');
    const values=this.reads.filter(read=>read.query||['knowledge_query','evidence_read'].includes(read.tool));
    const semantic=this.view.layered.semantic;
    const projection=(read:Reading)=>{
      const expression=read.query as z.infer<typeof semanticQuerySchema>|undefined,relations=semantic.relationTypes.filter(item=>expression?.traverse?.some(step=>step.relationTypeId===item.id));
      const propertyIds=new Set([...((read.result.items??[]) as Data[]).flatMap(item=>Object.keys((item.values??{}) as Data)),...((read.result.evidence??[]) as Data[]).flatMap(item=>Object.keys((item.properties??{}) as Data)),...((read.result.groupMembers??[]) as Data[]).flatMap(group=>(group.items as Data[]).flatMap(item=>Object.keys((item.values??{}) as Data))),...(expression?.filters??[]).map(item=>item.propertyId),...(expression?.sort??[]).map(item=>item.propertyId)]);
      const entityIds=new Set([expression?.target?.entityTypeId,...relations.flatMap(item=>[item.from,item.to])]),entities=semantic.entityTypes.filter(item=>entityIds.has(item.id));
      return {labels:Object.fromEntries([...entities,...relations,...semantic.properties.filter(item=>propertyIds.has(item.id))].map(item=>[item.id,item.name])),entities:entities.map(({id,name})=>({id,name})),relations:relations.map(({id,name,from,to})=>({id,name,from,to}))};
    };
    return jsonData({conclusion:conclusion.slice(0,24000),evidence:values.map(read=>({readId:read.id,query:read.query,labels:projection(read).labels,status:read.status,reason:read.reason??null,result:this.sanitize(read.result)})),gaps:[...this.reportedGaps.values()],
      receipt:{...this.view.receipt,readCount:this.calls,bytes:this.bytes,readings:values.map(read=>({readId:read.id,readAt:read.readAt,sources:this.sanitize(read.result).sources??[],coverage:read.result.coverage??null,versions:read.result.versions??null}))},limits:[...this.limits],
      visualization:values.filter(read=>read.query).map(read=>({readId:read.id,query:read.query,...projection(read),coverage:read.result.coverage??null,columns:read.result.columns??[],status:read.status,resultSet:this.sanitize(read.result).items??[],groupMembers:read.result.groupMembers??[],paths:read.result.paths??[],
        ...(read.reason&&gapReasons.has(read.reason)?{missing:{from:(read.query?.target as Data)?.entityTypeId,reason:read.reason,query:read.query}}:{})}))});
  }
}

export class QuestionAnswering {
  readonly gaps:Gaps;private memory:MemoryStore;private foundation:FoundationService;private live:LiveMemory;private versions:WorkspaceVersions;private semantic:SemanticQuery;
  constructor(memory:MemoryStore,foundation:FoundationService,live:LiveMemory,snapshots:Snapshots,versions:WorkspaceVersions,changes:OntologyChanges){
    this.memory=memory;this.foundation=foundation;this.live=live;this.versions=versions;this.semantic=new SemanticQuery(memory,live,snapshots);
    this.gaps=new Gaps(memory,changes,(question,dataView,preview,assertActive=()=>{})=>{
      const view=freezeQaView(memory,foundation,live,versions,dataView,assertActive);
      const assertBaseline=()=>{assertActive();view.assertValid();const current=foundation.read().adopted;if(memory.listArtifacts('live_ontology').some(item=>item.status==='adopted')||current?.id!==view.foundation?.id||current?.version!==view.foundation?.version)throw new Error('首个模型预览期间工作版已变化');};
      const preparedModel=preview&&!view.model&&preview.foundation?{definition:preview.definition,foundation:preview.foundation,assertUnchanged:assertBaseline}:undefined;
      const preparedReading=preview&&view.model?live.capturePreviewReading({id:view.model.id,version:view.model.version},preview.definition):preparedModel?{readMode:'active_snapshot' as const,pins:live.preparedReader(preparedModel.definition,preparedModel.foundation,assertBaseline).pins}:undefined;
      return async(expression,usePreview=false)=>{
        assertActive();
        let selected=view;
        if(preparedReading)selected={...view,options:{...view.options,...preparedReading}};
        if(usePreview&&preview){
          const options={...selected.options,modelDefinition:preview.definition,preparedFoundation:preview.foundation,...(preparedModel?{preparedModel}:{}),...(preview.corrections?.relations?{correctionPins:{records:preview.corrections.relations}}:{}),...(preview.corrections?.properties?{propertyCorrectionPins:{records:preview.corrections.properties}}:{})};
          selected={...selected,layered:parseLayeredModel(preview.definition.layered),options,assertValid:()=>{view.assertValid();if(preparedModel)assertBaseline();else if(view.model)live.identityReader(view.model,options).assertValid();}};
        }
        const run=new QaRun(memory,live,this.semantic,this.gaps,selected,{question,dataView,assertActive});
        return run.execute(expression.aggregate?'objects_aggregate':expression.traverse&&Array.isArray(expression.traverse)&&expression.traverse.length?'relations_traverse':'objects_query',expression);
      };
    });
  }
  begin(input:QaBegin){const view=freezeQaView(this.memory,this.foundation,this.live,this.versions,input.dataView,input.assertActive);return new QaRun(this.memory,this.live,this.semantic,this.gaps,view,input);}
}

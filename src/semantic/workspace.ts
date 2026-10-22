import {readStructure} from "../engine/structure-changes.ts";
import {z} from 'zod';
import type {Artifact,Data} from '../agent/contracts.ts';
import type {MemoryStore} from '../agent/memory.ts';
import type {FoundationService} from '../agent/foundation.ts';
import type {LiveMemory} from '../live/memory.ts';
import type {PendingCenter} from '../engine/pending.ts';
import type {WorkspaceVersions} from '../engine/workspace-versions.ts';
import type {LayeredModel} from './model.ts';
import {confirmedRelationWording} from '../engine/naming-relation-labels.ts';
import {SemanticQuery} from './query.ts';

const detailInput=z.object({kind:z.enum(['entity','relation']),id:z.string().min(1).max(200),developer:z.boolean().default(false),evidenceOffset:z.number().int().min(0).default(0)}).strict();
const list=(input:unknown):Data[]=>Array.isArray(input)?input as Data[]:[];
const ref=(item:Artifact|null)=>item?{id:item.id,version:item.version}:null;
const label=(item:Data|undefined)=>String(item?.name??'未命名');
/** Server-owned read model. It projects the adopted semantics; pending changes are marked, never applied here. */
export class OntologyWorkspace {
 private memory:MemoryStore;private foundation:FoundationService;private live:LiveMemory;private pending:PendingCenter;private versions:WorkspaceVersions;
 constructor(memory:MemoryStore,foundation:FoundationService,live:LiveMemory,pending:PendingCenter,versions:WorkspaceVersions){this.memory=memory;this.foundation=foundation;this.live=live;this.pending=pending;this.versions=versions;}
 private current(){
  const foundation=this.foundation.read({evidence:'compact'}).adopted;
  const model=this.memory.listArtifacts('live_ontology').find(item=>item.status==='adopted')??null;
  const layered=readStructure(this.memory,this.foundation,this.live);
  return{foundation,model,layered};
 }
 private bindings(layered:LayeredModel|null,entityId:string){
  return (layered?.bindings.entities??[]).filter(item=>item.entityTypeId===entityId).map(binding=>{
   let title='来源待核对';try{title=this.memory.getArtifact(binding.dataset.sourceId).title;}catch{}
   return {...binding,sourceTitle:title,roleLabel:binding.role==='primary'?'主来源':'补充来源'};
  });
 }
 private proposals(layered:LayeredModel|null){
  const entities:Array<{definition:Data;change:Artifact}>=[],relations:Array<{definition:Data;change:Artifact}>=[];
  for(const change of this.memory.listArtifacts('ontology_change').filter(item=>['proposed','verified','failed'].includes(item.status))){
   const subject=change.content.subject as Data,type=change.content.type;
   if(type==='entity'&&subject.action==='add'&&subject.entity)entities.push({definition:subject.entity as Data,change});
   if(subject.candidateRef){
    const reference=subject.candidateRef as Data;let candidate:Artifact;try{candidate=this.memory.getArtifact(String(reference.id),Number(reference.version));}catch{continue;}
    if(candidate.kind!=='engine_candidate')continue;
    const selection=subject.selection as Data|null;
    for(const [key,target,field] of [['entities',entities,'concepts'],['relations',relations,'relations']] as const){
     for(const id of (selection?.[key]??[]) as string[]){const definition=list(candidate.content[field]).find(item=>item.id===id);if(definition)target.push({definition,change});}
    }
   }
   if(type==='relation'&&subject.from&&subject.to&&!subject.candidateRef){
    const endpoints=[subject.from,subject.to] as Data[],ends=endpoints.map(end=>(layered?.bindings.entities??[]).filter(binding=>binding.role==='primary'&&this.live.snapshots?.bindingDataset?.(binding.dataset.sourceId,binding.dataset.capability)?.id===end.datasetId));
    if(ends.some(matches=>matches.length!==1))continue;
    const wording=confirmedRelationWording(this.memory,subject);
    relations.push({change,definition:{id:`proposal:${change.id}`,name:wording?.name??`${String(endpoints[0].column)} 对应`,description:wording?.description??change.content.evidence??'',from:ends[0][0].entityTypeId,to:ends[1][0].entityTypeId,cardinality:subject.cardinality??'N:1'}});
   }
  }
  return{entities,relations};
 }
 private relatedPending(id:string,proposals:ReturnType<OntologyWorkspace['proposals']>){
  const result=this.pending.list({object:id,limit:100}),items=new Map(result.items.map(item=>[item.id,item])),additional=new Set<string>();
  for(const {definition,change}of [...proposals.entities,...proposals.relations])if([definition.id,definition.from,definition.to].includes(id)){
   const item=this.pending.read(change.id);items.set(change.id,item);if(!item.objects.some(object=>object.id===id))additional.add(change.id);
  }
  return{...result,filteredTotal:result.filteredTotal+additional.size,items:[...items.values()]};
 }
 overview(){
  const {foundation,model,layered}=this.current(),summary=this.pending.summary();
  const concepts=list(foundation?.content.concepts),definitions=list(foundation?.content.relations);
  const proposals=this.proposals(layered);
  const entities=concepts.map(item=>{
   const entity=layered?.semantic.entityTypes.find(entity=>entity.id===item.id);
   const bindings=this.bindings(layered,String(item.id));
   const pending=this.relatedPending(String(item.id),proposals).filteredTotal;
   return {id:String(item.id),name:label(item),description:String(item.description??''),aliases:item.aliases??[],unnamed:item.origin==='program'&&/[_]|^[a-z\d]+$/i.test(label(item)),proposalRef:undefined as {id:string;version:number}|undefined,
    properties:entity?layered!.semantic.properties.filter(p=>p.entityTypeId===entity.id):[],identityKeys:entity?.identityKeys??[],bindings,
    state:pending?'pending':bindings.length?'adopted':'empty',pending};
  });
  for(const {change,definition:entity}of proposals.entities)if(!entities.some(item=>item.id===entity.id))entities.push({id:String(entity.id),name:label(entity),description:String(entity.description??''),aliases:entity.aliases??[],unnamed:entity.origin==='program',properties:[],identityKeys:[],bindings:[],state:'pending',pending:this.relatedPending(String(entity.id),proposals).filteredTotal,proposalRef:{id:change.id,version:change.version}});
  const relations=definitions.map(item=>{
   const relation=layered?.semantic.relationTypes.find(relation=>relation.id===item.id);
   const bound=layered?.bindings.relations.some(binding=>binding.relationTypeId===item.id);
   const pending=this.relatedPending(String(item.id),proposals).filteredTotal;
   return {id:String(item.id),name:label(item),description:String(item.description??''),from:String(item.from),to:String(item.to),
    fromName:label(concepts.find(c=>c.id===item.from)),toName:label(concepts.find(c=>c.id===item.to)),cardinality:relation?.cardinality??'尚未绑定',
    state:pending?'pending':bound?'adopted':'empty',pending,proposalRef:undefined as {id:string;version:number}|undefined};
  });
  for(const {definition:item,change}of proposals.relations)if(!relations.some(relation=>relation.id===item.id)&&[item.from,item.to].every(id=>entities.some(entity=>entity.id===id)))relations.push({id:String(item.id),name:label(item),description:String(item.description??''),from:String(item.from),to:String(item.to),fromName:entities.find(entity=>entity.id===item.from)!.name,toName:entities.find(entity=>entity.id===item.to)!.name,cardinality:String(item.cardinality??'待复验'),state:'pending',pending:this.relatedPending(String(item.id),proposals).filteredTotal,proposalRef:ref(change)!});
  const nextSteps:Array<{label:string;action:string;category?:string}>=[];
  if(summary.total)nextSteps.push({label:`${summary.total} 项变更或问题等待处理`,action:'pending'});
  if(!entities.length)nextSteps.push({label:'接入结构化数据，构建第一个业务对象',action:'data'});
  else if(entities.some(e=>e.unnamed))nextSteps.push({label:'核对自动发现的对象名称',action:'naming',category:'naming'});
  else if(entities.some(e=>e.state==='empty'))nextSteps.push({label:'为尚无数据的对象连接来源',action:'data'});
  else nextSteps.push({label:'围绕企业对象提问，核对数据与依据',action:'ask'});
  return {title:String((foundation?.content.enterprise as Data|undefined)?.name??'企业本体'),foundationRef:ref(foundation),modelRef:ref(model),workspaceVersion:Number(this.versions.latest()?.content.number??0),entities,relations,sourceCatalog:this.live.sources.list().filter(source=>source.status==='ready').map(source=>({id:source.id,name:source.title,capabilities:list(source.content.capabilities).filter(cap=>cap.contentKind==='records').map(cap=>({name:String(cap.name),fields:cap.fields as string[],idField:String(cap.idField)}))})),pending:summary,nextSteps:nextSteps.slice(0,2)};
 }
 async detail(input:unknown){
  const args=detailInput.parse(input),{foundation,model,layered}=this.current();
  const overview=this.overview(),items=args.kind==='entity'?overview.entities:overview.relations;
  const item=items.find(item=>item.id===args.id);if(!item)throw new Error('本体对象不存在');
  if('proposalRef' in item&&item.proposalRef)throw new Error('该实体尚未采用，请在待处理中心查看提议');
  const original=list(foundation?.content[args.kind==='entity'?'concepts':'relations']).find(item=>item.id===args.id)!;
  const evidenceIds=(original.evidenceRefs??[]) as string[];
  // Evidence is fetched by immutable owner reference and then bounded for this object.
  const evidence=foundation?this.memory.foundationEvidenceFor(foundation.id,foundation.version,evidenceIds,args.evidenceOffset,20):{total:0,items:[]};
  const records=evidence.items.map(entry=>{
   const {webSnapshot,knowledgeSnapshot,apiSnapshot,...safe}=entry;return safe;
  });
  const relation=args.kind==='relation'?overview.relations.find(r=>r.id===args.id)!:null;
  const relations=args.kind==='entity'?overview.relations.filter(r=>r.from===args.id||r.to===args.id):[];
  const bindings=args.kind==='entity'?this.bindings(layered,args.id):(layered?.bindings.relations??[]).filter(r=>r.relationTypeId===args.id);
  const property=args.kind==='entity'?layered?.semantic.properties.filter(p=>p.entityTypeId===args.id)??[]:[];
  let match;
  if(relation){
   try{
    const snapshots=this.live.snapshots;if(!model||!snapshots?.read||!snapshots.bindingDataset)throw new Error('关系尚未绑定可读取的快照');
    const result=await new SemanticQuery(this.memory,this.live,{read:snapshots.read.bind(snapshots),bindingDataset:snapshots.bindingDataset.bind(snapshots)}).execute({target:{entityTypeId:relation.from},fields:[],traverse:[{relationTypeId:relation.id}],page:{limit:1}},{modelRef:ref(model)!,relationReportId:relation.id});
    match={...result.relationReport,sources:result.sources,readMode:result.readMode,governance:result.governance};
   }catch(error){match={status:'unavailable',matchRate:null,reason:(error as Error).message};}
  }
  return {...item,kind:args.kind,title:relation?`${relation.fromName} → ${relation.name} → ${relation.toName}`:item.name,
   foundationRef:ref(foundation),modelRef:ref(model),properties:property,relations,bindings,propertyBindings:layered?.bindings.properties.filter(binding=>property.some(item=>item.id===binding.propertyId))??[],
   evidence:{total:evidence.total,items:records,nextOffset:args.evidenceOffset+records.length<evidence.total?args.evidenceOffset+records.length:null},
   pending:this.relatedPending(args.id,this.proposals(layered)),...(match?{match}:{}),
   ...(args.developer?{technical:{foundationRef:ref(foundation),modelRef:ref(model),definition:original}}:{})};
 }
}

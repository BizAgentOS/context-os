import type {Artifact,Data} from './contracts.ts';
import type {MemoryStore} from './memory.ts';
import type {FoundationService} from './foundation.ts';
import type {LiveMemory} from '../live/memory.ts';
import {readStructure} from '../engine/structure-changes.ts';

export interface ExampleQuestion {id:string;question:string;tool:'objects_query'|'objects_aggregate'|'relations_traverse';args:Data;refs:{entityTypeIds:string[];relationTypeIds:string[];propertyIds:string[]};}

const rows=(value:unknown):Data[]=>Array.isArray(value)?value as Data[]:[];
const reference=(item:Artifact|undefined|null)=>item?{id:item.id,version:item.version}:null;

/** A read-only account of actual work. Navigating the guide never creates or adopts ontology. */
export class FirstUse {
  private memory:MemoryStore;private foundation:FoundationService;private live?:LiveMemory;
  constructor(memory:MemoryStore,foundation:FoundationService,live?:LiveMemory){this.memory=memory;this.foundation=foundation;this.live=live;}
  examples(){
    const workspace=this.memory.listArtifacts('workspace_version')[0],base={workspaceRef:reference(workspace),dataView:{kind:'working' as const}};
    const empty=(message:string)=>({...base,questions:[] as ExampleQuestion[],message});
    const model=this.memory.listArtifacts('live_ontology').find(item=>item.status==='adopted');
    if(!model||!this.live)return empty('接入结构化来源并完成构建后，将根据可查询本体提供示例问题。');
    try{this.live.assertModel(model.id,model.version);}catch{return empty('当前来源或绑定需要处理；恢复可读取状态后再提供示例问题。');}
    const layered=readStructure(this.memory,this.foundation,this.live),semantic=layered.semantic;
    const primary=new Set(layered.bindings.entities.filter(item=>item.role==='primary').map(item=>item.entityTypeId));
    const entities=semantic.entityTypes.filter(item=>primary.has(item.id)).sort((a,b)=>a.name.localeCompare(b.name));
    if(!entities.length)return empty('已有本体定义尚未连接业务记录，接入来源后再提供查询示例。');
    const entity=entities[0],boundProperties=new Set(layered.bindings.properties.map(item=>item.propertyId));
    const properties=semantic.properties.filter(item=>item.entityTypeId===entity.id&&boundProperties.has(item.id));
    const fields=properties.slice(0,4).map(item=>item.id),refs={entityTypeIds:[entity.id],relationTypeIds:[],propertyIds:fields};
    const questions:ExampleQuestion[]=[
      {id:`count:${entity.id}`,question:`当前共有多少条“${entity.name}”记录？请说明数据截至时间和覆盖范围。`,tool:'objects_aggregate',args:{target:{entityTypeId:entity.id},aggregate:{measures:[{as:'total',op:'count'}]}},refs:{...refs,propertyIds:[]}},
      {id:`list:${entity.id}`,question:`查看“${entity.name}”的前5条记录${properties.length?`及${properties.slice(0,4).map(item=>item.name).join('、')}`:''}，并列出来源依据。`,tool:'objects_query',args:{target:{entityTypeId:entity.id},fields,page:{offset:0,limit:5}},refs},
    ];
    const relation=semantic.relationTypes.find(item=>item.from===entity.id&&primary.has(item.to)&&layered.bindings.relations.some(binding=>binding.relationTypeId===item.id));
    const numeric=properties.find(item=>['integer','decimal'].includes(item.valueType));
    if(relation){const target=semantic.entityTypes.find(item=>item.id===relation.to)!;
      questions.push({id:`relation:${relation.id}`,question:`“${entity.name}”通过“${relation.name}”关联了哪些“${target.name}”？列出最多5条实际结果及依据。`,tool:'relations_traverse',args:{target:{entityTypeId:entity.id},traverse:[{relationTypeId:relation.id}],page:{offset:0,limit:5}},refs:{entityTypeIds:[entity.id,target.id],relationTypeIds:[relation.id],propertyIds:[]}});
    }else if(numeric)questions.push({id:`sum:${numeric.id}`,question:`“${entity.name}”的“${numeric.name}”合计是多少？请区分缺失值、冲突和读取范围。`,tool:'objects_aggregate',args:{target:{entityTypeId:entity.id},aggregate:{measures:[{as:'total',op:'sum',propertyId:numeric.id}]}},refs:{...refs,propertyIds:[numeric.id]}});
    else if(entities[1]){const other=entities[1];questions.push({id:`count:${other.id}`,question:`当前共有多少条“${other.name}”记录？请说明来源与覆盖范围。`,tool:'objects_aggregate',args:{target:{entityTypeId:other.id},aggregate:{measures:[{as:'total',op:'count'}]}},refs:{entityTypeIds:[other.id],relationTypeIds:[],propertyIds:[]}});}
    else if(properties[0]){const property=properties[0];questions.push({id:`group:${property.id}`,question:`按“${properties[0].name}”分组统计“${entity.name}”记录数，并说明是否完整。`,tool:'objects_aggregate',args:{target:{entityTypeId:entity.id},aggregate:{groupBy:[property.id],measures:[{as:'total',op:'count'}]},page:{offset:0,limit:20}},refs:{...refs,propertyIds:[property.id]}});}
    else questions.push({id:`identity:${entity.id}`,question:`列出“${entity.name}”的前5个记录标识，并说明实际读取来源。`,tool:'objects_query',args:{target:{entityTypeId:entity.id},fields:[],page:{offset:0,limit:5}},refs:{...refs,propertyIds:[]}});
    return {...base,questions,message:'示例来自当前已采用的实体、属性与关系；点击后按本次实际读取回答。'};
  }
  progress(configured:boolean){
    const foundation=this.foundation.read().adopted,model=this.memory.listArtifacts('live_ontology').find(item=>item.status==='adopted');
    const sources=this.memory.listArtifacts('source').filter(item=>item.status==='ready'&&item.content.format==='csv');
    const connections=this.memory.listArtifacts('source_connection').filter(item=>item.status==='ready'&&!item.content.localSource&&rows(item.content.capabilities).some(cap=>!cap.contentKind||cap.contentKind==='records'));
    const datasets=this.memory.listArtifacts('data_dataset'),active=datasets.filter(item=>item.content.activeVersion);
    const job=this.memory.listArtifacts('engine_build')[0],running=job&&['queued','running'].includes(job.status);
    const issues=[...rows(job?.content.issues),...this.memory.listArtifacts('sync_issue').filter(item=>item.status==='open').map(item=>({message:item.title,ref:reference(item)}))];
    const entities=rows(foundation?.content.concepts).length,relations=rows(foundation?.content.relations).length;
    const pending=this.memory.listArtifacts('ontology_change').filter(item=>['proposed','verified','failed'].includes(item.status));
    const naming=this.memory.listArtifacts('naming_job')[0],namingChange=pending.find(item=>(item.content.owner as Data|undefined)?.kind==='naming_batch');
    const answeredAt=(item:Artifact)=>String(item.content.finishedAt??item.createdAt);
    const answer=this.memory.listArtifacts('agent_run').filter(item=>item.status==='completed'&&rows((item.content.answer as Data|undefined)?.evidence).some(read=>read.status==='available')).sort((a,b)=>answeredAt(a).localeCompare(answeredAt(b)))[0];
    const sourceCount=sources.length+connections.length;
    return {modelConfigured:configured,uploads:this.memory.listArtifacts('table_upload_batch').filter(item=>item.status==='collecting').map(item=>({ref:reference(item)!,received:rows(item.content.sources).length,errors:rows(item.content.errors)})),
      build:{status:running?'running':job&&['failed','cancelled','interrupted'].includes(job.status)?'needs_attention':model&&entities?'ready':sourceCount?'waiting_build':'waiting_source',
        jobRef:reference(job),sourceCount,sourcesRead:active.length,steps:rows(job?.content.steps),issues,hasStructuredSource:sourceCount>0},
      ontology:{entities,relations,pending:pending.length,pendingRelations:pending.filter(item=>item.content.type==='relation').length,foundationRef:reference(foundation),modelRef:reference(model)},
      naming:{status:namingChange?'review':naming?.status==='queued'&&!configured?'waiting_model':naming?.status??'idle',changeRef:reference(namingChange),error:naming?.content.error??null},
      firstAnswer:answer?{runRef:reference(answer),at:answeredAt(answer),question:answer.title}:null};
  }
}

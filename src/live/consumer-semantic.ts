import {createHash} from 'node:crypto';
import type {Artifact,Data} from '../agent/contracts.ts';
import type {MemoryStore} from '../agent/memory.ts';
import type {LiveMemory} from './memory.ts';
import type {LayeredModel} from '../semantic/model.ts';
import type {SemanticQueryOptions,SemanticQueryRequest} from '../semantic/query-contract.ts';
import {ConsumerViews} from './consumer-views.ts';
import {jsonData} from './sources.ts';

export class ConsumerScopeError extends Error {}

/** Both in-product consumer QA and deterministic external queries use this exact grant projection. */
export function consumerSemanticScope(memory:MemoryStore,live:LiveMemory,dataset:Artifact,layered:LayeredModel,options:SemanticQueryOptions){
  const business=dataset.content.business as Data|null,viewRef=business?.viewRef as {id:string;version:number}|undefined;
  const assertValid=()=>{
    const current=memory.getArtifact(dataset.id);
    if(current.kind!=='ontology_dataset'||current.status!=='active'||current.version!==dataset.version)throw new ConsumerScopeError('接入数据集已停用或变化');
    if(viewRef)new ConsumerViews(memory,live).assertLinkedReadable(viewRef);
  };
  assertValid();
  const grants=(business?.grants??[]) as Array<{type:string;fields:string[];relations:string[];evidence?:{fields:string[];relations:string[]}}>;
  const entityIds=new Set((dataset.content.concepts as Data[]).map(item=>String(item.id))),relationIds=new Set((dataset.content.relations as Data[]).map(item=>String(item.id)));
  const propertyIds=new Set<string>(),evidencePropertyIds=new Set<string>(),businessEntityIds=new Set<string>();
  for(const grant of grants){
    const entity=layered.semantic.entityTypes.find(item=>item.name===grant.type);
    if(!entity||!entityIds.has(entity.id))throw new ConsumerScopeError('接入方业务范围与发布不一致');
    businessEntityIds.add(entity.id);
    for(const property of layered.semantic.properties.filter(item=>item.entityTypeId===entity.id)){
      if(grant.fields.includes(property.name))propertyIds.add(property.id);
      if(grant.evidence?.fields.includes(property.name))evidencePropertyIds.add(property.id);
    }
  }
  const grantedRelations=new Set(layered.semantic.relationTypes.filter(relation=>relationIds.has(relation.id)&&entityIds.has(relation.from)&&entityIds.has(relation.to)&&grants.some(grant=>grant.type===layered.semantic.entityTypes.find(entity=>entity.id===relation.from)?.name&&grant.relations.includes(relation.name))).map(relation=>relation.id));
  const projection=structuredClone(layered);
  projection.semantic.entityTypes=projection.semantic.entityTypes.filter(item=>entityIds.has(item.id)).map(item=>({...item,identityKeys:item.identityKeys.filter(id=>propertyIds.has(id))}));
  projection.semantic.properties=projection.semantic.properties.filter(item=>propertyIds.has(item.id));
  projection.semantic.relationTypes=projection.semantic.relationTypes.filter(item=>relationIds.has(item.id)&&entityIds.has(item.from)&&entityIds.has(item.to));
  return{layered:projection,options:{...options,scope:{entityTypeIds:businessEntityIds,propertyIds,relationTypeIds:grantedRelations}},evidencePropertyIds,businessEntityIds,assertValid};
}

export function assertConsumerQueryScope(query:SemanticQueryRequest,scope:NonNullable<SemanticQueryOptions['scope']>){
  const properties=[...(query.fields??[]),...query.filters.map(item=>item.propertyId),...query.sort.map(item=>item.propertyId),...(query.aggregate?.groupBy??[]),...(query.aggregate?.measures.flatMap(item=>item.propertyId?[item.propertyId]:[])??[])];
  if(!scope.entityTypeIds.has(query.target.entityTypeId)||properties.some(id=>!scope.propertyIds.has(id))||query.traverse.some(step=>!scope.relationTypeIds.has(step.relationTypeId)))throw new ConsumerScopeError('查询表达式不在接入方授权范围');
}

/** Raw source addresses, SQL, governance records and ungranted evidence never cross the consumer boundary. */
export function consumerResult(result:Data,consumerId:string):Data{
  if(result.kind==='authorized_evidence')return result;
  const safe=jsonData(result);delete safe.governance;delete safe.evidence;delete safe.aggregateEvidence;
  if(Array.isArray(safe.sources))safe.sources=(safe.sources as Data[]).map((source,index)=>({name:`来源 ${index+1}`,id:createHash('sha256').update(consumerId+':'+source.id).digest('hex').slice(0,24),readMode:source.readMode,dataAsOf:source.dataAsOf,coverage:source.coverage,status:source.status??'read'}));
  return safe;
}

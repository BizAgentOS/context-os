import {metricReferenceSchema} from '../semantic/metric-contract.ts';
import {fingerprint} from './release-diff.ts';
import type {Artifact,Data} from '../agent/contracts.ts';
import {migrateLegacyModel,parseLayeredModel,type LegacyModel} from '../semantic/model.ts';
import {consumerGrant} from '../live/consumer-views.ts';

/** Resolve grants only against their frozen release, never current names or aliases. */
export function releaseScope(connection:Artifact,release:Artifact){
 const definition=release.content.definition as Data,model=definition.model as Data|null;
 const semantic=model?(model.layered?parseLayeredModel(model.layered):migrateLegacyModel(model as unknown as LegacyModel)).semantic:null;
 const entities=(definition.concepts as Data[]).filter(item=>(connection.content.conceptIds as string[]).includes(String(item.id)));
 const relations=(definition.relations as Data[]).filter(item=>(connection.content.relationIds as string[]).includes(String(item.id)));
 const grants=consumerGrant.array().parse((connection.content.business as Data|null)?.grants??[]).map(grant=>{
  const entity=semantic?.entityTypes.find(item=>item.name===grant.type);if(!entity)throw new Error('已授权业务对象无法对应发布定义');
  const property=(name:string)=>{const p=semantic!.properties.find(item=>item.entityTypeId===entity.id&&item.name===name);if(!p)throw new Error(`已授权属性「${name}」无法对应发布定义`);return p;};
  const relation=(name:string)=>{const r=semantic!.relationTypes.find(item=>item.from===entity.id&&item.name===name);if(!r)throw new Error(`已授权关系「${name}」无法对应发布定义`);return r;};
  return {entityTypeId:entity.id,objectId:grant.fields.includes('$id'),propertyIds:grant.fields.filter(name=>name!=='$id').map(name=>property(name).id),relationIds:grant.relations.map(name=>relation(name).id),
   ...(grant.evidence?{evidence:{propertyIds:grant.evidence.fields.map(name=>property(name).id),relationIds:grant.evidence.relations.map(name=>relation(name).id)}}:{})};
 });
 const metrics=metricReferenceSchema.array().parse(definition.metricReferences??[]).filter(item=>((connection.content.metricIds??[]) as string[]).includes(item.id));
 const propertyIds=new Set([...grants.flatMap(grant=>grant.propertyIds),...metrics.flatMap(item=>item.dimensions.map(mapping=>mapping.propertyId))]);
 const properties=[...new Map([...(semantic?.properties??[]),...((definition.properties??[]) as Data[])].map(item=>[item.id,item])).values()];
 return {entities,metrics,properties:properties.filter(item=>propertyIds.has(String(item.id))),relations,grants,
  evidence:grants.map(grant=>({entityTypeId:grant.entityTypeId,propertyIds:grant.evidence?.propertyIds??[],relationIds:grant.evidence?.relationIds??[]}))};
}

export function upgradedSelection(connection:Artifact,from:Artifact,to:Artifact){
 const scope=releaseScope(connection,from),definition=to.content.definition as Data,model=definition.model as Data|null;
 const semantic=model?(model.layered?parseLayeredModel(model.layered):migrateLegacyModel(model as unknown as LegacyModel)).semantic:null;
 const concepts=definition.concepts as Data[],relations=definition.relations as Data[];
 for(const id of connection.content.conceptIds as string[])if(!concepts.some(item=>item.id===id&&!item.deprecated))throw new Error('目标版本缺少已授权对象，不能扩大或替换原授权');
 for(const id of connection.content.relationIds as string[])if(!relations.some(item=>item.id===id&&!item.deprecated&&(connection.content.conceptIds as string[]).includes(String(item.from))&&(connection.content.conceptIds as string[]).includes(String(item.to))))throw new Error('目标版本缺少已授权关系或关系端点不在授权范围');
 const grants=scope.grants.map(grant=>{
  const entity=semantic?.entityTypes.find(item=>item.id===grant.entityTypeId),type=(model?.types as Data[]|undefined)?.find(item=>item.conceptId===grant.entityTypeId);
  if(!entity||!type)throw new Error('目标版本缺少已授权业务对象绑定');
  const fields=new Set([...Object.keys(type.fields as Data),...((type.supplements??[]) as Data[]).flatMap(item=>Object.keys(item.fields as Data))]);
  const property=(id:string)=>{const p=semantic!.properties.find(item=>item.id===id&&item.entityTypeId===entity.id);if(!p||!fields.has(p.name))throw new Error('目标版本缺少已授权字段或字段绑定');return p.name;};
  const relation=(id:string)=>{const r=semantic!.relationTypes.find(item=>item.id===id&&item.from===entity.id);if(!r||!(model!.relations as Data[]).some(item=>item.relationId===id))throw new Error('目标版本缺少已授权业务关系');return r.name;};
  return {type:entity.name,fields:[...(grant.objectId?['$id']:[]),...grant.propertyIds.map(property)],relations:grant.relationIds.map(relation),
   ...(grant.evidence?{evidence:{fields:grant.evidence.propertyIds.map(property),relations:grant.evidence.relationIds.map(relation)}}:{})};
 });
 const available=metricReferenceSchema.array().parse(definition.metricReferences??[]);
 for(const old of scope.metrics){
  const next=available.find(item=>item.id===old.id);
  const authority=(item:typeof old)=>({entityTypeId:item.entityTypeId,metricId:item.metricId,sourceId:item.sourceId,capability:item.capability,dimensions:item.dimensions,access:item.access});
  if(!next||fingerprint(authority(old))!==fingerprint(authority(next)))throw new Error('指标来源、维度或能力范围已变化，请重新选择并确认指标授权');
 }
 return {conceptIds:connection.content.conceptIds,relationIds:connection.content.relationIds,metricIds:connection.content.metricIds??[],...(connection.content.business?{business:{grants}}:{})};
}

/** Governance and binding rows refer indirectly to semantic IDs; include their effect on this exact grant. */
export function scopeAffectedObjects(scope:ReturnType<typeof releaseScope>,changes:ReturnType<typeof import('./release-diff.ts').releaseObjectDiff>,definitions:Data[]){
 const entities=new Set(scope.entities.map(item=>String(item.id))),properties=new Set(scope.properties.map(item=>item.id)),relations=new Set(scope.relations.map(item=>String(item.id)));
 const businessEntities=new Set(scope.grants.map(item=>item.entityTypeId)),businessRelations=new Set(scope.grants.flatMap(item=>item.relationIds));
 const bindings=new Map<string,string>(),rules=new Set<string>();
 for(const definition of definitions){const model=definition.model as Data|null,layered=model?.layered as Data|undefined,b=layered?.bindings as Data|undefined;
  for(const binding of (b?.entities??[]) as Data[])bindings.set(String(binding.id),String(binding.entityTypeId));
  for(const rule of (b?.identityRules??[]) as Data[]){
   if(rule.kind==='belongs_to'?businessRelations.has(String(rule.relationTypeId)):businessEntities.has(bindings.get(String((rule.right as Data).bindingId))??''))rules.add(String(rule.id));
  }
 }
 return changes.filter(change=>{
  if(change.kind==='metric_reference')return scope.metrics.some(item=>item.id===change.id);
  if(change.kind==='entity')return entities.has(change.id);
  if(change.kind==='property')return properties.has(change.id);
  if(change.kind==='relation')return relations.has(change.id);
  return [change.before,change.after].some(value=>{
   if(!value)return false;
   if(change.kind==='binding')return businessEntities.has(String(value.entityTypeId));
   if(change.kind==='property_binding'||change.kind==='property_correction')return properties.has(String(value.propertyId));
   if(change.kind==='relation_binding')return businessRelations.has(String(value.relationTypeId));
   if(change.kind==='identity_rule')return rules.has(String(value.id));
   if(change.kind==='identity_decision')return rules.has(String(value.ruleId));
   if(change.kind==='correction'){const target=value.target as Data;return definitions.some(definition=>{
    const entity=(definition.concepts as Data[]).find(item=>item.name===target.type);
    return !!entity&&(definition.relations as Data[]).some(item=>item.from===entity.id&&item.name===target.relation&&businessRelations.has(String(item.id)));
   });}
   return false;
  });
 });
}

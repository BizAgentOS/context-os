import {currentActor,assertRole} from '../security/actors.ts';
import { prepareIdentityDecisionMigration } from "../live/identity-migration.ts";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { FoundationService } from "../agent/foundation.ts";
import type { LiveMemory } from "../live/memory.ts";
import { identityDecisionSubject, identityRuleSubject, identityRows, identityTuple, captureIdentityDecision, identityDecisionsForModel, identityDecisionKey } from "../live/identity.ts";
import { parseLayeredModel, type IdentityRule, type LayeredModel } from "../semantic/model.ts";
import { jsonData } from "../live/sources.ts";
import { transformValue } from "../semantic/values.ts";
import { prepareCorrectionMigration } from "../live/correction-migration.ts";
import { fingerprint } from "./release-diff.ts";
import { ChangeConflict, type OntologyChanges } from "./changes.ts";
const ref=(a:Artifact)=>({id:a.id,version:a.version});
const stable=(prefix:string,value:unknown)=>prefix+'_'+fingerprint(value).slice(0,24);
const list=(value:unknown):Data[]=>Array.isArray(value)?structuredClone(value):[];
const role=(value:string,fields:string[])=>fields.some(field=>/^(username|user_name|login|login_name|account_status|is_bot)$/i.test(field))||/账号|账户|account|login|bot/i.test(value)?'account':/人员|员工|人事|person|people|employee|staff/i.test(value)?'person':/企业|公司|客户|company|customer|org/i.test(value)?'organization':'unknown';

export function connectIdentityChanges(memory:MemoryStore,foundation:FoundationService,live:LiveMemory,changes:OntologyChanges){
 const currentReadGuard=(model:Artifact,reader:ReturnType<LiveMemory['identityReader']>)=>()=>{
  try {
   reader.assertValid();
   if(fingerprint(live.identityReader(model).pins)!==fingerprint(reader.pins))throw new Error('活跃快照已变化');
  }catch(error){throw new ChangeConflict('verification_changed',`身份复验依赖的数据或授权已变化，请重新复验：${error instanceof Error?error.message:'读取范围变化'}`);}
 };
 const baseOf=(change:Artifact)=>{
  const base=(change.content.baseline as Data).modelRef as Data|null;
  if(!base)throw new Error('身份对应需要已采用的本体和来源绑定');
  const model=memory.getArtifact(String(base.id),Number(base.version));
  if(model.status!=='adopted')throw new Error('身份对应需要已采用的本体');
  return live.projectModel(model);
 };
 changes.registerHandler('identity_rule',{subject:identityRuleSubject,prepare:async change=>{
  const subject=identityRuleSubject.parse(change.content.subject),model=baseOf(change);
  const reader=live.identityReader(model),layered=structuredClone(reader.layered);
  const assertCurrent=currentReadGuard(model,reader);
  const left=layered.bindings.entities.find(b=>b.id===subject.left.bindingId),right=layered.bindings.entities.find(b=>b.id===subject.right.bindingId);
  if(!left||!right||left.id===right.id||right.role!=='primary')throw new Error('身份对应需要两个不同绑定，右侧必须是主绑定');
  const leftType=layered.semantic.entityTypes.find(e=>e.id===left.entityTypeId)!,rightType=layered.semantic.entityTypes.find(e=>e.id===right.entityTypeId)!;
  const sourceRole=(binding:typeof left,type:typeof leftType)=>role([type.name,type.description,...type.aliases,binding.dataset.capability].join(' '),reader.sources.capability(binding.dataset.sourceId,binding.dataset.capability).cap.fields);
  const leftRole=sourceRole(left,leftType),rightRole=sourceRole(right,rightType);
  if(subject.kind==='belongs_to'&&(left.role!=='primary'||left.entityTypeId===right.entityTypeId))throw new Error('归属对应需要不同实体的主绑定');
  if(subject.kind==='same_as'&&(leftType.kind!==rightType.kind||leftRole!=='unknown'&&rightRole!=='unknown'&&leftRole!==rightRole))throw new Error('身份类型不相容：账号与人员等不同业务对象应使用归属对应，不能合并身份');
  for(const [binding,end] of [[left,subject.left],[right,subject.right]] as const){
   const cap=reader.sources.capability(binding.dataset.sourceId,binding.dataset.capability).cap;
   if(end.columns.some(column=>!cap.fields.includes(column)))throw new Error('身份匹配列不在已授权来源字段中');
  }
  if(subject.left.columns.length!==subject.right.columns.length)throw new Error('身份匹配两端维度不一致');
  const rule:IdentityRule={legacy:false,id:subject.id??stable('identity_rule',{kind:subject.kind,left:subject.left,right:subject.right}),kind:subject.kind,left:subject.left,right:subject.right,transform:subject.transform,reason:subject.reason,evidence:subject.evidence};
  const [a,b]=await Promise.all([identityRows(reader,left),identityRows(reader,right)]);
  for(let index=0;index<rule.left.columns.length;index++){
   const observed=(rows:Data[],column:string)=>new Set(rows.map(row=>row[column]).filter(value=>value!==null&&value!==undefined&&!(typeof value==='string'&&!value.trim())).map(value=>typeof transformValue(value,rule.transform)));
   const leftTypes=observed(a.items,rule.left.columns[index]),rightTypes=observed(b.items,rule.right.columns[index]);
   if(leftTypes.size>1||rightTypes.size>1||[...leftTypes,...rightTypes].some(type=>!['string','number','boolean'].includes(type))||leftTypes.size&&rightTypes.size&&[...leftTypes][0]!==[...rightTypes][0])throw new Error('身份匹配列类型不相容，请明确字段转换后重新复验');
  }
  const keys=new Map<string,number>();for(const row of b.items){const key=identityTuple(row,rule.right.columns,rule);if(key)keys.set(key,(keys.get(key)??0)+1);}
  let matched=0,ambiguous=0,empty=0;
  const sourceKeys=new Map<string,number>();
  for(const row of a.items){const key=identityTuple(row,rule.left.columns,rule);if(!key){empty++;continue;}sourceKeys.set(key,(sourceKeys.get(key)??0)+1);const count=keys.get(key)??0;if(count===1)matched++;else if(count>1)ambiguous++;}
  const multipleSourceTargets=b.items.filter(row=>{const key=identityTuple(row,rule.right.columns,rule);return key!==null&&(sourceKeys.get(key)??0)>1;}).length;
  const reverseAmbiguous=subject.kind==='same_as'?multipleSourceTargets:0;
  const bots=a.items.filter(row=>Object.values(row).some(value=>typeof value==='string'&&/(^|[-_ ])(bot|robot)([-_ ]|$)|机器人/i.test(value))).length;
  const complete=a.complete&&b.complete;
  const targetUnique=b.complete&&b.items.length>0&&keys.size===b.items.length;
  const metrics={typeCompatible:true,targetUnique,leftRecords:a.items.length,rightRecords:b.items.length,matched,ambiguous,reverseAmbiguous,multipleSourceTargets,empty,matchRate:a.items.length?matched/a.items.length:0,complete,botRecords:bots};
  const notes:string[]=[];
  if(!complete)notes.push('读取覆盖不完整；不能把本次匹配率当作全量事实');
  if(ambiguous)notes.push('存在多个目标候选，查询不会选择其中一条，需要记录级决定');
  if(reverseAmbiguous)notes.push('反向对应存在一个主对象匹配多条补充记录，属性保持冲突，需要明确记录级决定');
  if(bots)notes.push('发现疑似机器人账号，请以明确排除决定核对');
  if(matched<a.items.length)notes.push('部分记录未按规则唯一对应，可补充记录级决定');
  const compatibilityKnown=left.entityTypeId===right.entityTypeId||leftRole!=='unknown'&&leftRole===rightRole;
  if(subject.kind==='same_as'&&!compatibilityKnown)notes.push('两端业务身份类型需要人工确认，数值重合不能证明同一对象');
  let virtual:Artifact|undefined;
  const original=foundation.read().adopted;
  if(subject.kind==='same_as'){
   let supplement=left;
   if(left.role==='primary'){
    const id=stable('entity_binding',{ruleId:rule.id,source:left.dataset});
    supplement=layered.bindings.entities.find(b=>b.id===id)??{...left,id,entityTypeId:right.entityTypeId,role:'supplement',name:leftType.name,keyColumns:[rule.left.columns[0]]};
    if(!layered.bindings.entities.some(b=>b.id===id))layered.bindings.entities.push(supplement);
    for(const source of layered.bindings.properties.filter(p=>p.entityBindingId===left.id)){
     const property=layered.semantic.properties.find(p=>p.id===source.propertyId)!;
     if(property.isIdentity||property.name==='$id')continue;
     let target=layered.semantic.properties.find(p=>p.entityTypeId===right.entityTypeId&&p.name===property.name);
     if(target&&target.valueType!=='unknown'&&property.valueType!=='unknown'&&target.valueType!==property.valueType)throw new Error('补充属性类型不相容，请先明确属性对应');
     if(!target){target={...property,id:stable('property',{entity:right.entityTypeId,source:property.id}),entityTypeId:right.entityTypeId,isIdentity:false};layered.semantic.properties.push(target);}
     const binding={...source,id:stable('property_binding',{property:target.id,binding:id,column:source.column}),propertyId:target.id,entityBindingId:id};
     if(!layered.bindings.properties.some(p=>p.entityBindingId===id&&p.propertyId===target!.id))layered.bindings.properties.push(binding);
    }
   }
   const matchProperty=layered.bindings.properties.find(p=>p.entityBindingId===right.id&&p.column===rule.right.columns[0]);
   if(!matchProperty)throw new Error('主来源匹配列还没有对应业务属性');
   supplement.match={primaryPropertyId:matchProperty.propertyId,sourceColumn:rule.left.columns[0]};supplement.keyColumns=[rule.left.columns[0]];supplement.rationale=subject.reason;
   rule.left={...rule.left,bindingId:supplement.id};
  }else{
   const id=subject.relationTypeId??stable('relation',{identityRule:rule.id}),name=subject.relationName??`${leftType.name}所属${rightType.name}`;
   const existing=layered.semantic.relationTypes.find(r=>r.id===id);
   if(existing&&(existing.from!==left.entityTypeId||existing.to!==right.entityTypeId))throw new Error('归属关系端点与身份规则不一致');
   if(!existing)layered.semantic.relationTypes.push({id,name,aliases:[],description:subject.reason,from:left.entityTypeId,to:right.entityTypeId,direction:'directed',cardinality:'N:1',allowSelf:false});
   const relationBinding={id:stable('relation_binding',id),relationTypeId:id,fromBindingId:left.id,toBindingId:right.id,fromColumns:rule.left.columns,toColumns:rule.right.columns,kind:'foreign_key' as const};
   layered.bindings.relations=layered.bindings.relations.filter(r=>r.relationTypeId!==id);layered.bindings.relations.push(relationBinding);rule.relationTypeId=id;
   if(original&&!list(original.content.relations).some(r=>r.id===id)){
    const evidenceRefs=[...new Set(list(original.content.concepts).filter(e=>[left.entityTypeId,right.entityTypeId].includes(String(e.id))).flatMap(e=>e.evidenceRefs as string[]))];
    virtual={...original,version:original.version+1,content:{...original.content,relations:[...list(original.content.relations),{id,name,from:left.entityTypeId,to:right.entityTypeId,description:subject.reason,evidenceRefs,origin:'human',governed:true}]}};
   }
  }
  layered.bindings.identityRules=layered.bindings.identityRules.filter(item=>item.id!==rule.id && !(item.kind===rule.kind&&item.left.bindingId===rule.left.bindingId&&item.right.bindingId===rule.right.bindingId));
  layered.bindings.identityRules.push(rule);
  const parsed=parseLayeredModel(layered);
  const input={purpose:model.content.purpose,rationale:subject.reason,layered:parsed,baseModelRef:ref(model),...(virtual||original?{foundationRef:ref((virtual??original)!)}:{})};
  const definition=virtual?await live.prepareDefinitionAgainst(input,virtual):await live.prepareDefinition(input);
  const migrateCorrections=await prepareCorrectionMigration(memory,live,definition);
  const migrateIdentities=await prepareIdentityDecisionMigration(memory,live,definition);
  const inputs=jsonData({modelRef:ref(model),definitionFingerprint:fingerprint({layered:parsed,connections:definition.connections}),factsFingerprint:fingerprint({left:a.items,right:b.items,complete}),pins:reader.pins,sourceVersions:model.content.connections,decisions:identityDecisionsForModel(memory,model).map(ref)});
  assertCurrent();
  return{verification:{result:!a.items.length||!b.items.length?'failed' as const:notes.length?'review' as const:'passed' as const,metrics,notes,inputs},apply:()=>{
   assertCurrent();
   const semantic=virtual?memory.putArtifact({...original!,expectedVersion:original!.version,content:virtual.content}):original;
   const saved=memory.putArtifact({kind:'live_ontology',title:model.title,status:'adopted',content:{...definition,...(semantic?{foundationRef:ref(semantic)}:{})}});
   migrateCorrections(saved);
   migrateIdentities(saved);
   return jsonData({ruleId:rule.id,modelRef:ref(saved),leftBindingId:rule.left.bindingId,rightBindingId:rule.right.bindingId,relationTypeId:rule.relationTypeId??null,preservedSourceEntity:leftType.id});
  }};
 }});
 changes.registerHandler('identity_decision',{subject:identityDecisionSubject,prepare:async change=>{
  const subject=identityDecisionSubject.parse(change.content.subject),model=baseOf(change),reader=live.identityReader(model);
  const assertCurrent=currentReadGuard(model,reader);
  const captured=await captureIdentityDecision(live,model,jsonData(subject),{readMode:reader.readMode,pins:reader.pins,modelDefinition:reader.model.content});
  const current=identityDecisionsForModel(memory,model);
  assertCurrent();
  return{verification:{result:'passed',metrics:{leftExists:true,rightExists:subject.right!==null,explicitExclusion:subject.decision==='no_match'},notes:['明确记录决定优先于列匹配规则；决定仅适用于已复验的规则与事实'],inputs:{...captured.inputs,decisions:current.map(ref)}},apply:()=>{
   assertCurrent();
   for(const old of current){
    if(old.content.ruleId!==subject.ruleId||(old.content.left as Data).recordId!==subject.left.recordId)continue;
    const samePair=identityDecisionKey(old.content)===identityDecisionKey(jsonData(subject));
    if(samePair||!subject.right||subject.decision==='match'&&(old.content.decision==='match'||!old.content.right))memory.putArtifact({...old,expectedVersion:old.version,status:'superseded'});
   }
   const saved=memory.putArtifact({kind:'identity_decision',title:subject.decision==='match'?'明确身份对应':'明确排除身份对应',status:'adopted',content:jsonData({...subject,modelRef:ref(model),...captured,decidedBy:currentActor().id,decidedAt:new Date().toISOString()})});
   return {decisionRef:ref(saved),ruleId:subject.ruleId,modelRef:ref(model)};
  }};
 }});
}

import type {AgentApplication} from '../agent/app.ts';
import type {Data} from '../agent/contracts.ts';
import {Releases} from '../engine/releases.ts';

/** Reuse the fixed fictional fixture through the same semantic services as the product. Never replace an existing working model. */
export async function ensureHeatingWorkspace(app:AgentApplication){
 if(app.memory.listArtifacts('live_ontology').some(item=>item.status==='adopted'))return;
 const original=app.memory.listArtifacts('ontology').find(item=>item.status==='adopted'&&item.title==='澄川热力 · 供热服务记忆');
 if(!original)return;
 const types=original.content.types as Data[],relations=original.content.relations as Data[];
 const ids=new Map(types.map((type,index)=>[String(type.name),`heating_entity_${index+1}`]));
 const relationsWithIds:Data[]=relations.map((item,index)=>({...item,id:`heating_relation_${index+1}`}));
 let foundation=app.foundation.read().adopted;
 if(!foundation){
  const task=app.memory.createTask('载入虚构热力演示'),statement='此工作区使用澄川热力有限公司虚构数据，仅演示供热服务中的对象、关系和证据，不连接真实企业或外部账号。';
  const message=app.memory.addMessage(task.id,'user',statement),context=app.memory.beginExecution(task.id);
  try{
   const draft=app.foundation.propose({baseVersion:app.foundation.read().current?.version??0,enterprise:{name:'澄川热力有限公司',evidenceRefs:['demo-fixture']},
    concepts:types.map(type=>({id:ids.get(String(type.name)),name:type.name,description:type.description,evidenceRefs:['demo-fixture']})),
    relations:relationsWithIds.map(item=>({id:item.id,name:item.name,from:ids.get(String(item.from)),to:ids.get(String(item.to)),description:`虚构演示记录中的${item.name}关联`,evidenceRefs:['demo-fixture']})),
    evidence:[{id:'demo-fixture',messageId:message.id,quote:statement}],unknowns:[],conflicts:[]},context,'heating-formal-foundation','heating-formal-foundation');
   foundation=app.foundation.adopt(draft.id,draft.version);
  }finally{app.memory.endExecution(context);}
 }
 const connections=new Map(types.map(type=>{
  const sourceId=String(type.sourceId),version=Number((original.content.sourceVersions as Data)[sourceId]);
  return[sourceId,app.live.sources.connectUpload(sourceId,version,String(type.idField))];
 }));
 await app.snapshots.sync({operationId:'heating-formal-snapshots',sourceIds:[...connections.keys()]});
 const candidate=await app.live.propose({foundationRef:{id:foundation.id,version:foundation.version},baseModelRef:null,purpose:original.content.purpose,rationale:'沿用虚构热力演示的明确编号对应，不根据字符串重合推断身份。',
  types:types.map(type=>({conceptId:ids.get(String(type.name)),name:type.name,description:type.description,sourceId:connections.get(String(type.sourceId))!.id,capability:'records',fields:type.fields})),
  relations:relationsWithIds.map(item=>({relationId:item.id,name:item.name,from:item.from,to:item.to,fromField:item.fromField,toField:item.toField}))});
 await app.live.adopt(candidate.id,candidate.version);
 const releases=new Releases(app.memory,app.live),working=releases.overview().working,check=await releases.check({inputHash:working.inputHash});
 if(check.status!=='ready')throw new Error('虚构热力演示未通过正式发布检查');
 releases.publish({operationId:'heating-formal-release',checkRef:{id:check.id,version:check.version},name:'热力服务演示',notes:'虚构企业与记录；仅用于离线浏览和本地产品演示，未签发外部接入密钥。'});
}

/** Current consumer setup: real model adoption, release checks and issued v4 grants. No historical credential writes. */
import {Releases} from '../../src/engine/releases.ts';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import type {AgentApplication} from '../../src/agent/app.ts';
import type {Artifact,Data} from '../../src/agent/contracts.ts';
import {jsonData} from '../../src/live/sources.ts';

export const ref=(artifact:{id:string;version:number})=>({id:artifact.id,version:artifact.version});
export function publishedDefinition(app:AgentApplication,definition:any){
 const current=app.foundation.read().adopted;
 const concepts=definition.types.map((type:any,index:number)=>({id:type.conceptId??`consumer_entity_${index}`,name:type.name,description:type.description||type.name}));
 const relations=definition.relations.map((relation:any,index:number)=>({id:relation.relationId??`consumer_relation_${index}`,name:relation.name,description:relation.description||relation.name,from:concepts.find((item:any)=>item.name===relation.from).id,to:concepts.find((item:any)=>item.name===relation.to).id}));
 const foundation=current??app.memory.putArtifact({kind:'foundation',title:'消费测试本体',status:'adopted',content:jsonData({enterprise:{name:'虚构消费测试企业'},concepts,relations,evidence:[],unknowns:[],conflicts:[]})});
 const types=definition.types.map((type:any)=>{const concept=(foundation.content.concepts as Data[]).find(item=>item.name===type.name);assert(concept,`missing fixture concept ${type.name}`);return {...type,conceptId:concept.id};});
 return {...definition,foundationRef:ref(foundation),baseModelRef:definition.baseModelRef??null,types,relations:definition.relations.map((relation:any)=>({...relation,relationId:(foundation.content.relations as Data[]).find(item=>item.name===relation.name)!.id}))};
}
export async function publishWorking(app:AgentApplication,name='测试发布'){
 const releases=new Releases(app.memory,app.live);
 const check=await releases.check({inputHash:releases.overview().working.inputHash});
 assert.equal(check.status,'ready',JSON.stringify(check.content.issues));
 return releases.publish({operationId:randomUUID(),checkRef:ref(check),name}).release;
}
export function connectPublished(app:AgentApplication,release:Artifact,input:{operationId?:string;name:string;purpose?:string;grants:any[]}){
 const definition=release.content.definition as Data,concepts=definition.concepts as Data[],relations=definition.relations as Data[];
 const selected=concepts.filter(item=>input.grants.some(grant=>grant.type===item.name));
 assert.equal(selected.length,input.grants.length,'every business grant must have a released concept');
 return new Releases(app.memory,app.live).connect({operationId:input.operationId??randomUUID(),name:input.name,purpose:input.purpose??'独立消费测试',releaseRef:ref(release),conceptIds:selected.map(item=>item.id),relationIds:relations.filter(item=>input.grants.some(grant=>grant.type===concepts.find(c=>c.id===item.from)?.name&&grant.relations.includes(item.name))).map(item=>item.id),business:{grants:input.grants}});
}

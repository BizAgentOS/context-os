import {z} from 'zod';
import type {Data} from '../agent/contracts.ts';
import type {MemoryStore} from '../agent/memory.ts';
import type {LiveMemory} from '../live/memory.ts';
import {fingerprint} from './release-diff.ts';
const reference=z.object({id:z.string().min(1),version:z.number().int().positive()});
const action=reference.extend({operationId:z.string().min(1).max(200),action:z.enum(['remove','disable']),acknowledgeImpact:z.literal(true)}).strict();
function mentions(value:unknown,ids:Set<string>):boolean{if(typeof value==='string')return ids.has(value);if(!value||typeof value!=='object')return false;if(Array.isArray(value))return value.some(item=>mentions(item,ids));return Object.entries(value).some(([key,item])=>ids.has(key)||mentions(item,ids));}
/** Local lifecycle preserves historical artifacts and applies source revocation through the shared source service. */
export class SourceLifecycle{
 private memory:MemoryStore;private live:LiveMemory;
 constructor(memory:MemoryStore,live:LiveMemory){this.memory=memory;this.live=live;}
 impact(input:unknown){
  const args=reference.strict().parse(input),source=this.memory.getArtifact(args.id);if(!['source','source_connection'].includes(source.kind))throw new Error('需要来源引用');if(source.version!==args.version)throw new Error('来源版本已变化，请重新查看影响');
  const connections=this.memory.listArtifacts('source_connection').filter(item=>item.id===source.id||(item.content.localSource as Data|undefined)?.id===source.id),ids=new Set([source.id,...connections.map(item=>item.id)]);
  const releases=this.memory.listArtifacts('data_release').filter(item=>mentions(item.content,ids)||['foundationRef','modelRef'].some(key=>{const pin=item.content[key] as Data|undefined;if(!pin)return false;return mentions(this.memory.getArtifact(String(pin.id),Number(pin.version)).content,ids);})).map(item=>({id:item.id,version:item.version,title:item.title}));
  const models=this.memory.listArtifacts('live_ontology').filter(item=>item.status==='adopted'),entities=models.flatMap(model=>((model.content.types??[]) as Data[]).filter(item=>mentions(item,ids)).map(item=>({id:String(item.conceptId??item.name),name:String(item.name)})));
  for(const foundation of this.memory.listArtifacts('foundation').filter(item=>item.status==='adopted')){
   const evidence=new Set(((foundation.content.evidence??[]) as Data[]).filter(item=>mentions(item,ids)).map(item=>String(item.id)));
   for(const concept of (foundation.content.concepts??[]) as Data[])if(mentions(concept,ids)||mentions(concept,evidence))if(!entities.some(item=>item.id===concept.id))entities.push({id:String(concept.id),name:String(concept.name)});
  }
  const datasets=this.memory.listArtifacts('data_dataset').filter(item=>ids.has(String(item.content.sourceId)));
  return {source:{id:source.id,version:source.version,title:source.title,status:source.status},releases,entities,datasets:datasets.map(item=>({id:item.id,title:item.title,versions:(item.content.versions as string[]).length})),allowed:{remove:releases.length===0,disable:source.status!=='removed'&&source.status!=='disabled'},consequence:releases.length?'停用会阻止依赖此来源的后续读取；已发布版本及历史快照保留，已有接入方可能受影响。':'删除后来源不再出现在可用目录，依赖此来源的后续读取会停止；历史依据和受保护快照保留。'};
 }
 validate(input:unknown){
  const args=action.parse(input),signature=fingerprint(args),prior=this.memory.listArtifacts('source_lifecycle').find(item=>item.content.operationId===args.operationId);
  if(prior){if(prior.content.signature!==signature)throw new Error('同一来源管理标识不能用于不同操作');return{args,signature,prior,impact:null};}
  const impact=this.impact({id:args.id,version:args.version});if(args.action==='remove'&&!impact.allowed.remove)throw new Error('此来源被已发布版本引用，只能停用；请先核对影响');
  return{args,signature,prior:null,impact};
 }
 manage(input:unknown){
  const {args,signature,prior,impact}=this.validate(input);
  if(prior){if(prior.content.signature!==signature)throw new Error('同一来源管理标识不能用于不同操作');return{source:this.memory.getArtifact(String((prior.content.sourceRef as Data).id),Number((prior.content.sourceRef as Data).version)),impact:prior.content.impact};}
  return this.memory.atomic(()=>{
   const source=this.memory.getArtifact(args.id);if(source.version!==args.version)throw new Error('来源版本已变化，请重新查看影响');
   for(const connection of this.memory.listArtifacts('source_connection').filter(item=>item.id===source.id||(item.content.localSource as Data|undefined)?.id===source.id)){if(connection.status==='ready')this.live.sources.disable(connection.id,connection.version);}
   const latest=this.memory.getArtifact(source.id),saved=this.memory.putArtifact({...latest,expectedVersion:latest.version,status:args.action==='remove'?'removed':'disabled'});
   this.memory.putArtifact({kind:'source_lifecycle',title:`${args.action==='remove'?'删除':'停用'}来源：${source.title}`,status:'completed',content:JSON.parse(JSON.stringify({operationId:args.operationId,signature,sourceRef:{id:saved.id,version:saved.version},action:args.action,acknowledgeImpact:true,impact}))});
   return{source:saved,impact};
  });
 }
}

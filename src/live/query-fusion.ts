import type {Artifact,Data,Repository} from '../agent/contracts.ts';
import type {LiveMemory} from './memory.ts';
import {captureIdentityDecision,type IdentityReading} from './identity.ts';
import {identityValue} from '../semantic/values.ts';
import {QuerySql,type QueryBinding} from '../semantic/query-sql.ts';
import {lit} from '../data/executor/engine.ts';
import type {FusionType,Supplement,Match} from './fusion.ts';
import type {SourceConnections} from './sources.ts';
type Page=Awaited<ReturnType<SourceConnections['readRecords']>>;

/** Fixed snapshot fusion resolves a page's keys together, retaining ambiguity and all decision pins. */
export async function prepareFusionBatch(repo:Repository,live:LiveMemory,model:Artifact,type:FusionType,primary:Page,fields:string[],decisions:Artifact[],options:IdentityReading,assertValid:()=>void){
  if(!live.snapshots?.read||!primary.items.length)return undefined;
  const reader=live.identityReader(model,options),layered=reader.layered;
  const main=layered.bindings.entities.find(b=>b.role==='primary'&&b.dataset.sourceId===type.sourceId&&b.dataset.capability===type.capability&&layered.bindings.properties.some(p=>p.entityBindingId===b.id&&Object.values(type.fields).includes(p.column)));
  if(!main)return undefined;
  const supplements=(type.supplements??[]).filter(s=>Object.keys(s.fields).some(f=>fields.includes(f)));
  const selected=supplements.map(s=>({s,binding:layered.bindings.entities.find(b=>b.role==='supplement'&&b.entityTypeId===main.entityTypeId&&b.name===s.name&&b.dataset.sourceId===s.sourceId&&b.dataset.capability===s.capability)}));
  if(selected.some(item=>!item.binding))return undefined;
  const bindings=[main,...selected.map(item=>item.binding!)],datasets=new Map<string,QueryBinding>();
  for(const binding of bindings){
    const version=reader.pins[`${binding.dataset.sourceId}\0${binding.dataset.capability}`];if(!version)return undefined;
    const snapshot=repo.getArtifact(version);if(snapshot.kind!=='data_snapshot')throw new Error('固定快照不存在');
    const {cap}=reader.sources.capability(binding.dataset.sourceId,binding.dataset.capability);
    datasets.set(binding.id,{table:'',version,cap,coverage:snapshot.content.coverage as Data});
  }
  const relevant=decisions.filter(d=>layered.bindings.identityRules.some(r=>r.id===d.content.ruleId&&datasets.has(r.left.bindingId)&&datasets.has(r.right.bindingId)));
  for(const decision of relevant){const captured=await captureIdentityDecision(live,model,decision.content,options);assertValid();if(captured.fingerprint!==decision.content.fingerprint||captured.scopeFingerprint!==decision.content.scopeFingerprint)throw new Error('身份决定依赖的事实或规则已变化，请重新复验');}
  const mainCap=datasets.get(main.id)!.cap,keys=primary.items.map(row=>String(identityValue(row,main.keyColumns,mainCap.idField)));
  const results=new Map<string,Map<string,{page:Page;status:Match['status'];reason:string;reads:Page['provenance'][]}>>();
  for(const {s,binding} of selected){
    const rule=layered.bindings.identityRules.find(r=>r.kind==='same_as'&&r.left.bindingId===binding!.id&&r.right.bindingId===main.id);if(!rule)return undefined;
    const compiler=new QuerySql(layered,new Map([[main.id,datasets.get(main.id)!],[binding!.id,datasets.get(binding!.id)!]]),relevant),edge=compiler.identity(rule);
    const sql=`WITH ${compiler.ctes.join(',')} SELECT ${compiler.rawId('p')} AS origin,CASE WHEN ${compiler.rawId('l')} IS NULL THEN NULL ELSE CAST(to_json(l) AS VARCHAR) END AS record,count(e.left_id) OVER(PARTITION BY ${compiler.rawId('p')}) AS total,EXISTS(SELECT 1 FROM ${edge.unique} u WHERE u.left_id=e.left_id AND u.right_id=e.right_id) AS eligible FROM ${compiler.bindings.get(main.id)} p LEFT JOIN ${edge.candidates} e ON e.right_id=${compiler.rawId('p')} LEFT JOIN ${compiler.bindings.get(binding!.id)} l ON ${compiler.rawId('l')}=e.left_id WHERE ${compiler.rawId('p')} IN (${keys.map(lit).join(',')}) QUALIFY row_number() OVER(PARTITION BY ${compiler.rawId('p')} ORDER BY e.left_id)<=2`;
    assertValid();const read=await live.snapshots.read(compiler.inputs,sql,{limit:Math.max(1,keys.length*2)});assertValid();
    const dataset=datasets.get(binding!.id)!,snapshot=repo.getArtifact(dataset.version),complete=dataset.coverage.complete===true&&datasets.get(main.id)!.coverage.complete===true;
    const provenance={sourceId:binding!.dataset.sourceId,capability:binding!.dataset.capability,connectionVersion:Number((model.content.connections as Data)[binding!.dataset.sourceId]),readAt:String(snapshot.content.syncedAt),historicalReplay:true,snapshotId:dataset.version};
    const mapped=new Map<string,{page:Page;status:Match['status'];reason:string;reads:Page['provenance'][]}>();
    for(const key of keys){
      const rows=read.rows.filter(row=>row.origin===key),total=Number(rows[0]?.total??0),items=rows.filter(r=>r.record!==null).map(r=>JSON.parse(String(r.record)) as Data);
      const status:Match['status']=!complete?'unknown':total>1||total===1&&!rows[0]?.eligible?'ambiguous':total===1?'unique':'missing';
      const page={items,coverage:{offset:0,shown:items.length,total:complete?total:null,complete:complete&&total===items.length},provenance};
      mapped.set(key,{page,status,reason:status==='unique'?'固定快照批量键得到唯一对应':status==='missing'?'固定快照批量查询无对应':status==='ambiguous'?'身份对应不唯一，未选择记录':'来源覆盖不完整',reads:[provenance]});
    }
    results.set(s.name,mapped);
  }
  return async(supplement:Supplement,row:Data)=>results.get(supplement.name)?.get(String(identityValue(row,main.keyColumns,mainCap.idField)));
}

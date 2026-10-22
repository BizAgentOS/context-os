import type {Artifact,Data,Json} from '../agent/contracts.ts';
import type {MemoryStore} from '../agent/memory.ts';
import type {ConsumptionService} from '../agent/consumption.ts';
import {assertRole} from '../security/actors.ts';

const credentials=/^(?:keyHash|apiKey|token|adminToken|authorization|password|secret|credentialVersion|operationSignature|operationId)$/i;
function safe(value:Json):Json {
 if(Array.isArray(value))return value.map(safe);
 if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).filter(([key])=>!credentials.test(key)).map(([key,item])=>[key,safe(item)]));
}

/** Explicit administrator-only archive. Retired grants never become a data-serving route again. */
export function exportLegacyConsumptionAudit(memory:MemoryStore,consumption:ConsumptionService){
 assertRole('users');
 const datasets=memory.listArtifacts('ontology_dataset'),currentDatasets=new Set(memory.listArtifacts('release_connection').map(item=>String((item.content.datasetRef as Data).id)));
 const currentViews=new Set(datasets.filter(item=>item.content.releaseRef||currentDatasets.has(item.id)).flatMap(item=>{
  const view=(item.content.business as Data|null)?.viewRef as Data|undefined;return view?[String(view.id)]:[];
 }));
 const records=['consumer','live_consumer','consumer_view','ontology_dataset','consumer_migration'].flatMap(kind=>memory.artifactHistory(kind))
  .filter(item=>!item.content.releaseRef&&!currentDatasets.has(item.id)&&!currentViews.has(item.id));
 const legacyIds=new Set(records.map(item=>item.id)),dependencies=new Map<string,Artifact>(),unavailable:Array<{id:string;version:number}>=[];
 const add=(id:unknown,version:unknown)=>{
  if(typeof id!=='string'||!Number.isSafeInteger(version)||Number(version)<1)return;
  const key=`${id}@${version}`;if(dependencies.has(key)||unavailable.some(item=>item.id===id&&item.version===version))return;
  let artifact:Artifact;try{artifact=memory.getArtifact(id,Number(version));}catch{unavailable.push({id,version:Number(version)});return;}
  // Only semantic definitions and saved local source facts enter this audit; live credentials/configuration never do.
  if(!['ontology','live_ontology','foundation','source','source_policy'].includes(artifact.kind))return;
  dependencies.set(key,artifact);references(artifact.content);
 };
 const references=(value:Data)=>{
  add(value.modelId,value.modelVersion);
  for(const field of ['modelRef','foundationRef','semanticRef']){const ref=value[field] as Data|undefined;if(ref)add(ref.id,ref.version);}
  for(const [id,version]of Object.entries((value.sourceVersions??value.documentVersions??{}) as Data))add(id,version);
  for(const evidence of (value.evidence??[]) as Data[])if(evidence.sourceId)add(evidence.sourceId,evidence.version??evidence.sourceVersion);
  const business=value.business as Data|undefined;if(business)references(business);
 };
 for(const item of records)references(item.content);
 const semantic=memory.artifactHistory('live_access').filter(item=>legacyIds.has(String(item.content.consumerId))),datasetAccess=memory.artifactHistory('dataset_access').filter(item=>legacyIds.has(String(item.content.datasetId)));
 return {formatVersion:1 as const,readOnly:true as const,retiredContracts:['v1','v2','v3','standalone_dataset'],exportedAt:new Date().toISOString(),
  records:records.map(item=>safe(item as unknown as Json) as unknown as Artifact),
  dependencies:[...dependencies.values()].map(item=>safe(item as unknown as Json) as unknown as Artifact),unavailable,
  access:{v1:consumption.auditHistory(),semantic:semantic.map(item=>safe(item as unknown as Json)),datasets:datasetAccess.map(item=>safe(item as unknown as Json))}};
}

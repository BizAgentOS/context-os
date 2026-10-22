import {z} from 'zod';
import {existsSync,lstatSync,realpathSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import type {Artifact,Data} from '../agent/contracts.ts';
import type {MemoryStore} from '../agent/memory.ts';
import type {Snapshots,DatasetContent} from '../data/snapshots.ts';
import {fingerprint} from '../engine/release-diff.ts';
import {snapshotFile} from '../data/executor/paths.ts';

const settingsSchema=z.object({rawDays:z.number().int().min(1).max(36500).default(90),snapshotVersions:z.number().int().min(1).max(100).default(5)}).strict();
const leases=new WeakMap<MemoryStore,number>();
export function holdManagedFiles(memory:MemoryStore){leases.set(memory,(leases.get(memory)??0)+1);let released=false;return()=>{if(!released){released=true;leases.set(memory,(leases.get(memory)??1)-1);}};}
export const managedFilesBusy=(memory:MemoryStore)=>(leases.get(memory)??0)>0;
export function retentionSettings(memory:MemoryStore){const saved=memory.listArtifacts('retention_settings')[0];return settingsSchema.parse(saved?.content??{});}
function visit(value:unknown,read:(value:Data)=>void){if(!value||typeof value!=='object')return;if(Array.isArray(value)){value.forEach(item=>visit(item,read));return;}read(value as Data);Object.values(value).forEach(item=>visit(item,read));}
export function protectedSnapshots(memory:MemoryStore){
 const pinned=new Set<string>();
 for(const kind of ['data_release','workspace_version','ontology_dataset'])for(const artifact of memory.artifactHistory(kind))visit(artifact.content,item=>{if(typeof item.snapshotId==='string')pinned.add(item.snapshotId);});
 return pinned;
}
export function snapshotRetentionPlan(memory:MemoryStore,dataset:Artifact){
 const content=dataset.content as unknown as DatasetContent,pinned=protectedSnapshots(memory),keep=new Set([...content.versions.slice(0,retentionSettings(memory).snapshotVersions),content.activeVersion,content.pendingVersion]);
 return content.versions.filter(id=>!keep.has(id)&&!pinned.has(id));
}
export function pruneDatasetSnapshots(memory:MemoryStore,directory:string,datasetId:string){
 if(managedFilesBusy(memory))return [];
 const dataset=memory.getArtifact(datasetId),dropped=snapshotRetentionPlan(memory,dataset);if(!dropped.length)return [];
 memory.atomic(()=>{
  const saved=memory.putArtifact({...dataset,expectedVersion:dataset.version,content:{...dataset.content,versions:(dataset.content.versions as string[]).filter(id=>!dropped.includes(id))}});
  for(const issue of memory.listArtifacts('sync_issue').filter(item=>item.status==='open'&&(item.content.datasetRef as Data|null)?.id===dataset.id))memory.putArtifact({...issue,expectedVersion:issue.version,content:{...issue.content,datasetRef:{id:saved.id,version:saved.version}}});
 });
 for(const id of dropped){const file=snapshotFile(join(directory,'data'),'workspace',id);if(existsSync(file)){if(lstatSync(file).isSymbolicLink())throw new Error('快照文件不能是符号链接');unlinkSync(file);}}
 return dropped;
}
function originalPath(memory:MemoryStore,file:string){
 if(!/^(documents|data\/table-files)\/[-a-f0-9]{36}\.original$/.test(file))throw new Error('原文文件引用无效');
 const root=realpathSync(memory.directory),path=join(root,file);if(existsSync(path)&&(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()||realpathSync(path)!==path))throw new Error('原文文件不属于当前工作区');return path;
}

export class WorkspaceRetention {
 private memory:MemoryStore;private snapshots:Snapshots;
 constructor(memory:MemoryStore,snapshots:Snapshots){this.memory=memory;this.snapshots=snapshots;}
 settings(){return retentionSettings(this.memory);}
 configure(input:unknown){const content=settingsSchema.parse(input),old=this.memory.listArtifacts('retention_settings')[0];this.memory.putArtifact({...(old?{id:old.id,expectedVersion:old.version}:{}),kind:'retention_settings',title:'数据保留策略',status:'active',content});return content;}
 preview(now=new Date().toISOString()){
  const time=z.iso.datetime().parse(now),cutoff=Date.parse(time)-this.settings().rawDays*86400000,all=this.memory.artifactHistory(undefined,{content:"compact"}),sources=all.filter(item=>item.kind==='source'),textSources=new Set(sources.filter(item=>(typeof item.content.raw==='string'||!!(item.content.sourceContent as Data|undefined)?.raw)).map(item=>`${item.id}@${item.version}`));
  const protectedRaw=this.memory.sourceContentPins();
  for(const artifact of all.filter(item=>!['source','source_connection','data_dataset','data_snapshot','data_sync','retention_run'].includes(item.kind)))visit(artifact.content,item=>{
    for(const key of [`${item.sourceId}@${item.sourceVersion}`,`${item.id}@${item.version}`])if(textSources.has(key))protectedRaw.add(key);
    if(item.documentVersions&&typeof item.documentVersions==='object'&&!Array.isArray(item.documentVersions))for(const [id,version] of Object.entries(item.documentVersions))if(textSources.has(`${id}@${version}`))protectedRaw.add(`${id}@${version}`);
  });
  const originals=sources.filter(source=>Date.parse(source.createdAt)<=cutoff&&source.content.origin!=='feishu').flatMap(source=>{
    const raw=(typeof source.content.raw==='string'||!!(source.content.sourceContent as Data|undefined)?.raw)&&!protectedRaw.has(`${source.id}@${source.version}`),files:string[]=[];
    const table=source.content.tableFile as Data|undefined,doc=source.content.documentFile as Data|undefined;
    if(typeof table?.file==='string')files.push('data/table-files/'+table.file);if(typeof doc?.file==='string')files.push('documents/'+doc.file);
    return raw||files.length?[{id:source.id,version:source.version,title:source.title,raw,files}]:[];
  });
  // Reparsed sheets may share an original file. A newer owner keeps that file until its own expiry.
  const expired=new Set(originals.map(item=>`${item.id}@${item.version}`)),activeFiles=new Set(sources.filter(source=>!expired.has(`${source.id}@${source.version}`)).flatMap(source=>{const table=source.content.tableFile as Data|undefined,doc=source.content.documentFile as Data|undefined;return [...(typeof table?.file==='string'?['data/table-files/'+table.file]:[]),...(typeof doc?.file==='string'?['documents/'+doc.file]:[])];}));
  for(const item of originals)item.files=item.files.filter(file=>!activeFiles.has(file));
  return {now:time,originals:originals.filter(item=>item.raw||item.files.length),protectedTextVersions:protectedRaw.size,snapshots:this.snapshots.datasets().flatMap(dataset=>snapshotRetentionPlan(this.memory,dataset).map(snapshotId=>({datasetId:dataset.id,snapshotId})))};
 }
 async run(input:{operationId:string;now?:string}){
  const args=z.object({operationId:z.string().min(1).max(200),now:z.iso.datetime().optional()}).strict().parse(input),signature=fingerprint(args),old=this.memory.listArtifacts('retention_run').find(item=>item.content.operationId===args.operationId);
  if(old){if(old.content.signature!==signature)throw new Error('同一清理操作标识不能用于不同范围');if(old.status==='completed')return old;}
  if(managedFilesBusy(this.memory))throw new Error('备份正在读取受管文件，请稍后清理');
  const plan=old?old.content.plan as unknown as ReturnType<WorkspaceRetention['preview']>:this.preview(args.now),files=[...new Set(plan.originals.flatMap(item=>item.files))];files.forEach(file=>originalPath(this.memory,file));
  // No await between final reference analysis and content expiry: new references cannot enter this host mid-decision.
  let receipt=old??this.memory.atomic(()=>{
    this.memory.expireSourceOriginals(plan.originals.map(item=>({...item,file:item.files.length>0})),plan.now);
    return this.memory.putArtifact({kind:'retention_run',title:'原文与快照清理',status:'running',content:JSON.parse(JSON.stringify({operationId:args.operationId,signature,plan}))});
  });
  try{
    for(const file of files){const path=originalPath(this.memory,file);if(existsSync(path))unlinkSync(path);}
    for(const dataset of this.snapshots.datasets())pruneDatasetSnapshots(this.memory,this.memory.directory,dataset.id);
    this.memory.collectSourceContent();
    return this.memory.putArtifact({...receipt,expectedVersion:receipt.version,status:'completed',content:{...receipt.content,finishedAt:new Date().toISOString()}});
  }catch(error){
    receipt=this.memory.putArtifact({...receipt,expectedVersion:receipt.version,status:'failed',content:{...receipt.content,error:'部分受管文件无法清理，请检查目录权限后重试；已保存快照未替换'}});
    throw new Error(String(receipt.content.error));
  }
 }
}

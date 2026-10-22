import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,constants} from 'node:fs';
import {chmod,copyFile,lstat,mkdir,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {z} from 'zod';
import type {Artifact,Data} from '../agent/contracts.ts';
import type {MemoryStore} from '../agent/memory.ts';
import {fingerprint} from '../engine/release-diff.ts';
import {holdManagedFiles,retentionSettings} from './workspace-retention.ts';

const identifier=z.string().min(1).max(200),uuid='[-a-f0-9]{36}';
const allowedFile=(path:string)=>/^(memory\.sqlite|config\.json|capabilities\/mcp\.json)$/.test(path)||new RegExp(`^(data/datasets/workspace/${uuid}\\.parquet|data/table-files/${uuid}\\.(jsonl|original)|documents/${uuid}\\.original|source-content/[a-f0-9]{64}\\.json)$`).test(path);
const manifestSchema=z.object({format:z.enum(['context-os-backup-v1','ade-backup-v1']),operationId:identifier,createdAt:z.iso.datetime(),files:z.array(z.object({path:z.string().refine(allowedFile),bytes:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(2).max(100000),credentialsIncluded:z.literal(false)}).strict();
export type BackupManifest=z.infer<typeof manifestSchema>;
async function digest(file:string){const hash=createHash('sha256');let bytes=0;for await(const chunk of createReadStream(file)){hash.update(chunk);bytes+=chunk.length;}return{bytes,sha256:hash.digest('hex')};}
async function exists(path:string){try{await lstat(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
async function managedPath(root:string,path:string){
 if(!allowedFile(path))throw new Error('备份文件路径不在受管范围');
 const base=await realpath(root),file=join(base,path),stat=await lstat(file);
 if(!stat.isFile()||stat.isSymbolicLink()||await realpath(file)!==file)throw new Error('备份只允许工作区内的普通受管文件');return file;
}
function scrub(value:unknown):unknown{
 if(Array.isArray(value))return value.map(scrub);if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).filter(([key])=>! /^(token|password|secret|clientSecret|refreshToken|accessToken|apiKey|headers|keyHash)$/i.test(key)).map(([key,item])=>[key,scrub(item)]));
}
function archiveFiles(db:DatabaseSync){
 const all=db.prepare('SELECT body FROM artifacts').all().map(row=>JSON.parse(String(row.body)) as Artifact),files=new Set<string>();
 const latest=new Map<string,Artifact>();for(const item of all)if(!latest.has(item.id)||latest.get(item.id)!.version<item.version)latest.set(item.id,item);
 for(const item of latest.values())if(item.kind==='data_dataset')for(const id of (item.content.versions??[]) as string[])files.add(`data/datasets/workspace/${id}.parquet`);
 const visit=(value:unknown)=>{if(!value||typeof value!=='object')return;if(Array.isArray(value)){value.forEach(visit);return;}const object=value as Data;if(typeof object.snapshotId==='string')files.add(`data/datasets/workspace/${object.snapshotId}.parquet`);Object.values(object).forEach(visit);};
 for(const item of all){
  if(['data_release','workspace_version','ontology_dataset'].includes(item.kind))visit(item.content);
  if(item.kind!=='source')continue;
  for(const ref of Object.values((item.content.sourceContent??{}) as Data))if(ref&&typeof ref==='object'&&!Array.isArray(ref)&&typeof ref.file==='string')files.add('source-content/'+ref.file);
  for(const [key,prefix] of [['tableFile','data/table-files'],['rowStorage','data/table-files'],['documentFile','documents']]){const value=item.content[key] as Data|undefined;if(typeof value?.file==='string')files.add(`${prefix}/${value.file}`);}
 }
 return [...files].sort();
}
async function readManifest(root:string){
 const file=join(root,'manifest.json'),stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>20_000_000)throw new Error('备份清单无效');
 const manifest=manifestSchema.parse(JSON.parse(await readFile(file,'utf8')));
 if(new Set(manifest.files.map(file=>file.path)).size!==manifest.files.length||!manifest.files.some(file=>file.path==='memory.sqlite')||!manifest.files.some(file=>file.path==='config.json'))throw new Error('备份清单不完整或文件重复');
 return manifest;
}
async function verify(root:string,manifest:BackupManifest){for(const file of manifest.files){const actual=await digest(await managedPath(root,file.path));if(actual.bytes!==file.bytes||actual.sha256!==file.sha256)throw new Error('备份文件完整性校验失败');}}

/** A backup is a directory package: consistent SQLite, immutable managed files and an exact checksum manifest. */
export class BackupService {
 private memory:MemoryStore;private running=new Map<string,{signature:string;promise:Promise<{path:string;manifest:BackupManifest}>}>();
 constructor(memory:MemoryStore){this.memory=memory;}
 async exportConfig(input:{destination:string}){
  const destination=resolve(z.string().min(1).parse(input.destination));if(await exists(destination))throw new Error('配置导出目标已存在，请选择新文件');
  const config={format:'context-os-config-v1',model:this.memory.getSettings(),retention:retentionSettings(this.memory),sources:this.memory.listArtifacts('source_connection').map(item=>({id:item.id,title:item.title,content:scrub(item.content)})),credentialsIncluded:false};
  await mkdir(dirname(destination),{recursive:true,mode:0o700});await writeFile(destination,JSON.stringify(config,null,2),{flag:'wx',mode:0o600});return{path:destination,credentialsIncluded:false};
 }
 async create(input:{destination:string;operationId:string}){
  const args=z.object({destination:z.string().min(1),operationId:identifier}).strict().parse(input),destination=resolve(args.destination),scope=relative(resolve(this.memory.directory),destination);
  if(!(scope==='..'||scope.startsWith('..'+sep)||isAbsolute(scope)))throw new Error('备份目录必须位于当前工作区之外');
  const signature=fingerprint({destination,operationId:args.operationId}),running=this.running.get(args.operationId);if(running){if(running.signature!==signature)throw new Error('同一备份标识不能用于其他目录');return running.promise;}
  const previous=this.memory.listArtifacts('workspace_backup').find(item=>item.content.operationId===args.operationId);
  if(previous&&previous.content.signature!==signature)throw new Error('同一备份标识不能用于其他目录');
  const path=typeof previous?.content.path==='string'?previous.content.path:join(destination,`context-os-backup-${createHash('sha256').update(args.operationId).digest('hex').slice(0,20)}`);
  const promise=this.createPackage(path,args.operationId,signature);this.running.set(args.operationId,{signature,promise});try{return await promise;}finally{if(this.running.get(args.operationId)?.promise===promise)this.running.delete(args.operationId);}
 }
 private async createPackage(path:string,operationId:string,signature:string){
  const prior=this.memory.listArtifacts('workspace_backup').find(item=>item.content.operationId===operationId);if(prior&&prior.content.signature!==signature)throw new Error('同一备份标识不能用于其他目录');
  if(await exists(path)){const manifest=await readManifest(path);if(manifest.operationId!==operationId)throw new Error('备份目标已存在');await verify(path,manifest);return{path,manifest};}
  await mkdir(dirname(path),{recursive:true,mode:0o700});const actualScope=relative(await realpath(this.memory.directory),await realpath(dirname(path)));if(!(actualScope==='..'||actualScope.startsWith('..'+sep)||isAbsolute(actualScope)))throw new Error('备份目录必须位于当前工作区之外');const temporary=join(dirname(path),`.context-os-backup-${randomUUID()}`);await mkdir(temporary,{mode:0o700});const release=holdManagedFiles(this.memory);
  try{
   await this.memory.backupTo(join(temporary,'memory.sqlite'));await chmod(join(temporary,'memory.sqlite'),0o600);
   const db=new DatabaseSync(join(temporary,'memory.sqlite'),{readOnly:true});let files:string[];let config:unknown;
   try{files=archiveFiles(db);const model=db.prepare("SELECT body FROM settings WHERE id='model'").get();config={format:'context-os-config-v1',model:model?JSON.parse(String(model.body)):{},credentialsIncluded:false};}finally{db.close();}
   await writeFile(join(temporary,'config.json'),JSON.stringify(config,null,2),{mode:0o600});
   for(const file of files){const source=await managedPath(this.memory.directory,file),target=join(temporary,file);await mkdir(dirname(target),{recursive:true,mode:0o700});await copyFile(source,target,constants.COPYFILE_EXCL);await chmod(target,0o600);}
   const mcp=join(this.memory.directory,'capabilities','mcp.json');if(await exists(mcp)){
    const content=JSON.parse(await readFile(await managedPath(this.memory.directory,'capabilities/mcp.json'),'utf8')) as Array<{config:Record<string,unknown>;credential?:boolean}>;
    for(const connection of content){if(Object.keys((connection.config.headers??{}) as object).length)connection.credential=true;delete connection.config.headers;}
    await mkdir(join(temporary,'capabilities'),{mode:0o700});await writeFile(join(temporary,'capabilities','mcp.json'),JSON.stringify(content),{mode:0o600});files.push('capabilities/mcp.json');
   }
   const manifest:BackupManifest={format:'context-os-backup-v1',operationId,createdAt:new Date().toISOString(),credentialsIncluded:false,files:[]};
   for(const file of ['memory.sqlite','config.json',...files])manifest.files.push({path:file,...await digest(join(temporary,file))});
   manifestSchema.parse(manifest);await writeFile(join(temporary,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});await rename(temporary,path);
   this.memory.putArtifact({kind:'workspace_backup',title:'工作区备份',status:'completed',content:{operationId,signature,path,createdAt:manifest.createdAt,files:manifest.files.length,credentialsIncluded:false}});
   return{path,manifest};
  }catch(error){await rm(temporary,{recursive:true,force:true});throw error;}finally{release();}
 }
 static async restore(input:{backup:string;destination:string}){
  const args=z.object({backup:z.string().min(1),destination:z.string().min(1)}).strict().parse(input),source=resolve(args.backup),destination=resolve(args.destination);
  if(await exists(destination))throw new Error('恢复目标必须是全新目录，已有目录不可覆盖');
  const manifest=await readManifest(source);await verify(source,manifest);
  await mkdir(dirname(destination),{recursive:true,mode:0o700});const temporary=join(dirname(destination),`.context-os-restore-${randomUUID()}`);await mkdir(temporary,{mode:0o700});
  try{
   for(const file of manifest.files){const target=join(temporary,file.path);await mkdir(dirname(target),{recursive:true,mode:0o700});await copyFile(await managedPath(source,file.path),target,constants.COPYFILE_EXCL);await chmod(target,0o600);}
   await verify(temporary,manifest);
   const db=new DatabaseSync(join(temporary,'memory.sqlite'),{readOnly:true});let sourceIds:string[];
   try{if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new Error('备份数据库完整性校验失败');sourceIds=[...new Set(db.prepare("SELECT body FROM artifacts WHERE kind='source_connection'").all().map(row=>JSON.parse(String(row.body)) as Artifact).filter(item=>item.content.adapter!=='uploaded_csv').map(item=>item.id))];}finally{db.close();}
   await writeFile(join(temporary,'restored-workspace.json'),JSON.stringify({format:'context-os-restore-v1',restoredAt:new Date().toISOString(),sourceIds,credentialsIncluded:false,reauthorizationRequired:true}),{mode:0o600});
   // Renaming to an existing empty directory is allowed on POSIX; explicitly recheck before committing.
   if(await exists(destination))throw new Error('恢复目标目录已存在');await rename(temporary,destination);
   return{directory:destination,files:manifest.files.length,reauthorizationRequired:true};
  }catch(error){await rm(temporary,{recursive:true,force:true});throw error;}
 }
}

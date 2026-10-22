import {createHash,randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,realpathSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import type {Artifact,Data,Json} from './contracts.ts';

const reference=z.object({file:z.string().regex(/^[a-f0-9]{64}\.json$/),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().min(0).max(256*1024*1024),size:z.number().int().nonnegative()}).strict();
const stored=z.object({raw:reference.optional(),rows:reference.optional()}).strict();
const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');

/** Immutable content-addressed originals. Artifact bodies retain small, verifiable references. */
export class SourceContent {
 private directory:string;
 constructor(workspace:string){
  const root=realpathSync(workspace);this.directory=join(root,'source-content');mkdirSync(this.directory,{recursive:true,mode:0o700});
  if(lstatSync(this.directory).isSymbolicLink()||realpathSync(this.directory)!==this.directory)throw new Error('来源正文目录不属于当前工作区');
 }
 private path(file:string){if(!/^[a-f0-9]{64}\.json$/.test(file))throw new Error('来源正文引用无效');return join(this.directory,file);}
 private write(value:string|Json[]){
  const body=JSON.stringify(value),sha256=digest(body),file=sha256+'.json',path=this.path(file),bytes=Buffer.byteLength(body);
  if(bytes>256*1024*1024)throw new Error('来源正文超过存储预算');
  if(existsSync(path))this.read({file,sha256,bytes,size:value.length});
  else{
   const temporary=join(this.directory,`.${randomUUID()}.tmp`);let fd:number|undefined;
   try{fd=openSync(temporary,'wx',0o600);writeFileSync(fd,body);fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temporary,path);}finally{if(fd!==undefined)closeSync(fd);if(existsSync(temporary))unlinkSync(temporary);}
  }
  return{file,sha256,bytes,size:value.length};
 }
 private read(input:unknown):Json{
  const ref=reference.parse(input),path=this.path(ref.file),stat=lstatSync(path);
  if(ref.file!==ref.sha256+'.json'||!stat.isFile()||stat.isSymbolicLink()||stat.size!==ref.bytes)throw new Error('来源正文完整性校验失败');
  const bytes=readFileSync(path);if(digest(bytes)!==ref.sha256)throw new Error('来源正文完整性校验失败');return JSON.parse(bytes.toString('utf8')) as Json;
 }
 encode(artifact:Artifact):Artifact{
  if(artifact.kind!=='source')return artifact;
  const content={...artifact.content},refs=stored.parse(content.sourceContent??{});
  if(typeof content.raw==='string'){refs.raw=this.write(content.raw);delete content.raw;}
  if(Array.isArray(content.rows)){refs.rows=this.write(content.rows);delete content.rows;}
  if(Object.keys(refs).length)content.sourceContent=refs as Data;
  return{...artifact,content};
 }
 collect(references:unknown[]){
  const keep=new Set(references.flatMap(value=>Object.values(stored.parse(value??{})).map(ref=>ref.file)));let removed=0;
  for(const file of readdirSync(this.directory))if(/^[a-f0-9]{64}\.json$/.test(file)&&!keep.has(file)){
   const path=this.path(file),stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('来源正文文件不属于当前工作区');unlinkSync(path);removed++;
  }
  return removed;
 }
 decode(artifact:Artifact):Artifact{
  if(artifact.kind!=='source'||!artifact.content.sourceContent)return artifact;
  const refs=stored.parse(artifact.content.sourceContent),content={...artifact.content};delete content.sourceContent;
  for(const key of ['raw','rows'] as const)if(refs[key]){
   const value=this.read(refs[key]);
   if(key==='raw'?typeof value!=='string':!Array.isArray(value))throw new Error('来源正文内容类型无效');
   if((value as string|Json[]).length!==refs[key].size)throw new Error('来源正文长度校验失败');content[key]=value;
  }
  return{...artifact,content};
 }
}

export function sourceTextLength(source:Artifact){return typeof source.content.raw==='string'?source.content.raw.length:Number(((source.content.sourceContent as Data|undefined)?.raw as Data|undefined)?.size??0);}
export function sourceRowsLength(source:Artifact){return Array.isArray(source.content.rows)?source.content.rows.length:Number(((source.content.sourceContent as Data|undefined)?.rows as Data|undefined)?.size??0);}

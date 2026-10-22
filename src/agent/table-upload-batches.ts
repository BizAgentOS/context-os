import {z} from 'zod';
import type {Artifact,Data} from './contracts.ts';
import type {MemoryStore} from './memory.ts';
import type {AutomaticApi} from './automatic-api.ts';
import type {TableFiles,TableImportResult} from '../data/table-files.ts';
import {fingerprint} from '../engine/release-diff.ts';
import {assertRole} from '../security/actors.ts';

const id=z.string().trim().min(1).max(200),rows=(value:unknown):Data[]=>Array.isArray(value)?value as Data[]:[];
const ref=(source:Artifact)=>({id:source.id,version:source.version});
class ReplayedFile extends Error {operation:Data;constructor(operation:Data){super('文件已接收');this.operation=operation;}}

/** A user's single file selection is one initial structural build, even across separate HTTP uploads. */
export class TableUploadBatches {
  private memory:MemoryStore;private files:TableFiles;private automatic:AutomaticApi;
  constructor(memory:MemoryStore,files:TableFiles,automatic:AutomaticApi){this.memory=memory;this.files=files;this.automatic=automatic;}
  read(batchId:string){const batch=this.memory.getArtifact(id.parse(batchId));if(batch.kind!=='table_upload_batch')throw new Error('表格上传批次不存在');return batch;}
  start(input:unknown){
    assertRole('source');const args=z.object({operationId:id,taskId:id,page:z.enum(['setup','ontology']),sessionId:id.optional()}).strict().parse(input);
    return this.memory.atomic(()=>{
      this.memory.getTask(args.taskId);const old=this.memory.listArtifacts('table_upload_batch').find(item=>item.content.operationId===args.operationId);
      if(old){if(old.content.signature!==fingerprint(args))throw new Error('同一批次操作标识不能用于不同会话');return old;}
      return this.memory.putArtifact({kind:'table_upload_batch',title:'表格上传批次',status:'collecting',content:{...args,signature:fingerprint(args),sources:[],errors:[],operations:[]}});
    });
  }
  async addFile(input:unknown,stream:AsyncIterable<Uint8Array>):Promise<{batch:Artifact;tableImport:TableImportResult|null;error?:string;replayed?:boolean}>{
    assertRole('source');const args=z.object({batchId:id,operationId:id,name:z.string().min(1).max(180),options:z.unknown().optional()}).strict().parse(input);
    const initial=this.read(args.batchId),operations=rows(initial.content.operations),prior=operations.find(item=>item.operationId===args.operationId);
    if(!prior&&(initial.status!=='collecting'||operations.length>=100))throw new Error(initial.status!=='collecting'?'上传批次已结束':'每批最多接入100份表格');
    try{
      const tableImport=await this.files.import({name:args.name,input:stream,options:args.options,onSaved:(sources,receipt)=>{
        assertRole('source');const batch=this.read(args.batchId),saved=rows(batch.content.operations),signature=fingerprint({name:args.name,hash:sources[0]?.content.hash,options:args.options??{}});
        const previous=saved.find(item=>item.operationId===args.operationId);
        if(previous){if(previous.signature!==signature)throw new Error('同一文件操作标识不能上传不同内容');throw new ReplayedFile({...previous,receipt:previous.receipt??receipt});}
        if(batch.status!=='collecting')throw new Error('上传批次已结束，迟到文件未保存');
        if(saved.length>=100)throw new Error('每批最多接入100份表格');
        const references=sources.map(ref);
        for(const source of sources)this.memory.attachArtifact(String(batch.content.taskId),source);
        this.memory.putArtifact({...batch,expectedVersion:batch.version,content:{...batch.content,sources:[...rows(batch.content.sources),...references],operations:[...saved,{operationId:args.operationId,signature,name:args.name,sources:references,receipt}]}});
      }});
      return {batch:this.read(args.batchId),tableImport};
    }catch(error){
      if(error instanceof ReplayedFile)return {batch:this.read(args.batchId),tableImport:{sources:rows(error.operation.sources).map(item=>this.memory.getArtifact(String(item.id),Number(item.version))),...error.operation.receipt as unknown as Omit<TableImportResult,'sources'>},replayed:true};
      assertRole('source');const batch=this.read(args.batchId);
      if(batch.status!=='collecting'||rows(batch.content.operations).some(item=>item.operationId===args.operationId))throw error;
      const message=error instanceof Error?error.message:'表格接入失败';
      const saved=this.memory.putArtifact({...batch,expectedVersion:batch.version,content:{...batch.content,errors:[...rows(batch.content.errors),{operationId:args.operationId,name:args.name,message}],operations:[...rows(batch.content.operations),{operationId:args.operationId,name:args.name,error:message}]}});
      return {batch:saved,tableImport:null,error:message};
    }
  }
  finalize(batchId:string){
    assertRole('source');return this.memory.atomic(()=>{
      const batch=this.read(batchId);if(batch.status==='finalized')return batch;if(batch.status!=='collecting')throw new Error('批次状态不允许提交');
      const errors=[...rows(batch.content.errors)],sources:Artifact[]=[];
      for(const reference of rows(batch.content.sources)){
        const source=this.memory.getArtifact(String(reference.id));
        if(source.version!==reference.version||source.status!=='ready')errors.push({name:source.title,message:'上传后表格已变化，未纳入此次构建'});
        else if(!sources.some(item=>item.id===source.id))sources.push(source);
      }
      const saved=this.memory.putArtifact({...batch,expectedVersion:batch.version,status:'finalized',content:{...batch.content,errors,finalizedAt:new Date().toISOString()}});
      this.automatic.enqueueBatch(sources,batch.id);
      this.memory.addMessage(String(batch.content.taskId),'user',`我上传了一批表格：${sources.length}张已接入${errors.length?`，${errors.length}项需要查看失败说明`:''}，请按整批来源构建。`);
      return saved;
    });
  }
}

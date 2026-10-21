import {z} from "zod";
import type {Artifact,Data} from "./contracts.ts";
import type {MemoryStore} from "./memory.ts";
import type {AutomaticFoundation} from "./automatic-foundation.ts";
import {Workspace} from "./workspace.ts";
import {fingerprint} from "../engine/release-diff.ts";

const identifier=z.string().trim().min(1).max(200);
const fileInput=z.object({batchId:identifier,operationId:identifier,name:z.string().min(1).max(180),content:z.string().max(5_000_000).optional(),error:z.string().min(1).max(1500).optional()}).strict()
  .refine(value=>(value.content!==undefined)!==(value.error!==undefined),"文件需要正文或具体失败原因");

/** Each file is persisted separately; finalization gives the background queue one durable batch. */
export class DocumentUploadBatches {
  private memory:MemoryStore;
  private automatic:AutomaticFoundation;
  constructor(memory:MemoryStore,automatic:AutomaticFoundation){this.memory=memory;this.automatic=automatic;}
  start(operationId:string,taskId:string,page:string,sessionId?:string){
    identifier.parse(operationId);
    const existing=this.memory.listArtifacts("document_upload_batch").find(item=>item.content.operationId===operationId);
    if(existing){if(existing.content.taskId!==taskId)throw new Error("批次操作标识已用于其他会话");return existing;}
    return this.memory.putArtifact({kind:"document_upload_batch",title:"资料上传批次",status:"collecting",content:{operationId,taskId,page,sessionId:sessionId??null,sources:[],errors:[],operations:[]}});
  }
  read(id:string){const batch=this.memory.getArtifact(id);if(batch.kind!=="document_upload_batch")throw new Error("资料批次不存在");return batch;}
  add(input:unknown){
    const args=fileInput.parse(input),signature=fingerprint(args);
    return this.memory.atomic(()=>{
      const batch=this.read(args.batchId),operations=(batch.content.operations??[]) as Data[];
      const previous=operations.find(item=>item.operationId===args.operationId);
      if(previous){if(previous.signature!==signature)throw new Error("文件操作标识已绑定不同内容");return batch;}
      if(batch.status!=="collecting")throw new Error("批次已结束，不能再添加文件");
      if(operations.length>=100)throw new Error("每批最多接入100份资料");
      const sources=[...(batch.content.sources??[]) as Data[]],errors=[...(batch.content.errors??[]) as Data[]];
      let error=args.error;
      if(!error){
        try{
          if(!/\.(md|txt)$/i.test(args.name))throw new Error("资料批次只接受 Markdown 或 TXT 文本");
          let source=new Workspace(this.memory).upload(args.name,args.content!);
          source=this.memory.putArtifact({...source,expectedVersion:source.version,content:{...source.content,uploadBatchId:batch.id}});
          this.memory.attachArtifact(String(batch.content.taskId),source);
          sources.push({id:source.id,version:source.version});
          if(source.status!=="ready")error=String(source.content.parseError??"资料正文无效");
        }catch(cause){error=(cause as Error).message;}
      }
      if(error)errors.push({operationId:args.operationId,name:args.name,message:error});
      return this.memory.putArtifact({...batch,expectedVersion:batch.version,content:{...batch.content,sources,errors,operations:[...operations,{operationId:args.operationId,signature}]}});
    });
  }
  finalize(id:string):Artifact{
    return this.memory.atomic(()=>{
      const batch=this.read(id);if(batch.status==="finalized")return batch;
      if(batch.status!=="collecting")throw new Error("批次状态不允许提交");
      const refs=(batch.content.sources??[]) as Data[],sources:Artifact[]=[],errors=[...(batch.content.errors??[]) as Data[]];
      for(const ref of refs){
        const source=this.memory.getArtifact(String(ref.id));
        if(source.version!==ref.version||source.status==="removed")errors.push({name:source.title,message:"上传后资料已变化，本批次未处理此旧版本"});
        else sources.push(source);
      }
      const saved=this.memory.putArtifact({...batch,expectedVersion:batch.version,status:"finalized",content:{...batch.content,errors,finalizedAt:new Date().toISOString()}});
      this.automatic.enqueueBatch(sources,batch.id);
      this.memory.addMessage(String(batch.content.taskId),"user",`我上传了一批资料：${sources.length}份已接入${errors.length?`，${errors.length}项需要查看失败说明`:""}。`);
      this.memory.trimMessages(String(batch.content.taskId));
      return saved;
    });
  }
}

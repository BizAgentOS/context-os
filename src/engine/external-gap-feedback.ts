import {currentActor,assertRole} from '../security/actors.ts';
import {z} from 'zod';
import type {MemoryStore} from '../agent/memory.ts';
import {qaReference,type QaDataView} from '../agent/qa-view.ts';
import {fingerprint} from './release-diff.ts';
import {jsonData} from '../live/sources.ts';

const configure=z.object({connectionRef:qaReference,enabled:z.boolean(),operationId:z.string().trim().min(1).max(200)}).strict();
type Reference=z.infer<typeof qaReference>;

/** This service is administrator-only. Consumer tools can inspect its gate, never configure it. */
export class ExternalGapFeedback {
  private memory:MemoryStore;
  constructor(memory:MemoryStore){this.memory=memory;}
  private connection(input:unknown){
    const expected=qaReference.parse(input),connection=this.memory.getArtifact(expected.id);
    if(connection.kind!=='release_connection'||connection.status!=='active'||connection.version!==expected.version)throw new Error('接入方已停用或版本变化');
    const pinned=qaReference.parse(connection.content.datasetRef),dataset=this.memory.getArtifact(pinned.id);
    if(dataset.kind!=='ontology_dataset'||dataset.status!=='active'||dataset.version!==pinned.version)throw new Error('接入数据授权已变化');
    return connection;
  }
  read(input:unknown){
    const connection=this.connection(input),connectionRef={id:connection.id,version:connection.version};
    const policy=this.memory.listArtifacts('external_gap_feedback_policy').find(item=>fingerprint(item.content.connectionRef)===fingerprint(connectionRef));
    return {connectionRef,enabled:policy?.content.enabled===true,metadataOnly:true as const,policyRef:policy?{id:policy.id,version:policy.version}:null};
  }
  configure(input:unknown){
    assertRole("connection");
    const args=configure.parse(input);
    return this.memory.atomic(()=>{
      this.connection(args.connectionRef);
      const signature=fingerprint(args),old=this.memory.listArtifacts('external_gap_feedback_receipt').find(item=>item.content.operationId===args.operationId);
      if(old){if(old.content.signature!==signature)throw new Error('同一操作标识已用于不同缺口回传设置');return old.content.result as ReturnType<ExternalGapFeedback['read']>;}
      const prior=this.memory.listArtifacts('external_gap_feedback_policy').find(item=>fingerprint(item.content.connectionRef)===fingerprint(args.connectionRef));
      this.memory.putArtifact({...(prior?{id:prior.id,expectedVersion:prior.version}:{}),kind:'external_gap_feedback_policy',title:'外部缺口回传设置',status:'saved',content:jsonData({connectionRef:args.connectionRef,enabled:args.enabled,actor:currentActor().id,updatedAt:new Date().toISOString()})});
      const result=this.read(args.connectionRef);
      this.memory.putArtifact({kind:'external_gap_feedback_receipt',title:'外部缺口回传设置回执',status:'saved',content:jsonData({operationId:args.operationId,signature,result,actor:currentActor().id})});
      return result;
    });
  }
  assertEnabled(view:Extract<QaDataView,{kind:'consumer'}>){
    const connection=this.connection(view.connectionRef);
    if(fingerprint(connection.content.releaseRef)!==fingerprint(view.releaseRef))throw new Error('接入发布范围已变化');
    if(!this.read(view.connectionRef).enabled)throw new Error('外部缺口回流默认关闭，管理员尚未开启');
  }
}

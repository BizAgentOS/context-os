import {z} from 'zod';
import type {MemoryStore} from '../agent/memory.ts';
import {currentActor,assertRole} from './actors.ts';
import {jsonData} from '../live/sources.ts';

const audited=new Set(['ontology_change','foundation_adjudication','identity_decision','relation_correction','property_correction','data_release','release_connection','ontology_dataset','consumer_view','source','source_connection','source_lifecycle','sync_issue','external_gap_feedback_policy','local_user','usage_policy','workspace_backup','retention_run']);
const installed=new WeakSet<MemoryStore>();

/** Audit entries share the business transaction; rolled-back decisions never look successful. */
export class AuditTrail {
  private memory:MemoryStore;
  constructor(memory:MemoryStore){
    this.memory=memory;
    if(installed.has(memory))return;installed.add(memory);
    const previous=memory.beforeCommit;
    memory.beforeCommit=written=>{
      previous?.(written);
      for(const item of [...written].filter(item=>audited.has(item.kind))){
        memory.putArtifact({kind:'audit_record',title:`${item.title} · ${item.status}`,status:'recorded',content:jsonData({actor:item.actor??currentActor(),action:`${item.kind}:${item.status}`,target:{id:item.id,version:item.version,kind:item.kind},at:item.createdAt})});
      }
    };
  }
  list(input:unknown={}){
    assertRole('users');
    const args=z.object({actorId:z.string().min(1).optional(),targetId:z.string().min(1).optional(),offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(100).default(50)}).strict().parse(input);
    const all=this.memory.listArtifacts('audit_record').filter(item=>(!args.actorId||(item.content.actor as {id:string}).id===args.actorId)&&(!args.targetId||(item.content.target as {id:string}).id===args.targetId));
    return {total:all.length,items:all.slice(args.offset,args.offset+args.limit)};
  }
}

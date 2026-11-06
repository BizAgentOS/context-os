import { authorize, ontologySchema, type Principal } from './contracts.ts';
import { planProposalSchema, planReviewSchema } from './build-contracts.ts';
import { fingerprint } from './sources.ts';
import { structureHash } from './structured-profile.ts';
import { STRUCTURED_POLICY } from './structured-compiler.ts';
import type { KnowledgeCore } from './service.ts';
import type { Sql } from './database.ts';

const headProof=(heads:Array<Record<string,any>>)=>heads.map(h=>({sourceId:h.source_id,version:h.source_version_id,runId:h.run_id,planId:h.build_plan_id})).sort((a,b)=>a.sourceId.localeCompare(b.sourceId));
export async function verifyReusableMapping(sql:Sql,template:NonNullable<Awaited<ReturnType<typeof reusableMapping>>>) {
  const heads=(await sql.query('SELECT * FROM knowledge.source_build_heads WHERE source_id=ANY($1::uuid[])',[template.sourceIds])).rows;
  const latest=(await sql.query("SELECT id FROM knowledge.ontologies WHERE status='published' ORDER BY published_at DESC LIMIT 1")).rows[0];
  if(latest?.id!==template.ontologyId||fingerprint(headProof(heads))!==template.headHash)throw new Error('映射复用期间已发布本体或来源构建头变化，请刷新后重新检查；未调用模型');
}

/** Reuse an approved mapping, never an old approval or frozen factual output. */
export async function reusableMapping(core:KnowledgeCore,actor:Principal,sourceVersionIds:string[]) {
  authorize(actor,true);
  const sources=(await core.db.pool.query('SELECT v.*,s.active_version,s.observed_version FROM knowledge.source_versions v JOIN knowledge.sources s ON s.id=v.source_id WHERE v.id=ANY($1::uuid[])',[sourceVersionIds])).rows;
  if(sources.length!==sourceVersionIds.length||sources.some(s=>s.content.kind!=='table'||(s.observed_version??s.active_version)!==s.id))return null;
  const heads=(await core.db.pool.query("SELECT h.*,r.status FROM knowledge.source_build_heads h JOIN knowledge.extraction_runs r ON r.id=h.run_id WHERE h.source_id=ANY($1::uuid[])",[sources.map(s=>s.source_id)])).rows;
  if(heads.length!==sources.length||heads.some(h=>h.status!=='completed')||new Set(heads.map(h=>h.build_plan_id)).size!==1)return null;
  const prior=(await core.db.pool.query("SELECT * FROM knowledge.build_plans WHERE id=$1 AND status='approved'",[heads[0].build_plan_id])).rows[0];
  if(!prior||prior.provenance?.structuredPolicy!==STRUCTURED_POLICY)return null;
  const current=(await core.db.pool.query("SELECT * FROM knowledge.ontologies WHERE status='published' ORDER BY published_at DESC LIMIT 1")).rows[0];
  if(!current||current.id!==prior.ontology_id||fingerprint(ontologySchema.parse(current.definition))!==prior.ontology_hash)return null;
  if(fingerprint(prior.manifest.map((m:any)=>m.sourceId).sort())!==fingerprint(sources.map(s=>s.source_id).sort()))return null;
  const ids=new Map<string,string>();
  for(const source of sources){
    const old=prior.manifest.find((m:any)=>m.sourceId===source.source_id),head=heads.find(h=>h.source_id===source.source_id)!;
    if(head.build_plan_id!==prior.id||source.active_version!==head.source_version_id||old.id!==head.source_version_id)return null;
    const version=(await core.db.pool.query('SELECT content FROM knowledge.source_versions WHERE id=$1',[old.id])).rows[0];
    if(!version||structureHash(version.content)!==structureHash(source.content))return null;
    ids.set(old.id,source.id);
  }
  const original=planProposalSchema.parse(prior.proposal);
  if(original.documents.length||original.csv.length!==sources.length)return null;
  const proposal=planProposalSchema.parse({...original,csv:original.csv.map(m=>({...m,sourceVersionId:ids.get(m.sourceVersionId)}))});
  const previousReview=planReviewSchema.parse(prior.review),items:typeof previousReview.items={};
  for(const [key,value] of Object.entries(previousReview.items)){
    const id=key.slice(0,36),replacement=ids.get(id);if(!replacement)return null;
    items[replacement+key.slice(36)]={...value,reviewed:false};
  }
  const review=planReviewSchema.parse({items,datetimeOffset:previousReview.datetimeOffset});
  return {ontologyId:current.id,ontologyRevision:current.revision,proposal,review,priorPlanId:prior.id,sourceIds:sources.map(s=>s.source_id),headHash:fingerprint(headProof(heads)),
    templateHash:fingerprint({ontology:prior.ontology_hash,proposal:original,items:previousReview.items,datetimeOffset:previousReview.datetimeOffset,policy:STRUCTURED_POLICY})};
}

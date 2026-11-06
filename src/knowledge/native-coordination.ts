import type { Sql } from './database.ts';
import type { Ontology } from './contracts.ts';
import { discoveryInput, validateDiscoveryEvidence, type DiscoverySource } from './discovery.ts';
import { fingerprint, type SourceContent } from './sources.ts';
import { structuredTableInput } from './structured-compiler.ts';
import { fromStructuredModel, structuredDiscoveryModelSchema } from './structured-model-boundary.ts';

/** Keep source sampling identical for original discovery and explicit receipt reuse. */
export function discoverySamples(sources:Array<Record<string,any>>):DiscoverySource[] {
  return sources.map(s=>{
    const content=s.content as SourceContent;
    if(content.kind==='pdf')return {...content,id:s.id,text:content.text?.slice(0,16000),coverage:{characters:Math.min(16000,content.text?.length??0),total:content.text?.length??0}};
    return {...content,id:s.id,sourceNamespace:`source.${s.source_id}`,nativeValues:content.kind==='table'?Object.fromEntries((content.rows??[]).slice(0,10).map(row=>[row[content.keyColumn!],content.nativeValues![row[content.keyColumn!]]])):undefined,
      rows:content.rows?.slice(0,10),coverage:{sampled:Math.min(10,content.rows?.length??0),total:content.rowCount??content.rows?.length??0}};
  });
}
const compatiblePolicies:Record<string,string>={
  'knowledge-native-sources-v16-structured-wire':'structured-compiler-v6',
  'knowledge-native-sources-v17-major-decisions':'structured-compiler-v7',
  'knowledge-native-sources-v18-compact-coordination':'structured-compiler-v8',
  'knowledge-native-sources-v19-evidence-coordination':'structured-compiler-v9',
  'knowledge-native-sources-v20-dependency-coordination':'structured-compiler-v10',
  'knowledge-native-sources-v21-current-reference-coverage':'structured-compiler-v11',
  'knowledge-native-sources-v22-nontrivial-references':'structured-compiler-v12',
};
export interface CoordinationScope {sourceVersionIds:string[];baseOntologyId?:string;baseRevision?:number;}
/** Explicit, narrow cross-policy bridge: verify the original receipt fingerprint, then revalidate current wire and evidence. */
export async function loadCoordinationTables(sql:Sql,parentId:string,sources:DiscoverySource[],base:Ontology|null,scope:CoordinationScope) {
  const parent=(await sql.query('SELECT * FROM knowledge.jobs WHERE id=$1',[parentId])).rows[0];
  if(!parent||parent.kind!=='discover'||!['completed','failed'].includes(parent.state))throw new Error('仅可复用已完成或失败的原生发现任务；运行中任务不可复用');
  const input=parent.payload.input;
  if(input.kind!=='discover'||input.revalidateFromJobId||input.coordinateFromJobId)throw new Error('请使用原始逐表发现任务，不能将本地校验或协调任务当作逐表结果');
  if(fingerprint({sourceVersionIds:input.sourceVersionIds,baseOntologyId:input.baseOntologyId,baseRevision:input.baseRevision})!==fingerprint(scope))throw new Error('复用来源范围或基础本体修订不一致');
  const policy=compatiblePolicies[parent.payload.promptVersion];
  if(!policy)throw new Error('原逐表响应策略不兼容；不会重新调用逐表模型');
  if(sources.length!==scope.sourceVersionIds.length||sources.some((s,i)=>s.id!==scope.sourceVersionIds[i]||s.kind!=='table'))throw new Error('仅协调复用必须保持原生来源及顺序');
  const receipts=(await sql.query('SELECT stage,fingerprint,result FROM knowledge.analysis_steps WHERE job_id=$1',[parentId])).rows;
  const tables:Record<string,unknown>={},proofs:Array<{stage:string;fingerprint:string;outputHash:string}>=[];
  for(const source of sources){
    const current=(await sql.query('SELECT COALESCE(observed_version,active_version) AS active_version FROM knowledge.sources WHERE id=(SELECT source_id FROM knowledge.source_versions WHERE id=$1)',[source.id])).rows[0];
    if(current?.active_version!==source.id)throw new Error('来源已有新版本或已不可用；禁止使用旧逐表结果协调');
    if(!source.rows?.length){if(source.rowCount!==0)throw new Error('非空来源样本缺失，不能当作空表复用');continue;}
    const stage=`table:${source.id}`,receipt=receipts.find(r=>r.stage===stage);
    if(!receipt)throw new Error('逐表保存结果不完整；仅协调任务禁止补跑逐表模型');
    const expected=fingerprint({policy,configuration:{model:parent.payload.modelId,budget:parent.payload.modelPolicy,prompt:parent.payload.promptVersion},stage,input:structuredTableInput(source,base,!['structured-compiler-v9','structured-compiler-v10','structured-compiler-v11','structured-compiler-v12'].includes(policy),policy==='structured-compiler-v9')});
    if(receipt.fingerprint!==expected)throw new Error('逐表冻结输入或基础本体与保存指纹不符，不能复用');
    const raw=structuredDiscoveryModelSchema('table').parse(receipt.result),candidate=fromStructuredModel(raw,'table');
    if(candidate.types.length){validateDiscoveryEvidence(candidate,[source],discoveryInput([source],base).catalog,base);}
    tables[source.id]=raw;
    proofs.push({stage,fingerprint:receipt.fingerprint,outputHash:fingerprint(raw)});
  }
  return {tables,originJobId:parentId,snapshotHash:fingerprint({parentId,scope,proofs}),tableCount:proofs.length,emptyCount:sources.length-proofs.length};
}

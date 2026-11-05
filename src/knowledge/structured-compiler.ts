import { z } from 'zod';
import type { KnowledgeCore } from './service.ts';
import { discoveryCandidateSchema, discoveryInput, validateDiscovery, validateDiscoveryEvidence, type TableDecision, type CatalogEntry, type DiscoverySource } from './discovery.ts';
import { fingerprint } from './sources.ts';
import { structuredCandidates, tableStructure } from './structured-profile.ts';
import { planProposalSchema } from './build-contracts.ts';
import type { Ontology } from './contracts.ts';

export const STRUCTURED_POLICY = 'structured-compiler-v2';
const tableCandidateSchema=discoveryCandidateSchema.extend({
  types:z.array(discoveryCandidateSchema.shape.types.element).max(100),
  disposition:z.enum(['candidate','deferred','not_applicable']).default('candidate'),
  reason:z.string().trim().max(2000).default(''),
}).refine(v=>v.disposition==='candidate'?v.types.length>0:!!v.reason,'无候选或暂缓须明确状态和理由')
  .refine(v=>v.types.length>0||(!v.links.length&&!v.evidenceReferences.length&&!v.uncertainties.length),'空候选不能携带悬空成员引用');
interface Options { core:KnowledgeCore; job:{id:string;leaseToken:string}; policy:unknown;
  generate:(stage:string,task:'discover'|'plan',input:unknown,schema:z.ZodType)=>Promise<unknown>;
  cached:(stage:string)=>void; }

/** Local checkpoints only. A new parent job cannot silently reuse a different input. */
export class StructuredCompiler {
  private options:Options;
  constructor(options:Options) {this.options=options;}
  private async step<T>(stage:string,task:'discover'|'plan',input:unknown,schema:z.ZodType<T>,validate:(value:T)=>void=()=>{}):Promise<T> {
    const {core,job}=this.options,hash=fingerprint({policy:STRUCTURED_POLICY,configuration:this.options.policy,stage,input});
    const check=async()=>{
      if(!(await core.db.pool.query("SELECT id FROM knowledge.jobs WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp()",[job.id,job.leaseToken])).rows.length)throw new Error('分析租约已失效，不能继续调用或保存模型');
    };
    await check();
    const old=(await core.db.pool.query('SELECT fingerprint,result FROM knowledge.analysis_steps WHERE job_id=$1 AND stage=$2',[job.id,stage])).rows[0];
    if(old){if(old.fingerprint!==hash)throw new Error('已保存分析步骤的冻结输入不一致，不能沿用');this.options.cached(stage);const output=schema.parse(old.result);validate(output);return output;}
    if(Buffer.byteLength(JSON.stringify(input))>180000)throw new Error(`分析阶段 ${stage} 超过输入预算，已完成步骤保留，不静默截断`);
    const output=schema.parse(await this.options.generate(stage,task,input,schema));
    validate(output);
    await core.db.transaction(async sql=>{
      if(!(await sql.query("SELECT id FROM knowledge.jobs WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp()",[job.id,job.leaseToken])).rows.length)throw new Error('分析租约失效，输出未采用');
      await sql.query('INSERT INTO knowledge.analysis_steps(job_id,stage,fingerprint,result) VALUES($1,$2,$3,$4::jsonb)',[job.id,stage,hash,JSON.stringify(output)]);
    });
    return output;
  }
  private physical(raw:unknown,sources:DiscoverySource[],catalog:CatalogEntry[],base:Ontology|null,local=false) {
    const candidate=discoveryCandidateSchema.parse(raw);
    for(const p of candidate.types.flatMap(t=>t.properties)){
      if(base?.types.flatMap(t=>t.properties).some(old=>old.id===p.id&&fingerprint(old)===fingerprint(p)))continue;
      const refs=candidate.evidenceReferences.filter(e=>e.memberId===p.id).flatMap(e=>e.evidenceIds);
      const fields=catalog.filter(e=>refs.includes(e.id)&&e.locator.kind==='field').flatMap(e=>{
        const source=sources.find(s=>s.id===e.sourceVersionId)!;
        return structuredCandidates(source).columns.filter(c=>e.locator.kind==='field'&&c.column===e.locator.field);
      });
      if(p.valueType==='datetime'&&!fields.some(f=>f.valueType==='datetime')){
        const columns=[...new Set(fields.map(f=>`${f.column} (${f.physicalType})`))].sort().join('、').slice(0,1200)||'未找到匹配的物理列类型';
        const question=`属性 ${p.id} 的日期候选没有已验证的物理日期列依据；证据列：${columns}。请核对字段业务含义、日期表示及转换规则/时区，数值可能是时间戳或耗时，不能凭名称或猜单位转换`;
        if(!candidate.uncertainties.some(u=>u.memberId===p.id&&u.kind==='datetime_representation'&&u.question===question))candidate.uncertainties.push({memberId:p.id,kind:'datetime_representation',question});
      }
      if(p.valueType==='enum'&&!fields.some(f=>f.enumValues&&fingerprint([...f.enumValues].sort())===fingerprint([...(p.enumValues??[])].sort()))){
        // A SQL scalar may carry a business enum. Keep it as a proposal, never infer closure from samples.
        const question=`属性 ${p.id} 的候选枚举缺少匹配的完整数据库 ENUM 声明；需核对业务字典、规则或字段说明，样本取值不能证明允许值集合完整`;
        if(!candidate.uncertainties.some(u=>u.memberId===p.id&&u.kind==='constraint'&&u.question===question))candidate.uncertainties.push({memberId:p.id,kind:'constraint',question});
      }
    }
    if(local)validateDiscoveryEvidence(candidate,sources,catalog,base);else validateDiscovery(candidate,sources,catalog,base);
    return candidate;
  }
  async discover(sources:DiscoverySource[],base:Ontology|null) {
    const tables:Array<z.infer<typeof discoveryCandidateSchema>>=[],catalog:CatalogEntry[]=[],tableDecisions:TableDecision[]=[],tableProposals:Array<{sourceVersionId:string;candidate:unknown;evidence:unknown}>=[];
    for(const [index,source] of sources.entries()){
      if(!source.rows?.length){if(source.rowCount!==0)throw new Error('来源声明非空但未加载实例，不能当作空表排除');tableDecisions.push({sourceVersionId:source.id,sourceName:`${source.metadata?.schema??''}.${source.metadata?.name??source.id}`,status:'no_evidence',reason:'当前完整来源无实例记录；保留结构信息，不伪造记录证据'});continue;}
      const prepared=discoveryInput([source],base),stage=`table:${source.id}`;
      const check=(value:z.infer<typeof tableCandidateSchema>)=>{
        const {disposition:_,reason:__,...candidate}=value;
        if(candidate.types.length)this.physical(candidate,[source],prepared.catalog,base,true);
      };
      const raw=await this.step(stage,'discover',{...prepared.input,stage:'table',instructions:'根据物理类型、声明约束和注释生成业务候选。观测值不能闭合枚举。不得只看列名决定日期。保留多对象，不自动合并跨源身份。没有业务候选可返回not_applicable，含糊表返回deferred并写reason；允许types为空，不虚设类型。'},tableCandidateSchema,check);
      const {disposition,reason,...candidate}=raw;
      const checked=candidate.types.length?this.physical(candidate,[source],prepared.catalog,base,true):candidate;
      const entirelyDeferred=checked.types.length>0&&checked.types.every(t=>checked.uncertainties.some(u=>u.kind==='definition'&&u.memberId===t.id));
      const status=disposition==='candidate'&&entirelyDeferred?'deferred':disposition;
      tableDecisions.push({sourceVersionId:source.id,sourceName:`${source.metadata?.schema??''}.${source.metadata?.name??source.id}`,status,reason:reason||(entirelyDeferred?'本表候选类型全部存在定义歧义，留待集中决定':'具有可验证的业务候选')});
      if(checked.types.length)tableProposals.push({sourceVersionId:source.id,candidate:checked,evidence:validateDiscoveryEvidence(checked,[source],prepared.catalog,base).proposed.discoveryEvidence});
      if(status!=='candidate')continue;
      const used=new Set(checked.evidenceReferences.flatMap(e=>e.evidenceIds)),prefix=`t${index+1}:`;
      catalog.push(...prepared.catalog.filter(e=>used.has(e.id)).map(e=>({...e,id:prefix+e.id})));
      if(checked.types.length)tables.push({...checked,evidenceReferences:checked.evidenceReferences.map(e=>({...e,evidenceIds:e.evidenceIds.map(id=>prefix+id)}))});
    }
    if(!tableDecisions.some(d=>d.status==='candidate')){
      if(!base)throw new Error('全部来源已分析，但本轮无可采用内容；暂缓步骤已保存，不能创建空本体');
      const {discoveryEvidence:_,...definition}=base;
      return {raw:{...definition,evidenceReferences:[],uncertainties:[]},catalog,tableDecisions,tableProposals};
    }
    if(sources.length===1){
      const prepared=discoveryInput(sources,base);
      const raw={...tables[0],evidenceReferences:tables[0].evidenceReferences.map(e=>({...e,evidenceIds:e.evidenceIds.map(id=>id.slice(id.indexOf(':')+1))}))};
      return {raw,catalog:prepared.catalog,tableDecisions,tableProposals};
    }
    const input={stage:'coordinate',baseOntology:base,tableCandidates:tables,tableDecisions,
      sources:sources.map(s=>({id:s.id,kind:s.kind,metadata:tableStructure(s),structuredCandidates:structuredCandidates(s)})),
      evidenceCatalog:catalog.map(e=>({evidenceId:e.id,sourceVersionId:e.sourceVersionId,...(e.locator.kind==='field'?{kind:'field',field:e.locator.field,recordKey:e.locator.recordKey,value:e.value}:{kind:'quote',text:e.value})})),
      instructions:'统一协调候选，沿用已发布稳定ID，保留多对象/自引用和暂缓依据。不从deferred/no_evidence/not_applicable来源新采用定义或事实，不强制每表一个类型。不自动合并跨源身份。返回统一候选，重大事项最终集中决定。'};
    const raw=await this.step('coordinate','discover',input,discoveryCandidateSchema,value=>{this.physical(value,sources,catalog,base);});
    return {raw:this.physical(raw,sources,catalog,base),catalog,tableDecisions,tableProposals};
  }
  async plan(ontology:Ontology,sources:DiscoverySource[],previous:unknown,issues:unknown,tableDecisions:TableDecision[]=[]) {
    const csv=[],skipped:Array<{sourceVersionId:string;reason:string}>=[],notes:string[]=[],noteLimit=Math.floor(50/sources.length);
    for(const source of sources){
      if(!source.rows?.length){if(source.rowCount!==0)throw new Error('来源声明非空但未加载实例，不能跳过构建');skipped.push({sourceVersionId:source.id,reason:'当前完整来源无实例记录，不生成事实；旧正式知识保留'});continue;}
      const decision=tableDecisions.find(d=>d.sourceVersionId===source.id);
      if(decision&&decision.status!=='candidate'){skipped.push({sourceVersionId:source.id,reason:decision.reason});continue;}
      const raw=await this.step(`mapping:${source.id}`,'plan',{stage:'table_mapping',ontology,sources:[{...source,metadata:tableStructure(source)}],structuredCandidates:structuredCandidates(source),previousProposal:previous,discoveryIssues:issues,
        instructions:`只生成此来源的结构化映射，notes最多${noteLimit}条。参考确定性列候选、物理主键及声明外键，但业务含义/时间不明保留unknown。允许一行多个对象；不自动合并跨源身份。无可执行业务映射时只返回当前来源的skipped和明确理由。booleanEncoding可选literal或zero_one，0/1必须显式zero_one；对象onNull可选error或skip_object，仅允许原生可空非主键列，策略将进入集中确认。`},planProposalSchema,value=>{
        if(value.notes.length>noteLimit)throw new Error(`表级计划说明超过本轮分配的${noteLimit}条预算`);
        if(value.documents.length||value.csv.length+(value.skipped?.length??0)!==1||[...value.csv,...(value.skipped??[])].some(s=>s.sourceVersionId!==source.id))throw new Error('表级计划必须且只能绑定当前来源，不能混入其他表或文档');
      });
      csv.push(...raw.csv);skipped.push(...(raw.skipped??[]));notes.push(...raw.notes);
    }
    return planProposalSchema.parse({csv,skipped,documents:[],notes:[...new Set(notes)]});
  }
}

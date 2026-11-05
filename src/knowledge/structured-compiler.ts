import { z } from 'zod';
import type { KnowledgeCore } from './service.ts';
import { discoveryCandidateSchema, discoveryInput, validateDiscovery, type CatalogEntry, type DiscoverySource } from './discovery.ts';
import { fingerprint } from './sources.ts';
import { structuredCandidates, tableStructure } from './structured-profile.ts';
import { planProposalSchema } from './build-contracts.ts';
import type { Ontology } from './contracts.ts';

export const STRUCTURED_POLICY = 'structured-compiler-v1';
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
  private physical(raw:unknown,sources:DiscoverySource[],catalog:CatalogEntry[],base:Ontology|null) {
    const candidate=discoveryCandidateSchema.parse(raw);
    for(const p of candidate.types.flatMap(t=>t.properties)){
      if(base?.types.flatMap(t=>t.properties).some(old=>old.id===p.id&&fingerprint(old)===fingerprint(p)))continue;
      const refs=candidate.evidenceReferences.filter(e=>e.memberId===p.id).flatMap(e=>e.evidenceIds);
      const fields=catalog.filter(e=>refs.includes(e.id)&&e.locator.kind==='field').flatMap(e=>{
        const source=sources.find(s=>s.id===e.sourceVersionId)!;
        return structuredCandidates(source).columns.filter(c=>e.locator.kind==='field'&&c.column===e.locator.field);
      });
      if(p.valueType==='datetime'&&!fields.some(f=>f.valueType==='datetime'))throw new Error(`属性 ${p.id} 的日期类型缺少物理日期列依据；不能依据名称中的 time 把耗时转成日期`);
      if(p.valueType==='enum'&&!fields.some(f=>f.enumValues&&fingerprint([...f.enumValues].sort())===fingerprint([...(p.enumValues??[])].sort())))throw new Error(`属性 ${p.id} 的封闭枚举没有完整数据库 ENUM 声明依据；样本取值只能作为观测值`);
    }
    validateDiscovery(candidate,sources,catalog,base);
    return candidate;
  }
  async discover(sources:DiscoverySource[],base:Ontology|null) {
    const tables:Array<z.infer<typeof discoveryCandidateSchema>>=[],catalog:CatalogEntry[]=[];
    for(const source of sources){
      const prepared=discoveryInput([source],base),stage=`table:${source.id}`;
      const raw=await this.step(stage,'discover',{...prepared.input,stage:'table',instructions:'根据物理类型、声明约束和注释生成业务候选。观测值不能闭合枚举。不得只看列名决定日期。保留多个对象的可能性，不自动合并跨源身份。'},discoveryCandidateSchema,value=>{this.physical(value,[source],prepared.catalog,base);});
      const checked=this.physical(raw,[source],prepared.catalog,base);
      const used=new Set(checked.evidenceReferences.flatMap(e=>e.evidenceIds)),prefix=`t${tables.length+1}:`;
      catalog.push(...prepared.catalog.filter(e=>used.has(e.id)).map(e=>({...e,id:prefix+e.id})));
      tables.push({...checked,evidenceReferences:checked.evidenceReferences.map(e=>({...e,evidenceIds:e.evidenceIds.map(id=>prefix+id)}))});
    }
    if(sources.length===1){
      const prepared=discoveryInput(sources,base);
      // Keep the single-table candidate's original catalog identifiers.
      const raw={...tables[0],evidenceReferences:tables[0].evidenceReferences.map(e=>({...e,evidenceIds:e.evidenceIds.map(id=>id.slice(id.indexOf(':')+1))}))};
      return {raw,catalog:prepared.catalog};
    }
    const input={stage:'coordinate',baseOntology:base,tableCandidates:tables,
      sources:sources.map(s=>({id:s.id,kind:s.kind,metadata:tableStructure(s),structuredCandidates:structuredCandidates(s)})),
      evidenceCatalog:catalog.map(e=>({evidenceId:e.id,sourceVersionId:e.sourceVersionId,...(e.locator.kind==='field'?{kind:'field',field:e.locator.field,recordKey:e.locator.recordKey,value:e.value}:{kind:'quote',text:e.value})})),
      instructions:'统一协调表级候选，沿用已发布稳定ID，区分物理表、业务概念和对象身份。已声明外键作为结构候选，保留自引用及多角色，不凭同名编号合并对象。关系需现有evidenceId依据。只输出本轮统一候选，不分表发布或要求逐表批准。'};
    const raw=await this.step('coordinate','discover',input,discoveryCandidateSchema,value=>{this.physical(value,sources,catalog,base);});
    return {raw:this.physical(raw,sources,catalog,base),catalog};
  }
  async plan(ontology:Ontology,sources:DiscoverySource[],previous:unknown,issues:unknown) {
    const csv=[],notes:string[]=[],noteLimit=Math.floor(50/sources.length);
    for(const source of sources){
      const raw=await this.step(`mapping:${source.id}`,'plan',{stage:'table_mapping',ontology,sources:[{...source,metadata:tableStructure(source)}],structuredCandidates:structuredCandidates(source),previousProposal:previous,discoveryIssues:issues,
        instructions:`只生成此来源的结构化映射，notes最多${noteLimit}条。参考确定性列候选、物理主键及声明外键，但业务含义/时间不明保留unknown。允许一行多个对象；不自动合并跨源身份。`},planProposalSchema,value=>{
        if(value.notes.length>noteLimit)throw new Error(`表级计划说明超过本轮分配的${noteLimit}条预算`);
        if(value.documents.length||value.csv.length!==1||value.csv[0].sourceVersionId!==source.id)throw new Error('表级计划必须且只能绑定当前来源，不能混入其他表或文档');
      });
      csv.push(raw.csv[0]);notes.push(...raw.notes);
    }
    return planProposalSchema.parse({csv,documents:[],notes:[...new Set(notes)]});
  }
}

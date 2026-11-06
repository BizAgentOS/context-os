import {relationshipValidation} from './relationship-validation.ts';
import {coordinationPages,catalogPairs,taskIdentity,semanticWindows} from './coordination-tasks.ts';
import { modelRequestSize } from './model.ts';
import { z } from 'zod';
import type { KnowledgeCore } from './service.ts';
import { discoveryCandidateSchema, discoveryInput, validateDiscovery, validateDiscoveryEvidence, candidateDefinition, carryDiscoveryEvidence, conservativeNativeDefinition, type TableDecision, type CatalogEntry, type DiscoverySource } from './discovery.ts';
import { fingerprint } from './sources.ts';
import { structuredCandidates, tableStructure } from './structured-profile.ts';
import { planProposalSchema } from './build-contracts.ts';
import { structuredDiscoveryModelSchema, fromStructuredModel, toStructuredModel, structuredOntologyView, structuredSourceView, structuredCoordinationSourceView, structuredMappingModelSchema, structuredPreviousPlan, structuredIssueView } from './structured-model-boundary.ts';
import type { Ontology } from './contracts.ts';
import { crossTableReferences, currentReferenceTypes } from './structured-references.ts';
import { compactCoordinationSchema, qualifyMemberId, coordinationReferences, materializeCoordination, compactCoordinationInstructions } from './compact-coordination.ts';

export const STRUCTURED_POLICY = 'structured-compiler-v12';
export function structuredTableInput(source:DiscoverySource,base:Ontology|null,legacy=false,oldCommentCodes=false) { return {stage:'table',sources:[structuredSourceView(source,true,legacy,oldCommentCodes)],baseOntology:structuredOntologyView(base),
        instructions:'根据声明类型、注释和样本提出候选。成员自身sourceColumns只填写真实列名，当前逐表可省略sourceVersionId；不确定项放在该成员自身uncertainties，不重复填写memberId。未知来源留空并暂缓，样本不证明完整枚举或业务必填。允许多对象；无业务候选返回not_applicable、含糊表返回deferred并写reason。'}; }
interface Options { core:KnowledgeCore; job:{id:string;leaseToken:string}; policy:unknown;
  generate:(stage:string,task:'discover'|'plan',input:unknown,schema:z.ZodType)=>Promise<unknown>;
  cached:(stage:string)=>void;
  reusedTables?:Record<string,unknown>;
  reuseActorId?:string;
  progress?:(event:Record<string,unknown>)=>void; }

export function requestDependencies(input:unknown){
  const sources=new Set<string>(),members=new Set<string>();
  const walk=(value:any)=>{if(Array.isArray(value)){value.forEach(walk);return;}if(!value||typeof value!=='object')return;
    for(const [key,child]of Object.entries(value)){if((key==='sourceVersionId'||key==='targetSourceVersionId')&&typeof child==='string')sources.add(child);if(key==='ref'&&typeof child==='string')members.add(child);walk(child);}
    if(value.kind==='table'&&typeof value.id==='string')sources.add(value.id);
  };walk(input);return {sourceVersionIds:[...sources].sort(),memberRefs:[...members].sort(),inputHash:fingerprint(input)};
}

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
    if(old){if(old.fingerprint!==hash)throw new Error('已保存分析步骤的冻结输入不一致，不能沿用');const output=schema.parse(old.result);this.options.cached(stage);validate(output);return output;}
    if(modelRequestSize(task,input,schema)>180000)throw new Error(`分析阶段 ${stage} 超过输入预算，已完成步骤保留，不静默截断`);
    const save=async(output:T,originJobId?:string)=>{
      await core.db.transaction(async sql=>{
        if(!(await sql.query("SELECT id FROM knowledge.jobs WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp()",[job.id,job.leaseToken])).rows.length)throw new Error('分析租约失效，输出未采用');
        await sql.query('INSERT INTO knowledge.analysis_steps(job_id,stage,fingerprint,result) VALUES($1,$2,$3,$4::jsonb)',[job.id,stage,hash,JSON.stringify(output)]);
        if(this.options.reuseActorId)await sql.query('INSERT INTO knowledge.analysis_steps(job_id,stage,fingerprint,result) VALUES($1,$2,$3,$4::jsonb)',[job.id,`dependencies:${stage}`,hash,JSON.stringify({contract:STRUCTURED_POLICY,requestHash:hash,originJobId:originJobId??null,dependencies:requestDependencies(input)})]);
      });
    };
    if(this.options.reuseActorId){
      const saved=(await core.db.pool.query(`SELECT s.result,s.job_id FROM knowledge.analysis_steps s JOIN knowledge.jobs j ON j.id=s.job_id
        WHERE s.fingerprint=$1 AND j.actor_id=$2 AND s.stage=$3 AND s.job_id<>$4 AND j.state IN ('completed','failed')
        ORDER BY s.created_at DESC LIMIT 1`,[hash,this.options.reuseActorId,stage,job.id])).rows[0];
      if(saved){
        let output:T|undefined;
        try{const value=schema.parse(saved.result);validate(value);output=value;}catch{this.options.progress?.({kind:'analysis.cache_rejected',stage,originJobId:saved.job_id});}
        if(output!==undefined){await check();await save(output,saved.job_id);this.options.cached(stage);this.options.progress?.({kind:'analysis.dependency_reused',stage,originJobId:saved.job_id});return output;}
      }
    }
    const output=schema.parse(await this.options.generate(stage,task,input,schema));
    // Save the paid schema-valid response before semantic validation. Same-job
    // retry never buys a replacement for a saved but semantically invalid output.
    await save(output);validate(output);return output;
  }

  private physical(raw:unknown,sources:DiscoverySource[],catalog:CatalogEntry[],base:Ontology|null,local=false) {
    const candidate=validateDiscoveryEvidence(raw,sources,catalog,base).candidate;
    const defaults=conservativeNativeDefinition(candidateDefinition(candidate),base);
    for(const type of candidate.types){
      type.identityNamespaces=defaults.types.find(t=>t.id===type.id)!.identityNamespaces;
      for(const p of type.properties)p.required=defaults.types.flatMap(t=>t.properties).find(item=>item.id===p.id)!.required;
    }
    for(const link of candidate.links)link.multiple=defaults.links.find(l=>l.id===link.id)!.multiple;
    const semantic=candidateDefinition(candidate);
    for(const p of candidate.types.flatMap(t=>t.properties)){
      if(base?.types.flatMap(t=>t.properties).some(old=>old.id===p.id&&fingerprint(old)===fingerprint(semantic.types.flatMap(t=>t.properties).find(property=>property.id===p.id))))continue;
      const refs=candidate.evidenceReferences.filter(e=>e.memberId===p.id).flatMap(e=>e.evidenceIds);
      const fields=catalog.filter(e=>refs.includes(e.id)&&(e.locator.kind==='field'||e.locator.kind==='column')).flatMap(e=>{
        const source=sources.find(s=>s.id===e.sourceVersionId)!;
        return structuredCandidates(source).columns.filter(c=>(e.locator.kind==='field'||e.locator.kind==='column')&&c.column===e.locator.field);
      });
      if(p.valueType==='datetime'&&fields.some(f=>f.valueType==='datetime'))
        candidate.uncertainties=candidate.uncertainties.filter(u=>u.memberId!==p.id||u.kind!=='datetime_representation');
      if(p.valueType==='datetime'&&!fields.some(f=>f.valueType==='datetime')){
        const columns=[...new Set(fields.map(f=>`${f.column} (${f.physicalType})`))].sort().join('、').slice(0,1200)||'未找到匹配的物理列类型';
        const question=`属性 ${p.id} 的日期候选没有已验证的物理日期列依据；证据列：${columns}。请核对字段业务含义、日期表示及转换规则/时区，数值可能是时间戳或耗时，不能凭名称或猜单位转换`;
        if(!candidate.uncertainties.some(u=>u.memberId===p.id&&u.kind==='datetime_representation'&&u.question===question))candidate.uncertainties.push({memberId:p.id,kind:'datetime_representation',question});
      }
      if(p.valueType==='enum'&&!fields.some(f=>f.enumValues&&fingerprint([...f.enumValues].sort())===fingerprint([...(p.enumValues??[])].sort()))){
        if(!base?.types.some(t=>t.properties.some(old=>old.id===p.id))&&fields.length&&new Set(fields.map(f=>f.valueType)).size===1&&fields[0].valueType!=='enum'){
          p.valueType=fields[0].valueType as typeof p.valueType;p.enumValues=[];
          // Physical scalar adoption does not erase a proposed business dictionary.
          const codes=fields.flatMap(f=>f.commentCodeCandidates??[]);
          const question=`属性 ${p.id} 已采用物理标量；封闭业务枚举仍未确认。原提议值：${JSON.stringify((semantic.types.flatMap(t=>t.properties).find(old=>old.id===p.id))?.enumValues??[])}；原注释：${fields.map(f=>f.description).join('；')}；代码候选：${JSON.stringify(codes)}。观测值不证明完整允许集合`;
          if(!candidate.uncertainties.some(u=>u.memberId===p.id&&u.kind==='constraint'))candidate.uncertainties.push({memberId:p.id,kind:'constraint',question});
          continue;
        }
        // Existing business constraints remain explicit decisions.

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
      const prepared=discoveryInput([source],base),stage=`table:${source.id}`;
      if(!source.rows?.length){if(source.rowCount!==0)throw new Error('来源声明非空但未加载实例，不能当作空表排除');tableDecisions.push({sourceVersionId:source.id,sourceName:`${source.metadata?.schema??''}.${source.metadata?.name??source.id}`,status:'no_evidence',reason:'当前完整来源无实例记录；保留结构信息，不伪造记录证据',structure:{declaration:tableStructure(source),sourceColumns:prepared.input.sources[0].sourceColumns}});continue;}
      const check=(value:unknown)=>{
        const candidate=fromStructuredModel(value,'table');
        if(candidate.types.length)this.physical(candidate,[source],prepared.catalog,base,true);
      };
      let raw:unknown;
      if(this.options.reusedTables){
        if(!Object.hasOwn(this.options.reusedTables,source.id))throw new Error('缺少保存的逐表结果；仅协调任务禁止回退逐表模型');
        raw=structuredDiscoveryModelSchema('table').parse(this.options.reusedTables[source.id]);
        check(raw);this.options.cached(stage);
      }else raw=await this.step(stage,'discover',structuredTableInput(source,base),structuredDiscoveryModelSchema('table'),check);
      const {disposition='candidate',reason=''}=raw as {disposition?:'candidate'|'deferred'|'not_applicable';reason?:string};
      const candidate=fromStructuredModel(raw,'table');
      const checked=candidate.types.length?this.physical(candidate,[source],prepared.catalog,base,true):candidate;
      const entirelyDeferred=checked.types.length>0&&checked.types.every(t=>checked.uncertainties.some(u=>(u.kind==='definition'||u.kind==='evidence'||u.kind==='source_binding')&&u.memberId===t.id));
      const status=disposition==='not_applicable'?'not_applicable':checked.types.length?'candidate':'deferred';
      tableDecisions.push({sourceVersionId:source.id,sourceName:`${source.metadata?.schema??''}.${source.metadata?.name??source.id}`,status,reason:reason||(entirelyDeferred?'本表候选仍有定义疑问，交由统一协调处理':'具有可验证的业务候选')});
      if(checked.types.length)tableProposals.push({sourceVersionId:source.id,candidate:checked,evidence:validateDiscoveryEvidence(checked,[source],prepared.catalog,base).proposed.discoveryEvidence});
      if(status!=='candidate')continue;
      const used=new Set(checked.evidenceReferences.flatMap(e=>e.evidenceIds)),prefix=`t${index+1}:`;
      catalog.push(...prepared.catalog.filter(e=>e.locator.kind==='column'||used.has(e.id)).map(e=>({...e,id:e.id.startsWith('column:')?e.id:prefix+e.id})));
      if(checked.types.length)tables.push({...checked,evidenceReferences:checked.evidenceReferences.map(e=>({...e,evidenceIds:e.evidenceIds.map(id=>id.startsWith('column:')?id:prefix+id)}))});
    }
    for(const entry of discoveryInput(sources,base).catalog.filter(e=>e.locator.kind==='column'))if(!catalog.some(e=>e.id===entry.id))catalog.push(entry);
    let candidates=tables.map(toStructuredModel);
    // Local candidates can reuse a type/property ID without asserting that the
    // underlying business objects are identical. Distinguish those candidates
    // mechanically before partial coordination; only a model's explicit merge
    // may identify them. Published base IDs keep their original owner.
    const typeCounts=new Map<string,number>();for(const c of candidates)for(const t of c.types)typeCounts.set(t.id,(typeCounts.get(t.id)??0)+1);
    const reserved=new Set(candidates.flatMap(c=>[...c.types,...c.types.flatMap(t=>t.properties),...c.links].map(m=>m.id)));
    const mechanicalIds:Array<{originalId:string;candidateId:string;owner?:string}>=[];
    for(const candidate of candidates){const renamed=new Map<string,string>();
      for(const t of candidate.types)if(typeCounts.get(t.id)!>1){const old=t.id;const scope=[...t.sourceColumns,...t.properties.flatMap(p=>p.sourceColumns)].map(b=>b.sourceVersionId).sort();t.id=qualifyMemberId(old+':candidate',fingerprint(scope).slice(0,20),reserved);renamed.set(old,t.id);mechanicalIds.push({originalId:old,candidateId:t.id});}
      for(const link of candidate.links){link.from=renamed.get(link.from)??link.from;link.to=renamed.get(link.to)??link.to;}
      for(const t of candidate.types)for(const p of t.properties){const owner=base?.types.find(old=>old.properties.some(b=>b.id===p.id));if(owner&&owner.id!==t.id){const old=p.id;p.id=qualifyMemberId(t.id,old,reserved);mechanicalIds.push({originalId:old,candidateId:p.id,owner:t.id});}}
    }
    const linkCounts=new Map<string,number>();for(const c of candidates)for(const l of c.links)linkCounts.set(l.id,(linkCounts.get(l.id)??0)+1);
    const nonLinks=new Set([...candidates.flatMap(c=>c.types.flatMap(t=>[t.id,...t.properties.map(p=>p.id)])),...(base?.types.flatMap(t=>[t.id,...t.properties.map(p=>p.id)])??[])]);
    for(const candidate of candidates)for(const link of candidate.links)if(linkCounts.get(link.id)!>1||nonLinks.has(link.id)){
      const old=link.id;link.id=qualifyMemberId(old+':candidate',fingerprint({from:link.from,to:link.to,sourceColumns:link.sourceColumns}).slice(0,20),reserved);mechanicalIds.push({originalId:old,candidateId:link.id,owner:'relationship'});
    }
    const otherKinds=new Set([...candidates.flatMap(c=>[...c.types.map(t=>t.id),...c.links.map(l=>l.id)]),...(base?[...base.types.map(t=>t.id),...base.links.map(l=>l.id)]:[])]);
    for(const c of candidates)for(const t of c.types)for(const p of t.properties)if(otherKinds.has(p.id)){const old=p.id;p.id=qualifyMemberId(t.id,old,reserved);mechanicalIds.push({originalId:old,candidateId:p.id,owner:t.id});}
    // Existing definitions are members of the delta input too: omission cannot
    // become an implicit removal of a published or manually edited member.
    if(base){
      const wire=structuredDiscoveryModelSchema('coordinate').parse(structuredOntologyView(base));
      for(const type of wire.types){const found=candidates.flatMap(c=>c.types).find(t=>t.id===type.id);if(found){for(const p of type.properties)if(!candidates.flatMap(c=>c.types.flatMap(t=>t.properties)).some(old=>old.id===p.id))found.properties.push(p);}else candidates.push({...wire,types:[type],links:[],actions:[]});}
      candidates[0].actions.push(...wire.actions.filter(a=>!candidates.some(c=>c.actions.some(old=>old===a))));
      for(const link of wire.links)if(!candidates.some(c=>c.links.some(l=>l.id===link.id)))candidates[0].links.push(link);
    }
    const decisions=tableDecisions.map(({sourceVersionId,status,reason,sourceName})=>({sourceVersionId,status,reason,sourceName}));
    let references=crossTableReferences(sources,candidates);
    const aliases=new Map<string,string|null>(),audit:Array<{memberId:string;reason:string;stage:string}>=[],completed:string[]=[],bindingDecisions=new Map<string,z.infer<typeof compactCoordinationSchema>['relationshipBindings'][number]>();
    const entries=(values:unknown[])=>coordinationReferences(values,true).flatMap(c=>[...c.types.flatMap(t=>[t,...t.properties]),...c.links]);
    const currentRef=(ref:string)=>{const seen=new Set<string>();while(aliases.has(ref)&&!seen.has(ref)){seen.add(ref);const next=aliases.get(ref);if(next===null)return null;if(next===ref)break;ref=next!;}return ref;};
    const rebase=(input:any):any=>{
      const members=new Map(entries(candidates).map(m=>[m.ref,m]));
      const walk=(value:any):any=>{
        if(Array.isArray(value))return value.map(walk).filter(v=>v!==null);
        if(!value||typeof value!=='object')return value;
        const result=Object.fromEntries(Object.entries(value).map(([k,v])=>[k,walk(v)]));
        if(typeof value.ref==='string'){
          const ref=currentRef(value.ref);if(ref===null)return null;result.ref=ref;
          const member=members.get(ref) as any;if(member)for(const key of ['id','name','from','to'])if(Object.hasOwn(result,key)&&member[key]!==undefined)result[key]=member[key];
          if(Object.hasOwn(value,'index')&&member){let index=member.uncertainties.findIndex((u:any)=>u.kind===value.kind&&u.question===value.question);
            if(index<0){const matches=member.uncertainties.map((u:any,i:number)=>({u,i})).filter(({u}:any)=>u.kind===value.kind&&u.question.includes(value.question));if(matches.length===1)index=matches[0].i;}
            if(index<0)return null;result.index=index;}
        }
        if(typeof value.targetSourceVersionId==='string'&&Array.isArray(value.targetColumns)&&Object.hasOwn(value,'targetCandidateTypes'))
          Object.assign(result,currentReferenceTypes(value,candidates));
        return result;
      };return walk(input);
    };
    const projectIssues=(input:any)=>{
      const indexedUncertainties:any[]=[];
      const walk=(value:any):any=>{if(Array.isArray(value))return value.map(walk);if(!value||typeof value!=='object')return value;
        const result=Object.fromEntries(Object.entries(value).map(([key,child])=>[key,walk(child)]));
        if(typeof value.ref==='string'&&Array.isArray(value.uncertainties)){indexedUncertainties.push(...value.uncertainties.map((u:any,index:number)=>({ref:value.ref,index,...u})));result.uncertainties=[];result.uncertaintyCount=value.uncertainties.length;}
        return result;
      };return {...walk(input),indexedUncertainties};
    };
    const common={stage:'coordinate',coordinationFormat:'references-v3',baseOntology:null,
      instructions:'所有任务属于同一冻结范围，按业务问题顺序进行。只提交有依据的必要变化；本页没出现不代表不存在。indexedUncertainties使用给出的index，分片疑问不得解疑。'+compactCoordinationInstructions};
    const normalize=(value:unknown,current:unknown[])=>{
      const wire=materializeCoordination(current,value,true,true);
      return wire.types.length?carryDiscoveryEvidence(fromStructuredModel(wire,'coordinate'),tables):null;
    };
    const selectedBindings=(value:unknown,wire:ReturnType<typeof materializeCoordination>)=>{
      const parsed=compactCoordinationSchema.parse(value),selected=new Map(bindingDecisions);
      for(const group of parsed.links)if(typeof group.changes?.id==='string')for(const ref of group.refs){const old=entries(candidates).find(m=>m.ref===ref);if(old&&selected.has(old.id)){const prior=selected.get(old.id)!;selected.delete(old.id);selected.set(group.changes.id,{...prior,linkId:group.changes.id});}}
      for(const id of selected.keys())if(!wire.links.some(l=>l.id===id))selected.delete(id);
      if(new Set(parsed.relationshipBindings.map(b=>b.linkId)).size!==parsed.relationshipBindings.length)throw new Error('关系绑定决定重复');
      for(const decision of parsed.relationshipBindings)selected.set(decision.linkId,decision);
      return [...selected.values()];
    };
    const saveManifest=async(state:string,planned:number)=>{
      const manifest={contract:STRUCTURED_POLICY,state,planned,completed:[...completed],sources:sources.map(s=>s.id),audit,relationshipBindings:[...bindingDecisions.values()]};
      this.options.progress?.({kind:'analysis.coverage',state,planned,completed:completed.length});
      await this.options.core.db.transaction(async sql=>{
        if(!(await sql.query("SELECT id FROM knowledge.jobs WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp()",[this.options.job.id,this.options.job.leaseToken])).rows.length)throw new Error('覆盖保存租约已失效');
        await sql.query('INSERT INTO knowledge.analysis_steps(job_id,stage,fingerprint,result) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(job_id,stage) DO UPDATE SET fingerprint=excluded.fingerprint,result=excluded.result',[this.options.job.id,'coverage:manifest',fingerprint(manifest),JSON.stringify(manifest)]);
      });
    };
    let planned=0;
    const run=async(key:string,input:any)=>{
      const pages=coordinationPages(projectIssues(input));planned+=pages.length;await saveManifest('in_progress',planned);
      for(const [part,page]of pages.entries()){
        const request=rebase(page.input),snapshot=candidates,stage=pages.length===1?key:`${key}:page:${part}`;
        const validate=(value:unknown)=>{
          const parsed=compactCoordinationSchema.parse(value);
          for(const resolution of parsed.resolutions)for(const index of resolution.indexes){
            const issue=request.indexedUncertainties?.find((u:any)=>u.ref===resolution.ref&&u.index===index);
            const original=entries(snapshot).find(m=>m.ref===resolution.ref)?.uncertainties[index];
            if(!issue||!original||issue.kind!==original.kind||issue.question!==original.question)throw new Error('不能用未完整展示的疑问或错误索引解疑');
          }
          const wire=materializeCoordination(snapshot,value,true,true);
          const visible=(request.referenceCandidates??[]).flatMap((r:any)=>(r.alternatives??[]).map((a:any)=>({...a,sourceVersionId:r.sourceVersionId})));
          for(const decision of parsed.relationshipBindings)for(const binding of decision.bindings){const shown=visible.find((a:any)=>a.ref===binding.candidateRef),actual=references.flatMap(r=>r.alternatives).find(a=>a.ref===binding.candidateRef);if(!shown||!actual||fingerprint(shown.sourceColumns)!==fingerprint(actual.sourceColumns)||fingerprint(shown.targetColumns)!==fingerprint(actual.targetColumns))throw new Error('不能选择未完整展示的绑定候选');}
          relationshipValidation(wire,sources,audit,selectedBindings(value,wire));
          const normalized=normalize(value,snapshot);if(normalized)this.physical(normalized,sources,catalog,base);
        };
        // A prior delta can change a header; partition again rather than exceed
        // the measured request budget. This recursion is lossless and finite.
        if(modelRequestSize('discover',request,compactCoordinationSchema)>48000){planned--;await run(`${stage}:rebase`,request);continue;}
        const output=await this.step(stage,'discover',request,compactCoordinationSchema,validate);
        const before=entries(snapshot),next=materializeCoordination(snapshot,output,true,true),parsed=compactCoordinationSchema.parse(output),selections=selectedBindings(output,next);
        bindingDecisions.clear();for(const decision of selections)bindingDecisions.set(decision.linkId,decision);
        candidates=next.types.length?[next]:[];
        const after=entries(candidates);
        const mapMember=(ref:string,id?:string)=>{const old=before.find(m=>m.ref===ref);if(!old)return;
          let target=after.filter(m=>m.ref[0]===old.ref[0]&&m.id===(id??old.id));
          if(!target.length&&!id)target=after.filter(m=>m.ref[0]===old.ref[0]&&fingerprint({...m,id:null,ref:null})===fingerprint({...old,id:null,ref:null}));if(target.length===1)aliases.set(ref,target[0].ref);else if(!target.length)aliases.set(ref,null);
        };
        for(const old of before)mapMember(old.ref);
        for(const group of parsed.types){for(const ref of group.refs)mapMember(ref,typeof group.changes?.id==='string'?group.changes.id:undefined);for(const p of group.properties)for(const ref of p.refs)mapMember(ref,typeof p.changes?.id==='string'?p.changes.id:undefined);}
        for(const group of parsed.links)for(const ref of group.refs)mapMember(ref,typeof group.changes?.id==='string'?group.changes.id:undefined);
        for(const group of parsed.links)if(typeof group.changes?.id==='string'){const previous=before.find(m=>m.ref===group.refs[0]);if(previous)for(const entry of audit)if(entry.memberId===previous.id)entry.memberId=group.changes.id;}
        for(const group of [...parsed.types,...parsed.types.flatMap(t=>t.properties),...parsed.links])if(group.reason){const first=before.find(m=>m.ref===group.refs[0]);const id=typeof group.changes?.id==='string'?group.changes.id:first?.id;if(id)audit.push({memberId:id,reason:group.reason,stage});}
        for(const addition of [...parsed.additions.types,...parsed.additions.properties,...parsed.additions.links])audit.push({memberId:addition.member.id,reason:addition.reason,stage});
        completed.push(stage);await saveManifest('in_progress',planned);
      }
    };
    const sourceView=(source:DiscoverySource)=>structuredCoordinationSourceView(source);
    const directory=()=>coordinationReferences(candidates,true).flatMap(c=>c.types.map(t=>({id:t.id,ref:t.ref,name:t.name,sourceColumns:t.sourceColumns,
      sourceVersionIds:[...new Set([...t.sourceColumns,...t.properties.flatMap(p=>p.sourceColumns)].map(b=>b.sourceVersionId))],propertyCount:t.properties.length})));
    const full={...common,businessQuestion:'全局业务对象、属性及跨表关系发现',candidateIdOrigins:mechanicalIds,tableDecisions:decisions,tableCandidates:coordinationReferences(candidates,true),referenceCandidates:references,sources:sources.map(sourceView)};
    if(modelRequestSize('discover',projectIssues(full),compactCoordinationSchema)<=48000)await run('coordinate',full);
    else{
      const collisions=[...new Set(mechanicalIds.filter(m=>!m.owner).map(m=>m.originalId))];
      for(const originalId of collisions){
        const ids=new Set(mechanicalIds.filter(m=>!m.owner&&m.originalId===originalId).map(m=>m.candidateId));
        const focus=coordinationReferences(candidates,true).map(c=>({...c,types:c.types.filter(t=>ids.has(t.id)),links:[]})).filter(c=>c.types.length);
        await run(taskIdentity('identity',{originalId,candidates:[...ids].sort()}),{...common,businessQuestion:`核对同名候选 ${originalId} 是否同一业务类型；编号限定仅区分来源，不确认对象身份`,candidateIdOrigins:mechanicalIds.filter(m=>ids.has(m.candidateId)),tableCandidates:focus,globalDirectory:directory().filter(t=>ids.has(t.id)),sources:[],referenceCandidates:[]});
      }
      const topics=coordinationReferences(candidates,true).flatMap(c=>c.types.map(t=>({ref:t.ref,id:t.id})));
      for(const topic of topics){
        const type=entries(candidates).find(m=>m.ref===currentRef(topic.ref)) as any;if(!type)continue;
        const focus=coordinationReferences(candidates,true).map(c=>({...c,types:c.types.filter(t=>t.ref===type.ref),links:c.links.filter(l=>l.from===type.id||l.to===type.id)})).filter(c=>c.types.length);
        const sourceIds=new Set(focus.flatMap(c=>c.types.flatMap(t=>[...t.sourceColumns,...t.properties.flatMap(p=>p.sourceColumns)].map(b=>b.sourceVersionId))));
        await run(taskIdentity('definition',{ref:topic.ref}),{...common,businessQuestion:`核对业务对象 ${type.id} 的定义、属性归属和约束`,tableCandidates:focus,globalDirectory:directory().filter(t=>t.ref===type.ref),tableDecisions:decisions.filter(d=>sourceIds.has(d.sourceVersionId)),sources:sources.filter(s=>sourceIds.has(s.id)).map(sourceView),referenceCandidates:[]});
      }
      references=crossTableReferences(sources,candidates);
      for(const reference of references){
        const visible=directory().filter(t=>t.sourceVersionIds.includes(reference.sourceVersionId)||reference.alternatives.some(a=>t.sourceVersionIds.includes(a.targetSourceVersionId)));
        const typeIds=new Set(visible.map(t=>t.id));
        const links=coordinationReferences(candidates,true).flatMap(c=>c.links).filter(l=>l.sourceColumns.some(b=>b.sourceVersionId===reference.sourceVersionId&&reference.columns.includes(b.column))||typeIds.has(l.from)||typeIds.has(l.to));
        await run(taskIdentity('reference',{source:reference.sourceVersionId,columns:reference.columns}),{...common,businessQuestion:`核对来源列 ${reference.columns.join('、')} 的跨表业务关系与临时端点；改写已有关系时保留ID，不能仅按端点名字猜配`,
          tableCandidates:[{name:'待协调关系',types:[],links,actions:[]}],globalDirectory:visible,referenceCandidates:[reference],tableDecisions:decisions.filter(d=>d.sourceVersionId===reference.sourceVersionId||reference.alternatives.some(a=>a.targetSourceVersionId===d.sourceVersionId)),sources:[]});
      }
      const represented=new Set(tableProposals.map(p=>p.sourceVersionId));
      for(const source of sources.filter(s=>!represented.has(s.id)))await run(taskIdentity('uncovered',{source:source.id}),{...common,businessQuestion:'核对尚无逐表候选来源的业务对象及关系，不把局部无候选解释为无全局关系',tableCandidates:[],globalDirectory:[],tableDecisions:decisions.filter(d=>d.sourceVersionId===source.id),sources:[sourceView(source)],referenceCandidates:[]});
      const global=directory();
      const catalogEntries=[...global,...sources.filter(s=>!global.some(t=>t.sourceVersionIds.includes(s.id))).map(s=>({id:s.id,ref:undefined,name:String(s.metadata?.name??s.id),sourceVersionIds:[s.id],kind:'source_without_type'}))];
      const pairs=catalogPairs(catalogEntries.map(t=>({...t,description:undefined})),4);
      const catalogPageCount=Math.max(...pairs.map(p=>p.j))+1;
      for(const pair of pairs){
        const scope=[...pair.left,...pair.right],ids=new Set(scope.flatMap(t=>t.sourceVersionIds));
        const windows=semanticWindows(sources.filter(s=>ids.has(s.id)).map(sourceView));
        // Compare every evidence window jointly, including windows from the same
        // table. Generic byte partitioning may never separate these two windows.
        for(let left=0;left<windows.length;left++)for(let right=left;right<windows.length;right++){
          const visible=[...directory().filter(t=>t.sourceVersionIds.some(id=>ids.has(id))||scope.some(old=>old.id===t.id)),...scope.filter(t=>!t.ref)];
          const typeIds=new Set(visible.map(t=>t.id));
          const relevantLinks=coordinationReferences(candidates,true).flatMap(c=>c.links).filter(l=>typeIds.has(l.from)||typeIds.has(l.to));
          const key=pairs.length===1&&windows.length===1?'coordinate:coverage':taskIdentity('coverage',{members:visible.map(t=>t.id).sort(),jointEvidence:[windows[left],windows[right]]});
          await run(key,{...common,businessQuestion:'全局联合覆盖检查：jointEvidence两端依据必须同时检查；跨业务对象/来源发现未由逐表提出的关系，可修订已有类和关系，不按名称自动映射；分段注释须保留疑问',
            tableCandidates:[{name:'当前相关关系',types:[],links:relevantLinks,actions:[]}],globalDirectory:visible.map(t=>({id:t.id,ref:t.ref,name:t.name,sourceVersionIds:t.sourceVersionIds})),
            typeDescriptions:visible.map(t=>({ref:t.ref,id:t.id,description:(entries(candidates).find(type=>type.ref===t.ref) as any)?.description??''})),referenceCandidates:[],tableDecisions:decisions.filter(d=>ids.has(d.sourceVersionId)),sources:[],
            jointEvidence:left===right?windows[left]:[...windows[left],...windows[right]],coverage:{catalogPages:catalogPageCount,pair:[pair.i,pair.j],evidenceWindows:windows.length,jointWindow:[left,right],sourceVersionIds:[...ids]}});
        }
      }
    }
    if(!candidates.some(c=>c.types.length)){await saveManifest('completed_without_candidate',planned);throw new Error('所有局部与全局发现已完成，但没有可采用的有依据类型；保存覆盖与响应，不创建空草稿');}
    const raw=this.physical(carryDiscoveryEvidence(fromStructuredModel(candidates[0],'coordinate'),tables),sources,catalog,base);
    // The one-call path can still contain several unchanged input candidates.
    if(completed.length!==planned)throw new Error('协调覆盖任务未全部完成，不能保存成功草稿');
    await saveManifest('completed',planned);
    return {raw,catalog,tableDecisions,tableProposals,mechanicalIds,coordinationAudit:audit,relationshipBindings:[...bindingDecisions.values()],coverageManifest:{contract:STRUCTURED_POLICY,state:'completed',planned,completed}};
  }

  async plan(ontology:Ontology,sources:DiscoverySource[],previous:unknown,issues:unknown,tableDecisions:TableDecision[]=[],unresolvedSourceIds:string[]=[],deferred:Array<{member:{id:string};evidence?:Array<{sourceVersionId:string}>}>=[]) {
    const csv=[],skipped:Array<{sourceVersionId:string;reason:string}>=[],notes:string[]=[],noteLimit=Math.floor(50/sources.length);
    for(const source of sources){
      if(!source.rows?.length){if(source.rowCount!==0)throw new Error('来源声明非空但未加载实例，不能跳过构建');skipped.push({sourceVersionId:source.id,reason:'当前完整来源无实例记录，不生成事实；旧正式知识保留'});continue;}
      const decision=tableDecisions.find(d=>d.sourceVersionId===source.id);
      if(decision&&decision.status!=='candidate'){skipped.push({sourceVersionId:source.id,reason:`${decision.reason}；触发成员：${deferred.filter(d=>d.evidence?.some(e=>e.sourceVersionId===source.id)).map(d=>d.member.id).join('、')||'依赖范围未能精确定位，使用保守兜底'}；影响范围：来源 ${source.id}；不生成替换映射，保留旧正式事实及构建头。`});continue;}
      if(unresolvedSourceIds.includes(source.id)){
        const prior=(await this.options.core.db.pool.query('SELECT h.run_id FROM knowledge.source_versions v JOIN knowledge.source_build_heads h ON h.source_id=v.source_id WHERE v.id=$1',[source.id])).rows[0];
        if(prior?.run_id){skipped.push({sourceVersionId:source.id,reason:`局部候选尚未解决；触发成员：${deferred.filter(d=>d.evidence?.some(e=>e.sourceVersionId===source.id)).map(d=>d.member.id).join('、')||'依赖范围未能精确定位，使用保守兜底'}；影响范围：来源 ${source.id}。已有正式构建，保留旧构建头，避免部分映射退休旧事实。`});continue;}
      }
      const raw=await this.step(`mapping:${source.id}`,'plan',{stage:'table_mapping',ontology:structuredOntologyView(ontology),sources:[structuredSourceView(source,true)],previousProposal:structuredPreviousPlan(previous),discoveryIssues:structuredIssueView(issues),
        instructions:`只生成此来源的结构化映射，notes最多${noteLimit}条。参考确定性列候选、物理主键及声明外键，但业务含义/时间不明保留unknown。不得为已暂缓或不在ontology中的成员生成映射。允许一行多个对象；不自动合并跨源身份。无可执行业务映射时只返回当前来源的skipped和明确理由。booleanEncoding可选literal或zero_one，0/1必须显式zero_one；对象onNull可选error或skip_object，仅允许原生可空非主键列，策略将进入集中确认。`},structuredMappingModelSchema,value=>{
        if(value.notes.length>noteLimit)throw new Error(`表级计划说明超过本轮分配的${noteLimit}条预算`);
        if(value.csv.length+(value.skipped?.length??0)!==1||[...value.csv,...(value.skipped??[])].some(s=>s.sourceVersionId!==source.id))throw new Error('表级计划必须且只能绑定当前来源，不能混入其他表或文档');
      });
      csv.push(...raw.csv);skipped.push(...(raw.skipped??[]));notes.push(...raw.notes);
    }
    return planProposalSchema.parse({csv,skipped,documents:[],notes:[...new Set(notes)]});
  }
}

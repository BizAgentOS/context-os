import { z } from 'zod';
import { objectTypeSchema, propertySchema, linkSchema, strictComparisonSchema, ontologySchema, type Ontology } from './contracts.ts';
import { discoveryCandidateSchema, uncertaintySchema, type DiscoverySource } from './discovery.ts';
import { structuredCandidates, tableStructure } from './structured-profile.ts';
import { planProposalSchema } from './build-contracts.ts';
import { compactCoordinationSchema } from './compact-coordination-schema.ts';

// The model wire contract deliberately has no evidence IDs, locators or internal hashes.
const localIssues = z.array(z.object({ kind: uncertaintySchema.shape.kind, question: uncertaintySchema.shape.question,
  dimensions: uncertaintySchema.shape.dimensions }).strict().refine(u=>u.kind!=='missing_context'||!!u.dimensions?.length,'缺失口径需明确维度')).max(100).default([]);
export function structuredDiscoveryModelSchema(stage: 'table' | 'coordinate') {
  const binding = z.object({ sourceVersionId: stage==='table' ? z.string().uuid().optional() : z.string().uuid(), column:z.string().min(1).max(300) }).strict();
  const common={sourceColumns:z.array(binding).max(50).default([]),uncertainties:localIssues};
  const objectIssues=z.array(z.object({kind:z.enum(['definition','fact_conflict','time_attachment','evidence','source_binding']),question:uncertaintySchema.shape.question}).strict()).max(100).default([]);
  const property=z.object({...propertySchema.shape,comparison:strictComparisonSchema.optional(),...common}).strict()
    .refine(p=>p.valueType!=='enum'||!!p.enumValues?.length,'枚举缺少取值');
  const type=z.object({...objectTypeSchema.shape,properties:z.array(property).max(100),...common,uncertainties:objectIssues}).strict();
  const shape={name:ontologySchema.shape.name,types:z.array(type).min(stage==='table'?0:1).max(100),
    links:z.array(z.object({...linkSchema.shape,...common,uncertainties:objectIssues}).strict()).max(200).default([]),actions:ontologySchema.shape.actions};
  if(stage==='coordinate')return z.object(shape).strict();
  return z.object({...shape,disposition:z.enum(['candidate','deferred','not_applicable']).default('candidate'),reason:z.string().trim().max(2000).default('')}).strict()
    .refine(v=>v.disposition==='candidate'?v.types.length>0:!!v.reason,'无候选或暂缓须明确状态和理由')
    .refine(v=>v.types.length>0||v.links.length===0,'空候选不能携带悬空关系');
}

/** Convert model-local annotations into host-owned member references. Never accepts legacy wire fields. */
export function fromStructuredModel(raw: unknown, stage:'table'|'coordinate') {
  const value=structuredDiscoveryModelSchema(stage).parse(raw);
  const uncertainties:z.infer<typeof uncertaintySchema>[]=[];
  const member=<T extends {id:string;uncertainties:Array<{kind:z.infer<typeof uncertaintySchema>['kind'];question:string;dimensions?:Array<'unit'|'currency'|'scope'>}>}>(item:T)=>{
    const {uncertainties:issues,...definition}=item;
    uncertainties.push(...issues.map(issue=>({...issue,memberId:item.id})));
    return {...definition,sourceColumnIds:[] as string[]};
  };
  const types=value.types.map(t=>({...member(t),properties:t.properties.map(member)}));
  const {disposition:_,reason:__,...definition}=value as typeof value & {disposition?:string;reason?:string};
  return {...definition,types,links:value.links.map(member),evidenceReferences:[],uncertainties};
}

/** Prior verified candidates are projected onto the same wire contract used for new output. */
export function toStructuredModel(raw:unknown) {
  const candidate=discoveryCandidateSchema.parse(raw);
  const member=<T extends {id:string;sourceColumnIds:string[]}>(item:T)=>{
    const {sourceColumnIds:_,...definition}=item;
    return {...definition,uncertainties:candidate.uncertainties.filter(u=>u.memberId===item.id).map(({memberId:__,...u})=>
      ({...u,question:u.question.replace(/\bcolumn:[a-f0-9]{64}\b/g,'[内部列标识]')}))};
  };
  return {name:candidate.name,actions:candidate.actions,types:candidate.types.map(t=>({...member(t),properties:t.properties.map(member)})),links:candidate.links.map(member)};
}
export function structuredOntologyView(ontology:Ontology|null) {
  if(!ontology)return null;
  const {discoveryEvidence:_,...definition}=ontology;
  return definition;
}
export function structuredSourceView(source:DiscoverySource, records=false, legacy=false,oldCommentCodes=false) {
  const {structureHash:_,...candidates}=structuredCandidates(source,legacy,oldCommentCodes);
  return {id:source.id,kind:source.kind,sourceNamespace:source.sourceNamespace,columns:source.columns,keyColumn:source.keyColumn,
    metadata:tableStructure(source),structuredCandidates:candidates,
    ...(records?{rows:source.rows,nativeValues:source.nativeValues}:{}),coverage:source.coverage};
}
/** Coordination reconciles definitions, not raw column profiling or source records. */
export function structuredCoordinationSourceView(source:DiscoverySource) {
  const candidates=structuredCandidates(source);
  const profiles={profile:candidates.profile,columns:candidates.columns.map(({column,valueType,enumValues,enumBasis,commentCodeCandidates})=>({column,valueType,enumValues,enumBasis,commentCodeCandidates})),note:'声明枚举、注释代码候选与观测值独立；观测全集不证明业务闭枚举'};
  return {id:source.id,kind:source.kind,sourceNamespace:source.sourceNamespace,metadata:tableStructure(source),keyProfiles:profiles,coverage:source.coverage};
}
// Native mapping has no document claims and therefore no model-generated evidence locators.
export const structuredMappingModelSchema=planProposalSchema.omit({documents:true});
export function structuredPreviousPlan(raw:unknown) {
  if(!raw)return null;
  const parsed=planProposalSchema.parse(raw);
  return {csv:parsed.csv,skipped:parsed.skipped,notes:parsed.notes};
}
export function structuredIssueView(raw:unknown) {
  return (Array.isArray(raw)?raw:[]).map(item=>{
    const u=uncertaintySchema.parse(item);
    return u.kind==='source_binding'||u.kind==='evidence'?{...u,question:'成员已暂缓，不得为其生成新映射。'}:u;
  });
}

/** Enforce the boundary before a trace or provider request can be created, including future callers. */
export function assertStructuredModelRequest(task:'discover'|'plan'|'extract',input:unknown,schema:z.ZodType) {
  const value=input as {stage?:string;coordinationFormat?:string;sources?:Array<{kind?:string}>};
  if(task==='extract'||!value?.sources?.some(s=>s.kind==='table')&&value?.coordinationFormat===undefined)return;
  const stage=value.stage;
  if(!(value.sources??[]).every(s=>s.kind==='table')||(task==='discover'?stage!=='table'&&stage!=='coordinate':stage!=='table_mapping'))
    throw new Error('原生表必须使用结构化模型契约，不能回退到旧证据目录通道；混合资料请分批生成后通过基础本体补充');
  if(value.coordinationFormat!==undefined&&(task!=='discover'||stage!=='coordinate'||value.coordinationFormat!=='references-v3'))throw new Error('未知结构化协调格式，禁止回退旧输出通道');
  const expected=task==='discover'?(value.coordinationFormat==='references-v3'?compactCoordinationSchema:structuredDiscoveryModelSchema(stage as 'table'|'coordinate')):structuredMappingModelSchema;
  if(JSON.stringify(z.toJSONSchema(schema))!==JSON.stringify(z.toJSONSchema(expected)))throw new Error('结构化模型输出契约不匹配，已在调用模型前阻止旧通道');
  const forbidden=new Set(['evidenceCatalog','evidenceReferences','evidenceIds','evidenceId','sourceColumnIds','sourceColumnId','structureHash','schemaHash','discoveryEvidence','locator']);
  const inspect=(item:unknown)=>{
    if(Array.isArray(item)){item.forEach(inspect);return;}
    if(!item||typeof item!=='object')return;
    for(const [key,child]of Object.entries(item)){
      if(forbidden.has(key))throw new Error(`结构化模型输入混入内部字段：${key}；已在调用模型前阻止`);
      // Source values may legitimately have columns named like host metadata.
      if(key!=='rows'&&key!=='nativeValues'&&key!=='observedValues')inspect(child);
    }
  };
  inspect(input);
}

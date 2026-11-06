import { z } from 'zod';
import { ontologySchema, propertySchema, objectTypeSchema, strictComparisonSchema, linkSchema, key, type Ontology } from './contracts.ts';
import { fingerprint, locateDiscoveryEvidence, sourceStructureHash, type SourceContent } from './sources.ts';
import { structuredCandidates } from './structured-profile.ts';

export const DISCOVERY_POLICY = 'model-first-major-decisions-v8';
export const uncertaintySchema = z.object({ memberId: key, kind: z.enum(['definition', 'fact_conflict', 'missing_context', 'time_attachment', 'constraint', 'datetime_representation', 'evidence', 'source_binding']), question: z.string().trim().min(1).max(2000), dimensions: z.array(z.enum(['unit', 'currency', 'scope'])).max(3).optional() }).strict().refine(u => u.kind !== 'missing_context' || !!u.dimensions?.length, '缺失口径需明确缺少哪些维度');
type Uncertainty = { memberId: string; question: string; kind?: string; dimensions?: Array<'unit' | 'currency' | 'scope'> };
export interface DiscoverySource extends SourceContent { id: string; sourceNamespace?: string; coverage?: unknown; }
export interface CatalogEntry { id: string; sourceVersionId: string; locator: Ontology['discoveryEvidence'][number]['locator']; value: string | null; }
const sourceColumns = z.array(z.object({ sourceVersionId: z.string().uuid().optional(), column: z.string().min(1).max(300) }).strict()).max(50).default([]);
const sourceColumnIds = z.array(z.string().min(1)).max(50).default([]);
export const discoveryCandidateSchema = z.object({
  name: ontologySchema.shape.name, types: z.array(objectTypeSchema.extend({ sourceColumnIds, sourceColumns, properties: z.array(z.object({ ...propertySchema.shape, sourceColumnIds, sourceColumns, comparison: strictComparisonSchema.optional() }).strict().refine(p => p.valueType !== 'enum' || !!p.enumValues?.length, '枚举缺少取值')).max(100) })).min(1).max(100), links: z.array(linkSchema.extend({ sourceColumnIds, sourceColumns })).max(200).default([]),
  actions: ontologySchema.shape.actions,
  evidenceReferences: z.array(z.object({ memberId: key, evidenceIds: z.array(z.string().min(1)).min(1).max(50) }).strict()).max(1000).default([]),
  uncertainties: z.array(uncertaintySchema).max(500).default([]),
}).strict();
export function discoveryInput(sources: DiscoverySource[], baseOntology: Ontology | null) {
  const catalog: CatalogEntry[] = [];
  let recordEvidenceNumber = 0;
  const add = (source: DiscoverySource, locator: CatalogEntry['locator'], value: string | null) => {
    if (catalog.length >= 3000) throw new Error('发现证据目录超过 3000 项，请减少来源或拆分资料');
    catalog.push({ id: `e${++recordEvidenceNumber}`, sourceVersionId: source.id, locator, value });
  };
  for (const source of sources) {
    if (source.kind === 'table') {
      const hash = sourceStructureHash(source);
      for (const column of (source.metadata?.columns ?? []) as Array<{name:string}>) {
        if (!source.columns?.includes(column.name)) throw new Error('声明列与来源列目录不一致');
        if (catalog.length >= 3000) throw new Error('发现证据目录超过 3000 项，请减少来源或拆分资料');
        catalog.push({ id: `column:${fingerprint({ sourceVersionId: source.id, structureHash: hash, field: column.name })}`,
          sourceVersionId: source.id, locator: { kind: 'column', field: column.name, structureHash: hash }, value: JSON.stringify(column) });
      }
    }
    if (source.kind !== 'pdf') {
      for (const row of source.rows ?? []) for (const field of source.columns ?? []) {
        const recordKey = row[source.keyColumn!];
        if (recordKey === undefined) throw new Error('发现样本缺少记录主键');
        // NULL is locatable evidence of a field's presence, never a non-null business value.
        const value = source.kind === 'table' && source.nativeValues?.[recordKey]?.[field] === null ? null : row[field] ?? '';
        add(source, { kind: 'field', recordKey, field }, value);
      }
    } else {
      const text = source.text ?? '';
      // Exact slices only: never rewrite or summarize a source into evidence.
      let start = 0;
      while (start < text.length) {
        const newline = text.indexOf('\n', start);
        const end = Math.min(newline < 0 ? text.length : newline, start + 800);
        const quote = text.slice(start, end);
        if (quote.trim()) add(source, { kind: 'quote', quote, start }, quote);
        start = end === newline ? end + 1 : end;
      }
    }
  }
  return { catalog, input: {
    sources: sources.map(s => ({ id: s.id, kind: s.kind, sourceNamespace: s.sourceNamespace, columns: s.columns, keyColumn: s.keyColumn, ...(s.metadata ? { metadata: {...s.metadata,profile:undefined} } : {}), ...(s.kind==='table'?{structuredCandidates:structuredCandidates(s), sourceColumns:catalog.filter(e=>e.sourceVersionId===s.id&&e.locator.kind==='column').map(e=>({sourceColumnId:e.id,...(e.locator.kind==='column'?{column:e.locator.field}:{} )}))}:{}), coverage: s.coverage })),
    baseOntology,
    evidenceCatalog: catalog.map(e => ({ evidenceId: e.id, sourceVersionId: e.sourceVersionId, kind: e.locator.kind, ...(e.locator.kind === 'field' ? { recordKey: e.locator.recordKey, field: e.locator.field, value: e.value } : e.locator.kind === 'column' ? { field:e.locator.field, structureHash:e.locator.structureHash, declaration:JSON.parse(e.value!) } : { text: e.value, start: e.locator.start }) })),
  } };
}
export interface TableDecision {sourceVersionId:string;status:'candidate'|'deferred'|'no_evidence'|'not_applicable';reason:string;sourceName?:string;structure?:unknown;}
export interface ReviewIssue { id: string; memberId: string; question: string; kind: string; }
export function discoveryReviewIssues(definition: Ontology, uncertainties: Uncertainty[] = [], base: Ontology | null = null,tableDecisions:TableDecision[]=[], deferred:Array<{member:{id:string};reason:string}>=[]): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const add = (kind: string, memberId: string, question: string) => issues.push({ id: fingerprint({ kind, memberId, question }), kind, memberId, question });
  const members = (o: Ontology) => [...o.types, ...o.types.flatMap(t => t.properties), ...o.links];
  if (!base) add('first_release', 'ontology', '首次启用此本体：整体确认业务范围与关键假设，无需逐个成员确认。');
  const old = new Map(base ? members(base).map(m => [m.id, m]) : []);
  const current = new Map(members(definition).map(m => [m.id, m]));
  const removed = [...old.keys()].filter(id => !current.has(id));
  if (removed.length) add('removal', 'ontology', `删除已有成员可能影响下游：${removed.join('、')}`);
  const changed: string[] = [], constrained: string[] = [];
  for (const t of definition.types) {
    const previous = base?.types.find(x => x.id === t.id);
    if (previous && fingerprint({ name: previous.name, description: previous.description, identityNamespaces: previous.identityNamespaces }) !== fingerprint({ name: t.name, description: t.description, identityNamespaces: t.identityNamespaces })) changed.push(t.id);
    if (!previous && t.identityNamespaces.length) constrained.push(t.id);
    for (const property of t.properties) {
      const prior = old.get(property.id);
      if (prior && (fingerprint(prior) !== fingerprint(property) || base?.types.find(x => x.properties.some(p => p.id === property.id))?.id !== t.id)) changed.push(property.id);
      if (!prior && (property.required || property.valueType === 'enum'&&!uncertainties.some(u=>u.memberId===property.id&&u.kind==='constraint') || property.comparison && Object.keys(property.comparison).length)) constrained.push(property.id);
    }
  }
  for (const link of definition.links) {
    const prior = old.get(link.id);
    if (prior && fingerprint(prior) !== fingerprint(link)) changed.push(link.id);
    if (!prior && !link.multiple) constrained.push(link.id);
  }
  if (base && fingerprint(base.actions) !== fingerprint(definition.actions)) changed.push('actions');
  if (changed.length) add('semantic_change', 'ontology', `已有业务含义、约束或动作发生变化：${changed.join('、')}`);
  if (constrained.length) add('new_constraint', 'ontology', `新增身份规则、必填、枚举、比较口径或单值关系约束：${constrained.join('、')}`);
  const constraintCandidates=uncertainties.filter(u=>u.kind==='constraint');
  for (const memberId of new Set(constraintCandidates.map(u=>u.memberId))) {
    const property=definition.types.flatMap(t=>t.properties).find(p=>p.id===memberId);
    const questions=[...new Set(constraintCandidates.filter(u=>u.memberId===memberId).map(u=>u.question))].sort().join('；');
    if(property?.valueType==='enum')add('constraint_confirmation',memberId,`${questions}；当前拟采用的业务枚举：${JSON.stringify(property.enumValues)}。确认完整允许值及业务依据后再采用；也可先修改草稿取消封闭约束。`);
  }
  for (const memberId of new Set(uncertainties.filter(u=>u.kind==='datetime_representation').map(u=>u.memberId))) {
    if(!definition.types.flatMap(t=>t.properties).some(p=>p.id===memberId&&p.valueType==='datetime'))continue;
    const questions=[...new Set(uncertainties.filter(u=>u.memberId===memberId&&u.kind==='datetime_representation').map(u=>u.question))].sort();
    add('datetime_confirmation',memberId,questions.join('；'));
  }
  return issues;
}
/** Model proposals do not turn physical keys/nullability or observed cardinality into business constraints. */
export function conservativeNativeDefinition(definition:Ontology,base:Ontology|null) {
  const result=discoveryProposalSchema.parse(structuredClone(definition));
  const oldProperties=new Set(base?.types.flatMap(t=>t.properties).map(p=>p.id)??[]);
  const oldLinks=new Set(base?.links.map(l=>l.id)??[]);
  for(const type of result.types){
    if(!base?.types.some(t=>t.id===type.id))type.identityNamespaces=[];
    for(const property of type.properties)if(!oldProperties.has(property.id))property.required=false;
  }
  for(const link of result.links)if(!oldLinks.has(link.id))link.multiple=true;
  return result;
}
/** Reassess only adopted members; excluded candidates require coordination, never silent restoration. */
export function reassessNativeDefinition(definition:Ontology,previous:any,sources:DiscoverySource[]) {
  const normalized=ontologySchema.parse(conservativeNativeDefinition(definition,previous.baseline??null));
  const resolvedDates=new Set<string>();
  for(const p of normalized.types.flatMap(t=>t.properties)) {
    const fields=normalized.discoveryEvidence.filter(e=>e.memberId===p.id).flatMap(e=>{
      const source=sources.find(s=>s.id===e.sourceVersionId);
      return source&&(e.locator.kind==='column'||e.locator.kind==='field')?structuredCandidates(source).columns.filter(c=>c.column===(e.locator as {field:string}).field):[];
    });
    if(p.valueType==='datetime'&&fields.some(f=>f.valueType==='datetime'))resolvedDates.add(p.id);
    if(p.valueType==='enum'&&!previous.baseline?.types.some((t:Ontology['types'][number])=>t.properties.some(old=>old.id===p.id))&&
       !fields.some(f=>f.enumValues&&fingerprint([...f.enumValues].sort())===fingerprint([...(p.enumValues??[])].sort()))&&fields.length) {
      const kinds=new Set(fields.map(f=>f.valueType));
      if(kinds.size===1&&!kinds.has('enum')){p.valueType=fields[0].valueType as typeof p.valueType;p.enumValues=[];}
    }
  }
  const uncertainties=(previous.uncertainties??[]).filter((u:Uncertainty)=>!(resolvedDates.has(u.memberId)&&u.kind==='datetime_representation'));
  return {definition:normalized,validation:refreshDiscoveryValidation(normalized,{...previous,uncertainties})};
}
export function discoverySourceOutcomes(definition:Ontology,decisions:TableDecision[]=[]) {
  const adopted=new Set(definition.discoveryEvidence.map(e=>e.sourceVersionId));
  return decisions.map(d=>{
    if(adopted.has(d.sourceVersionId)&&d.status!=='candidate')return {...d,status:'candidate' as const,reason:'当前协调结果已采用本来源的明确候选；局部未知项保留或暂缓，不升级为整表排除。'};
    if(!adopted.has(d.sourceVersionId)&&d.status==='candidate')return {...d,status:'deferred' as const,reason:'协调结果未采用本来源的任何成员；保留原候选，不生成无依据映射或替换旧事实。'};
    return d;
  });
}
export function unresolvedDiscoverySources(definition:Ontology,deferred:Array<{member:{id:string};evidence:Array<{sourceVersionId:string}>}>,proposals:Array<{sourceVersionId:string;candidate:unknown}>,sourceIds:string[]) {
  const affected=new Set<string>(),byMember=new Map<string,Set<string>>();
  for(const proposal of proposals){
    const c=discoveryCandidateSchema.parse(proposal.candidate);
    for(const member of [...c.types,...c.types.flatMap(t=>t.properties),...c.links]){const ids=byMember.get(member.id)??new Set<string>();ids.add(proposal.sourceVersionId);byMember.set(member.id,ids);}
  }
  for(const item of deferred){
    for(const e of item.evidence)affected.add(e.sourceVersionId);
    for(const id of byMember.get(item.member.id)??[])affected.add(id);
    if(!item.evidence.length&&!byMember.has(item.member.id))sourceIds.forEach(id=>affected.add(id));
  }
  return [...affected];
}
export function refreshDiscoveryValidation(definition: Ontology, previous: any) {
  const issues = discoveryReviewIssues(definition, previous.uncertainties ?? [], previous.baseline ?? null,previous.tableDecisions??[],previous.deferred??[]);
  const tableDecisions=discoverySourceOutcomes(definition,previous.tableDecisions??[]);
  const unresolvedSourceVersionIds=unresolvedDiscoverySources(definition,previous.deferred??[],previous.tableProposals??[],tableDecisions.map(d=>d.sourceVersionId));
  return { ...previous, tableDecisions, unresolvedSourceVersionIds, policy: DISCOVERY_POLICY, definitionHash: fingerprint(definition), issues, reviewRequired: issues.length > 0 };
}
export class DiscoveryEvidenceError extends Error {
  readonly code = 'DISCOVERY_EVIDENCE_MISSING';
  readonly missingMemberIds: string[];
  constructor(missingMemberIds: string[]) {
    super(`以下候选缺少可验证依据：${missingMemberIds.join('、')}；不会以模型重试代替证据校验`);
    this.missingMemberIds = missingMemberIds;
  }
}
// Proposals may retain unresolved relationship endpoints for audit. Only the final
// adopted definition must satisfy ontologySchema's complete endpoint contract.
const discoveryProposalSchema=z.object({...ontologySchema.shape}).strict().superRefine((o,ctx)=>{
  const ids=new Set<string>();
  for(const member of [...o.types,...o.types.flatMap(t=>t.properties),...o.links]){
    if(ids.has(member.id))ctx.addIssue({code:'custom',message:'候选成员编号重复'});
    ids.add(member.id);
  }
});
export function candidateDefinition(candidate: z.infer<typeof discoveryCandidateSchema>) {
  return discoveryProposalSchema.parse({ name:candidate.name, actions:candidate.actions, links:candidate.links.map(({sourceColumnIds:_,sourceColumns:__,...link})=>link),
    types:candidate.types.map(({sourceColumnIds:_,sourceColumns:__,properties,...type})=>({...type,properties:properties.map(({sourceColumnIds:__,sourceColumns:___,...property})=>property)})) });
}
/** Restore omitted citations only for exactly unchanged members, never by name similarity. */
export function carryDiscoveryEvidence(raw: unknown, prior: Array<z.infer<typeof discoveryCandidateSchema>>) {
  const candidate=discoveryCandidateSchema.parse(raw);
  const members=(c:z.infer<typeof discoveryCandidateSchema>)=>[...c.types.map(({properties:_,...t})=>t),...c.types.flatMap(t=>t.properties.map(p=>({...p,ownerTypeId:t.id}))),...c.links];
  for(const member of members(candidate)) {
    const {sourceColumnIds:_,sourceColumns:__,...definition}=member;
    for(const previous of prior) {
      const old=members(previous).find(m=>m.id===member.id);
      if(!old)continue;
      const {sourceColumnIds:__,sourceColumns:___,...oldDefinition}=old;
      if(fingerprint(definition)!==fingerprint(oldDefinition))continue;
      const target=[...candidate.types,...candidate.types.flatMap(t=>t.properties),...candidate.links].find(m=>m.id===member.id)!;
      target.sourceColumnIds=[...new Set([...target.sourceColumnIds,...old.sourceColumnIds])];
      target.sourceColumns=[...new Map([...target.sourceColumns,...old.sourceColumns].map(c=>[fingerprint(c),c])).values()];
      for(const ref of previous.evidenceReferences.filter(r=>r.memberId===member.id)) {
        let current=candidate.evidenceReferences.find(r=>r.memberId===member.id);
        if(!current){current={memberId:member.id,evidenceIds:[]};candidate.evidenceReferences.push(current);}
        current.evidenceIds=[...new Set([...current.evidenceIds,...ref.evidenceIds])];
      }
    }
  }
  return discoveryCandidateSchema.parse(candidate);
}
export function validateDiscoveryEvidence(raw: unknown, sources: DiscoverySource[], catalog: CatalogEntry[], base: Ontology | null) {
  const candidate = discoveryCandidateSchema.parse(raw);
  const semantic = candidateDefinition(candidate);
  const ids = new Set([...candidate.types, ...candidate.types.flatMap(t => t.properties), ...candidate.links].map(m => m.id));
  const evidence: Ontology['discoveryEvidence'] = [];
  const byId = new Map(catalog.map(e => [e.id, e]));
  const native = sources.length > 0 && sources.every(source=>source.kind==='table');
  if(native){
    const types=new Set(candidate.types.map(t=>t.id));
    for(const link of candidate.links)if(!types.has(link.from)||!types.has(link.to)){
      const question=`关系端点尚未在本次候选中定义（from=${link.from}，to=${link.to}）；保留关系候选并暂缓，不虚设目标类型。`;
      if(!candidate.uncertainties.some(u=>u.memberId===link.id&&u.kind==='source_binding'&&u.question===question))
        candidate.uncertainties.push({memberId:link.id,kind:'source_binding',question});
    }
  }
  // Accept only an exact owner-qualified alias of an actually declared property.
  // An existing canonical ID always wins; suffix/name similarity is never used.
  const aliases=new Map<string,Set<string>>();
  for(const type of candidate.types)for(const property of type.properties){
    const alias=`${type.id}.${property.id}`,targets=aliases.get(alias)??new Set<string>();
    targets.add(property.id);aliases.set(alias,targets);
  }
  const memberId=(id:string)=>{
    if(ids.has(id)||!native)return id;
    const targets=aliases.get(id);
    return targets?.size===1?[...targets][0]:id;
  };
  const quarantine=(kind:string,original:unknown)=>{
    const question=`模型${kind}引用不存在的候选成员，保留原引用并暂缓本表，不猜配成员：${JSON.stringify(original).slice(0,1400)}`;
    for(const type of candidate.types)if(!candidate.uncertainties.some(u=>u.memberId===type.id&&u.kind==='source_binding'&&u.question===question))
      candidate.uncertainties.push({memberId:type.id,kind:'source_binding',question});
  };
  for(const ref of candidate.evidenceReferences)ref.memberId=memberId(ref.memberId);
  const originalUncertainties=candidate.uncertainties;
  candidate.uncertainties=[];
  for(const uncertainty of originalUncertainties){
    const resolved=memberId(uncertainty.memberId);
    if(ids.has(resolved))candidate.uncertainties.push({...uncertainty,memberId:resolved});
    else if(native)quarantine('不确定项',uncertainty);
    else throw new Error('不确定项引用不存在的成员');
  }
  for (const member of [...candidate.types, ...candidate.types.flatMap(t=>t.properties), ...candidate.links]) {
    const rejected: unknown[] = [];
    const resolved: typeof member.sourceColumns = [];
    for (const binding of member.sourceColumns) {
      const sourceVersionId=binding.sourceVersionId??(sources.length===1?sources[0].id:undefined);
      const entry=catalog.find(e=>e.sourceVersionId===sourceVersionId&&e.locator.kind==='column'&&e.locator.field===binding.column);
      if(!entry){rejected.push(binding);continue;}
      resolved.push({sourceVersionId:entry.sourceVersionId,column:binding.column});
      if(!member.sourceColumnIds.includes(entry.id))member.sourceColumnIds.push(entry.id);
    }
    member.sourceColumns=resolved;
    const invalid=member.sourceColumnIds.filter(id=>byId.get(id)?.locator.kind!=='column');
    rejected.push(...invalid);
    member.sourceColumnIds=member.sourceColumnIds.filter(id=>byId.get(id)?.locator.kind==='column');
    if(rejected.length){
      const question=`显式来源绑定不在本次目录或来源不明确，候选暂缓，不推测修正：${JSON.stringify(rejected).slice(0,1500)}`;
      if(!candidate.uncertainties.some(u=>u.memberId===member.id&&u.kind==='source_binding'&&u.question===question))candidate.uncertainties.push({memberId:member.id,kind:'source_binding',question});
    }
    // Materialize source versions so a table-local shorthand stays unambiguous during coordination.
    for(const id of member.sourceColumnIds){const entry=byId.get(id)!;const locator=entry.locator;if(locator.kind==='column'&&!member.sourceColumns.some(c=>c.sourceVersionId===entry.sourceVersionId&&c.column===locator.field))member.sourceColumns.push({sourceVersionId:entry.sourceVersionId,column:locator.field});}
    for (const id of member.sourceColumnIds) {
      let ref = candidate.evidenceReferences.find(r=>r.memberId===member.id);
      if (!ref) { ref={memberId:member.id,evidenceIds:[]};candidate.evidenceReferences.push(ref); }
      if (!ref.evidenceIds.includes(id)) ref.evidenceIds.push(id);
    }
  }
  for (const ref of candidate.evidenceReferences) {
    if (!ids.has(ref.memberId)&&!native) throw new Error(`证据引用不存在的候选成员：${ref.memberId}`);
    for (const id of ref.evidenceIds) {
      const entry = byId.get(id);
      if (!entry) throw new Error(`引用不在本次样本证据目录中：${id}`);
      const source = sources.find(s => s.id === entry.sourceVersionId);
      if (!source) throw new Error('发现证据的来源版本不存在');
      locateDiscoveryEvidence(source, entry.locator);
      if(ids.has(ref.memberId))evidence.push({ memberId: ref.memberId, sourceVersionId: entry.sourceVersionId, locator: entry.locator });
    }
  }
  if(native){
    for(const ref of candidate.evidenceReferences.filter(ref=>!ids.has(ref.memberId)))quarantine('证据',ref);
    candidate.evidenceReferences=candidate.evidenceReferences.filter(ref=>ids.has(ref.memberId));
  }
  const inherited = new Map(base ? [...base.types, ...base.types.flatMap(t => t.properties), ...base.links].map(m => [m.id, fingerprint(m)]) : []);
  const typeHeader = (t: Ontology['types'][number]) => fingerprint({ id: t.id, name: t.name, description: t.description, identityNamespaces: t.identityNamespaces });
  const derivedTypeEvidence: Array<{ typeId: string; fromMemberIds: string[]; scope: string }> = [];
  for (const type of semantic.types) {
    if (evidence.some(e => e.memberId === type.id)) continue;
    const old = base?.types.find(t => t.id === type.id);
    if (old && typeHeader(old) === typeHeader(type)) evidence.push(...(base?.discoveryEvidence.filter(e => e.memberId === type.id) ?? []));
    if (evidence.some(e => e.memberId === type.id)) continue;
    const ownedIds = new Set(type.properties.map(p => p.id));
    let supporting = evidence.filter(e => ownedIds.has(e.memberId));
    if (!supporting.length) {
      const endpointLinks = new Set(candidate.links.filter(l => l.from === type.id || l.to === type.id).map(l => l.id));
      supporting = evidence.filter(e => endpointLinks.has(e.memberId));
    }
    if (supporting.length) {
      const unique = new Map(supporting.map(e => [fingerprint({ source: e.sourceVersionId, locator: e.locator }), { ...e, memberId: type.id }]));
      evidence.push(...unique.values());
      derivedTypeEvidence.push({ typeId: type.id, fromMemberIds: [...new Set(supporting.map(e => e.memberId))], scope: 'structural_presence_only; not proof of description, uniqueness or constraints' });
    }
  }
  const missing: string[] = [];
  for (const member of [...semantic.types, ...semantic.types.flatMap(t => t.properties), ...semantic.links]) {
    if (evidence.some(e => e.memberId === member.id)) continue;
    if (inherited.get(member.id) === fingerprint(member)) evidence.push(...(base?.discoveryEvidence.filter(e => e.memberId === member.id) ?? []));
    else missing.push(member.id);
  }
  if (missing.length) {
    if (!sources.length || !sources.every(s=>s.kind==='table')) throw new DiscoveryEvidenceError(missing);
    for (const memberId of missing) if (!candidate.uncertainties.some(u=>u.memberId===memberId&&u.kind==='evidence'))
      candidate.uncertainties.push({memberId,kind:'evidence',question:'未提供可验证的显式来源列绑定或证据引用；保留候选并暂缓，不按成员名称猜测来源。'});
  }
  if (candidate.uncertainties.some(u => !ids.has(u.memberId))) throw new Error('不确定项引用不存在的成员');
  candidate.uncertainties=candidate.uncertainties.filter(u=>u.kind!=='evidence'||!evidence.some(e=>e.memberId===u.memberId));
  const proposed = (native?discoveryProposalSchema:ontologySchema).parse({ ...semantic, discoveryEvidence: evidence });
  return {candidate,proposed,derivedTypeEvidence};
}
export function validateDiscovery(raw:unknown,sources:DiscoverySource[],catalog:CatalogEntry[],base:Ontology|null) {
  const {candidate,proposed,derivedTypeEvidence}=validateDiscoveryEvidence(raw,sources,catalog,base);
  const evidence=proposed.discoveryEvidence;
  const deferredIds = new Set(candidate.uncertainties.filter(u => u.kind === 'definition' || u.kind === 'evidence' || u.kind === 'source_binding').map(u => u.memberId));
  for (const u of candidate.uncertainties.filter(u => u.kind === 'missing_context')) {
    const property = proposed.types.flatMap(t => t.properties).find(p => p.id === u.memberId);
    if (!property) throw new Error('缺失口径必须关联已定义的属性');
    property.comparisonRequired = [...new Set([...(property.comparisonRequired ?? []), ...(u.dimensions ?? [])])];
  }
  for (const t of proposed.types) if (deferredIds.has(t.id)) {
    for (const p of t.properties) deferredIds.add(p.id);
    for (const l of proposed.links) if (l.from === t.id || l.to === t.id) deferredIds.add(l.id);
  }
  const restoredIds = new Set<string>();
  const types = proposed.types.flatMap(t => {
    if (deferredIds.has(t.id)) { const old = base?.types.find(x => x.id === t.id); if (old) { restoredIds.add(old.id); old.properties.forEach(p => restoredIds.add(p.id)); return [old]; } return []; }
    return [{ ...t, properties: t.properties.flatMap(p => {
      if (!deferredIds.has(p.id)) return [p];
      const old = base?.types.find(x => x.id === t.id)?.properties.find(x => x.id === p.id);
      if (old) { restoredIds.add(old.id); return [old]; } return [];
    }) }];
  });
  const activeTypes = new Set(types.map(t => t.id));
  const links = proposed.links.flatMap(l => {
    if (!deferredIds.has(l.id)) return activeTypes.has(l.from) && activeTypes.has(l.to) ? [l] : [];
    const old = base?.links.find(x => x.id === l.id);
    if (old && activeTypes.has(old.from) && activeTypes.has(old.to)) { restoredIds.add(old.id); return [old]; } return [];
  });
  if (!types.length) throw new Error('候选类型均存在歧义，暂无可自动采用内容；请补充业务范围或来源说明，不会创建空本体');
  const activeIds = new Set([...types, ...types.flatMap(t => t.properties), ...links].map(m => m.id));
  const definition = ontologySchema.parse({ name: proposed.name, types, links, actions: proposed.actions, discoveryEvidence: [
    ...evidence.filter(e => activeIds.has(e.memberId) && !restoredIds.has(e.memberId)),
    ...(base?.discoveryEvidence.filter(e => restoredIds.has(e.memberId)) ?? []),
  ] });
  const deferred = [...proposed.types, ...proposed.types.flatMap(t => t.properties), ...proposed.links].filter(m => deferredIds.has(m.id)).map(member => ({ member, ownerTypeId:proposed.types.find(t=>t.properties.some(p=>p.id===member.id))?.id, evidence: proposed.discoveryEvidence.filter(e => e.memberId === member.id), reason: candidate.uncertainties.find(u => u.memberId === member.id && (u.kind === 'evidence' || u.kind === 'definition' || u.kind === 'source_binding'))?.question ?? '依赖的类型已暂缓' }));
  const issues = discoveryReviewIssues(definition, candidate.uncertainties, base, [], deferred);
  return { definition, validation: { policy: DISCOVERY_POLICY, catalogHash: fingerprint(catalog), derivedTypeEvidence, schemaValid: true, evidenceValid: true, semanticVerified: false, reviewRequired: issues.length > 0, baseline: base, uncertainties: candidate.uncertainties, deferred, definitionHash: fingerprint(definition), issues } };
}

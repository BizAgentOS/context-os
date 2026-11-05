import { z } from 'zod';
import { ontologySchema, propertySchema, objectTypeSchema, strictComparisonSchema, key, type Ontology, type Claim } from './contracts.ts';
import { fingerprint, locateEvidence, type SourceContent } from './sources.ts';
import { structuredCandidates } from './structured-profile.ts';

export const DISCOVERY_POLICY = 'catalog-evidence-recovery-v4';
export const uncertaintySchema = z.object({ memberId: key, kind: z.enum(['definition', 'fact_conflict', 'missing_context', 'time_attachment', 'constraint']), question: z.string().trim().min(1).max(2000), dimensions: z.array(z.enum(['unit', 'currency', 'scope'])).max(3).optional() }).strict().refine(u => u.kind !== 'missing_context' || !!u.dimensions?.length, '缺失口径需明确缺少哪些维度');
type Uncertainty = { memberId: string; question: string; kind?: string; dimensions?: Array<'unit' | 'currency' | 'scope'> };
export interface DiscoverySource extends SourceContent { id: string; sourceNamespace?: string; coverage?: unknown; }
export interface CatalogEntry { id: string; sourceVersionId: string; locator: Claim['evidence'][number]; value: string; }
export const discoveryCandidateSchema = z.object({
  name: ontologySchema.shape.name, types: z.array(objectTypeSchema.extend({ properties: z.array(z.object({ ...propertySchema.shape, comparison: strictComparisonSchema.optional() }).strict().refine(p => p.valueType !== 'enum' || !!p.enumValues?.length, '枚举缺少取值')).max(100) })).min(1).max(100), links: ontologySchema.shape.links,
  actions: ontologySchema.shape.actions,
  evidenceReferences: z.array(z.object({ memberId: key, evidenceIds: z.array(z.string().min(1)).min(1).max(50) }).strict()).max(1000),
  uncertainties: z.array(uncertaintySchema).max(500).default([]),
}).strict();
export function discoveryInput(sources: DiscoverySource[], baseOntology: Ontology | null) {
  const catalog: CatalogEntry[] = [];
  const add = (source: DiscoverySource, locator: CatalogEntry['locator'], value: string) => {
    if (catalog.length >= 3000) throw new Error('发现证据目录超过 3000 项，请减少来源或拆分资料');
    catalog.push({ id: `e${catalog.length + 1}`, sourceVersionId: source.id, locator, value });
  };
  for (const source of sources) {
    if (source.kind !== 'pdf') {
      for (const row of source.rows ?? []) for (const field of source.columns ?? []) {
        const recordKey = row[source.keyColumn!];
        if (recordKey === undefined) throw new Error('发现样本缺少记录主键');
        if (source.kind === 'table' && source.nativeValues?.[recordKey]?.[field] === null) continue;
        add(source, { kind: 'field', recordKey, field }, row[field] ?? '');
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
    sources: sources.map(s => ({ id: s.id, kind: s.kind, sourceNamespace: s.sourceNamespace, columns: s.columns, keyColumn: s.keyColumn, ...(s.metadata ? { metadata: {...s.metadata,profile:undefined} } : {}), ...(s.kind==='table'?{structuredCandidates:structuredCandidates(s)}:{}), coverage: s.coverage })),
    baseOntology,
    evidenceCatalog: catalog.map(e => ({ evidenceId: e.id, sourceVersionId: e.sourceVersionId, kind: e.locator.kind, ...(e.locator.kind === 'field' ? { recordKey: e.locator.recordKey, field: e.locator.field, value: e.value } : { text: e.value, start: e.locator.start }) })),
  } };
}
export interface ReviewIssue { id: string; memberId: string; question: string; kind: string; }
export function discoveryReviewIssues(definition: Ontology, uncertainties: Uncertainty[] = [], base: Ontology | null = null): ReviewIssue[] {
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
      if (!prior && (property.required || property.valueType === 'enum' || property.comparison && Object.keys(property.comparison).length)) constrained.push(property.id);
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
  const reintroduced = uncertainties.filter(u => (!u.kind || u.kind === 'definition') && current.has(u.memberId) && fingerprint(current.get(u.memberId)) !== fingerprint(old.get(u.memberId)));
  if (reintroduced.length) add('resolve_deferred', 'ontology', `本次纳入曾暂缓的含糊内容，需明确业务决定：${reintroduced.map(u => `${u.memberId}：${u.question}`).join('；')}`);
  return issues;
}
export function refreshDiscoveryValidation(definition: Ontology, previous: any) {
  const issues = discoveryReviewIssues(definition, previous.uncertainties ?? [], previous.baseline ?? null);
  return { ...previous, policy: DISCOVERY_POLICY, definitionHash: fingerprint(definition), issues, reviewRequired: issues.length > 0 };
}
export class DiscoveryEvidenceError extends Error {
  readonly code = 'DISCOVERY_EVIDENCE_MISSING';
  readonly missingMemberIds: string[];
  constructor(missingMemberIds: string[]) {
    super(`以下候选缺少可验证依据：${missingMemberIds.join('、')}；不会以模型重试代替证据校验`);
    this.missingMemberIds = missingMemberIds;
  }
}
export function validateDiscovery(raw: unknown, sources: DiscoverySource[], catalog: CatalogEntry[], base: Ontology | null) {
  const candidate = discoveryCandidateSchema.parse(raw);
  const ids = new Set([...candidate.types, ...candidate.types.flatMap(t => t.properties), ...candidate.links].map(m => m.id));
  const evidence: Ontology['discoveryEvidence'] = [];
  const byId = new Map(catalog.map(e => [e.id, e]));
  for (const ref of candidate.evidenceReferences) {
    if (!ids.has(ref.memberId)) throw new Error(`证据引用不存在的候选成员：${ref.memberId}`);
    for (const id of ref.evidenceIds) {
      const entry = byId.get(id);
      if (!entry) throw new Error(`引用不在本次样本证据目录中：${id}`);
      const source = sources.find(s => s.id === entry.sourceVersionId);
      if (!source) throw new Error('发现证据的来源版本不存在');
      locateEvidence(source, entry.locator);
      evidence.push({ memberId: ref.memberId, sourceVersionId: entry.sourceVersionId, locator: entry.locator });
    }
  }
  const inherited = new Map(base ? [...base.types, ...base.types.flatMap(t => t.properties), ...base.links].map(m => [m.id, fingerprint(m)]) : []);
  const typeHeader = (t: Ontology['types'][number]) => fingerprint({ id: t.id, name: t.name, description: t.description, identityNamespaces: t.identityNamespaces });
  const derivedTypeEvidence: Array<{ typeId: string; fromMemberIds: string[]; scope: string }> = [];
  for (const type of candidate.types) {
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
  for (const member of [...candidate.types, ...candidate.types.flatMap(t => t.properties), ...candidate.links]) {
    if (evidence.some(e => e.memberId === member.id)) continue;
    if (inherited.get(member.id) === fingerprint(member)) evidence.push(...(base?.discoveryEvidence.filter(e => e.memberId === member.id) ?? []));
    else missing.push(member.id);
  }
  if (missing.length) throw new DiscoveryEvidenceError(missing);
  if (candidate.uncertainties.some(u => !ids.has(u.memberId))) throw new Error('不确定项引用不存在的成员');
  const proposed = ontologySchema.parse({ name: candidate.name, types: candidate.types, links: candidate.links, actions: candidate.actions, discoveryEvidence: evidence });
  const deferredIds = new Set(candidate.uncertainties.filter(u => u.kind === 'definition').map(u => u.memberId));
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
  const issues = discoveryReviewIssues(definition, candidate.uncertainties, base);
  const deferred = [...proposed.types, ...proposed.types.flatMap(t => t.properties), ...proposed.links].filter(m => deferredIds.has(m.id)).map(member => ({ member, evidence: proposed.discoveryEvidence.filter(e => e.memberId === member.id), reason: candidate.uncertainties.find(u => u.memberId === member.id)?.question ?? '依赖的类型已暂缓' }));
  return { definition, validation: { policy: DISCOVERY_POLICY, catalogHash: fingerprint(catalog), derivedTypeEvidence, schemaValid: true, evidenceValid: true, semanticVerified: false, reviewRequired: issues.length > 0, baseline: base, uncertainties: candidate.uncertainties, deferred, definitionHash: fingerprint(definition), issues } };
}

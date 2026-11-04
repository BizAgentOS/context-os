import { sourceContent } from './table-content.ts';
import { buildConflictEvents, type BuildEvent } from './build-events.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authorize, ontologySchema, strictComparisonSchema, extractionSchema, type Claim, type Principal, type Ontology } from './contracts.ts';
import { itemKey, planProposalSchema, planReviewSchema, sourceVersionIdsSchema, type PlanProposal, type PlanReview } from './build-contracts.ts';
import { compileCsvPlan } from './build-mapping.ts';
import { fingerprint, locateEvidence, validateClaim, type SourceContent } from './sources.ts';
import type { Sql } from './database.ts';
import type { KnowledgeCore } from './service.ts';

const json = (value: unknown) => JSON.stringify(value);
const uuid = (value: string) => z.string().uuid().parse(value);
export interface PlanItem { key: string; sourceVersionId: string; kind: string; label: string; detail: unknown; }
interface SourceRow { id: string; source_id: string; active_version: string; content_hash: string; title: string; revision: number; content: SourceContent; }
export interface PlanRow { decisionPackageId?: string; continuationJobId?: string; id: string; revision: number; ontology_id: string; ontology_hash: string; manifest: Array<{ id: string; sourceId: string; title: string; hash: string; coverage: unknown }>; proposal: PlanProposal; review: PlanReview; preview: PlanPreview | null; status: string; provenance: unknown; }
interface IdentityGroup { key: string; typeId: string; value: string; canonicalId: string; decision: 'pending' | 'same' | 'separate'; autoContinued?: boolean; reason: string; participants: Array<{ sourceVersionId: string; sourceId: string; title: string; evidence: Claim['evidence']; bindingId?: string; objectId?: string; canonicalNamespace?: string }>; }
export interface IdentityMapping { source: Claim['subject']; target: Claim['subject']; bindingId: string | null; objectId: string | null; targetBindingId: string | null; targetObjectId: string | null; adopt?: { identity: Claim['subject']; bindingId: string; objectId: string }; }
interface PlanOutput { sourceVersionId: string; output: { claims: Claim[] }; identityMappings?: IdentityMapping[]; }
interface PlanPreview { acknowledgementPlanId?: string | null; events: BuildEvent[]; eventHash: string; ready: boolean; errors: string[]; warnings: string[]; items: PlanItem[]; identities: IdentityGroup[]; outputs: PlanOutput[]; counts: unknown; signature: string; identityCandidateHash: string; automaticFailures: string[]; }
async function one<T = Record<string, any>>(sql: Sql, query: string, values: unknown[] = []) {
  const row = (await sql.query<T>(query, values)).rows[0];
  if (!row) throw new Error('计划不存在或修订已变化，请重新读取');
  return row;
}
export function sourceCoverage(source: { content: SourceContent }) {
  const c = source.content;
  return c.kind !== 'pdf' ? { kind: c.kind, sampledRows: Math.min(10, c.rowCount ?? c.rows?.length ?? 0), totalRows: c.rowCount ?? c.rows?.length ?? 0 } : { kind: 'pdf', characters: Math.min(40000, c.text?.length ?? 0), totalCharacters: c.text?.length ?? 0 };
}
function items(row: PlanRow): PlanItem[] {
  const result: PlanItem[] = row.manifest.map(s => ({ key: itemKey(s.id, 'source', 'include'), sourceVersionId: s.id, kind: 'source', label: s.title, detail: s.coverage }));
  for (const source of row.proposal.csv) {
    for (const [kind, values] of [['object', source.objects], ['property', source.properties], ['link', source.links]] as const) {
      for (const value of values) result.push({ key: itemKey(source.sourceVersionId, kind, value.id), sourceVersionId: source.sourceVersionId, kind, label: value.id, detail: value });
    }
  }
  for (const source of row.proposal.documents) source.claims.forEach((value, i) => result.push({ key: itemKey(source.sourceVersionId, 'claim', i), sourceVersionId: source.sourceVersionId, kind: 'claim', label: value.claim.predicate, detail: value }));
  return result;
}
function included(row: PlanRow, key: string) { return row.review.items[key]?.include !== false; }
function signature(row: PlanRow) { return fingerprint({ ontologyId: row.ontology_id, ontology: row.ontology_hash, manifest: row.manifest, proposal: row.proposal, review: row.review }); }

/** Draft/preview/approval are database transactions. Model calls never hold these locks. */
export class BuildPlans {
  private core: KnowledgeCore;
  constructor(core: KnowledgeCore) { this.core = core; }
  private async row(sql: Sql, id: string, revision?: number) {
    return one<PlanRow>(sql, 'SELECT * FROM knowledge.build_plans WHERE id=$1 AND ($2::integer IS NULL OR revision=$2)', [uuid(id), revision ?? null]);
  }
  private async context(sql: Sql, row: PlanRow) {
    const model = await one(sql, 'SELECT * FROM knowledge.ontologies WHERE id=$1', [row.ontology_id]);
    const ontology = ontologySchema.parse(model.definition);
    if (fingerprint(ontology) !== row.ontology_hash) throw new Error('本体定义已变化，请基于当前版本重新生成计划');
    const sources: SourceRow[] = [];
    for (const ref of row.manifest) {
      const source = await one<SourceRow>(sql, 'SELECT v.*,COALESCE(s.observed_version,s.active_version) AS active_version,s.title FROM knowledge.source_versions v JOIN knowledge.sources s ON s.id=v.source_id WHERE v.id=$1', [ref.id]);
      if (source.active_version !== source.id || source.content_hash !== ref.hash) throw new Error('来源版本已更新，请重新生成或检查计划，旧批准不能自动沿用');
      source.content = await sourceContent(sql, source.id, source.content); sources.push(source);
    }
    if (row.status === 'approved') {
      const newer = await sql.query('SELECT h.run_id FROM knowledge.approved_plan_outputs o JOIN knowledge.source_versions v ON v.id=o.source_version_id JOIN knowledge.source_build_heads h ON h.source_id=v.source_id JOIN knowledge.build_plans p ON p.id=o.plan_id WHERE p.id=$1 AND h.installed_at>p.approved_at AND h.build_plan_id IS DISTINCT FROM p.id LIMIT 1', [row.id]);
      if (newer.rows.length) throw new Error('该批准之后已有后续构建，旧计划不能重放，请生成新计划');
    }
    return { model, ontology, sources };
  }
  private async event(sql: Sql, row: PlanRow, actor: Principal, kind: string, details: unknown) {
    await sql.query('INSERT INTO knowledge.plan_events(id,plan_id,actor_id,kind,revision,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [randomUUID(), row.id, actor.id, kind, row.revision, json(details)]);
  }
  async create(actor: Principal, ontologyId: string, sourceVersionIds: string[], raw: unknown, provenance: unknown = {}, job?: { id: string; leaseToken: string }, expectedOntologyRevision?: number, continuationPrompt?: string, afterCreate?: (sql: Sql, row: PlanRow) => Promise<void>): Promise<PlanRow> {
    authorize(actor, true); const proposal = planProposalSchema.parse(raw);
    sourceVersionIdsSchema.parse(sourceVersionIds);
    if (new Set(sourceVersionIds).size !== sourceVersionIds.length) throw new Error('来源版本不能重复');
    return this.core.db.transaction(async sql => {
      if (job) await one(sql, "SELECT id FROM knowledge.jobs WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp()", [job.id, job.leaseToken]);
      const current = await one(sql, 'SELECT definition,revision FROM knowledge.ontologies WHERE id=$1', [uuid(ontologyId)]);
      if (expectedOntologyRevision !== undefined && current.revision !== expectedOntologyRevision) throw new Error('本体修订已变化，请重新生成计划');
      const ontology = ontologySchema.parse(current.definition);
      const manifest = [];
      for (const id of sourceVersionIds) {
        const source = await one<SourceRow>(sql, 'SELECT v.*,COALESCE(s.observed_version,s.active_version) AS active_version,s.title FROM knowledge.source_versions v JOIN knowledge.sources s ON s.id=v.source_id WHERE v.id=$1', [id]);
        if (source.active_version !== id) throw new Error('来源已有新版本，请重新选择');
        manifest.push({ id, sourceId: source.source_id, title: source.title, hash: source.content_hash, coverage: sourceCoverage(source) });
      }
      this.checkSourceRefs(proposal, sourceVersionIds);
      const row = await one<PlanRow>(sql, 'INSERT INTO knowledge.build_plans(id,ontology_id,ontology_hash,manifest,proposal,provenance,created_by) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7) RETURNING *', [randomUUID(), ontologyId, fingerprint(ontology), json(manifest), json(proposal), json(provenance), actor.id]);
      await this.event(sql, row, actor, 'created', { provenance });
      let continuationJobId: string | undefined;
      if (continuationPrompt) {
        continuationJobId = randomUUID();
        const input = { kind: 'build', operationId: `pipeline:${row.id}:initial`, planId: row.id, preflight: true };
        const payload = { input, modelId: null, modelPolicy: null, promptVersion: continuationPrompt };
        await sql.query('INSERT INTO knowledge.jobs(id,operation_id,fingerprint,kind,actor_id,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [continuationJobId, input.operationId, fingerprint({ actor: actor.id, input, model: null, modelPolicy: null, prompt: continuationPrompt }), 'build', actor.id, json(payload)]);
      }
      await afterCreate?.(sql, row);
      if (job) await sql.query("UPDATE knowledge.jobs SET state='completed',result=$3::jsonb,lease_until=NULL WHERE id=$1 AND lease_token=$2", [job.id, job.leaseToken, json({ planId: row.id, ...(row.decisionPackageId ? { decisionPackageId: row.decisionPackageId, stage: 'queued_collection' } : {}), ...(continuationJobId ? { stage: 'queued_preflight', continuationJobId } : {}) })]);
      return { ...row, continuationJobId };
    });
  }
  private checkSourceRefs(proposal: PlanProposal, ids: string[]) {
    const refs = [...proposal.csv, ...proposal.documents].map(s => s.sourceVersionId);
    if (refs.some(id => !ids.includes(id)) || new Set(refs).size !== refs.length) throw new Error('计划包含本次输入以外或重复的来源版本');
  }
  async list(actor: Principal) {
    authorize(actor);
    return (await this.core.db.pool.query(`SELECT p.id,p.revision,p.ontology_id,p.status,p.manifest,p.provenance,p.created_at,p.approved_at,
      CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(p.manifest) m JOIN knowledge.source_versions v ON v.id=(m->>'id')::uuid JOIN knowledge.sources s ON s.id=v.source_id WHERE COALESCE(s.observed_version,s.active_version) IS DISTINCT FROM v.id OR v.content_hash IS DISTINCT FROM m->>'hash')
      OR EXISTS (SELECT 1 FROM knowledge.approved_plan_outputs o JOIN knowledge.source_versions v ON v.id=o.source_version_id JOIN knowledge.source_build_heads h ON h.source_id=v.source_id WHERE o.plan_id=p.id AND h.installed_at>p.approved_at AND h.build_plan_id IS DISTINCT FROM p.id)
      THEN 'obsolete' ELSE p.status END AS effective_status
      FROM knowledge.build_plans p ORDER BY p.created_at DESC,p.id LIMIT 100`)).rows;
  }
  async get(actor: Principal, id: string) {
    authorize(actor); const row = await this.row(this.core.db.pool, id);
    let staleReason: string | null = null;
    try { await this.context(this.core.db.pool, row); } catch (error) { staleReason = error instanceof Error ? error.message : '输入版本已失效'; }
    const progress = (await this.core.db.pool.query('SELECT r.source_version_id,r.status,r.result,(h.run_id=r.id AND s.active_version=r.source_version_id) AS is_current FROM knowledge.extraction_runs r JOIN knowledge.source_versions v ON v.id=r.source_version_id JOIN knowledge.sources s ON s.id=v.source_id LEFT JOIN knowledge.source_build_heads h ON h.source_id=v.source_id WHERE r.build_plan_id=$1 ORDER BY r.created_at', [id])).rows;
    return { ...row, effectiveStatus: staleReason ? 'obsolete' : row.status, items: items(row), staleReason, progress };
  }
  async save(actor: Principal, id: string, revision: number, raw: unknown, rawReview: unknown) {
    authorize(actor, true); const proposal = planProposalSchema.parse(raw), review = planReviewSchema.parse(rawReview);
    for (const choice of Object.values(review.identities)) if (choice.decision !== 'pending' && !choice.reason.trim() && review.reason.trim()) choice.reason = review.reason;
    return this.core.db.transaction(async sql => {
      const old = await this.row(sql, id, revision);
      if (old.status === 'approved') throw new Error('已批准计划不可修改，请生成新计划');
      await this.context(sql, old);
      this.checkSourceRefs(proposal, old.manifest.map(s => s.id));
      const validItems = new Set(items({ ...old, proposal }).map(i => i.key));
      if (Object.keys(review.items).some(key => !validItems.has(key))) throw new Error('审核引用了不存在的绑定');
      const row = await one<PlanRow>(sql, "UPDATE knowledge.build_plans SET proposal=$2::jsonb,review=$3::jsonb,preview=NULL,status='draft',revision=revision+1 WHERE id=$1 RETURNING *", [id, json(proposal), json(review)]);
      await this.event(sql, row, actor, 'edited', { reason: review.reason }); return row;
    });
  }
  async decideIdentityBatch(actor: Principal, id: string, raw: unknown, continuationPrompt?: string): Promise<PlanRow> {
    authorize(actor, true);
    const input = z.object({ expectedRevision: z.number().int().positive(), candidateHash: z.string().min(1), decision: z.enum(['same', 'separate']), reason: z.string().trim().min(1).max(4000), overrides: z.record(z.string(), z.object({ decision: z.enum(['same', 'separate']), reason: z.string().trim().max(4000).optional() }).strict()).default({}) }).strict().parse(raw);
    return this.core.db.transaction(async sql => {
      const row = await this.row(sql, id, input.expectedRevision);
      if (row.status === 'approved') throw new Error('已批准计划不可修改');
      const current = await this.preview(sql, row);
      if (current.identityCandidateHash !== input.candidateHash) throw new Error('身份候选或绑定已变化，请重新读取本批摘要');
      const groups = current.identities.filter(g => !g.autoContinued);
      if (!groups.length || Object.keys(input.overrides).some(k => !groups.some(g => g.key === k))) throw new Error('批量决定包含不存在或已自动延续的候选');
      const review = planReviewSchema.parse(row.review);
      for (const group of groups) {
        const override = input.overrides[group.key];
        review.identities[group.key] = { decision: override?.decision ?? input.decision, reason: override?.reason?.trim() || input.reason };
      }
      review.reason ||= input.reason;
      const next = await one<PlanRow>(sql, "UPDATE knowledge.build_plans SET review=$2::jsonb,preview=NULL,status='draft',revision=revision+1 WHERE id=$1 RETURNING *", [id, json(review)]);
      await this.event(sql, next, actor, 'identity_batch_decided', { candidateHash: input.candidateHash, reason: input.reason, decisions: groups.map(g => ({ key: g.key, participants: g.participants, ...review.identities[g.key] })), scope: '仅本批具体编号，不创建跨版本匹配规则' });
      let continuationJobId: string | undefined;
      if (continuationPrompt) {
        continuationJobId = randomUUID();
        const nextInput = { kind: 'build', operationId: `pipeline:${id}:decision:${next.revision}`, planId: id, preflight: true };
        await sql.query('INSERT INTO knowledge.jobs(id,operation_id,fingerprint,kind,actor_id,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [continuationJobId, nextInput.operationId, fingerprint({ actor: actor.id, input: nextInput, model: null, modelPolicy: null, prompt: continuationPrompt }), 'build', actor.id, json({ input: nextInput, modelId: null, modelPolicy: null, promptVersion: continuationPrompt })]);
      }
      return { ...next, continuationJobId };
    });
  }
  private async preview(sql: Sql, row: PlanRow): Promise<PlanPreview> {
    const { sources, ontology } = await this.context(sql, row);
    const automaticFailures: string[] = [];
    const errors: string[] = [], warnings: string[] = [], outputs: PlanOutput[] = [], allItems = items(row);
    const selectedSource = (id: string) => included(row, itemKey(id, 'source', 'include'));
    // Ordinary items are validated automatically; only domain events require a decision.
    for (const source of sources) {
      if (!selectedSource(source.id)) continue;
      try {
        let claims: Claim[];
        const csv = row.proposal.csv.find(s => s.sourceVersionId === source.id), doc = row.proposal.documents.find(s => s.sourceVersionId === source.id);
        if (source.content.kind !== 'pdf' && csv) claims = compileCsvPlan(source.content, csv, ontology, `source.${source.source_id}`, row.review).claims;
        else if (source.content.kind === 'pdf' && doc) {
          if ((source.content.text?.length ?? 0) > 40000) throw new Error('PDF 超过首期完整候选抽取预算，请拆分后接入；不静默截断');
          claims = doc.claims.flatMap((entry, index) => {
            if (!included(row, itemKey(source.id, 'claim', index))) return [];
            const claim = extractionSchema.parse({ claims: [entry.claim] }).claims[0];
            validateClaim(ontology, claim);
            if (claim.validity.precision !== 'unknown') {
              if (!entry.timeExplanation.trim() || !entry.timeEvidenceIndexes.length) throw new Error('已知有效时间必须有归属解释和所选原文依据');
              for (const i of entry.timeEvidenceIndexes) if (!claim.evidence[i]) throw new Error('时间依据索引不存在');
            }
            const prop = ontology.types.find(t => t.id === claim.subject.typeId)?.properties.find(p => p.id === claim.predicate);
            if (prop?.valueType === 'datetime' && !entry.timeExplanation.trim()) throw new Error('日期属性必须解释业务归属，不能用任职结束冒充合同终止');
            claim.subject.namespace = `source.${source.source_id}`;
            if (claim.object) claim.object.namespace = `source.${source.source_id}`;
            return [claim];
          });
        } else throw new Error('选定来源没有可执行绑定；请生成计划或明确排除此来源');
        for (const claim of claims) {
          strictComparisonSchema.parse(claim.comparison);
          for (const ref of claim.evidence) locateEvidence(source.content, ref);
          for (const identity of [claim.subject, ...(claim.object ? [claim.object] : [])]) {
            if (!claim.evidence.some(ref => ref.kind === 'field' ? source.content.rows?.some(r => r[source.content.keyColumn!] === ref.recordKey && r[ref.field] === identity.value) : ref.quote.includes(identity.value))) throw new Error('身份原始值必须可在所引用证据中找到');
          }
        }
        outputs.push({ sourceVersionId: source.id, output: { claims } });
        if (!claims.length) warnings.push(`${source.title} 没有纳入声明；不会替代该来源的旧结果`);
      } catch (error) { const message = `${source.title}：${error instanceof Error ? error.message : '预检失败'}`; errors.push(message); automaticFailures.push(message); }
    }
    const groupMap = new Map<string, IdentityGroup>();
    for (const output of outputs) {
      const source = sources.find(s => s.id === output.sourceVersionId)!;
      for (const claim of output.output.claims) for (const identity of [claim.subject, ...(claim.object ? [claim.object] : [])]) {
        const grouping = fingerprint({ typeId: identity.typeId, value: identity.value });
        let group = groupMap.get(grouping);
        if (!group) { group = { key: '', typeId: identity.typeId, value: identity.value, canonicalId: '', decision: 'pending', reason: '', participants: [] }; groupMap.set(grouping, group); }
        if (!group.participants.some(p => p.sourceVersionId === source.id)) group.participants.push({ sourceVersionId: source.id, sourceId: source.source_id, title: source.title, evidence: claim.evidence });
      }
    }
    // Read current source aliases, including single-source updates. Every reuse is reviewed again.
    for (const group of groupMap.values()) for (const p of group.participants) {
      const binding = (await sql.query("SELECT b.id,b.object_id,b.approval_plan_id,i.namespace FROM knowledge.identity_bindings b LEFT JOIN knowledge.identifiers i ON i.object_id=b.object_id AND i.type_id=b.type_id AND i.value=b.value AND i.namespace LIKE 'approved.%' WHERE b.type_id=$1 AND b.namespace=$2 AND b.value=$3 AND b.system_to IS NULL ORDER BY i.namespace LIMIT 1", [group.typeId, `source.${p.sourceId}`, group.value])).rows[0];
      if (binding) { p.bindingId = binding.id; p.objectId = binding.object_id; if (binding.approval_plan_id && binding.namespace) p.canonicalNamespace = binding.namespace; }
    }
    const identities: IdentityGroup[] = [];
    for (const group of groupMap.values()) {
      if (group.participants.length < 2 && !group.participants.some(p => p.canonicalNamespace)) continue;
      group.key = fingerprint({ typeId: group.typeId, value: group.value, sources: group.participants.map(p => p.sourceId).sort() });
      const previous = (await sql.query("SELECT canonical_id FROM knowledge.plan_identity_decisions WHERE group_key=$1 AND decision='same' ORDER BY created_at DESC LIMIT 1", [group.key])).rows[0];
      const existing = [...new Set(group.participants.flatMap(p => p.canonicalNamespace ? [p.canonicalNamespace.slice('approved.'.length)] : []))];
      if (existing.length > 1) errors.push(`已有多个对象绑定，需先身份纠错：${group.value}`);
      const seed = fingerprint({ planId: row.id, groupKey: group.key });
      group.canonicalId = existing[0] ?? previous?.canonical_id ?? `${seed.slice(0,8)}-${seed.slice(8,12)}-5${seed.slice(13,16)}-8${seed.slice(17,20)}-${seed.slice(20,32)}`;
      const decision = row.review.identities[group.key];
      const continuation = existing.length === 1 && group.participants.every(p => p.canonicalNamespace === `approved.${existing[0]}`);
      group.autoContinued = continuation && !decision;
      group.decision = decision?.decision ?? (continuation ? 'same' : 'pending'); group.reason = decision?.reason ?? (continuation ? '已批准的具体来源绑定未变化，自动沿用；非新合并规则' : '');
      if (group.decision === 'pending' || !group.reason.trim()) errors.push(`跨源身份尚未决定或缺少理由：${group.typeId} ${group.value}`);
      if (group.decision === 'separate' && (group.participants.some(p => p.canonicalNamespace) || new Set(group.participants.flatMap(p => p.objectId ? [p.objectId] : [])).size < group.participants.filter(p => p.objectId).length)) errors.push(`已有统一对象绑定不能静默拆分，请先执行身份纠错：${group.value}`);
      if (group.decision === 'same') {
        const target = (await sql.query('SELECT object_id FROM knowledge.identifiers WHERE type_id=$1 AND namespace=$2 AND value=$3', [group.typeId, `approved.${group.canonicalId}`, group.value])).rows[0];
        const objects = [...new Set(group.participants.flatMap(p => p.objectId ? [p.objectId] : []))];
        if (target ? objects.some(id => id !== target.object_id) : objects.length > 1) errors.push(`来源编号已有其他对象，需先身份纠错：${group.value}`);
      }
      identities.push(group);
    }
    if (Object.keys(row.review.identities).some(key => !identities.some(g => g.key === key))) errors.push('身份候选集合已变化，请移除失效的审核决定并重新检查');
    for (const output of outputs) for (const claim of output.output.claims) {
      for (const identity of [claim.subject, ...(claim.object ? [claim.object] : [])]) {
        const group = identities.find(g => g.typeId === identity.typeId && g.value === identity.value && g.participants.some(p => p.sourceVersionId === output.sourceVersionId));
        if (group?.decision === 'same') identity.namespace = `approved.${group.canonicalId}`;
      }
    }
    for (const output of outputs) {
      const source = sources.find(s => s.id === output.sourceVersionId)!;
      const unique = new Map<string, IdentityMapping>();
      for (const claim of output.output.claims) for (const target of [claim.subject, ...(claim.object ? [claim.object] : [])]) {
        const original = { ...target, namespace: `source.${source.source_id}` };
        const binding = (await sql.query('SELECT id,object_id FROM knowledge.identity_bindings WHERE type_id=$1 AND namespace=$2 AND value=$3 AND system_to IS NULL', [original.typeId, original.namespace, original.value])).rows[0];
        const targetBinding = (await sql.query('SELECT id,object_id FROM knowledge.identity_bindings WHERE type_id=$1 AND namespace=$2 AND value=$3 AND system_to IS NULL', [target.typeId, target.namespace, target.value])).rows.at(0);
        const group = identities.find(g => g.typeId === target.typeId && g.value === target.value && g.decision === 'same');
        const anchor = !targetBinding && group?.participants.find(p => p.bindingId && p.objectId);
        const adopt = anchor ? { identity: { typeId: target.typeId, namespace: `source.${anchor.sourceId}`, value: target.value }, bindingId: anchor.bindingId!, objectId: anchor.objectId! } : undefined;
        unique.set(fingerprint(original), { ...(adopt ? { adopt } : {}), source: original, target: { ...target }, bindingId: binding?.id ?? null, objectId: binding?.object_id ?? null, targetBindingId: targetBinding?.id ?? null, targetObjectId: targetBinding?.object_id ?? null });
      }
      output.identityMappings = [...unique.values()];
    }
    const total = outputs.reduce((sum, output) => sum + output.output.claims.length, 0);
    if (!total) { errors.push('没有纳入任何可构建声明'); automaticFailures.push('没有可执行声明'); }
    const allClaims = outputs.flatMap(o => o.output.claims);
    // Existing unaffected source facts participate in preview conflicts as well as this batch.
    const existingSubjects = new Map<string, Claim['subject']>();
    for (const output of outputs) for (const m of output.identityMappings ?? []) if (m.targetObjectId) existingSubjects.set(m.targetObjectId, m.target);
    if (existingSubjects.size) {
      const old = (await sql.query("SELECT a.object_id,a.predicate,r.value,r.target_id,ti.type_id AS target_type,ti.namespace AS target_namespace,ti.value AS target_value,r.valid_from,r.valid_to,r.time_precision,r.basis,r.semantics,r.comparison FROM knowledge.assertions a JOIN knowledge.assertion_revisions r ON r.assertion_id=a.id AND r.system_to IS NULL LEFT JOIN LATERAL (SELECT i.type_id,i.namespace,i.value FROM knowledge.identifiers i WHERE i.object_id=r.target_id ORDER BY (i.namespace LIKE 'approved.%') DESC,i.namespace LIMIT 1) ti ON true WHERE a.object_id=ANY($1::uuid[]) AND a.origin='source' AND r.status='accepted' AND NOT (a.source_version_id IN (SELECT id FROM knowledge.source_versions WHERE source_id=ANY($2::uuid[])))", [[...existingSubjects.keys()], row.manifest.filter(m => outputs.some(o => o.sourceVersionId === m.id && o.output.claims.length > 0)).map(m => m.sourceId)])).rows;
      for (const fact of old) allClaims.push({ subject: existingSubjects.get(fact.object_id)!, predicate: fact.predicate, ...(fact.target_id ? { object: { typeId: fact.target_type, namespace: fact.target_namespace, value: fact.target_value } } : { value: fact.value }), validity: { from: fact.valid_from ? new Date(fact.valid_from).toISOString() : null, to: fact.valid_to ? new Date(fact.valid_to).toISOString() : null, precision: fact.time_precision }, basis: fact.basis, semantics: fact.semantics, comparison: fact.comparison, evidence: [] });
    }
    const events = buildConflictEvents(ontology, allClaims);
    const assumptions = row.proposal.csv.filter(s => selectedSource(s.sourceVersionId)).flatMap(s => [...s.properties, ...s.links].filter(b => b.time.mode === 'fixed' && included(row, itemKey(s.sourceVersionId, 'object' in b ? 'property' : 'link', b.id))).map(b => ({ sourceVersionId: s.sourceVersionId, binding: b.id, time: b.time })));
    if (assumptions.length) events.push({ id: fingerprint(assumptions), kind: 'fixed_time_assumption', summary: '本次含固定时间配置，需确认其业务依据或人工假设', details: assumptions });
    events.sort((a, b) => a.id.localeCompare(b.id));
    const eventHash = fingerprint(events);
    const priorAcknowledgement = events.length ? (await sql.query("SELECT id FROM knowledge.build_plans WHERE status='approved' AND review->>'eventAcknowledgement'=$1 AND length(btrim(review->>'reason'))>0 ORDER BY approved_at DESC,id LIMIT 1", [eventHash])).rows[0] : null;
    if (events.length && !priorAcknowledgement && (row.review.eventAcknowledgement !== eventHash || !row.review.reason.trim())) errors.push('存在重大构建事件，请查看摘要并记录决定；无需逐条确认普通绑定');
    warnings.push('仅对选中版本有效；正式构建将替代这些来源当前的来源声明，保留人工修正与系统历史。');
    warnings.push('系统校验证据、结构和口径，含糊内容应保留未知或暂缓；仅重大事件要求业务决定，不保证自动证明全部语义。');
    return { automaticFailures, identityCandidateHash: fingerprint({ ontology: row.ontology_hash, manifest: row.manifest, identities }), acknowledgementPlanId: priorAcknowledgement?.id ?? null, events, eventHash, ready: errors.length === 0, errors, warnings, items: allItems, identities, outputs, counts: { sources: outputs.length, claims: total, identities: new Set(outputs.flatMap(o => o.output.claims.flatMap(c => [c.subject, ...(c.object ? [c.object] : [])]).map(i => fingerprint(i)))).size }, signature: signature(row) };
  }
  async preflight(actor: Principal, id: string, revision: number) {
    authorize(actor, true);
    const next = await this.core.db.transaction(async sql => {
      const row = await this.row(sql, id, revision);
      if (row.status === 'approved') throw new Error('已批准计划不可重新预检，请生成新计划');
      const preview = await this.preview(sql, row);
      const next = await one<PlanRow>(sql, "UPDATE knowledge.build_plans SET preview=$2::jsonb,status=$3,revision=revision+1 WHERE id=$1 RETURNING *", [id, json(preview), preview.ready ? 'ready' : 'draft']);
      await this.event(sql, next, actor, 'preflight', { ready: preview.ready, counts: preview.counts, errors: preview.errors }); return next;
    });
    if (next.preview?.ready) {
      const model = await this.core.ontology(actor, next.ontology_id);
      if (model.status === 'published') return this.approve(actor, next.id, next.revision, true);
    }
    return next;
  }
  async approve(actor: Principal, id: string, revision: number, automatic = false) {
    authorize(actor, true);
    return this.core.db.transaction(async sql => {
      const row = await this.row(sql, id, revision);
      if (row.status === 'approved') return row;
      const { model } = await this.context(sql, row);
      if (model.status !== 'published') throw new Error('请先发布该计划对应的本体；发布不改变定义内容');
      if (!row.preview?.ready || row.preview.signature !== signature(row)) throw new Error('需完成当前预检并处理重大事件后批准');
      const preview = await this.preview(sql, row);
      if (!preview.ready) throw new Error('预检已失效，请重新检查审核项');
      if (fingerprint(preview.outputs.map(o => o.identityMappings)) !== fingerprint(row.preview.outputs.map(o => o.identityMappings))) throw new Error('身份绑定在预检后已变化，请重新预检并审核');
      for (const group of preview.identities) await sql.query('INSERT INTO knowledge.plan_identity_decisions(plan_id,group_key,decision,canonical_id,participants,reason,actor_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)', [id, group.key, group.decision, group.canonicalId, json(group.participants), group.reason, actor.id]);
      for (const output of preview.outputs) {
        if (!output.output.claims.length) continue;
        const namespaces = [...new Set(output.output.claims.flatMap(c => [c.subject.namespace, ...(c.object ? [c.object.namespace] : [])]))];
        await sql.query('INSERT INTO knowledge.approved_plan_outputs(plan_id,source_version_id,output,output_hash,namespaces,identity_mappings) VALUES($1,$2,$3::jsonb,$4,$5,$6::jsonb)', [id, output.sourceVersionId, json(output.output), fingerprint(output.output), namespaces, json(output.identityMappings)]);
      }
      const next = await one<PlanRow>(sql, "UPDATE knowledge.build_plans SET status='approved',approved_by=$2,approved_at=clock_timestamp(),preview=$3::jsonb,revision=revision+1 WHERE id=$1 RETURNING *", [id, actor.id, json(preview)]);
      await this.event(sql, next, actor, automatic ? 'auto_approved' : 'approved', { automatic, reason: row.review.reason || (preview.events.length ? '沿用已批准的相同重大事件决定' : '自动校验通过，无新增重大事件'), reusedDecisionPlanId: preview.acknowledgementPlanId, identities: preview.identities, events: preview.events }); return next;
    });
  }
  async build(actor: Principal, id: string, job?: { id: string; leaseToken: string }) {
    authorize(actor, true);
    const row = await this.row(this.core.db.pool, id);
    if (row.status !== 'approved') throw new Error('构建必须使用已批准计划');
    await this.context(this.core.db.pool, row);
    const outputs = (await this.core.db.pool.query('SELECT source_version_id,output FROM knowledge.approved_plan_outputs WHERE plan_id=$1 ORDER BY source_version_id', [id])).rows;
    const results = [];
    for (const output of outputs) {
      const result = await this.core.commitExtraction(actor, { operationId: `plan:${id}:${output.source_version_id}`, ontologyId: row.ontology_id, sourceVersionId: output.source_version_id, configuration: { buildPlanId: id, reviewHash: signature(row) }, output: output.output, buildPlanId: id, job });
      results.push({ sourceVersionId: output.source_version_id, result });
    }
    return { planId: id, results };
  }
  async events(actor: Principal, id: string) {
    authorize(actor); return (await this.core.db.pool.query('SELECT actor_id,kind,revision,details,created_at FROM knowledge.plan_events WHERE plan_id=$1 ORDER BY created_at', [uuid(id)])).rows;
  }
}

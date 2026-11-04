import { sourceContent } from './table-content.ts';
import { refreshDiscoveryValidation } from './discovery.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Database, type Sql } from './database.ts';
import { AccessDenied, actionSchema, strictComparisonSchema, authorize, extractionSchema, identitySchema, ontologySchema, requiresReview, validateValue, type Action, type Claim, type Ontology, type Principal } from './contracts.ts';
import { fingerprint, locateEvidence, validateClaim, type PreparedSource, type SourceContent } from './sources.ts';
import { FUSION_POLICY, projectStatements, type Statement } from './projection.ts';
import { rematchIdentity } from './identity.ts';
import type { IdentityMapping } from './build-plans.ts';

const json = (v: unknown) => JSON.stringify(v);
const uuid = (v: string) => z.string().uuid().parse(v);
function ontologyDiscoveryView(row: Record<string, any>) {
  if (row.status !== 'draft' || !row.discovery?.validation) return row;
  return { ...row, discovery: { ...row.discovery, validation: refreshDiscoveryValidation(ontologySchema.parse(row.definition), row.discovery.validation) } };
}
async function one(sql: Sql, query: string, values: unknown[] = []) {
  const row = (await sql.query(query, values)).rows[0];
  if (!row) throw new Error('目标不存在');
  return row;
}
async function checkJob(sql: Sql, job?: { id: string; leaseToken: string }) {
  if (!job) return;
  await one(sql, "SELECT id FROM knowledge.jobs WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp() FOR UPDATE", [job.id, job.leaseToken]);
}
async function finishJob(sql: Sql, job: { id: string; leaseToken: string } | undefined, result: unknown) {
  if (job) await sql.query("UPDATE knowledge.jobs SET state='completed',result=$3::jsonb,error=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2 AND state='running'", [job.id, job.leaseToken, json(result)]);
}
export class KnowledgeCore {
  readonly db: Database;
  constructor(db: Database) { this.db = db; }

  async list(actor: Principal, kind: 'sources' | 'ontologies' | 'objects' | 'jobs', limit = 100, offset = 0) {
    authorize(actor);
    z.enum(['sources', 'ontologies', 'objects', 'jobs']).parse(kind);
    const take = z.number().int().min(1).max(200).parse(limit), skip = z.number().int().nonnegative().parse(offset);
    if (kind === 'sources') return (await this.db.pool.query('SELECT s.*,v.revision AS active_revision,o.revision AS observed_revision FROM knowledge.sources s LEFT JOIN knowledge.source_versions v ON v.id=s.active_version LEFT JOIN knowledge.source_versions o ON o.id=s.observed_version ORDER BY s.title,s.id LIMIT $1 OFFSET $2', [take, skip])).rows;
    const order = 'created_at DESC,id';
    // Table names are a closed enumeration, never request SQL.
    const rows = (await this.db.pool.query(`SELECT * FROM knowledge.${kind} ORDER BY ${order} LIMIT $1 OFFSET $2`, [take, skip])).rows;
    return kind === 'ontologies' ? rows.map(ontologyDiscoveryView) : rows;
  }
  async sourceVersion(actor: Principal, id: string, sampleLimit?: number): Promise<Record<string, any>> {
    authorize(actor); const row = await one(this.db.pool, 'SELECT * FROM knowledge.source_versions WHERE id=$1', [uuid(id)]);
    return { ...row, content: await sourceContent(this.db.pool, row.id, row.content, sampleLimit) };
  }
  async ontology(actor: Principal, id: string, published = false) {
    authorize(actor);
    const row = await one(this.db.pool, 'SELECT * FROM knowledge.ontologies WHERE id=$1', [uuid(id)]);
    if (published && row.status !== 'published') throw new Error('需使用已发布本体版本');
    return { ...ontologyDiscoveryView(row), discovery: ontologyDiscoveryView(row).discovery, id: String(row.id), revision: Number(row.revision), status: String(row.status), definition: ontologySchema.parse(row.definition) };
  }
  async draft(actor: Principal, input: unknown, existing?: { id: string; expectedRevision: number }, job?: { id: string; leaseToken: string }, discovery: unknown = {}, copyFromId?: string, afterCreate?: (sql: Sql, result: Record<string, any>) => Promise<void>) {
    authorize(actor, true); const definition = ontologySchema.parse(input);
    for (const t of definition.types) for (const p of t.properties) if (p.comparison) strictComparisonSchema.parse(p.comparison);
    return this.db.transaction(async sql => {
      await checkJob(sql, job);
      if (!existing) {
        if (copyFromId) {
          const parent = await one(sql, 'SELECT discovery,definition,status FROM knowledge.ontologies WHERE id=$1', [uuid(copyFromId)]);
          const metadata = parent.discovery;
          discovery = metadata?.validation ? { ...metadata, review: null, parentOntologyId: copyFromId, validation: { ...refreshDiscoveryValidation(definition, { ...metadata.validation, baseline: parent.status === 'published' ? ontologySchema.parse(parent.definition) : metadata.validation.baseline }), evidenceValid: false } } : metadata;
        }
        const id = randomUUID();
        const result = await one(sql, 'INSERT INTO knowledge.ontologies(id,status,definition,discovery) VALUES($1,\'draft\',$2::jsonb,$3::jsonb) RETURNING *', [id, json(definition), json(discovery)]);
        await afterCreate?.(sql, result);
        await finishJob(sql, job, result);
        return result;
      }
      const old = await one(sql, "SELECT * FROM knowledge.ontologies WHERE id=$1 AND revision=$2 AND status='draft'", [uuid(existing.id), existing.expectedRevision]);
      let metadata = old.discovery;
      if (metadata?.validation && fingerprint(ontologySchema.parse(old.definition)) !== fingerprint(definition)) {
        metadata = { ...metadata, review: null, validation: { ...refreshDiscoveryValidation(definition, metadata.validation), evidenceValid: false } };
      }
      return one(sql, "UPDATE knowledge.ontologies SET definition=$3::jsonb,discovery=$4::jsonb,revision=revision+1 WHERE id=$1 AND revision=$2 RETURNING *", [existing.id, existing.expectedRevision, json(definition), json(metadata)]);
    });
  }
  async reviewDiscovery(actor: Principal, id: string, raw: unknown) {
    authorize(actor, true);
    const input = z.object({ expectedRevision: z.number().int().positive(), issueIds: z.array(z.string()).max(2000), reason: z.string().trim().min(1).max(4000) }).strict().parse(raw);
    return this.db.transaction(async sql => {
      const draft = ontologyDiscoveryView(await one(sql, "SELECT * FROM knowledge.ontologies WHERE id=$1 AND revision=$2 AND status='draft'", [uuid(id), input.expectedRevision]));
      if (!draft.discovery?.validation) throw new Error('该本体没有新版本发现校验，请重新生成候选');
      const definition = ontologySchema.parse(draft.definition);
      if (draft.discovery.validation.definitionHash !== fingerprint(definition)) throw new Error('定义已修改，请保存后重新读取审核项');
      const issues = draft.discovery.validation.issues as Array<{ id: string }>;
      if (new Set(input.issueIds).size !== issues.length || input.issueIds.length !== issues.length || issues.some(i => !input.issueIds.includes(i.id))) throw new Error('重大事件集合已变化，请重新读取节点摘要后决定');
      const review = { actorId: actor.id, at: new Date().toISOString(), reason: input.reason, issueIds: input.issueIds, definitionHash: fingerprint(definition) };
      const discovery = { ...draft.discovery, review };
      await sql.query('INSERT INTO knowledge.action_events(operation_id,fingerprint,actor_id,kind,target_id,payload,result) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)', [randomUUID(), fingerprint({ id, input }), actor.id, 'ReviewOntologyDiscovery', id, json(input), json(review)]);
      return one(sql, 'UPDATE knowledge.ontologies SET discovery=$2::jsonb,revision=revision+1 WHERE id=$1 RETURNING *', [id, json(discovery)]);
    });
  }
  async importSource(actor: Principal, operationId: string, sourceKey: string, title: string, prepared: PreparedSource) {
    authorize(actor, true);
    z.string().min(1).max(160).parse(operationId); z.string().min(1).max(160).parse(sourceKey); z.string().min(1).max(300).parse(title);
    const hash = fingerprint({ actor: actor.id, sourceKey, title, hash: prepared.hash, content: prepared.content });
    let retained = false;
    let committed = false;
    try {
      const result = await this.db.transaction(async sql => {
        const prior = (await sql.query('SELECT * FROM knowledge.operations WHERE id=$1', [operationId])).rows[0];
        if (prior) { if (prior.fingerprint !== hash) throw new Error('operationId 已用于不同输入'); return prior.result; }
        let source = (await sql.query('SELECT * FROM knowledge.sources WHERE source_key=$1', [sourceKey])).rows[0];
        if (!source) source = await one(sql, 'INSERT INTO knowledge.sources(id,source_key,title,kind) VALUES($1,$2,$3,$4) RETURNING *', [randomUUID(), sourceKey, title, prepared.content.kind]);
        if (source.kind !== prepared.content.kind) throw new Error('来源种类不能原地改变');
        let version = source.active_version ? await one(sql, 'SELECT * FROM knowledge.source_versions WHERE id=$1', [source.active_version]) : null;
        if (!version || version.content_hash !== prepared.hash || fingerprint(version.content) !== fingerprint(prepared.content)) {
          const revision = version ? version.revision + 1 : 1;
          const versionId = randomUUID();
          version = await one(sql, 'INSERT INTO knowledge.source_versions(id,source_id,revision,content_hash,content,original_path) VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING *', [versionId, source.id, revision, prepared.hash, json(prepared.content), prepared.path]);
          if (source.active_version) await this.retireVersion(sql, source.active_version);
          source = await one(sql, 'UPDATE knowledge.sources SET active_version=$2,title=$3,revision=revision+1 WHERE id=$1 RETURNING *', [source.id, versionId, title]);
          retained = true;
        }
        const receipt = { source, version };
        await sql.query('INSERT INTO knowledge.operations(id,fingerprint,result) VALUES($1,$2,$3::jsonb)', [operationId, hash, json(receipt)]);
        return receipt;
      });
      committed = true;
      return result;
    } finally { if (!retained || !committed) await prepared.discard(); }
  }
  private async retireVersion(sql: Sql, versionId: string) {
    const rows = (await sql.query("SELECT a.id,a.object_id,a.revision FROM knowledge.assertions a JOIN knowledge.assertion_revisions r ON r.assertion_id=a.id AND r.system_to IS NULL WHERE a.source_version_id=$1 AND r.status IN ('accepted','pending')", [versionId])).rows;
    for (const row of rows) await this.revise(sql, row.id, row.revision, { status: 'superseded', reason: '来源已有新版本；未推断业务结束时间' });
  }
  private async resolveObject(sql: Sql, raw: Claim['subject']) {
    const identity = identitySchema.parse(raw);
    const found = (await sql.query('SELECT object_id FROM knowledge.identifiers WHERE type_id=$1 AND namespace=$2 AND value=$3', [identity.typeId, identity.namespace, identity.value])).rows[0];
    if (found) return found.object_id as string;
    const id = randomUUID();
    await sql.query('INSERT INTO knowledge.objects(id,type_id) VALUES($1,$2)', [id, identity.typeId]);
    await sql.query('INSERT INTO knowledge.identifiers(type_id,namespace,value,object_id) VALUES($1,$2,$3,$4)', [identity.typeId, identity.namespace, identity.value, id]);
    await sql.query('INSERT INTO knowledge.identity_bindings(id,type_id,namespace,value,object_id) VALUES($1,$2,$3,$4,$5)', [randomUUID(), identity.typeId, identity.namespace, identity.value, id]);
    return id;
  }
  async commitExtraction(actor: Principal, input: { operationId: string; ontologyId: string; sourceVersionId: string; configuration: unknown; output: unknown; buildPlanId?: string; job?: { id: string; leaseToken: string } }) {
    authorize(actor, true);
    const output = extractionSchema.parse(input.output);
    for (const claim of output.claims) strictComparisonSchema.parse(claim.comparison);
    const hash = fingerprint({ actor: input.buildPlanId ? null : actor.id, ontologyId: input.ontologyId, sourceVersionId: input.sourceVersionId, configuration: input.configuration, ...(input.buildPlanId ? { buildPlanId: input.buildPlanId } : {}) });
    return this.db.transaction(async sql => {
      await checkJob(sql, input.job);
      const previous = (await sql.query('SELECT * FROM knowledge.extraction_runs WHERE operation_id=$1', [input.operationId])).rows[0];
      if (previous) {
        if (previous.fingerprint !== hash) throw new Error('抽取 operationId 输入不一致');
        if (input.buildPlanId) {
          const current = await sql.query('SELECT h.run_id FROM knowledge.source_build_heads h JOIN knowledge.sources s ON s.id=h.source_id AND s.active_version=h.source_version_id WHERE h.source_version_id=$1 AND h.run_id=$2', [input.sourceVersionId, previous.id]);
          if (!current.rows.length) throw new Error('该计划结果已有后续构建或来源更新，请新建计划');
        }
        return previous.result;
      }
      const ontology = await one(sql, "SELECT * FROM knowledge.ontologies WHERE id=$1 AND status='published'", [uuid(input.ontologyId)]);
      const definition = ontologySchema.parse(ontology.definition);
      const source = await one(sql, 'SELECT v.*,COALESCE(s.observed_version,s.active_version) AS active_version,s.active_version AS adopted_version FROM knowledge.source_versions v JOIN knowledge.sources s ON s.id=v.source_id WHERE v.id=$1', [uuid(input.sourceVersionId)]);
      if (source.active_version !== source.id) throw new Error('来源已变化，请基于新版本抽取');
      source.content = await sourceContent(sql, source.id, source.content);
      let approvedNamespaces: string[] = [];
      let identityMappings: IdentityMapping[] = [];
      if (input.buildPlanId) {
        const approved = await one(sql, "SELECT p.ontology_id,p.ontology_hash,p.approved_at,o.output_hash,o.namespaces,o.identity_mappings FROM knowledge.build_plans p JOIN knowledge.approved_plan_outputs o ON o.plan_id=p.id WHERE p.id=$1 AND p.status='approved' AND o.source_version_id=$2", [uuid(input.buildPlanId), source.id]);
        if (approved.ontology_id !== ontology.id || approved.ontology_hash !== fingerprint(definition) || approved.output_hash !== fingerprint(output)) throw new Error('构建内容与已批准计划不一致');
        const newer = await sql.query('SELECT run_id FROM knowledge.source_build_heads WHERE source_id=$1 AND installed_at>$2 AND build_plan_id IS DISTINCT FROM $3::uuid', [source.source_id, approved.approved_at, input.buildPlanId]);
        if (newer.rows.length) throw new Error('该批准之后已有后续构建，请重新生成并审核计划');
        approvedNamespaces = approved.namespaces;
        identityMappings = approved.identity_mappings;
        if (output.claims.length && !identityMappings.length) throw new Error('旧计划缺少来源身份审核快照，请重新生成并批准计划');
        for (const mapping of identityMappings) {
          const current = (await sql.query('SELECT id,object_id FROM knowledge.identity_bindings WHERE type_id=$1 AND namespace=$2 AND value=$3 AND system_to IS NULL', [mapping.source.typeId, mapping.source.namespace, mapping.source.value])).rows[0];
          if ((current?.id ?? null) !== mapping.bindingId || (current?.object_id ?? null) !== mapping.objectId) throw new Error('来源身份绑定已变化，请重新预检并批准新计划');
          if (mapping.source.namespace !== `source.${source.source_id}` || mapping.source.typeId !== mapping.target.typeId || mapping.source.value !== mapping.target.value) throw new Error('批准的来源身份映射无效');
          if (mapping.targetBindingId === undefined) throw new Error('旧计划缺少目标身份快照，请重新生成计划');
          const target = (await sql.query('SELECT id,object_id,approval_plan_id FROM knowledge.identity_bindings WHERE type_id=$1 AND namespace=$2 AND value=$3 AND system_to IS NULL', [mapping.target.typeId, mapping.target.namespace, mapping.target.value])).rows[0];
          const createdByThisPlan = mapping.targetBindingId === null && target?.approval_plan_id === input.buildPlanId;
          if (!createdByThisPlan && ((target?.id ?? null) !== mapping.targetBindingId || (target?.object_id ?? null) !== mapping.targetObjectId)) throw new Error('目标身份在批准后已变化，请重新审核计划');
          if (mapping.adopt) {
            const anchor = (await sql.query('SELECT id,object_id FROM knowledge.identity_bindings WHERE type_id=$1 AND namespace=$2 AND value=$3 AND system_to IS NULL', [mapping.adopt.identity.typeId, mapping.adopt.identity.namespace, mapping.adopt.identity.value])).rows[0];
            if (mapping.adopt.identity.typeId !== mapping.target.typeId || mapping.adopt.identity.value !== mapping.target.value || !mapping.adopt.identity.namespace.startsWith('source.') || anchor?.id !== mapping.adopt.bindingId || anchor?.object_id !== mapping.adopt.objectId) throw new Error('已批准的现有对象依据已变化，请重新预检并批准');
            if (target && target.object_id !== mapping.adopt.objectId) throw new Error('目标身份已绑定其他对象，请先身份纠错');
          }
          if (current && current.object_id !== (target?.object_id ?? mapping.adopt?.objectId)) throw new Error('来源标识已绑定其他对象，请先进行身份纠错');
        }
      }
      if (!input.buildPlanId) for (const claim of output.claims) for (const identity of [claim.subject, ...(claim.object ? [claim.object] : [])]) {
        const shared = await sql.query('SELECT id FROM knowledge.identity_bindings WHERE type_id=$1 AND namespace=$2 AND value=$3 AND system_to IS NULL AND approval_plan_id IS NOT NULL', [identity.typeId, identity.namespace, identity.value]);
        if (shared.rows.length) throw new Error('已有跨源绑定的标识需通过构建计划重新审核延续，不能直接抽取');
      }
      // Validate entire batch before any object or assertion is written.
      const validated = output.claims.map(claim => {
        validateClaim(definition, claim);
        for (const identity of [claim.subject, ...(claim.object ? [claim.object] : [])]) {
          if (!input.buildPlanId && identity.namespace !== `source.${source.source_id}`) throw new Error('直接抽取仅允许来源内身份；跨源或共享身份必须通过构建计划审核');
          if (input.buildPlanId && !identityMappings.some(m => fingerprint(m.target) === fingerprint(identity))) throw new Error('声明身份没有对应的批准来源映射');
          const allowed = definition.types.find(t => t.id === identity.typeId)!.identityNamespaces;
          if (!allowed.includes(identity.namespace) && identity.namespace !== `source.${source.source_id}` && !approvedNamespaces.includes(identity.namespace)) throw new Error('身份命名空间未获本体批准');
          if (identity.namespace !== `source.${source.source_id}` && !claim.evidence.some(ref => ref.kind === 'field'
            ? String((source.content as SourceContent).rows?.find(r => r[(source.content as SourceContent).keyColumn!] === ref.recordKey)?.[ref.field]) === identity.value
            : ref.quote.includes(identity.value))) throw new Error('可信身份值缺少来源证据');
        }
        if (['name', 'label', '姓名', '名称'].includes(claim.subject.namespace.toLowerCase()) || claim.object && ['name', 'label', '姓名', '名称'].includes(claim.object.namespace.toLowerCase())) throw new Error('名称不能作为自动合并的可信身份；请使用来源限定标识');
        return { claim, locators: claim.evidence.map(ref => locateEvidence(source.content as SourceContent, ref)) };
      });
      const runId = randomUUID();
      if (input.buildPlanId) {
        if (source.adopted_version && source.adopted_version !== source.id) await this.retireVersion(sql, source.adopted_version);
        await this.retireVersion(sql, source.id);
      }
      await sql.query("INSERT INTO knowledge.extraction_runs(id,operation_id,fingerprint,ontology_id,source_version_id,configuration,status,build_plan_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,'running',$7)", [runId, input.operationId, hash, ontology.id, source.id, json(input.configuration), input.buildPlanId ?? null]);
      // Materialize the approved target and its source alias together in this source transaction.
      for (const mapping of identityMappings) {
        if (mapping.adopt) {
          const existingTarget = (await sql.query('SELECT object_id FROM knowledge.identifiers WHERE type_id=$1 AND namespace=$2 AND value=$3', [mapping.target.typeId, mapping.target.namespace, mapping.target.value])).rows[0];
          if (existingTarget && existingTarget.object_id !== mapping.adopt.objectId) throw new Error('目标身份已有其他对象，请重新预检');
          if (!existingTarget) {
            await sql.query('INSERT INTO knowledge.identifiers(type_id,namespace,value,object_id) VALUES($1,$2,$3,$4)', [mapping.target.typeId, mapping.target.namespace, mapping.target.value, mapping.adopt.objectId]);
            await sql.query('INSERT INTO knowledge.identity_bindings(id,type_id,namespace,value,object_id,approval_plan_id) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), mapping.target.typeId, mapping.target.namespace, mapping.target.value, mapping.adopt.objectId, input.buildPlanId]);
          }
        }
        const objectId = await this.resolveObject(sql, mapping.target);
        if (mapping.targetBindingId === null && mapping.source.namespace !== mapping.target.namespace) await sql.query('UPDATE knowledge.identity_bindings SET approval_plan_id=$4 WHERE type_id=$1 AND namespace=$2 AND value=$3 AND system_to IS NULL AND approval_plan_id IS NULL', [mapping.target.typeId, mapping.target.namespace, mapping.target.value, input.buildPlanId]);
        if (fingerprint(mapping.source) !== fingerprint(mapping.target)) {
          const existing = (await sql.query('SELECT object_id FROM knowledge.identifiers WHERE type_id=$1 AND namespace=$2 AND value=$3', [mapping.source.typeId, mapping.source.namespace, mapping.source.value])).rows[0];
          if (existing && existing.object_id !== objectId) throw new Error('来源标识冲突，请先进行身份纠错');
          if (!existing) {
            await sql.query('INSERT INTO knowledge.identifiers(type_id,namespace,value,object_id) VALUES($1,$2,$3,$4)', [mapping.source.typeId, mapping.source.namespace, mapping.source.value, objectId]);
            await sql.query('INSERT INTO knowledge.identity_bindings(id,type_id,namespace,value,object_id,approval_plan_id) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), mapping.source.typeId, mapping.source.namespace, mapping.source.value, objectId, input.buildPlanId]);
          }
        }
      }
      const ids: string[] = [], touched = new Set<string>();
      for (const { claim, locators } of validated) {
        const objectId = await this.resolveObject(sql, claim.subject);
        const target = claim.object ? await this.resolveObject(sql, claim.object) : null;
        if (target) touched.add(target);
        const dedup = fingerprint({ ontology: ontology.id, version: source.id, config: input.configuration, claim });
        const prior = (await sql.query('SELECT id FROM knowledge.assertions WHERE dedup_key=$1', [dedup])).rows[0];
        if (prior) { ids.push(prior.id); continue; }
        const id = randomUUID();
        await sql.query("INSERT INTO knowledge.assertions(id,object_id,predicate,ontology_id,source_version_id,run_id,origin,dedup_key) VALUES($1,$2,$3,$4,$5,$6,'source',$7)", [id, objectId, claim.predicate, ontology.id, source.id, runId, dedup]);
        await sql.query("INSERT INTO knowledge.assertion_revisions(assertion_id,revision,value,target_id,valid_from,valid_to,time_precision,status,basis,semantics,comparison) VALUES($1,1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)", [id, claim.object ? null : json(claim.value), target, claim.validity.from, claim.validity.to, claim.validity.precision, requiresReview(claim.basis, claim.semantics) ? 'pending' : 'accepted', claim.basis, json(claim.semantics), json(claim.comparison)]);
        for (const locator of locators) {
          const evidenceId = randomUUID();
          await sql.query('INSERT INTO knowledge.evidence(id,source_version_id,locator) VALUES($1,$2,$3::jsonb)', [evidenceId, source.id, json(locator)]);
          await sql.query('INSERT INTO knowledge.assertion_evidence(assertion_id,evidence_id) VALUES($1,$2)', [id, evidenceId]);
        }
        ids.push(id); touched.add(objectId);
      }
      for (const id of touched) { await sql.query('UPDATE knowledge.objects SET revision=revision+1 WHERE id=$1', [id]); await sql.query('DELETE FROM knowledge.projections WHERE object_id=$1', [id]); }
      if (source.content.kind === 'table') await sql.query('UPDATE knowledge.sources SET active_version=$2 WHERE id=$1', [source.source_id, source.id]);
      const result = { runId, assertionIds: ids, objects: [...touched], count: ids.length };
      await sql.query("UPDATE knowledge.extraction_runs SET status='completed',result=$2::jsonb WHERE id=$1", [runId, json(result)]);
      await sql.query('INSERT INTO knowledge.source_build_heads(source_id,source_version_id,run_id,build_plan_id) VALUES($1,$2,$3,$4) ON CONFLICT(source_id) DO UPDATE SET source_version_id=EXCLUDED.source_version_id,run_id=EXCLUDED.run_id,build_plan_id=EXCLUDED.build_plan_id,installed_at=clock_timestamp()', [source.source_id, source.id, runId, input.buildPlanId ?? null]);
      if (!input.buildPlanId) await finishJob(sql, input.job, result);
      return result;
    });
  }
  private async revise(sql: Sql, assertionId: string, expected: number, changes: Record<string, unknown>, systemAt?: string) {
    const a = await one(sql, 'SELECT * FROM knowledge.assertions WHERE id=$1 AND revision=$2', [assertionId, expected]);
    const old = await one(sql, 'SELECT * FROM knowledge.assertion_revisions WHERE assertion_id=$1 AND system_to IS NULL', [a.id]);
    const stamp = systemAt ?? (await one(sql, "SELECT GREATEST(clock_timestamp(),system_from+interval '1 microsecond')::text AS stamp FROM knowledge.assertion_revisions WHERE assertion_id=$1 AND system_to IS NULL", [a.id])).stamp;
    await sql.query('UPDATE knowledge.assertion_revisions SET system_to=$2 WHERE assertion_id=$1 AND system_to IS NULL', [a.id, stamp]);
    const next = { ...old, ...changes };
    await sql.query('INSERT INTO knowledge.assertion_revisions(assertion_id,revision,value,target_id,valid_from,valid_to,time_precision,system_from,status,basis,override_mode,override_source_version,reason,semantics,comparison) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb)', [a.id, expected + 1, next.target_id ? null : json(next.value), next.target_id, next.valid_from, next.valid_to, next.time_precision, stamp, next.status, next.basis, next.override_mode, next.override_source_version, next.reason, json(next.semantics), json(next.comparison)]);
    // Preserve earlier revision bases without exposing future additions to old revisions.
    await sql.query('INSERT INTO knowledge.assertion_revision_evidence(assertion_id,revision,evidence_id) SELECT assertion_id,$2,evidence_id FROM knowledge.assertion_revision_evidence WHERE assertion_id=$1 AND revision=$3', [a.id, expected + 1, expected]);
    await sql.query('UPDATE knowledge.assertions SET revision=revision+1 WHERE id=$1', [a.id]);
    await sql.query('UPDATE knowledge.objects SET revision=revision+1 WHERE id=$1', [a.object_id]);
    await sql.query('DELETE FROM knowledge.projections WHERE object_id=$1', [a.object_id]);
    for (const target of new Set([old.target_id, next.target_id].filter(Boolean))) {
      await sql.query('UPDATE knowledge.objects SET revision=revision+1 WHERE id=$1', [target]);
      await sql.query('DELETE FROM knowledge.projections WHERE object_id=$1', [target]);
    }
    return { assertionId: a.id, revision: expected + 1, objectId: a.object_id };
  }
  async act(actor: Principal, raw: unknown) {
    authorize(actor, true); const input = actionSchema.parse(raw);
    if (input.comparison) strictComparisonSchema.parse(input.comparison);
    if (input.kind === 'PublishOntologyVersion' && actor.role !== 'admin') throw new AccessDenied('只有管理员可以发布本体');
    if (input.kind === 'RematchIdentity' && actor.role !== 'admin') throw new AccessDenied('只有管理员可以纠正身份绑定');
    const hash = fingerprint({ actor: actor.id, input });
    return this.db.transaction(async sql => {
      const prior = (await sql.query('SELECT * FROM knowledge.action_events WHERE operation_id=$1', [input.operationId])).rows[0];
      if (prior) { if (prior.fingerprint !== hash) throw new Error('Action operationId 已用于其他输入'); return prior.result; }
      const result = await this.applyAction(sql, input);
      await sql.query('INSERT INTO knowledge.action_events(operation_id,fingerprint,actor_id,kind,target_id,payload,result) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)', [input.operationId, hash, actor.id, input.kind, input.targetId, json(input), json(result)]);
      return result;
    });
  }
  private async applyAction(sql: Sql, input: Action): Promise<Record<string, unknown>> {
    if (input.kind === 'RematchIdentity') return rematchIdentity(sql, input, (sql, id, revision, changes, systemAt) => this.revise(sql, id, revision, changes, systemAt));
    if (input.kind === 'PublishOntologyVersion') {
      const draft = await one(sql, "SELECT * FROM knowledge.ontologies WHERE id=$1 AND revision=$2 AND status='draft'", [input.targetId, input.expectedRevision]);
      const definition = ontologySchema.parse(draft.definition);
      for (const t of definition.types) for (const p of t.properties) if (p.comparison) strictComparisonSchema.parse(p.comparison);
      if (draft.discovery?.jobId) {
        const validation = draft.discovery.validation ? refreshDiscoveryValidation(definition, draft.discovery.validation) : null;
        if (!validation) throw new Error('旧自动候选缺少证据及语义审核契约，请重新生成');
        const review = draft.discovery.review;
        if (validation.issues.length && (!review || review.definitionHash !== fingerprint(definition) || validation.issues.some((i: { id: string }) => !review.issueIds.includes(i.id)))) throw new Error('尚未保存当前重大本体事件的决定：请在“重大本体事件”查看定义摘要，填写决定理由并确认保存，再发布草稿');
        draft.discovery = { ...draft.discovery, validation };
        const refs = definition.discoveryEvidence;
        for (const ref of refs) {
          const source = await one(sql, 'SELECT id,content FROM knowledge.source_versions WHERE id=$1', [ref.sourceVersionId]);
          locateEvidence(await sourceContent(sql, source.id, source.content, undefined, ref.locator.kind === 'field' ? [ref.locator.recordKey] : undefined), ref.locator);
        }
        const base = draft.discovery.baseOntologyId ? (await sql.query('SELECT definition FROM knowledge.ontologies WHERE id=$1', [draft.discovery.baseOntologyId])).rows[0] : null;
        const oldMembers = base ? [...base.definition.types, ...base.definition.types.flatMap((t: Ontology['types'][number]) => t.properties), ...base.definition.links] : [];
        for (const member of [...definition.types, ...definition.types.flatMap(t => t.properties), ...definition.links]) if (!refs.some(e => e.memberId === member.id) && !oldMembers.some(m => m.id === member.id && fingerprint(m) === fingerprint(member))) throw new Error(`成员缺少依据：${member.id}`);
      }
      if (!definition.actions.includes(input.kind)) throw new Error('本体未启用发布操作');
      const metadata = draft.discovery?.validation ? { ...draft.discovery, validation: { ...draft.discovery.validation, evidenceValid: true, semanticVerified: false, semanticReviewStatus: draft.discovery.validation.issues.length ? 'human_decided_major_events' : 'automatic_checks_passed' } } : draft.discovery;
      return one(sql, "UPDATE knowledge.ontologies SET status='published',discovery=$2::jsonb,published_at=clock_timestamp(),revision=revision+1 WHERE id=$1 RETURNING *", [draft.id, json(metadata)]);
    }
    if (input.kind === 'CorrectProperty') {
      const object = (await sql.query('SELECT * FROM knowledge.objects WHERE id=$1', [input.targetId])).rows[0];
      if (!object) throw new Error('属性纠正需要对象 ID，不能使用声明 ID；请重新查看对象并点击“纠正此属性”');
      if (object.revision !== input.expectedRevision) throw new Error('对象修订号已变化，请重新查看对象后再提交属性纠正');
      if (input.value === undefined || !input.predicate || !input.validity || input.validity.precision === 'unknown' || !(input.validity.from || input.validity.to) || !input.duration) throw new Error('纠正需要属性、值、已知有效范围及明确持续方式');
      const model = await one(sql, "SELECT * FROM knowledge.ontologies WHERE status='published' ORDER BY published_at DESC LIMIT 1");
      const definition = ontologySchema.parse(model.definition);
      if (!definition.actions.includes(input.kind)) throw new Error('本体未启用此 Action');
      const property = definition.types.find(t => t.id === object.type_id)?.properties.find(p => p.id === input.predicate);
      if (!property || property.multiple) throw new Error('第一阶段属性纠正只支持当前本体的单值属性');
      validateValue(property, input.value);
      if (input.duration === 'source_version') {
        if (!input.sourceVersionId) throw new Error('需指定所覆盖的来源版本');
        await one(sql, 'SELECT a.id FROM knowledge.assertions a JOIN knowledge.source_versions v ON v.id=a.source_version_id JOIN knowledge.sources s ON s.active_version=v.id WHERE a.object_id=$1 AND a.predicate=$2 AND v.id=$3 LIMIT 1', [object.id, input.predicate, input.sourceVersionId]);
      }
      const comparison = input.comparison ?? {};
      if (property.comparison && Object.entries(property.comparison).some(([key, value]) => comparison[key as keyof typeof comparison] !== value)) throw new Error('人工修正需明确本体要求的单位、币种和口径');
      const id = randomUUID();
      await sql.query("INSERT INTO knowledge.assertions(id,object_id,predicate,ontology_id,origin) VALUES($1,$2,$3,$4,'human')", [id, object.id, input.predicate, model.id]);
      await sql.query("INSERT INTO knowledge.assertion_revisions(assertion_id,revision,value,valid_from,valid_to,time_precision,status,basis,override_mode,override_source_version,reason,comparison) VALUES($1,1,$2::jsonb,$3,$4,$5,'accepted','human',$6,$7,$8,$9::jsonb)", [id, json(input.value), input.validity.from, input.validity.to, input.validity.precision, input.duration, input.sourceVersionId ?? null, input.reason, json(comparison)]);
      await this.attachRevisionEvidence(sql, id, 1, input.evidence);
      await sql.query('UPDATE knowledge.objects SET revision=revision+1 WHERE id=$1', [object.id]);
      await sql.query('DELETE FROM knowledge.projections WHERE object_id=$1', [object.id]);
      return { assertionId: id, objectId: object.id, revision: object.revision + 1 };
    }
    const a = await one(sql, 'SELECT a.*,o.definition FROM knowledge.assertions a JOIN knowledge.ontologies o ON o.id=a.ontology_id WHERE a.id=$1', [input.targetId]);
    if (!ontologySchema.parse(a.definition).actions.includes(input.kind)) throw new Error('本体未启用此 Action');
    if (input.kind === 'CorrectValidity') {
      if (!input.validity) throw new Error('需指定修正的有效时间');
      const result = await this.revise(sql, input.targetId, input.expectedRevision, { valid_from: input.validity.from, valid_to: input.validity.to, time_precision: input.validity.precision, reason: input.reason });
      await this.attachRevisionEvidence(sql, input.targetId, result.revision, input.evidence);
      return result;
    }
    return this.revise(sql, input.targetId, input.expectedRevision, { status: 'rejected', reason: input.reason });
  }
  async object(actor: Principal, id: string, options: { validAt?: string; knownAt?: string } = {}) {
    authorize(actor); uuid(id);
    const validAt = options.validAt ? z.string().datetime({ offset: true }).parse(options.validAt) : new Date().toISOString();
    const knownAt = options.knownAt ? z.string().datetime({ offset: true }).parse(options.knownAt) : null;
    // Transaction provides a coherent view of statements and writes cache/dependencies atomically.
    return this.db.transaction(async sql => {
      const object = await one(sql, 'SELECT * FROM knowledge.objects WHERE id=$1', [id]);
      if (knownAt && new Date(object.created_at).getTime() > Date.parse(knownAt)) throw new Error('该系统时点尚无此对象');
      const rows = (await sql.query(`SELECT a.id,a.predicate,a.origin,a.source_version_id,a.ontology_id,v.source_id,r.*
        FROM knowledge.assertions a JOIN knowledge.assertion_revisions r ON r.assertion_id=a.id
        LEFT JOIN knowledge.source_versions v ON v.id=a.source_version_id
        WHERE a.object_id=$1 AND ($2::timestamptz IS NULL AND r.system_to IS NULL OR $2::timestamptz IS NOT NULL AND r.system_from<=$2 AND (r.system_to IS NULL OR r.system_to>$2))
        ORDER BY a.id,r.revision`, [id, knownAt])).rows;
      const model = (await sql.query("SELECT * FROM knowledge.ontologies WHERE status='published' AND ($1::timestamptz IS NULL OR published_at<=$1) ORDER BY published_at DESC LIMIT 1", [knownAt])).rows[0];
      if (!model) throw new Error('查询时点没有已发布本体');
      const currentDefinition = ontologySchema.parse(model.definition);
      const currentType = currentDefinition.types.find(t => t.id === object.type_id);
      const priorIds = [...new Set(rows.filter(r => ['accepted','pending'].includes(r.status) && r.ontology_id !== model.id).map(r => r.ontology_id))];
      for (const priorId of priorIds) {
        const prior = await one(sql, 'SELECT definition FROM knowledge.ontologies WHERE id=$1', [priorId]);
        const priorDefinition = ontologySchema.parse(prior.definition), priorType = priorDefinition.types.find(t => t.id === object.type_id);
        const header = (t: NonNullable<typeof priorType>) => ({ id:t.id,name:t.name,description:t.description,identityNamespaces:t.identityNamespaces });
        const compatible = priorType && currentType && fingerprint(header(priorType)) === fingerprint(header(currentType)) &&
          priorType.properties.every(p => currentType.properties.some(n => n.id === p.id && fingerprint(p) === fingerprint(n))) &&
          currentType.properties.filter(p => !priorType.properties.some(n => n.id === p.id)).every(p => !p.required) &&
          priorDefinition.links.filter(l => l.from === object.type_id || l.to === object.type_id).every(l => currentDefinition.links.some(n => n.id === l.id && fingerprint(l) === fingerprint(n)));
        if (!compatible) throw new Error('最新本体与当前对象声明不兼容，知识迁移尚未完成；查询暂未就绪，请查看发布与构建回执');
      }
      const view = projectStatements(object.type_id, currentDefinition, rows as Statement[], validAt);
      const identifiers = (await sql.query('SELECT namespace,value FROM knowledge.identity_bindings WHERE object_id=$1 AND ($2::timestamptz IS NULL AND system_to IS NULL OR $2::timestamptz IS NOT NULL AND system_from<=$2 AND (system_to IS NULL OR system_to>$2))', [id, knownAt])).rows;
      const incoming = (await sql.query(`SELECT a.id,a.object_id,a.predicate,a.ontology_id,r.revision,r.status,r.valid_from,r.valid_to,r.time_precision FROM knowledge.assertions a JOIN knowledge.assertion_revisions r ON r.assertion_id=a.id
        WHERE r.target_id=$1 AND ($2::timestamptz IS NULL AND r.system_to IS NULL OR $2::timestamptz IS NOT NULL AND r.system_from<=$2 AND (r.system_to IS NULL OR r.system_to>$2)) ORDER BY a.id`, [id, knownAt])).rows;
      const result = { id, revision: knownAt ? null : object.revision, identifiers, knownAt, ontologyId: model.id, ...view, assertions: rows, incoming, humanBasis: rows.filter(r => r.origin === 'human').map(r => ({ assertionId: r.id, reason: r.reason, kind: 'human_judgment' })) };
      if (!knownAt) {
        await sql.query('INSERT INTO knowledge.projections(object_id,object_revision,body,fusion_policy_version) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(object_id) DO UPDATE SET object_revision=excluded.object_revision,body=excluded.body,fusion_policy_version=excluded.fusion_policy_version,computed_at=clock_timestamp()', [id, object.revision, json(result), FUSION_POLICY]);
        await sql.query('DELETE FROM knowledge.projection_dependencies WHERE object_id=$1', [id]);
        for (const row of rows) await sql.query('INSERT INTO knowledge.projection_dependencies(object_id,assertion_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, row.id]);
      }
      return result;
    });
  }
  private async attachRevisionEvidence(sql: Sql, assertionId: string, revision: number, refs: Action['evidence']) {
    for (const ref of refs ?? []) {
      const source = await one(sql, 'SELECT id,content FROM knowledge.source_versions WHERE id=$1', [ref.sourceVersionId]);
      const locator = locateEvidence(await sourceContent(sql, source.id, source.content, undefined, ref.locator.kind === 'field' ? [ref.locator.recordKey] : undefined), ref.locator);
      const id = randomUUID();
      await sql.query('INSERT INTO knowledge.evidence(id,source_version_id,locator) VALUES($1,$2,$3::jsonb)', [id, ref.sourceVersionId, json(locator)]);
      await sql.query('INSERT INTO knowledge.assertion_revision_evidence(assertion_id,revision,evidence_id) VALUES($1,$2,$3)', [assertionId, revision, id]);
    }
  }
  async evidence(actor: Principal, assertionId: string, revision?: number): Promise<Array<Record<string, unknown> & { source_version_id: string; locator: ReturnType<typeof locateEvidence> }>> {
    authorize(actor);
    const a = await one(this.db.pool, 'SELECT revision FROM knowledge.assertions WHERE id=$1', [uuid(assertionId)]);
    const selected = revision === undefined ? a.revision : z.number().int().positive().parse(revision);
    await one(this.db.pool, 'SELECT revision FROM knowledge.assertion_revisions WHERE assertion_id=$1 AND revision=$2', [assertionId, selected]);
    const evidenceRows = (await this.db.pool.query(`SELECT e.id,e.locator,v.id AS source_version_id,v.source_id,v.revision,v.content_hash,v.content,ae.role FROM (
      SELECT evidence_id,'source_evidence' AS role FROM knowledge.assertion_evidence WHERE assertion_id=$1
      UNION ALL SELECT evidence_id,'revision_basis' AS role FROM knowledge.assertion_revision_evidence WHERE assertion_id=$1 AND revision=$2
    ) ae JOIN knowledge.evidence e ON e.id=ae.evidence_id JOIN knowledge.source_versions v ON v.id=e.source_version_id`, [assertionId, selected])).rows;
    return Promise.all(evidenceRows.map(async row => {
      const locator = locateEvidence(await sourceContent(this.db.pool, row.source_version_id, row.content, undefined, row.locator.kind === 'field' ? [row.locator.recordKey] : undefined), row.locator);
      const { content, ...safe } = row;
      return { ...safe, source_version_id: String(row.source_version_id), locator };
    }));
  }
  async events(actor: Principal) {
    authorize(actor); return (await this.db.pool.query('SELECT * FROM knowledge.action_events ORDER BY created_at DESC LIMIT 100')).rows;
  }
  async jobAttempts(actor: Principal, id: string) {
    authorize(actor);
    return (await this.db.pool.query('SELECT attempt,outcome,metrics FROM knowledge.job_attempts WHERE job_id=$1 ORDER BY attempt', [uuid(id)])).rows;
  }
}

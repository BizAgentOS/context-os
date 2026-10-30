import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Database, type Sql } from './database.ts';
import { AccessDenied, actionSchema, authorize, extractionSchema, identitySchema, ontologySchema, validateValue, type Action, type Claim, type Ontology, type Principal } from './contracts.ts';
import { fingerprint, locateEvidence, validateClaim, type PreparedSource, type SourceContent } from './sources.ts';
import { projectStatements, type Statement } from './projection.ts';

const json = (v: unknown) => JSON.stringify(v);
const uuid = (v: string) => z.string().uuid().parse(v);
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
    if (kind === 'sources') return (await this.db.pool.query('SELECT s.*,v.revision AS active_revision FROM knowledge.sources s LEFT JOIN knowledge.source_versions v ON v.id=s.active_version ORDER BY s.title,s.id LIMIT $1 OFFSET $2', [take, skip])).rows;
    const order = 'created_at DESC,id';
    // Table names are a closed enumeration, never request SQL.
    return (await this.db.pool.query(`SELECT * FROM knowledge.${kind} ORDER BY ${order} LIMIT $1 OFFSET $2`, [take, skip])).rows;
  }
  async sourceVersion(actor: Principal, id: string) {
    authorize(actor); return one(this.db.pool, 'SELECT * FROM knowledge.source_versions WHERE id=$1', [uuid(id)]);
  }
  async ontology(actor: Principal, id: string, published = false) {
    authorize(actor);
    const row = await one(this.db.pool, 'SELECT * FROM knowledge.ontologies WHERE id=$1', [uuid(id)]);
    if (published && row.status !== 'published') throw new Error('需使用已发布本体版本');
    return { ...row, definition: ontologySchema.parse(row.definition) };
  }
  async draft(actor: Principal, input: unknown, existing?: { id: string; expectedRevision: number }, job?: { id: string; leaseToken: string }) {
    authorize(actor, true); const definition = ontologySchema.parse(input);
    return this.db.transaction(async sql => {
      await checkJob(sql, job);
      if (!existing) {
        const id = randomUUID();
        const result = await one(sql, 'INSERT INTO knowledge.ontologies(id,status,definition) VALUES($1,\'draft\',$2::jsonb) RETURNING *', [id, json(definition)]);
        await finishJob(sql, job, result);
        return result;
      }
      return one(sql, "UPDATE knowledge.ontologies SET definition=$3::jsonb,revision=revision+1 WHERE id=$1 AND revision=$2 AND status='draft' RETURNING *", [uuid(existing.id), existing.expectedRevision, json(definition)]);
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
    return id;
  }
  async commitExtraction(actor: Principal, input: { operationId: string; ontologyId: string; sourceVersionId: string; configuration: unknown; output: unknown; job?: { id: string; leaseToken: string } }) {
    authorize(actor, true);
    const output = extractionSchema.parse(input.output);
    const hash = fingerprint({ actor: actor.id, ontologyId: input.ontologyId, sourceVersionId: input.sourceVersionId, configuration: input.configuration });
    return this.db.transaction(async sql => {
      await checkJob(sql, input.job);
      const previous = (await sql.query('SELECT * FROM knowledge.extraction_runs WHERE operation_id=$1', [input.operationId])).rows[0];
      if (previous) { if (previous.fingerprint !== hash) throw new Error('抽取 operationId 输入不一致'); return previous.result; }
      const ontology = await one(sql, "SELECT * FROM knowledge.ontologies WHERE id=$1 AND status='published'", [uuid(input.ontologyId)]);
      const definition = ontologySchema.parse(ontology.definition);
      const source = await one(sql, 'SELECT v.*,s.active_version FROM knowledge.source_versions v JOIN knowledge.sources s ON s.id=v.source_id WHERE v.id=$1', [uuid(input.sourceVersionId)]);
      if (source.active_version !== source.id) throw new Error('来源已变化，请基于新版本抽取');
      // Validate entire batch before any object or assertion is written.
      const validated = output.claims.map(claim => {
        validateClaim(definition, claim);
        for (const identity of [claim.subject, ...(claim.object ? [claim.object] : [])]) {
          const allowed = definition.types.find(t => t.id === identity.typeId)!.identityNamespaces;
          if (!allowed.includes(identity.namespace) && identity.namespace !== `source.${source.source_id}`) throw new Error('身份命名空间未获本体批准');
          if (identity.namespace !== `source.${source.source_id}` && !claim.evidence.some(ref => ref.kind === 'field'
            ? String((source.content as SourceContent).rows?.find(r => r[(source.content as SourceContent).keyColumn!] === ref.recordKey)?.[ref.field]) === identity.value
            : ref.quote.includes(identity.value))) throw new Error('可信身份值缺少来源证据');
        }
        if (['name', 'label', '姓名', '名称'].includes(claim.subject.namespace.toLowerCase()) || claim.object && ['name', 'label', '姓名', '名称'].includes(claim.object.namespace.toLowerCase())) throw new Error('名称不能作为自动合并的可信身份；请使用来源限定标识');
        return { claim, locators: claim.evidence.map(ref => locateEvidence(source.content as SourceContent, ref)) };
      });
      const runId = randomUUID();
      await sql.query("INSERT INTO knowledge.extraction_runs(id,operation_id,fingerprint,ontology_id,source_version_id,configuration,status) VALUES($1,$2,$3,$4,$5,$6::jsonb,'running')", [runId, input.operationId, hash, ontology.id, source.id, json(input.configuration)]);
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
        await sql.query("INSERT INTO knowledge.assertion_revisions(assertion_id,revision,value,target_id,valid_from,valid_to,time_precision,status,basis) VALUES($1,1,$2::jsonb,$3,$4,$5,$6,$7,$8)", [id, claim.object ? null : json(claim.value), target, claim.validity.from, claim.validity.to, claim.validity.precision, claim.basis === 'inferred' ? 'pending' : 'accepted', claim.basis]);
        for (const locator of locators) {
          const evidenceId = randomUUID();
          await sql.query('INSERT INTO knowledge.evidence(id,source_version_id,locator) VALUES($1,$2,$3::jsonb)', [evidenceId, source.id, json(locator)]);
          await sql.query('INSERT INTO knowledge.assertion_evidence(assertion_id,evidence_id) VALUES($1,$2)', [id, evidenceId]);
        }
        ids.push(id); touched.add(objectId);
      }
      for (const id of touched) { await sql.query('UPDATE knowledge.objects SET revision=revision+1 WHERE id=$1', [id]); await sql.query('DELETE FROM knowledge.projections WHERE object_id=$1', [id]); }
      const result = { runId, assertionIds: ids, objects: [...touched], count: ids.length };
      await sql.query("UPDATE knowledge.extraction_runs SET status='completed',result=$2::jsonb WHERE id=$1", [runId, json(result)]);
      await finishJob(sql, input.job, result);
      return result;
    });
  }
  private async revise(sql: Sql, assertionId: string, expected: number, changes: Record<string, unknown>) {
    const a = await one(sql, 'SELECT * FROM knowledge.assertions WHERE id=$1 AND revision=$2', [assertionId, expected]);
    const old = await one(sql, 'SELECT * FROM knowledge.assertion_revisions WHERE assertion_id=$1 AND system_to IS NULL', [a.id]);
    const stamp = (await one(sql, "SELECT GREATEST(clock_timestamp(),system_from+interval '1 microsecond')::text AS stamp FROM knowledge.assertion_revisions WHERE assertion_id=$1 AND system_to IS NULL", [a.id])).stamp;
    await sql.query('UPDATE knowledge.assertion_revisions SET system_to=$2 WHERE assertion_id=$1 AND system_to IS NULL', [a.id, stamp]);
    const next = { ...old, ...changes };
    await sql.query('INSERT INTO knowledge.assertion_revisions(assertion_id,revision,value,target_id,valid_from,valid_to,time_precision,system_from,status,basis,override_mode,override_source_version,reason) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [a.id, expected + 1, old.target_id ? null : json(next.value), old.target_id, next.valid_from, next.valid_to, next.time_precision, stamp, next.status, next.basis, next.override_mode, next.override_source_version, next.reason]);
    await sql.query('UPDATE knowledge.assertions SET revision=revision+1 WHERE id=$1', [a.id]);
    await sql.query('UPDATE knowledge.objects SET revision=revision+1 WHERE id=$1', [a.object_id]);
    await sql.query('DELETE FROM knowledge.projections WHERE object_id=$1', [a.object_id]);
    return { assertionId: a.id, revision: expected + 1, objectId: a.object_id };
  }
  async act(actor: Principal, raw: unknown) {
    authorize(actor, true); const input = actionSchema.parse(raw);
    if (input.kind === 'PublishOntologyVersion' && actor.role !== 'admin') throw new AccessDenied('只有管理员可以发布本体');
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
    if (input.kind === 'PublishOntologyVersion') {
      const draft = await one(sql, "SELECT * FROM knowledge.ontologies WHERE id=$1 AND revision=$2 AND status='draft'", [input.targetId, input.expectedRevision]);
      const definition = ontologySchema.parse(draft.definition);
      if (!definition.actions.includes(input.kind)) throw new Error('本体未启用发布操作');
      return one(sql, "UPDATE knowledge.ontologies SET status='published',published_at=clock_timestamp(),revision=revision+1 WHERE id=$1 RETURNING *", [draft.id]);
    }
    if (input.kind === 'CorrectProperty') {
      const object = await one(sql, 'SELECT * FROM knowledge.objects WHERE id=$1 AND revision=$2', [input.targetId, input.expectedRevision]);
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
      const id = randomUUID();
      await sql.query("INSERT INTO knowledge.assertions(id,object_id,predicate,ontology_id,origin) VALUES($1,$2,$3,$4,'human')", [id, object.id, input.predicate, model.id]);
      await sql.query("INSERT INTO knowledge.assertion_revisions(assertion_id,revision,value,valid_from,valid_to,time_precision,status,basis,override_mode,override_source_version,reason) VALUES($1,1,$2::jsonb,$3,$4,$5,'accepted','human',$6,$7,$8)", [id, json(input.value), input.validity.from, input.validity.to, input.validity.precision, input.duration, input.sourceVersionId ?? null, input.reason]);
      await sql.query('UPDATE knowledge.objects SET revision=revision+1 WHERE id=$1', [object.id]);
      await sql.query('DELETE FROM knowledge.projections WHERE object_id=$1', [object.id]);
      return { assertionId: id, objectId: object.id, revision: object.revision + 1 };
    }
    const a = await one(sql, 'SELECT a.*,o.definition FROM knowledge.assertions a JOIN knowledge.ontologies o ON o.id=a.ontology_id WHERE a.id=$1', [input.targetId]);
    if (!ontologySchema.parse(a.definition).actions.includes(input.kind)) throw new Error('本体未启用此 Action');
    if (input.kind === 'CorrectValidity') {
      if (!input.validity) throw new Error('需指定修正的有效时间');
      return this.revise(sql, input.targetId, input.expectedRevision, { valid_from: input.validity.from, valid_to: input.validity.to, time_precision: input.validity.precision, reason: input.reason });
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
      const view = projectStatements(object.type_id, ontologySchema.parse(model.definition), rows as Statement[], validAt);
      const identifiers = (await sql.query('SELECT namespace,value FROM knowledge.identifiers WHERE object_id=$1', [id])).rows;
      const incoming = (await sql.query(`SELECT a.id,a.object_id,a.predicate,a.ontology_id,r.revision,r.status,r.valid_from,r.valid_to,r.time_precision FROM knowledge.assertions a JOIN knowledge.assertion_revisions r ON r.assertion_id=a.id
        WHERE r.target_id=$1 AND ($2::timestamptz IS NULL AND r.system_to IS NULL OR $2::timestamptz IS NOT NULL AND r.system_from<=$2 AND (r.system_to IS NULL OR r.system_to>$2)) ORDER BY a.id`, [id, knownAt])).rows;
      const result = { id, revision: knownAt ? null : object.revision, identifiers, knownAt, ontologyId: model.id, ...view, assertions: rows, incoming };
      if (!knownAt) {
        await sql.query('INSERT INTO knowledge.projections(object_id,object_revision,body) VALUES($1,$2,$3::jsonb) ON CONFLICT(object_id) DO UPDATE SET object_revision=excluded.object_revision,body=excluded.body,computed_at=clock_timestamp()', [id, object.revision, json(result)]);
        await sql.query('DELETE FROM knowledge.projection_dependencies WHERE object_id=$1', [id]);
        for (const row of rows) await sql.query('INSERT INTO knowledge.projection_dependencies(object_id,assertion_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, row.id]);
      }
      return result;
    });
  }
  async evidence(actor: Principal, assertionId: string): Promise<Array<Record<string, unknown> & { source_version_id: string; locator: ReturnType<typeof locateEvidence> }>> {
    authorize(actor);
    return (await this.db.pool.query('SELECT e.id,e.locator,v.id AS source_version_id,v.source_id,v.revision,v.content_hash,v.content FROM knowledge.assertion_evidence ae JOIN knowledge.evidence e ON e.id=ae.evidence_id JOIN knowledge.source_versions v ON v.id=e.source_version_id WHERE ae.assertion_id=$1', [uuid(assertionId)])).rows.map(row => {
      const locator = locateEvidence(row.content as SourceContent, row.locator);
      const { content, ...safe } = row;
      return { ...safe, source_version_id: String(row.source_version_id), locator };
    });
  }
  async events(actor: Principal) {
    authorize(actor); return (await this.db.pool.query('SELECT * FROM knowledge.action_events ORDER BY created_at DESC LIMIT 100')).rows;
  }
}

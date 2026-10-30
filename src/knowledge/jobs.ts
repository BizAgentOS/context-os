import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authorize, extractionSchema, mappingSchema, ontologySchema, type Principal } from './contracts.ts';
import { KnowledgeCore } from './service.ts';
import { fingerprint, locateEvidence, mapCsv, type SourceContent } from './sources.ts';
import type { JsonModel } from './model.ts';

const jobInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('discover'), operationId: z.string().min(1).max(160), sourceVersionIds: z.array(z.string().uuid()).min(1).max(10) }).strict(),
  z.object({ kind: z.literal('extract'), operationId: z.string().min(1).max(160), sourceVersionId: z.string().uuid(), ontologyId: z.string().uuid(), mapping: mappingSchema.optional() }).strict(),
]);
export class KnowledgeJobs {
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private stopping = false;
  private core: KnowledgeCore;
  private model?: JsonModel;
  constructor(core: KnowledgeCore, model?: JsonModel) { this.core = core; this.model = model; }
  async enqueue(actor: Principal, raw: unknown) {
    authorize(actor, true); const input = jobInput.parse(raw);
    const hash = fingerprint({ actor: actor.id, input, model: this.model?.identity ?? null, prompt: 'knowledge-v1' });
    return this.core.db.transaction(async sql => {
      const prior = (await sql.query('SELECT * FROM knowledge.jobs WHERE operation_id=$1', [input.operationId])).rows[0];
      if (prior) { if (prior.fingerprint !== hash) throw new Error('任务 operationId 输入不一致'); return prior; }
      return (await sql.query('INSERT INTO knowledge.jobs(id,operation_id,fingerprint,kind,actor_id,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *', [randomUUID(), input.operationId, hash, input.kind, actor.id, JSON.stringify({ input, modelId: this.model?.identity ?? null, promptVersion: 'knowledge-v1' })])).rows[0];
    });
  }
  async retry(actor: Principal, id: string) {
    authorize(actor, true); z.string().uuid().parse(id);
    return this.core.db.transaction(async sql => {
      const row = (await sql.query("UPDATE knowledge.jobs SET state='queued',error=NULL,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND (state='failed' OR state='running' AND lease_until<clock_timestamp()) RETURNING *", [id])).rows[0];
      if (!row) throw new Error('任务尚在运行或已完成');
      return row;
    });
  }
  start() {
    if (this.timer || this.active) return;
    this.stopping = false;
    const tick = () => {
      if (this.stopping) return;
      this.active = this.once().catch(() => { /* Individual job failure is persisted; infrastructure errors are retried on next tick. */ }).finally(() => {
        this.active = undefined;
        if (!this.stopping) this.timer = setTimeout(() => { this.timer = undefined; tick(); }, 1500);
      });
    };
    tick();
  }
  async close() {
    this.stopping = true; if (this.timer) clearTimeout(this.timer);
    await this.active; await this.model?.close();
  }
  async once() {
    const job = await this.core.db.transaction(async sql => {
      // Expired work requires explicit retry, avoiding repeated paid model calls after a crash.
      await sql.query("UPDATE knowledge.jobs SET state='failed',error='任务租约失效，请确认后重试',lease_token=NULL WHERE state='running' AND lease_until<clock_timestamp()");
      const pending = (await sql.query("SELECT * FROM knowledge.jobs WHERE state='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
      if (!pending) return null;
      return (await sql.query("UPDATE knowledge.jobs SET state='running',attempts=attempts+1,lease_token=$2,lease_until=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() WHERE id=$1 RETURNING *", [pending.id, randomUUID()])).rows[0];
    });
    if (!job) return;
    const lease = { id: job.id as string, leaseToken: job.lease_token as string };
    const heartbeat = setInterval(() => { void this.core.db.pool.query("UPDATE knowledge.jobs SET lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$1 AND lease_token=$2 AND state='running'", [lease.id, lease.leaseToken]).catch(() => {}); }, 30000);
    try {
      const actor: Principal = { id: job.actor_id, role: 'editor' };
      const input = jobInput.parse(job.payload.input);
      if ((input.kind === 'discover' || !input.mapping) && job.payload.modelId !== (this.model?.identity ?? null)) throw new Error('模型配置已变化，请新建任务而非复用原任务');
      let result: unknown;
      if (input.kind === 'discover') {
        if (!this.model) throw new Error('尚未配置模型，不能自动生成候选本体');
        const sources = await Promise.all(input.sourceVersionIds.map(id => this.core.sourceVersion(actor, id)));
        const samples = sources.map(s => {
          const content = s.content as SourceContent;
          if (content.kind === 'csv') return { id: s.id, sourceNamespace: `source.${s.source_id}`, ...content, rows: content.rows?.slice(0, 10), coverage: { sampled: Math.min(10, content.rows?.length ?? 0), total: content.rows?.length ?? 0 } };
          return { id: s.id, sourceNamespace: `source.${s.source_id}`, kind: content.kind, text: content.text?.slice(0, 16000), coverage: { characters: Math.min(16000, content.text?.length ?? 0), total: content.text?.length ?? 0 } };
        });
        if (Buffer.byteLength(JSON.stringify(samples)) > 100000) throw new Error('本体样本超过单次预算，请减少来源');
        const output = ontologySchema.parse(await this.model.generate('discover', { sources: samples }, ontologySchema));
        for (const item of output.discoveryEvidence) {
          const source = sources.find(s => s.id === item.sourceVersionId);
          if (!source) throw new Error('本体依据必须引用本次输入的来源版本');
          const located = locateEvidence(source.content as SourceContent, item.locator);
          if (item.locator.kind === 'quote' && located.kind === 'quote' && located.start !== item.locator.start) {
            item.originalStart = item.locator.start;
            item.locator = { kind: 'quote', quote: located.quote, start: located.start };
          }
        }
        for (const member of [...output.types, ...output.links]) if (!output.discoveryEvidence.some(e => e.memberId === member.id)) throw new Error('自动候选的每个类型和关系都需要来源依据');
        result = await this.core.draft(actor, output, undefined, lease);
      } else {
        const source = await this.core.sourceVersion(actor, input.sourceVersionId);
        const ontology = await this.core.ontology(actor, input.ontologyId, true);
        const content = source.content as SourceContent;
        const configuration = { prompt: 'knowledge-v1', model: input.mapping ? 'deterministic-mapping-v1' : this.model?.identity, mapping: input.mapping ?? null };
        let output: unknown;
        if (input.mapping) output = mapCsv(content, input.mapping, ontology.definition);
        else {
          if (!this.model) throw new Error('尚未配置模型；CSV 可指定字段映射，PDF 需配置模型');
          if (content.kind !== 'pdf') throw new Error('结构化数据请提供显式字段映射');
          if ((content.text?.length ?? 0) > 40000) throw new Error('第一阶段单次模型抽取最多 40000 字符，请拆分文档后接入；没有静默截断');
          output = await this.model.generate('extract', { ontology: ontology.definition, sourceNamespace: `source.${source.source_id}`, sourceVersionId: source.id, content }, extractionSchema);
        }
        result = await this.core.commitExtraction(actor, { operationId: input.operationId, ontologyId: input.ontologyId, sourceVersionId: input.sourceVersionId, configuration, output, job: lease });
      }
      await this.core.db.pool.query("UPDATE knowledge.jobs SET state='completed',result=$3::jsonb,error=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2 AND state='running'", [job.id, lease.leaseToken, JSON.stringify(result)]);
    } catch (error) {
      // Avoid persisting arbitrary provider messages that can contain credentials or request content.
      const message = error instanceof z.ZodError ? '输入或模型输出未通过结构校验' : error instanceof Error && !/key|token|authorization|bearer|https?:/i.test(error.message) ? error.message.slice(0, 500) : '任务失败，请检查配置或输入后重试';
      await this.core.db.pool.query("UPDATE knowledge.jobs SET state='failed',error=$3,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2 AND state='running'", [job.id, lease.leaseToken, message]);
    } finally { clearInterval(heartbeat); }
  }
}

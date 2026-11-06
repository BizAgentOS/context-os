import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, authorize, type Principal } from './contracts.ts';
import type { KnowledgeCore } from './service.ts';
import type { Sql } from './database.ts';
import { CredentialVault } from '../security/credential-vault.ts';
import { MysqlReader, type MysqlConfig } from './mysql-reader.ts';
import { fingerprint } from './sources.ts';
import { MAX_SOURCE_ASSETS } from './build-contracts.ts';
import { TABLE_RECORD_KEY } from './table-content.ts';
import { TableProfiler } from './structured-profile.ts';

const configSchema = z.object({ url: z.string().max(4000), tls: z.enum(['verify','disabled']).optional(), ca: z.string().max(20000).optional() }).strict();
const admin = (actor: Principal) => { authorize(actor, true); if (actor.role !== 'admin') throw new AccessDenied('只有管理员可管理来源连接'); };
const one = async (sql: Sql, q: string, args: unknown[]) => { const r = (await sql.query(q,args)).rows[0]; if (!r) throw new Error('连接不存在、已停用或修订变化'); return r; };

/** Native capture stages observations. Only an approved build activates knowledge. */
export class ConnectedSources {
  private core: KnowledgeCore; private vault: CredentialVault; private reader: MysqlReader;
  constructor(core: KnowledgeCore, vault: CredentialVault, reader = new MysqlReader()) { this.core = core; this.vault = vault; this.reader = reader; }
  async list(actor: Principal) { authorize(actor); return (await this.core.db.pool.query('SELECT id,name,kind,scope,revision,enabled,created_at FROM knowledge.connections ORDER BY created_at,id')).rows; }
  async create(actor: Principal, raw: unknown) {
    admin(actor);
    const input = z.object({ operationId: z.string().min(1).max(160), name: z.string().trim().min(1).max(200), config: configSchema, tables: z.array(z.string().min(1).max(64)).max(100).default([]) }).strict().parse(raw);
    const u = new URL(input.config.url); if (u.protocol !== 'mysql:') throw new Error('当前仅接受 MySQL 连接');
    const hash = fingerprint({ actor: actor.id, input });
    return this.core.db.transaction(async sql => {
      const prior = (await sql.query('SELECT fingerprint,result FROM knowledge.operations WHERE id=$1', [input.operationId])).rows[0];
      if (prior) { if (prior.fingerprint !== hash) throw new Error('连接 operationId 输入变化'); return prior.result; }
      const id = randomUUID(), credentials = this.vault.get('knowledge-sources');
      this.vault.set('knowledge-sources', { ...credentials, [id]: input.config });
      const result = await one(sql, "INSERT INTO knowledge.connections(id,name,kind,scope,created_by) VALUES($1,$2,'mysql',$3::jsonb,$4) RETURNING id,name,kind,scope,revision,enabled", [id,input.name,JSON.stringify({ tables: [...new Set(input.tables)] }),actor.id]);
      await sql.query('INSERT INTO knowledge.operations(id,fingerprint,result) VALUES($1,$2,$3::jsonb)', [input.operationId,hash,JSON.stringify(result)]);
      return result;
    });
  }
  private async connection(actor: Principal, id: string) { authorize(actor); z.string().uuid().parse(id); return one(this.core.db.pool, 'SELECT * FROM knowledge.connections WHERE id=$1 AND enabled', [id]); }
  private config(id: string): MysqlConfig { return configSchema.parse(this.vault.get('knowledge-sources')[id]); }
  async catalog(actor: Principal, id: string) {
    const connection = await this.connection(actor,id), result = await this.reader.catalog(this.config(id));
    await this.connection(actor,id);
    return { ...result, tables: result.tables.filter(t => !connection.scope.tables.length || connection.scope.tables.includes(t.name)) };
  }
  async revoke(actor: Principal, id: string, revision: number) {
    admin(actor); z.string().uuid().parse(id); z.number().int().positive().parse(revision);
    return this.core.db.transaction(sql => one(sql,'UPDATE knowledge.connections SET enabled=false,revision=revision+1 WHERE id=$1 AND revision=$2 RETURNING id,revision,enabled',[id,revision]));
  }
  async observations(actor: Principal, id: string) { authorize(actor); z.string().uuid().parse(id); return (await this.core.db.pool.query('SELECT id,state,table_name,result,error,created_at,finished_at FROM knowledge.observation_runs WHERE connection_id=$1 ORDER BY created_at DESC LIMIT 100',[id])).rows; }
  async captureAll(actor: Principal,id:string,operationId:string,maxRows:number) {
    authorize(actor,true);
    const catalog=await this.catalog(actor,id);
    if(!catalog.tables.length)throw new Error('授权范围没有可见表，不推断删除');
    if(catalog.tables.length>MAX_SOURCE_ASSETS)throw new Error(`本轮业务范围超过 ${MAX_SOURCE_ASSETS} 张表，请配置较小的连接范围；不静默抽样`);
    const results=[];
    for(const table of catalog.tables) results.push(await this.capture(actor,id,{operationId:`observe:${fingerprint({operationId,id,table:table.name})}`,table:table.name,maxRows}));
    return {sourceVersionIds:results.map(r=>String(r.sourceVersionId)),changed:results.some(r=>r.changed),coverage:catalog.coverage};
  }
  async capture(actor: Principal, id: string, raw: unknown) {
    authorize(actor,true);
    const input = z.object({ operationId: z.string().min(1).max(160), table: z.string().min(1).max(64), maxRows: z.number().int().min(1).max(100000).default(10000) }).strict().parse(raw);
    const connection = await this.connection(actor,id), hash = fingerprint({ actor: actor.id, id, revision: connection.revision, input });
    const run = await this.core.db.transaction(async sql => {
      const previous = (await sql.query('SELECT * FROM knowledge.observation_runs WHERE operation_id=$1',[input.operationId])).rows[0];
      if (previous) { if (previous.fingerprint !== hash) throw new Error('观测 operationId 输入不一致'); return previous; }
      return one(sql,"INSERT INTO knowledge.observation_runs(id,connection_id,operation_id,fingerprint,connection_revision,state,table_name) VALUES($1,$2,$3,$4,$5,'running',$6) RETURNING *",[randomUUID(),id,input.operationId,hash,connection.revision,input.table]);
    });
    if (run.state === 'completed') return run.result;
    const claimed = await this.core.db.pool.query('UPDATE knowledge.observation_runs SET result=$2::jsonb WHERE id=$1 AND state=\'running\' AND result IS NULL RETURNING id',[run.id,JSON.stringify({ claimed: true })]);
    if (!claimed.rows.length) throw new Error('观测正在执行或已中断，请查看记录并显式新建本轮读取');
    try {
      const catalog = await this.catalog(actor,id), table = catalog.tables.find(t => t.name === input.table);
      if (!table) throw new Error('表不在连接授权范围或账号不可见，不能当成已删除');
      if (table.columns.some(c => c.name === TABLE_RECORD_KEY)) throw new Error('来源字段与平台保留记录键冲突');
      const digest = createHash('sha256').update(JSON.stringify(table)); let bytes = 0;
      const profiler = new TableProfiler(table.columns.map(c=>c.name));
      const receipt = await this.reader.read(this.config(id),table,{ pageSize: 500,maxRows: input.maxRows },async page => {
        const encoded = JSON.stringify(page.records); bytes += Buffer.byteLength(encoded);
        if (bytes > 100_000_000) throw new Error('本轮读取超过内容上限，未完成');
        digest.update(encoded);
        profiler.add(page.records);
        // Staging is not domain adoption. Do not wait on the PG global domain
        // lock while the source reader holds its consistent-read transaction.
        const staged=await this.core.db.pool.query('INSERT INTO knowledge.observation_pages(run_id,page,records) SELECT $1,$2,$3::jsonb WHERE EXISTS(SELECT 1 FROM knowledge.connections WHERE id=$4 AND enabled AND revision=$5) RETURNING run_id',[run.id,page.index,encoded,id,connection.revision]);
        if(!staged.rows.length)throw new Error('连接修订已变化，本轮观测未采用');
      });
      return await this.core.db.transaction(async sql => {
        await one(sql,'SELECT id FROM knowledge.connections WHERE id=$1 AND enabled AND revision=$2',[id,connection.revision]);
        const newer = await sql.query("SELECT 1 FROM knowledge.observation_runs WHERE connection_id=$1 AND table_name=$2 AND state='completed' AND created_at>(SELECT created_at FROM knowledge.observation_runs WHERE id=$3) LIMIT 1",[id,input.table,run.id]);
        if(newer.rows.length)throw new Error('已有更新的完整观测，不允许旧批次覆盖');
        const sourceKey = `mysql.${id}.${table.schema}.${table.name}`;
        let source = (await sql.query('SELECT * FROM knowledge.sources WHERE source_key=$1',[sourceKey])).rows[0];
        if (!source) source = await one(sql,"INSERT INTO knowledge.sources(id,source_key,title,kind) VALUES($1,$2,$3,'table') RETURNING *",[randomUUID(),sourceKey,`${connection.name} · ${table.name}`]);
        const contentHash = digest.digest('hex');
        let version = (await sql.query('SELECT id FROM knowledge.source_versions WHERE source_id=$1 AND content_hash=$2 ORDER BY revision DESC LIMIT 1',[source.id,contentHash])).rows[0];
        const changed = !version || (source.observed_version ?? source.active_version) !== version.id;
        if (!version) {
          const content = { kind: 'table', columns: [TABLE_RECORD_KEY,...table.columns.map(c => c.name)], keyColumn: TABLE_RECORD_KEY, rowCount: receipt.rows, metadata: { ...table, connectionId: id, coverage: receipt, profile: profiler.finish() }, warnings: table.columns.some(c => /date|time/i.test(c.type)) ? ['日期保留来源表示；零值/缺失日期不得猜测为业务时间。'] : [] };
          version = await one(sql,"INSERT INTO knowledge.source_versions(id,source_id,revision,content_hash,content,original_path) SELECT $1,$2,COALESCE(max(revision),0)+1,$3,$4::jsonb,'native:mysql' FROM knowledge.source_versions WHERE source_id=$2 RETURNING id",[randomUUID(),source.id,contentHash,JSON.stringify(content)]);
          await sql.query(`INSERT INTO knowledge.source_records(source_version_id,record_key,ordinal,values)
            SELECT $1,e.value->>'key',((p.page*500)+e.ordinality-1)::integer,e.value->'values'
            FROM knowledge.observation_pages p CROSS JOIN LATERAL jsonb_array_elements(p.records) WITH ORDINALITY e(value,ordinality) WHERE p.run_id=$2`,[version.id,run.id]);
        }
        await sql.query('UPDATE knowledge.sources SET observed_version=$2,revision=revision+1 WHERE id=$1',[source.id,version.id]);
        const result = { sourceId: source.id,sourceVersionId: version.id,changed,stage: 'observed',coverage: receipt,previousActiveVersion: source.active_version };
        await sql.query("UPDATE knowledge.observation_runs SET state='completed',source_version_id=$2,result=$3::jsonb,finished_at=clock_timestamp() WHERE id=$1",[run.id,version.id,JSON.stringify(result)]);
        await sql.query('DELETE FROM knowledge.observation_pages WHERE run_id=$1',[run.id]);
        return result;
      });
    } catch (e) {
      const message = e instanceof Error && /上限|完整|主键|不可见|目录结构|MariaDB|保留记录键|InnoDB|列预算|旧批次/.test(e.message) ? e.message : '观测失败；未激活来源，未推断删除，请检查配置后显式新建读取';
      await this.core.db.pool.query("UPDATE knowledge.observation_runs SET state='failed',error=$2,finished_at=clock_timestamp() WHERE id=$1",[run.id,message]);
      await this.core.db.pool.query('DELETE FROM knowledge.observation_pages WHERE run_id=$1',[run.id]);
      throw new Error(message);
    }
  }
}

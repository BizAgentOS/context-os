import { getLogger } from '../observability/logger.ts';
import { readFile } from 'node:fs/promises';

export interface Result<T = Record<string, any>> { rows: T[]; rowCount: number | null; }
export interface Sql { query<T = Record<string, any>>(text: string, values?: unknown[]): Promise<Result<T>>; }
interface Client extends Sql { release(): void; }
export interface Pool extends Sql { connect(): Promise<Client>; end(): Promise<void>; }
/** Driver loaded only when the knowledge core is explicitly started. */
export async function openDatabase(connectionString: string): Promise<Database> {
  if (!connectionString) throw new Error('请设置 CONTEXT_OS_KNOWLEDGE_DATABASE_URL');
  const driver = 'pg';
  const pg = await import(driver);
  const PoolClass = pg.Pool ?? pg.default.Pool;
  return new Database(new PoolClass({ connectionString, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 30000 }),metric=>getLogger().log('info','knowledge.transaction',{component:'knowledge.database',...metric}));
}
export class Database {
  readonly pool: Pool;
  private observe:(metric:{lockWaitMs:number;durationMs:number;outcome:string})=>void;
  constructor(pool: Pool, observe:(metric:{lockWaitMs:number;durationMs:number;outcome:string})=>void=()=>{}) { this.pool = pool;this.observe=observe; }
  async transaction<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
    const started=performance.now();let lockWaitMs=0,outcome='failed';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Small single-enterprise first stage: serialize domain writes, never hold this lock during model I/O.
      const waiting=performance.now();
      await client.query("SELECT pg_advisory_xact_lock(80731030)");
      lockWaitMs=performance.now()-waiting;
      const result = await run(client);
      await client.query('COMMIT');outcome='committed';
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release();try{this.observe({lockWaitMs,durationMs:performance.now()-started,outcome});}catch{/* Telemetry cannot alter transaction outcome. */} }
  }
  async initialize() {
    const schemas = await Promise.all(['001-core.sql', '002-phase1-hardening.sql', '003-build-plans.sql', '004-build-heads.sql', '005-source-identities.sql', '006-autonomy.sql', '007-structured-compiler.sql'].map(name => readFile(new URL(`./sql/${name}`, import.meta.url), 'utf8')));
    await this.transaction(async sql => {
      await sql.query('CREATE TABLE IF NOT EXISTS knowledge_schema_versions(version integer PRIMARY KEY, installed_at timestamptz NOT NULL DEFAULT clock_timestamp())');
      const schema = await sql.query("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='knowledge') AS present");
      // A removed schema leaves public migration markers behind. There is no domain
      // data to preserve when the entire namespace is absent; replay known migrations.
      if (!schema.rows[0].present) await sql.query('DELETE FROM knowledge_schema_versions WHERE version BETWEEN 1 AND $1', [schemas.length]);
      for (const [index, schema] of schemas.entries()) {
        const version = index + 1;
        const applied = await sql.query('SELECT version FROM knowledge_schema_versions WHERE version=$1', [version]);
        if (!applied.rows.length) {
          // Earlier backfills may queue deferred FK checks on a table altered by the next migration.
          await sql.query('SET CONSTRAINTS ALL IMMEDIATE');
          await sql.query(schema);
          await sql.query('INSERT INTO knowledge_schema_versions(version) VALUES($1)', [version]);
        }
      }
    });
  }
  close() { return this.pool.end(); }
}

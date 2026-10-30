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
  return new Database(new PoolClass({ connectionString, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 30000 }));
}
export class Database {
  readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }
  async transaction<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Small single-enterprise first stage: serialize domain writes, never hold this lock during model I/O.
      await client.query("SELECT pg_advisory_xact_lock(80731030)");
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async initialize() {
    const schema = await readFile(new URL('./sql/001-core.sql', import.meta.url), 'utf8');
    await this.transaction(async sql => {
      await sql.query('CREATE TABLE IF NOT EXISTS knowledge_schema_versions(version integer PRIMARY KEY, installed_at timestamptz NOT NULL DEFAULT clock_timestamp())');
      const applied = await sql.query('SELECT version FROM knowledge_schema_versions WHERE version=1');
      if (!applied.rows.length) { await sql.query(schema); await sql.query('INSERT INTO knowledge_schema_versions(version) VALUES(1)'); }
    });
  }
  close() { return this.pool.end(); }
}

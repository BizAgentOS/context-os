import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Data } from "../agent/contracts.ts";
import { lit, quote } from "../data/executor/engine.ts";

export interface DatabaseConfig { name: string; kind: "postgres" | "mysql"; host: string; port: number; database: string; user: string; password: string; sslMode: "prefer" | "require" | "verify-full" }
export interface DatabaseTable { schema: string; table: string; estimatedRows: number | null; columns: { name: string; type: string }[]; primaryKey: string[] }
export type SelectedDatabaseTable = DatabaseTable & { idField: string };
export interface DatabaseScanner {
  tables(config: DatabaseConfig): Promise<DatabaseTable[]>;
  read(config: DatabaseConfig, table: SelectedDatabaseTable, where: Data, offset: number, limit: number): Promise<{ items: Data[]; total: number }>;
  snapshot(config: DatabaseConfig, table: SelectedDatabaseTable, limit: number, file: string, incremental?: { field: string; since: string }): Promise<{ rows: number; total: number; complete: boolean }>;
}

const postgresCatalog = `SELECT n.nspname AS schema_name,c.relname AS table_name,GREATEST(c.reltuples,0)::bigint AS estimated_rows,
  a.attname AS column_name,format_type(a.atttypid,a.atttypmod) AS data_type,COALESCE(a.attnum=ANY(i.indkey),false) AS primary_key
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
  LEFT JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary
  WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
  AND a.attnum>0 AND NOT a.attisdropped AND has_table_privilege(c.oid,'SELECT') ORDER BY n.nspname,c.relname,a.attnum`;
const mysqlCatalog = `SELECT c.TABLE_SCHEMA AS schema_name,c.TABLE_NAME AS table_name,t.TABLE_ROWS AS estimated_rows,
  c.COLUMN_NAME AS column_name,c.DATA_TYPE AS data_type,c.COLUMN_KEY='PRI' AS primary_key
  FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME
  WHERE c.TABLE_SCHEMA=DATABASE() AND t.TABLE_TYPE='BASE TABLE' ORDER BY c.TABLE_NAME,c.ORDINAL_POSITION`;

/** Only fixed metadata and generated SELECTs reach a READ_ONLY attachment. No SQL is accepted from callers. */
export class DuckDatabaseScanner implements DatabaseScanner {
  private directory: string;
  constructor(directory: string) { this.directory = join(directory, "database-extensions"); mkdirSync(this.directory, { recursive: true, mode: 0o700 }); }
  private async using<T>(config: DatabaseConfig, fn: (connection: DuckDBConnection) => Promise<T>): Promise<T> {
    let db: DuckDBInstance | undefined, c: DuckDBConnection | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      db = await DuckDBInstance.create(":memory:", { memory_limit: "256MB", threads: "2", extension_directory: this.directory,
        allow_unsigned_extensions: "false", autoinstall_known_extensions: "false", autoload_known_extensions: "false" });
      c = await db.connect();
      timer = setTimeout(() => c?.interrupt(), 120_000); timer.unref();
      await c.run(`INSTALL ${config.kind} FROM core; LOAD ${config.kind}`);
      const ssl = config.kind === "postgres" ? `SSLMODE ${lit(config.sslMode)}, CONNECT_TIMEOUT '10'`
        : `SSL_MODE ${lit({ prefer: "preferred", require: "required", "verify-full": "verify_identity" }[config.sslMode])}`;
      await c.run(`CREATE SECRET source_credentials (TYPE ${config.kind}, HOST ${lit(config.host)}, PORT ${config.port}, DATABASE ${lit(config.database)}, USER ${lit(config.user)}, PASSWORD ${lit(config.password)}, ${ssl})`);
      await c.run(`ATTACH '' AS remote (TYPE ${config.kind}, SECRET source_credentials, READ_ONLY)`);
      await c.run("BEGIN TRANSACTION");
      const value = await fn(c);
      await c.run("COMMIT");
      return value;
    } catch {
      // Driver errors can contain a connection string or SQL secret. Never expose those messages.
      throw new Error("数据库读取失败：请检查地址、只读账号的连接与 SELECT 权限、表结构及网络；未返回替代数据");
    } finally { if (timer) clearTimeout(timer); c?.closeSync(); db?.closeSync(); }
  }
  async tables(config: DatabaseConfig): Promise<DatabaseTable[]> {
    return this.using(config, async c => {
      const catalog = config.kind === "postgres" ? postgresCatalog : mysqlCatalog;
      const rows = (await c.runAndReadAll(`SELECT * FROM ${config.kind}_query('remote', ${lit(catalog)})`)).getRowObjectsJson();
      const tables = new Map<string, DatabaseTable>();
      for (const row of rows) {
        const schema = String(row.schema_name), table = String(row.table_name), key = JSON.stringify([schema, table]);
        let item = tables.get(key);
        if (!item) { item = { schema, table, estimatedRows: row.estimated_rows === null ? null : Number(row.estimated_rows), columns: [], primaryKey: [] }; tables.set(key, item); }
        item.columns.push({ name: String(row.column_name), type: String(row.data_type) });
        if (row.primary_key === true || row.primary_key === 1 || row.primary_key === "1") item.primaryKey.push(String(row.column_name));
      }
      return [...tables.values()];
    });
  }
  private table(table: SelectedDatabaseTable) { return `remote.${quote(table.schema)}.${quote(table.table)}`; }
  private projection(table: SelectedDatabaseTable) {
    return table.columns.map(column => column.name === table.idField || /json|array|\[|bytea|blob|binary|geometry/i.test(column.type)
      ? `CAST(${quote(column.name)} AS VARCHAR) AS ${quote(column.name)}` : quote(column.name)).join(", ");
  }
  async read(config: DatabaseConfig, table: SelectedDatabaseTable, where: Data, offset: number, limit: number) {
    return this.using(config, async c => {
      const filters = Object.entries(where).map(([field, value]) => `CAST(${quote(field)} AS VARCHAR) = ${lit(String(value))}`);
      const from = `${this.table(table)}${filters.length ? " WHERE " + filters.join(" AND ") : ""}`;
      const count = (await c.runAndReadAll(`SELECT COUNT(*) AS n FROM ${from}`)).getRowObjectsJson()[0];
      const items = (await c.runAndReadAll(`SELECT ${this.projection(table)} FROM ${from} ORDER BY ${quote(table.idField)} LIMIT ${limit} OFFSET ${offset}`)).getRowObjectsJson() as Data[];
      return { items, total: Number(count.n) };
    });
  }
  async snapshot(config: DatabaseConfig, table: SelectedDatabaseTable, limit: number, file: string, incremental?: { field: string; since: string }) {
    return this.using(config, async c => {
      if (incremental && !table.columns.some(column => column.name === incremental.field && /date|time|int|numeric|decimal|float|double|real/i.test(column.type))) throw new Error("增量字段必须是已批准的时间或数值字段");
      const from = this.table(table), filter = incremental ? ` WHERE ${quote(incremental.field)} >= ${lit(incremental.since)}` : "";
      const count = (await c.runAndReadAll(`SELECT COUNT(*) AS n FROM ${from}${filter}`)).getRowObjectsJson()[0], total = Number(count.n);
      // Preserve DECIMAL and temporal types; JSON transport would silently turn exact numbers into text.
      const columns = (await c.runAndReadAll(`DESCRIBE SELECT * FROM ${from}`)).getRowObjectsJson().map(column => ({ name: String(column.column_name), type: String(column.column_type) }));
      const current = { ...table, columns };
      await c.run(`COPY (SELECT ${this.projection(current)} FROM ${from}${filter} ORDER BY ${quote(table.idField)} LIMIT ${limit}) TO ${lit(file)} (FORMAT PARQUET, ROW_GROUP_SIZE 8192)`);
      const rows = Number((await c.runAndReadAll(`SELECT COUNT(*) AS n FROM read_parquet(${lit(file)})`)).getRowObjectsJson()[0].n);
      return { rows, total, complete: rows === total };
    });
  }
}

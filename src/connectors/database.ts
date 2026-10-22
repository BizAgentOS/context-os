import { z } from "zod";
import { CredentialVault } from "../security/credential-vault.ts";
import type { Artifact, Data, Repository } from "../agent/contracts.ts";
import { DuckDatabaseScanner, type DatabaseConfig, type DatabaseScanner, type SelectedDatabaseTable } from "./database-scanner.ts";

const name = z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f]/.test(value));
export const databaseConfig = z.object({ name, kind: z.enum(["postgres", "mysql"]), host: z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9.:_-]+$/),
  port: z.number().int().min(1).max(65535).optional(), database: name, user: name, password: z.string().max(4000).refine(value => !value.includes("\0")),
  sslMode: z.enum(["prefer", "require", "verify-full"]).default("prefer") }).strict();
const selection = z.object({ id: name, version: z.number().int().positive(), tables: z.array(z.object({ schema: name, table: name, idField: name.optional() }).strict()).min(1).max(100) }).strict();
const data = (value: unknown): Data => JSON.parse(JSON.stringify(value));

export class DatabaseConnections {
  private repo: Repository;
  private vault: CredentialVault;
  private get passwords():Record<string,string>{return z.record(z.string(),z.string()).parse(this.vault.get('database'));}
  private scanner: DatabaseScanner;
  private saved: (source: Artifact) => void;
  constructor(directory: string, repo: Repository, saved: (source: Artifact) => void, scanner?: DatabaseScanner) {
    this.repo = repo; this.saved = saved; this.scanner = scanner ?? new DuckDatabaseScanner(directory);
    this.vault=new CredentialVault(directory);this.vault.migrateJson('database','database-credentials.json');
  }
  forget(id: string) {const passwords=this.passwords;if(Object.hasOwn(passwords,id)){delete passwords[id];this.vault.set('database',passwords);}}
  private parse(input: unknown): DatabaseConfig { const value = databaseConfig.parse(input); return { ...value, port: value.port ?? (value.kind === "postgres" ? 5432 : 3306) }; }
  private source(id: string, version?: number) {
    const source = this.repo.getArtifact(id);
    if (source.kind !== "source_connection" || source.status !== "ready" || source.content.adapter !== "database") throw new Error("数据库连接已停用或不存在");
    if (version !== undefined && source.version !== version) throw new Error("数据库连接版本已变化，请重新读取");
    return source;
  }
  private config(source: Artifact): DatabaseConfig {
    if (!Object.hasOwn(this.passwords, source.id)) throw new Error("数据库凭据不可用，请重新连接");
    return this.parse({ ...source.content.database as Data, name: source.title, password: this.passwords[source.id] });
  }
  async test(input: unknown) { const config = this.parse(input); return { ok: true, readOnly: true, tables: await this.scanner.tables(config) }; }
  async connect(input: unknown) {
    const config = this.parse(input); await this.scanner.tables(config);
    const { password, name, ...safe } = config;
    const source = this.repo.putArtifact({ kind: "source_connection", title: name, status: "ready", content: data({ name, protocol: config.kind,
      adapter: "database", database: safe, readOnly: true, capabilities: [], databaseTables: [] }) });
    try { this.vault.set('database',{...this.passwords,[source.id]:password}); return source; }
    catch (error) { this.repo.putArtifact({ ...source, expectedVersion: source.version, status: "disabled" }); throw error; }
  }
  async tables(id: string) { const source = this.source(id), tables = await this.scanner.tables(this.config(source)); this.source(id, source.version); return { id, version: source.version, tables, selected: source.content.databaseTables }; }
  async select(input: unknown) {
    const args = selection.parse(input), source = this.source(args.id, args.version), available = await this.scanner.tables(this.config(source));
    const tables = args.tables.map(pick => {
      const table = available.find(item => item.schema === pick.schema && item.table === pick.table);
      if (!table) throw new Error(`表不存在或没有 SELECT 权限：${pick.schema}.${pick.table}`);
      const idField = pick.idField ?? (table.primaryKey.length === 1 ? table.primaryKey[0] : undefined);
      if (!idField || !table.columns.some(column => column.name === idField)) throw new Error(`请选择 ${pick.table} 的唯一身份列（复合主键需明确选择单列）`);
      if (table.columns.length > 100) throw new Error(`表 ${pick.table} 超过当前100列读取范围`);
      return { ...table, idField };
    });
    const names = tables.map(table => `${table.schema}.${table.table}`);
    if (new Set(names).size !== names.length) throw new Error("表选择重复或名称冲突");
    const capabilities = tables.map((table, index) => ({ name: names[index], contentKind: "records", fields: table.columns.map(c => c.name), idField: table.idField, idType: "string",
      itemsPath: "items", totalPath: "total", limitParam: "__cos_limit", offsetParam: "__cos_offset", filters: Object.fromEntries(table.columns.map((c, i) => [c.name, `__cos_filter_${i}`])) }));
    this.source(source.id, source.version);
    const saved = this.repo.putArtifact({ ...source, expectedVersion: source.version, content: data({ ...source.content, capabilities, databaseTables: tables }) });
    this.saved(saved); return saved;
  }
  /** Called only inside the snapshot-accept transaction; old source versions and released snapshots stay immutable. */
  acceptSchema(id: string, capability: string, sourceVersion: number, columns: { name: string; type: string }[]) {
    const source = this.source(id), tables = source.content.databaseTables as unknown as SelectedDatabaseTable[];
    const table = tables.find(item => `${item.schema}.${item.table}` === capability);
    if (!table || !columns.some(column => column.name === table.idField)) throw new Error("数据库表选择或身份列已变化，请重新同步");
    if (columns.length > 100 || new Set(columns.map(column => column.name)).size !== columns.length) throw new Error("数据库表列超出范围或存在重复，请重新选择");
    const previous = (this.repo.getArtifact(id, sourceVersion).content.databaseTables as unknown as SelectedDatabaseTable[]).find(item => `${item.schema}.${item.table}` === capability);
    const signature = (value: SelectedDatabaseTable | undefined) => JSON.stringify(value && { idField: value.idField, columns: value.columns.map(({ name, type }) => ({ name, type })) });
    const next = { ...table, columns };
    if (signature(table) !== signature(previous) && signature(table) !== signature(next)) throw new Error("数据库表的读取范围已变化，请重新同步后确认");
    if (signature(table) === signature(next)) return source;
    const capabilities = (source.content.capabilities as Data[]).map(cap => cap.name !== capability ? cap : { ...cap,
      fields: columns.map(column => column.name), filters: Object.fromEntries(columns.map((column, index) => [column.name, `__cos_filter_${index}`])) });
    return this.repo.putArtifact({ ...source, expectedVersion: source.version, content: data({ ...source.content, capabilities,
      databaseTables: tables.map(item => item === table ? next : item) }) });
  }
  private selected(id: string, capability: string, version?: number) {
    const source = this.source(id, version), tables = source.content.databaseTables as unknown as SelectedDatabaseTable[];
    const table = tables.find(item => `${item.schema}.${item.table}` === capability);
    if (!table) throw new Error("数据库表未经选择，不能读取");
    return { source, table, config: this.config(source) };
  }
  async read(id: string, capability: string, where: Data, offset: number, limit: number, version: number) {
    const { source, table, config } = this.selected(id, capability, version);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("数据库分页范围无效");
    if (Object.keys(where).some(field => !table.columns.some(c => c.name === field))) throw new Error("数据库过滤列不存在");
    const result = await this.scanner.read(config, table, where, offset, limit); this.source(id, source.version); return result;
  }
  async snapshot(id: string, capability: string, version: number, limit: number, file: string, incremental?: { field: string; since: string }) {
    const { source, table, config } = this.selected(id, capability, version);
    const result = await this.scanner.snapshot(config, table, limit, file, incremental); this.source(id, source.version); return result;
  }
}

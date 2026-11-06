import { createConnection, type Connection, type RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { fingerprint } from './sources.ts';

export interface MysqlConfig { url: string; tls?: 'verify' | 'disabled'; ca?: string; }
export interface MysqlColumn { name: string; type: string; nullable: boolean; comment: string; collation: string | null; }
export interface MysqlTable { schema: string; name: string; engine: string; comment: string; columns: MysqlColumn[]; primaryKey: string[]; uniqueKeys?:Array<{name:string;columns:string[]}>; foreignKeys: Array<{ name: string; column: string; targetSchema: string; targetTable: string; targetColumn: string; ordinal: number }>; }
export interface MysqlRecord { key: string; values: Record<string, string | null>; }
export interface MysqlPage { index: number; records: MysqlRecord[]; }
const quote = (s: string) => '`' + s.replaceAll('`', '``') + '`';
const rows = async (c: Connection, sql: string, values: unknown[] = []) => (await c.query<RowDataPacket[]>({ sql, timeout: 30000 }, values))[0];

/** Fixed metadata/SELECTs only; no model SQL, writes, DuckDB or credentials in receipts. */
export class MysqlReader {
  private async connect(config: MysqlConfig) {
    const u = new URL(config.url);
    if (u.protocol !== 'mysql:' || !u.hostname || !u.pathname.slice(1) || u.search || u.hash) throw new Error('需要明确的 MySQL 连接配置，不接受额外连接参数');
    if (config.tls === 'disabled' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error('远程 MySQL 连接必须校验 TLS 证书');
    return createConnection({ host: u.hostname, port: Number(u.port || 3306), database: decodeURIComponent(u.pathname.slice(1)), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
      supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false, dateStrings: true, jsonStrings: true,
      multipleStatements: false, flags: ['-LOCAL_FILES'], connectTimeout: 10000,
      ...(config.tls === 'disabled' || !config.tls && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ? {} : { ssl: { rejectUnauthorized: true, ...(config.ca ? { ca: config.ca } : {}) } }) });
  }
  private async describe(c: Connection) {
    const info = (await rows(c, 'SELECT DATABASE() AS db,VERSION() AS version'))[0];
    if (/mariadb/i.test(String(info.version))) throw new Error('MariaDB 需要单独适配验证，不能冒充已验证的 MySQL');
    if (!/^8\./.test(String(info.version))) throw new Error('当前原生接入仅验证 MySQL 8 系列接口');
    const catalog = await rows(c, `SELECT t.TABLE_SCHEMA,t.TABLE_NAME,t.ENGINE,t.TABLE_COMMENT,c.COLUMN_NAME,c.COLUMN_TYPE,c.IS_NULLABLE,c.COLUMN_COMMENT,c.COLLATION_NAME,c.ORDINAL_POSITION
      FROM information_schema.TABLES t JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA=t.TABLE_SCHEMA AND c.TABLE_NAME=t.TABLE_NAME
      WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_TYPE='BASE TABLE' ORDER BY t.TABLE_NAME,c.ORDINAL_POSITION`);
    const keys = await rows(c, `SELECT CONSTRAINT_NAME,TABLE_NAME,COLUMN_NAME,ORDINAL_POSITION,REFERENCED_TABLE_SCHEMA,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME
      FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION`);
    const map = new Map<string, MysqlTable>();
    for (const r of catalog) {
      if (!map.has(r.TABLE_NAME)) map.set(r.TABLE_NAME, { schema: r.TABLE_SCHEMA, name: r.TABLE_NAME, engine: r.ENGINE, comment: r.TABLE_COMMENT, columns: [], primaryKey: [], uniqueKeys:[], foreignKeys: [] });
      map.get(r.TABLE_NAME)!.columns.push({ name: r.COLUMN_NAME, type: r.COLUMN_TYPE, nullable: r.IS_NULLABLE === 'YES', comment: r.COLUMN_COMMENT, collation: r.COLLATION_NAME });
    }
    for (const r of keys) {
      const t = map.get(r.TABLE_NAME); if (!t) continue;
      if(r.CONSTRAINT_NAME!=='PRIMARY'&&!r.REFERENCED_TABLE_NAME){let key=t.uniqueKeys!.find(k=>k.name===r.CONSTRAINT_NAME);if(!key){key={name:r.CONSTRAINT_NAME,columns:[]};t.uniqueKeys!.push(key);}key.columns.push(r.COLUMN_NAME);}
      if (r.CONSTRAINT_NAME === 'PRIMARY') t.primaryKey.push(r.COLUMN_NAME);
      if (r.REFERENCED_TABLE_NAME) t.foreignKeys.push({ name: r.CONSTRAINT_NAME, column: r.COLUMN_NAME, targetSchema: r.REFERENCED_TABLE_SCHEMA, targetTable: r.REFERENCED_TABLE_NAME, targetColumn: r.REFERENCED_COLUMN_NAME, ordinal: Number(r.ORDINAL_POSITION) });
    }
    return { database: String(info.db), version: String(info.version), tables: [...map.values()], coverage: 'visible_authorized_objects_only', directoryComplete: false, note: '目录仅显示当前账号可见对象，不推断不存在的或未授权资产；读取范围须由管理员配置。' };
  }
  async catalog(config: MysqlConfig) {
    let c: Connection | undefined;
    try { c = await this.connect(config); return await this.describe(c); }
    catch (e) { if (e instanceof Error && /MariaDB|仅验证/.test(e.message)) throw e; throw new Error('MySQL 目录读取失败，请检查只读连接与权限；未返回凭据或替代目录'); }
    finally { await c?.end().catch(() => {}); }
  }
  async read(config: MysqlConfig, expected: MysqlTable, limits: { pageSize: number; maxRows: number }, page: (value: MysqlPage) => Promise<void>) {
    z.number().int().min(1).max(1000).parse(limits.pageSize); z.number().int().min(1).max(1000000).parse(limits.maxRows);
    if (!expected.primaryKey.length) throw new Error('来源表缺少稳定主键，不能猜测记录身份');
    if (expected.engine !== 'InnoDB') throw new Error('当前完整读取只支持 InnoDB 一致性边界');
    if (expected.columns.length > 200 || expected.columns.some(c => /blob|binary|geometry|vector|bit\(/i.test(c.type))) throw new Error('表含当前不支持的二进制/空间类型或超过列预算，请配置精简授权视图后接入');
    let c: Connection | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
    const startedAt = new Date().toISOString();
    try {
      c = await this.connect(config);
      deadline = setTimeout(() => c?.destroy(), 120000); deadline.unref();
      const before = await this.describe(c);
      if (fingerprint(before.tables.find(t => t.name === expected.name && t.schema === expected.schema)) !== fingerprint(expected)) throw new Error('目录结构已变化，请重新探查');
      await c.query("SET SESSION time_zone = '+00:00'");
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const full = `${quote(expected.schema)}.${quote(expected.name)}`;
      const projection = expected.columns.map(col => `CAST(t.${quote(col.name)} AS CHAR) AS ${quote(col.name)}`).join(',');
      const order = expected.primaryKey.map(k => `t.${quote(k)}`).join(',');
      let last: string[] | null = null, count = 0, index = 0;
      for (;;) {
        const where = last ? ` WHERE (${order}) > (${last.map(() => '?').join(',')})` : '';
        const values: unknown[] = last ?? [];
        const data = await rows(c, `SELECT ${projection} FROM ${full} AS t${where} ORDER BY ${order} LIMIT ${limits.pageSize}`, values);
        if (!data.length) break;
        count += data.length;
        if (count > limits.maxRows) throw new Error('读取超过本轮上限，未形成完整批次，不允许据此删除或激活');
        const records = data.map(r => {
          const values = Object.fromEntries(expected.columns.map(col => [col.name, r[col.name] === null ? null : String(r[col.name])]));
          const keys = expected.primaryKey.map(k => values[k]);
          if (keys.some(k => k === null)) throw new Error('主键值无效，不能完成批次');
          return { key: JSON.stringify(keys), values };
        });
        await page({ index: index++, records });
        last = expected.primaryKey.map(k => String(data.at(-1)![k]));
      }
      const after = await this.describe(c);
      if (fingerprint(after.tables.find(t => t.name === expected.name && t.schema === expected.schema)) !== fingerprint(expected)) throw new Error('目录结构在读取期间变化，批次无效');
      await c.rollback();
      return { complete: true, rows: count, pages: index, startedAt, finishedAt: new Date().toISOString(), schemaHash: fingerprint(expected), consistency: 'single_connection_innodb_repeatable_read', directoryCoverage: 'configured_table_only' };
    } catch (e) {
      await c?.rollback().catch(() => {});
      if (e instanceof Error && /上限|完整批次|主键|目录结构/.test(e.message)) throw e;
      throw new Error('MySQL 读取未完成，未激活资料；断线需重新读取一致性批次，不按旧游标推断删除');
    } finally { if (deadline) clearTimeout(deadline); await c?.end().catch(() => {}); }
  }
}

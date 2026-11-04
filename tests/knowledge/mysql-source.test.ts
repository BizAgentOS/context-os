import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MysqlReader } from '../../src/knowledge/mysql-reader.ts';

const url = process.env.CONTEXT_OS_KNOWLEDGE_TEST_MYSQL_URL;
test('native MySQL metadata and bounded complete reads preserve precise values and composite keys', { skip: !url }, async () => {
  const { createConnection } = await import('mysql2/promise');
  const setup = await createConnection(url!);
  const owned: string[] = [];
  try {
    const [existing] = await setup.query("SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE()");
    assert.equal((existing as any[]).length, 0, "MySQL integration tests require an empty dedicated schema");
    await setup.query('CREATE TABLE vendors (code varchar(30) PRIMARY KEY, name varchar(50)) ENGINE=InnoDB');
    owned.push('vendors');
    await setup.query("CREATE TABLE contracts (tenant int NOT NULL, code varchar(30) COLLATE utf8mb4_bin NOT NULL COMMENT '合同编号', vendor varchar(30), amount decimal(30,2), large_id bigint unsigned, effective date, PRIMARY KEY(tenant,code), FOREIGN KEY(vendor) REFERENCES vendors(code)) ENGINE=InnoDB COMMENT='合同业务记录'");
    owned.push('contracts');
    await setup.query("INSERT INTO vendors VALUES ('V1','示例公司')");
    await setup.query("INSERT INTO contracts VALUES (1,'A','V1',123456789012345678901.12,18446744073709551615,'2026-04-01'),(1,'B','V1',200.00,42,NULL),(2,'A','V1',300.00,43,NULL)");
    await setup.query('CREATE TABLE numeric_keys (id int PRIMARY KEY) ENGINE=InnoDB'); owned.push('numeric_keys');
    await setup.query('INSERT INTO numeric_keys VALUES (1),(2),(10),(11)');
    const reader = new MysqlReader();
    const config = { ...Object.fromEntries([]), url: url! };
    const catalog = await reader.catalog(config);
    const numeric: string[] = [];
    await reader.read(config, catalog.tables.find(t => t.name === 'numeric_keys')!, {pageSize:2,maxRows:10}, async p => {numeric.push(...p.records.map(r => r.values.id!));});
    assert.deepEqual(numeric, ['1','2','10','11']);
    const table = catalog.tables.find(t => t.name === 'contracts')!;
    assert.deepEqual(table.primaryKey, ['tenant', 'code']);
    assert.equal(table.comment, '合同业务记录');
    assert.equal(table.columns.find(c => c.name === 'code')!.comment, '合同编号');
    assert.equal(table.foreignKeys.length, 1);
    const pages: any[] = [];
    const receipt = await reader.read(config, table, { pageSize: 1, maxRows: 10 }, async page => { pages.push(page); });
    assert.equal(receipt.complete, true); assert.equal(receipt.rows, 3); assert.equal(pages.length, 3);
    assert.equal(pages[0].records[0].values.amount, '123456789012345678901.12');
    assert.equal(pages[0].records[0].values.large_id, '18446744073709551615');
    assert.equal(pages[0].records[0].values.effective, '2026-04-01');
    assert.equal(pages[1].records[0].values.effective, null);
    assert.equal(new Set(pages.flatMap(p => p.records.map((r: any) => r.key))).size, 3);
    await assert.rejects(reader.read(config, table, { pageSize: 1, maxRows: 2 }, async () => {}), /上限|完整/);
    await assert.rejects(reader.read(config, { ...table, primaryKey: [] }, { pageSize: 1, maxRows: 10 }, async () => {}), /主键/);
  } finally { for (const name of owned.reverse()) await setup.query('DROP TABLE `'+name+'`'); await setup.end(); }
});

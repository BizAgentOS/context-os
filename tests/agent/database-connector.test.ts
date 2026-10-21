import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { SourceConnections } from "../../src/live/sources.ts";

test("database connections expose selected tables through the shared read contract without exposing credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ade-database-")), memory = new MemoryStore(dir);
  const rows = [{ id: "001", name: "南区门店" }, { id: "002", name: "北区门店" }];
  const scanner = {
    async tables() { return [{ schema: "public", table: "stores", estimatedRows: 2, columns: [{ name: "id", type: "VARCHAR" }, { name: "name", type: "VARCHAR" }], primaryKey: ["id"] }]; },
    async read(_config: unknown, _table: unknown, where: Record<string, unknown>, offset: number, limit: number) {
      const all = rows.filter(row => Object.entries(where).every(([k, v]) => row[k as keyof typeof row] === v));
      return { items: all.slice(offset, offset + limit), total: all.length };
    },
    async snapshot(_config: unknown, _table: unknown, limit: number, _file: string) {
      return { rows: Math.min(rows.length, limit), total: rows.length, complete: rows.length <= limit };
    },
  };
  try {
    const sources = new SourceConnections(dir, memory, scanner);
    const config = { name: "仓配库", kind: "postgres", host: "127.0.0.1", database: "warehouse", user: "readonly", password: "secret-for-test" };
    const preview = await sources.databases.test(config);
    assert.equal(preview.readOnly, true);
    assert.equal(memory.listArtifacts("source_connection").length, 0);
    const connected = await sources.databases.connect(config);
    assert.equal(JSON.stringify(connected).includes(config.password), false);
    const selected = await sources.databases.select({ id: connected.id, version: connected.version, tables: [{ schema: "public", table: "stores" }] });
    assert.equal((selected.content.capabilities as any[])[0].name, "public.stores");
    const result = await sources.readRecords(selected.id, "public.stores", { id: "001" });
    assert.deepEqual(result.items, [rows[0]]);
    assert.equal(result.coverage.complete, true);
    assert.deepEqual((await new SourceConnections(dir, memory, scanner).readRecords(selected.id, "public.stores", { id: "002" })).items, [rows[1]], "private credentials survive a host restart");
    assert.equal(statSync(join(dir, "database-credentials.json")).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(dir, "database-credentials.json"), "utf8").includes(config.password), true);
    await assert.rejects(sources.databases.select({ id: selected.id, version: selected.version, tables: [{ schema: "public", table: "missing" }] }), /不存在/);
    await assert.rejects(sources.databases.test({ ...config, sql: "DROP TABLE stores" }), /Unrecognized|sql/);
    sources.disable(selected.id, selected.version);
    await assert.rejects(sources.readRecords(selected.id, "public.stores"), /停用/);
    assert.equal(readFileSync(join(dir, "database-credentials.json"), "utf8").includes(config.password), false);
  } finally { memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("revocation during table discovery cannot re-enable a database connection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ade-database-race-")), memory = new MemoryStore(dir);
  let pause = false, unblock: () => void = () => {}, entered: () => void = () => {};
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const scanner = {
    async tables() { if (pause) { entered(); await new Promise<void>(resolve => { unblock = resolve; }); } return [{ schema: "public", table: "stores", estimatedRows: 1, columns: [{ name: "id", type: "VARCHAR" }], primaryKey: ["id"] }]; },
    async read() { return { items: [{ id: "001" }], total: 1 }; },
    async snapshot() { return { rows: 1, total: 1, complete: true }; },
  };
  try {
    const sources = new SourceConnections(dir, memory, scanner);
    const connected = await sources.databases.connect({ name: "库", kind: "postgres", host: "localhost", database: "db", user: "reader", password: "fixture" });
    pause = true;
    const selection = sources.databases.select({ id: connected.id, version: connected.version, tables: [{ schema: "public", table: "stores" }] });
    await waiting; sources.disable(connected.id, connected.version); unblock();
    await assert.rejects(selection, /停用|变化/);
    assert.equal(memory.getArtifact(connected.id).status, "disabled");
    assert.deepEqual(memory.getArtifact(connected.id).content.capabilities, []);
  } finally { memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("schema confirmation rejects a concurrent type-only contract change and replays an identical accepted schema", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ade-database-schema-race-")), memory = new MemoryStore(dir);
  let amountType = "INTEGER";
  const scanner = {
    async tables() { return [{ schema: "public", table: "orders", estimatedRows: 1, columns: [{ name: "id", type: "VARCHAR" }, { name: "amount", type: amountType }], primaryKey: ["id"] }]; },
    async read() { return { items: [{ id: "001", amount: 1 }], total: 1 }; },
    async snapshot() { return { rows: 1, total: 1, complete: true }; },
  };
  try {
    const sources = new SourceConnections(dir, memory, scanner);
    const connected = await sources.databases.connect({ name: "库", kind: "postgres", host: "localhost", database: "db", user: "reader", password: "fixture" });
    const original = await sources.databases.select({ id: connected.id, version: connected.version, tables: [{ schema: "public", table: "orders" }] });
    amountType = "DOUBLE";
    const concurrent = await sources.databases.select({ id: original.id, version: original.version, tables: [{ schema: "public", table: "orders" }] });
    const pending = [{ name: "id", type: "VARCHAR" }, { name: "amount", type: "DECIMAL(18,2)" }];
    assert.throws(() => sources.databases.acceptSchema(original.id, "public.orders", original.version, pending), /变化/);
    assert.equal(memory.getArtifact(original.id).version, concurrent.version);
    const accepted = sources.databases.acceptSchema(concurrent.id, "public.orders", concurrent.version, pending);
    const replay = sources.databases.acceptSchema(original.id, "public.orders", original.version, pending);
    assert.equal(replay.version, accepted.version);
    assert.equal((replay.content.databaseTables as any[])[0].columns[1].type, "DECIMAL(18,2)");
  } finally { memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

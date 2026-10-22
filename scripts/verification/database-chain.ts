/** Real local container acceptance. Credentials and data below belong only to disposable fixtures. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "../../src/agent/server.ts";
import type { AddressInfo } from "node:net";
import { SyncGovernance } from "../../src/data/sync-governance.ts";
import { sourceSummary } from "../../src/agent/source-summary.ts";
import type { Data } from "../../src/agent/contracts.ts";

const docker = (args: string[], input?: string) => execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 180_000 }).trim();
const suffix = randomUUID().slice(0, 8), directory = mkdtempSync(join(tmpdir(), "context-os-database-chain-"));
const containers: string[] = [], service = await createServer({ directory, automaticApi: false }), app = service.app;
service.server.listen(0, "127.0.0.1");
await new Promise<void>(resolve => service.server.once("listening", resolve));
const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
async function api(path: string, body?: unknown) {
  const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "x-contextos-token": service.adminToken },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "请求失败");
  return value;
}
const originalCap = process.env.CONTEXT_OS_SNAPSHOT_MAX_ROWS;
const adminPassword = "context_os058-local-admin", password = "context_os058-local-reader";
const selectedConnections: Array<{ id: string; capability: string }> = [];

async function fixture(kind: "postgres" | "mysql") {
  const name = `context_os058-${kind}-${suffix}`, image = kind === "postgres" ? "pgvector/pgvector:pg16" : "mysql:8.4", port = kind === "postgres" ? 5432 : 3306;
  containers.push(name);
  docker(["run", "-d", "--rm", "--name", name, "-p", `127.0.0.1::${port}`, ...(kind === "postgres" ? ["-e", `POSTGRES_PASSWORD=${adminPassword}`, "-e", "POSTGRES_DB=context_os058"] : ["-e", `MYSQL_ROOT_PASSWORD=${adminPassword}`, "-e", "MYSQL_DATABASE=context_os058"]), image]);
  const admin = (sql: string) => docker(kind === "postgres" ? ["exec", "-i", name, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "context_os058"]
    : ["exec", "-i", "-e", `MYSQL_PWD=${adminPassword}`, name, "mysql", "--default-character-set=utf8mb4", "-uroot", "context_os058"], sql);
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try { admin("SELECT 1;"); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  assert.ok(ready, `${kind} container becomes ready`);
  admin(`CREATE TABLE stores (id VARCHAR(20) PRIMARY KEY, name VARCHAR(100), amount DECIMAL(10,2), updated_at TIMESTAMP DEFAULT '2026-01-01 00:00:00');
    INSERT INTO stores (id,name,amount) VALUES ('001','南区门店',12.50),('002','北区门店',20.25);
    CREATE TABLE shipments (id INTEGER PRIMARY KEY, store_id VARCHAR(20));
    INSERT INTO shipments VALUES (1,'001'),(2,'002'),(3,'001');`);
  admin(kind === "postgres" ? `CREATE USER context_os_reader WITH PASSWORD '${password}'; GRANT USAGE ON SCHEMA public TO context_os_reader; GRANT SELECT ON ALL TABLES IN SCHEMA public TO context_os_reader; ANALYZE;`
    : `CREATE USER 'context_os_reader'@'%' IDENTIFIED BY '${password}'; GRANT SELECT ON context_os058.* TO 'context_os_reader'@'%'; ANALYZE TABLE stores,shipments;`);
  const boundPort = Number(docker(["port", name, String(port)]).split(":").at(-1));
  return { name, admin, config: { name: `${kind} 隔离验收库`, kind, host: "127.0.0.1", port: boundPort, database: "context_os058", user: "context_os_reader", password }, schema: kind === "postgres" ? "public" : "context_os058" };
}

try {
  for (const kind of (process.argv.includes("--postgres-only") ? ["postgres"] : ["postgres", "mysql"]) as Array<"postgres" | "mysql">) {
    const f = await fixture(kind);
    const checked = await api("/api/databases/test", f.config);
    assert.equal(checked.readOnly, true); assert.equal(checked.tables.length, 2);
    assert.ok(!JSON.stringify(checked).includes(password));
    assert.deepEqual(checked.tables.find((table: any) => table.table === "stores")!.primaryKey, ["id"]);
    await assert.rejects(api("/api/databases/test", { ...f.config, password: "incorrect-private-value" }), error => error instanceof Error && /权限|连接/.test(error.message) && !error.message.includes("incorrect-private-value"));
    const created = await api("/api/databases/connect", f.config);
    const listed = await api(`/api/databases/tables?id=${encodeURIComponent(created.id)}`);
    assert.equal(listed.tables.length, 2);
    let selected = await api("/api/databases/select", { id: created.id, version: created.version,
      tables: checked.tables.map((table: any) => ({ schema: table.schema, table: table.table })) });
    assert.ok(!JSON.stringify(selected).includes(password));
    const cap = `${f.schema}.stores`;
    const page = await app.live.sources.readRecords(selected.id, cap, { id: "001" });
    assert.equal(page.items[0].name, "南区门店"); assert.equal(page.items[0].id, "001"); assert.equal(page.coverage.total, 1);
    new SyncGovernance(app.memory, app.snapshots).configure({ sourceId: selected.id, schedule: { mode: "manual" }, incrementalField: "updated_at" });
    const synced = await app.snapshots.sync({ operationId: `sync-${kind}`, sourceIds: [selected.id] });
    assert.equal(synced.content.outcome, "synced", JSON.stringify(synced.content.issues));
    const data = app.snapshots.datasets().find(dataset => dataset.content.sourceId === selected.id && dataset.content.capability === cap)!;
    assert.equal(((data.content.profile as Data).columns as Data[]).find(column => column.name === "amount")!.type, "DECIMAL(10,2)");
    const historical = String(data.content.activeVersion);
    assert.equal((await app.snapshots.preview({ datasetId: data.id })).rows[0].id, "001");
    assert.equal(sourceSummary(app.memory).sources.filter(source => source.connectionId === selected.id).length, 2);
    f.admin("UPDATE stores SET name='增量门店', updated_at='2026-01-02 00:00:00' WHERE id='001';");
    const incremented = await app.snapshots.sync({ operationId: `increment-${kind}`, sourceIds: [selected.id] });
    assert.equal(incremented.content.outcome, "synced", JSON.stringify(incremented.content.issues));
    const incrementData = app.snapshots.dataset(data.id), incrementSnapshot = app.memory.getArtifact(String(incrementData.content.activeVersion));
    assert.equal(incrementSnapshot.content.syncMode, "incremental");
    assert.equal((await app.snapshots.preview({ datasetId: data.id })).rows[0].name, "增量门店");
    assert.equal((incrementData.content.profile as Data).rows, 2);
    assert.equal(((incrementData.content.profile as Data).columns as Data[]).find(column => column.name === "amount")!.type, "DECIMAL(10,2)");
    const delta = await app.live.sources.databases.snapshot(selected.id, cap, selected.version, 100, join(directory, `${kind}-delta.parquet`), { field: "updated_at", since: "2026-01-02 00:00:00" });
    assert.equal(delta.rows, 1, "native read-only scanner applies the update boundary before transport");
    const beforeSchema = incrementData.content.activeVersion;
    f.admin("ALTER TABLE stores ADD COLUMN region VARCHAR(30); UPDATE stores SET region='城区';");
    await app.snapshots.sync({ operationId: `schema-${kind}`, sourceIds: [selected.id], full: true });
    const pending = app.snapshots.dataset(data.id);
    assert.ok(pending.content.pendingVersion); assert.equal(pending.content.activeVersion, beforeSchema);
    app.snapshots.accept({ id: pending.id, version: pending.version, operationId: `accept-schema-${kind}` });
    selected = app.memory.getArtifact(selected.id);
    assert.equal((await app.live.sources.readRecords(selected.id, cap)).items[0].region, "城区", "accepting the schema promotes the selected table contract too");
    f.admin("UPDATE stores SET name='新门店名称' WHERE id='001';");
    process.env.CONTEXT_OS_SNAPSHOT_MAX_ROWS = "1";
    const limited = await app.snapshots.sync({ operationId: `limited-${kind}`, sourceIds: [selected.id], full: true });
    assert.ok((limited.content.issues as Data[]).some(issue => issue.code === "snapshot_capacity"));
    const limitedData = app.snapshots.dataset(data.id);
    assert.equal((limitedData.content.coverage as Data).complete, false);
    assert.equal((limitedData.content.coverage as Data).rows, 1);
    assert.equal((await app.snapshots.preview({ datasetId: data.id, snapshotId: historical })).rows[0].name, "南区门店");
    delete process.env.CONTEXT_OS_SNAPSHOT_MAX_ROWS;
    await app.snapshots.sync({ operationId: `full-${kind}`, sourceIds: [selected.id] });
    assert.equal((await app.snapshots.preview({ datasetId: data.id })).rows[0].name, "新门店名称");
    const build = await app.programBuilds.build({ operationId: `build-${kind}` });
    assert.equal(build.status, "completed", JSON.stringify(build.content.issues));
    const candidate = app.programBuilds.overview().candidate!;
    assert.ok(candidate, `selected database tables produce an ontology candidate: ${JSON.stringify(build.content)}`);
    const verified = await app.programBuilds.check({ id: candidate.id, version: candidate.version });
    assert.equal((verified.content.checks as Data).valid, true, JSON.stringify(verified.content.checks));
    // Explicit adoption here simulates a human review; this test makes no model claims.
    const adopted = await app.programBuilds.adopt({ id: verified.id, version: verified.version, operationId: `adopt-${kind}` });
    const type = (adopted.model.content.types as Data[]).find(type => type.sourceId === selected.id && type.capability === cap)!;
    assert.ok(type, "the table is bound to its own business object");
    const object = await api("/api/live/query", { modelId: adopted.model.id, type: type.name, id: "001" });
    assert.equal(object.items[0].name, "新门店名称");
    // Prove the source-side fixture account itself cannot write; this does not use an application SQL endpoint.
    const write = spawnSync("docker", kind === "postgres" ? ["exec", "-e", `PGPASSWORD=${password}`, f.name, "psql", "-h", "127.0.0.1", "-U", "context_os_reader", "-d", "context_os058", "-v", "ON_ERROR_STOP=1", "-c", "DELETE FROM stores"]
      : ["exec", "-e", `MYSQL_PWD=${password}`, f.name, "mysql", "-ucontext_os_reader", "context_os058", "-e", "DELETE FROM stores"], { encoding: "utf8" });
    assert.notEqual(write.status, 0, "the database account is SELECT-only");
    selectedConnections.push({ id: selected.id, capability: cap });
    console.log(`${kind}: HTTP connection, read-only discovery, exact types, schema acceptance, ontology/query, row cap and history passed`);
  }
  for (const selected of selectedConnections) {
    app.live.sources.disable(selected.id, app.memory.getArtifact(selected.id).version);
    await assert.rejects(app.live.sources.readRecords(selected.id, selected.capability), /停用/);
    assert.ok(!readFileSync(join(directory, "database-credentials.json"), "utf8").includes(selected.id));
  }
  console.log("Both source-side read-only permissions and immediate revocation passed.");
  console.log(`Database connector acceptance passed (${process.argv.includes("--postgres-only") ? "PostgreSQL focused run" : "real isolated PostgreSQL and MySQL"}; no model simulation).`);
} finally {
  if (originalCap === undefined) delete process.env.CONTEXT_OS_SNAPSHOT_MAX_ROWS; else process.env.CONTEXT_OS_SNAPSHOT_MAX_ROWS = originalCap;
  await service.close();
  for (const name of containers) { try { docker(["rm", "-f", name]); } catch { /* already removed */ } }
  rmSync(directory, { recursive: true, force: true });
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { MemoryStore } from "../../src/agent/memory.ts";
import { LiveMemory } from "../../src/live/memory.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { Snapshots } from "../../src/data/snapshots.ts";
import { snapshotFile } from "../../src/data/executor/paths.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ade-snapshots-"));
  const memory = new MemoryStore(directory);
  const live = new LiveMemory(directory, memory);
  const snapshots = new Snapshots(memory, live, directory);
  return { memory, live, snapshots, directory, workspace: new Workspace(memory),
    async close() { await snapshots.close(); memory.close(); rmSync(directory, { recursive: true, force: true }); } };
}

async function records(rows: () => Array<Record<string, unknown>>) {
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost"), all = rows();
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 20);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: all.slice(offset, offset + limit), total: all.length }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

test("an uploaded CSV becomes an immutable profiled snapshot; unchanged data adds no version and old versions stay readable", async () => {
  const f = fixture();
  try {
    const source = f.workspace.upload("企业.csv", "企业编号,企业名称\nA001,青山\nA002,海川\n");
    const run = await f.snapshots.sync({ operationId: "sync-1" });
    assert.equal(run.status, "completed", JSON.stringify(run.content));
    const [dataset] = f.snapshots.overview().datasets;
    assert.equal(dataset.content.sourceId, source.id);
    assert.equal(dataset.content.sourceVersion, source.version);
    const first = dataset.content.activeVersion as string;
    const profile = dataset.content.profile as any;
    assert.equal(profile.rows, 2);
    assert.equal(profile.columns.find((c: any) => c.name === "企业编号").primaryKey, true);
    assert.equal(profile.columns.find((c: any) => c.name === "企业编号").type, "VARCHAR", "identities keep their text form");
    assert.ok(existsSync(snapshotFile(join(f.directory, "data"), "workspace", first)));
    assert.equal((await f.snapshots.sync({ operationId: "sync-1" })).id, run.id, "operation ids are idempotent");

    await f.snapshots.sync({ operationId: "sync-2" });
    assert.deepEqual(f.snapshots.overview().datasets[0].content.versions, [first], "the same rows do not create a version");

    f.workspace.upload("企业.csv", "企业编号,企业名称\nA001,青山集团\nA002,海川\nA003,远山\n");
    await f.snapshots.sync({ operationId: "sync-3" });
    const updated = f.snapshots.overview().datasets[0];
    const second = updated.content.activeVersion as string;
    assert.notEqual(second, first);
    assert.deepEqual(updated.content.versions, [second, first]);
    const old = await f.snapshots.preview({ datasetId: updated.id, snapshotId: first });
    assert.equal(old.snapshot.status, "historical");
    assert.deepEqual(old.rows.map(r => r["企业名称"]), ["青山", "海川"]);
    const now = await f.snapshots.query([updated.id], `SELECT count(*) AS n FROM ${f.snapshots.table(updated.id)}`);
    assert.equal(Number(now.rows[0].n), 3);
    assert.deepEqual(now.inputs, [{ datasetId: updated.id, snapshotId: second }]);
  } finally { await f.close(); }
});

test("a schema change stays pending until accepted while the active version keeps serving reads", async () => {
  const f = fixture();
  try {
    f.workspace.upload("orders.csv", "id,company_id\nO1,A001\nO2,A002\n");
    await f.snapshots.sync({ operationId: "a" });
    const before = f.snapshots.overview().datasets[0];
    f.workspace.upload("orders.csv", "id,company_id,amount\nO1,A001,10\nO2,A002,20\n");
    const run = await f.snapshots.sync({ operationId: "b" });
    const drifted = f.snapshots.overview().datasets[0];
    assert.equal(drifted.content.activeVersion, before.content.activeVersion);
    assert.ok(drifted.content.pendingVersion);
    assert.deepEqual(drifted.content.pendingChanges, [{ column: "amount", before: null, after: "VARCHAR" }], "the user sees which columns change before confirming");
    assert.ok((run.content.issues as any[]).some(issue => issue.code === "schema_drift"));
    const active = await f.snapshots.preview({ datasetId: drifted.id });
    assert.deepEqual(Object.keys(active.rows[0]).sort(), ["company_id", "id"]);
    assert.throws(() => f.snapshots.accept({ id: drifted.id, version: drifted.version - 1, operationId: "x" }), /版本/);
    const accepted = f.snapshots.accept({ id: drifted.id, version: drifted.version, operationId: "accept" });
    assert.equal(accepted.content.activeVersion, drifted.content.pendingVersion);
    assert.equal(accepted.content.pendingVersion, null);
    assert.equal(accepted.content.pendingChanges, undefined);
    assert.equal(f.snapshots.accept({ id: drifted.id, version: drifted.version, operationId: "accept" }).version, accepted.version);
  } finally { await f.close(); }
});

test("an HTTP source is synced across all pages with explicit coverage, and uniqueness loss is reported", async () => {
  const f = fixture();
  let rows = Array.from({ length: 250 }, (_, i) => ({ id: `C${i}`, name: `公司${i}` }));
  const api = await records(() => rows);
  try {
    const source = await f.live.sources.connect({ name: "企业目录", protocol: "http", url: api.url,
      capabilities: [{ name: "companies", path: "/companies", fields: ["id", "name"], idField: "id", totalPath: "total" }] });
    const run = await f.snapshots.sync({ operationId: "http", sourceIds: [source.id] });
    assert.equal(run.status, "completed", JSON.stringify(run.content));
    const dataset = f.snapshots.overview().datasets[0];
    assert.equal(dataset.content.connectionId, source.id);
    assert.equal(dataset.content.capability, "companies");
    assert.deepEqual(dataset.content.coverage, { rows: 250, total: 250, complete: true });
    assert.equal((dataset.content.profile as any).rows, 250);

    rows = rows.map((row, i) => ({ ...row, name: i < 2 ? "同名" : row.name }));
    const second = await f.snapshots.sync({ operationId: "http-2", sourceIds: [source.id] });
    assert.ok((second.content.issues as any[]).some(issue => issue.code === "uniqueness_lost" && issue.details.column === "name"));
  } finally { await api.close(); await f.close(); }
});

test("identical saved rows with changed source coverage create a new version, while identical coverage reuses it", async () => {
  const f = fixture(), priorLimit = process.env.ADE_SNAPSHOT_MAX_ROWS;
  const original = Array.from({ length: 10 }, (_, i) => ({ id: `C${i}`, name: `公司${i}` }));
  let rows = original;
  const api = await records(() => rows);
  process.env.ADE_SNAPSHOT_MAX_ROWS = "10";
  try {
    const source = await f.live.sources.connect({ name: "企业目录", protocol: "http", url: api.url,
      capabilities: [{ name: "companies", path: "/companies", fields: ["id", "name"], idField: "id", totalPath: "total" }] });
    await f.snapshots.sync({ operationId: "complete", sourceIds: [source.id] });
    const complete = f.snapshots.overview().datasets[0];
    assert.deepEqual(complete.content.coverage, { rows: 10, total: 10, complete: true });

    rows = [...original, { id: "C10", name: "公司10" }, { id: "C11", name: "公司11" }];
    await f.snapshots.sync({ operationId: "partial", sourceIds: [source.id] });
    const partial = f.snapshots.overview().datasets[0];
    assert.deepEqual(partial.content.coverage, { rows: 10, total: 12, complete: false });
    assert.notEqual(partial.content.activeVersion, complete.content.activeVersion, "coverage is an immutable part of a snapshot observation");

    await f.snapshots.sync({ operationId: "same-partial", sourceIds: [source.id] });
    assert.deepEqual(f.snapshots.overview().datasets[0].content.versions, partial.content.versions);

    rows = original;
    await f.snapshots.sync({ operationId: "complete-again", sourceIds: [source.id] });
    const restored = f.snapshots.overview().datasets[0];
    assert.deepEqual(restored.content.coverage, { rows: 10, total: 10, complete: true });
    assert.notEqual(restored.content.activeVersion, partial.content.activeVersion);
    assert.deepEqual((await f.snapshots.preview({ datasetId: restored.id, snapshotId: partial.content.activeVersion })).rows, original);
  } finally {
    if (priorLimit === undefined) delete process.env.ADE_SNAPSHOT_MAX_ROWS; else process.env.ADE_SNAPSHOT_MAX_ROWS = priorLimit;
    await api.close(); await f.close();
  }
});

test("snapshot queries run one read-only statement in an isolated process", async () => {
  const f = fixture();
  try {
    f.workspace.upload("a.csv", "id\n1\n");
    await f.snapshots.sync({ operationId: "q" });
    const id = f.snapshots.overview().datasets[0].id, table = f.snapshots.table(id);
    await assert.rejects(f.snapshots.query([id], `SELECT 1; SELECT 2`), /single SELECT/);
    await assert.rejects(f.snapshots.query([id], `DELETE FROM ${table}`), /single SELECT/);
    await assert.rejects(f.snapshots.query([id], `SELECT * FROM read_csv_auto('/etc/hosts')`), /disabled|Permission|external/i);
    await assert.rejects(f.snapshots.query(["missing"], "SELECT 1"), /数据集/);
  } finally { await f.close(); }
});

test("a live policy skips materialization and a restart marks a running sync interrupted", async () => {
  const f = fixture();
  try {
    f.workspace.upload("live.csv", "id\n1\n");
    await f.snapshots.sync({ operationId: "first" });
    const dataset = f.snapshots.overview().datasets[0];
    const live = f.snapshots.setPolicy({ id: dataset.id, version: dataset.version, materialization: "live" });
    f.workspace.upload("live.csv", "id\n1\n2\n");
    await f.snapshots.sync({ operationId: "second" });
    assert.equal(f.snapshots.overview().datasets[0].content.activeVersion, live.content.activeVersion, "a live dataset keeps its last snapshot only as history");

    f.memory.putArtifact({ kind: "data_sync", title: "同步数据快照", status: "running", content: { operationId: "stuck", inputHash: "x", issues: [], progress: [], outcome: "pending" } });
    const restarted = new Snapshots(f.memory, f.live, f.directory);
    assert.equal(restarted.overview().jobs.find(job => job.content.operationId === "stuck")!.status, "interrupted");
    await restarted.close();
  } finally { await f.close(); }
});

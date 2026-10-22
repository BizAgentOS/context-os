import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { MemoryStore } from "../../src/agent/memory.ts";
import { LiveMemory } from "../../src/live/memory.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { Snapshots } from "../../src/data/snapshots.ts";
import type { Capability } from "../../src/live/sources.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "context-os-snapshot-values-"));
  const memory = new MemoryStore(directory), live = new LiveMemory(directory, memory);
  const snapshots = new Snapshots(memory, live, directory);
  return { live, snapshots, workspace: new Workspace(memory),
    async close() { await snapshots.close(); memory.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function capability(fields: string[]): Capability {
  return { name: "records", contentKind: "records", fields, idField: "id", idType: "string", itemsPath: "items", filters: {}, limitParam: "limit", offsetParam: "offset" };
}

test("CSV snapshots preserve date and time text and remain readable by the original literal values", async () => {
  const f = fixture();
  try {
    const row = { id: "001", day: "2026-10-15", time: "12:34:56.1200", timestamp: "2026-10-15T12:30:01.123456Z", offset: "2026-10-15T12:30:01.123+08:00", enabled: "true" };
    const source = f.workspace.upload("dates.csv", `${Object.keys(row).join(",")}\n${Object.values(row).join(",")}\n`);
    const run = await f.snapshots.sync({ operationId: "csv-values" });
    assert.equal(run.status, "completed", JSON.stringify(run.content));
    const [dataset] = f.snapshots.overview().datasets;
    assert.deepEqual((await f.snapshots.preview({ datasetId: dataset.id })).rows, [row]);
    const cap = capability(Object.keys(row));
    for (const field of ["day", "time", "timestamp", "offset"] as const) {
      const result = await f.snapshots.readPinned(dataset.content.activeVersion as string, cap,
        { sourceId: source.id, connectionVersion: source.version }, { [field]: row[field] }, 0, 50);
      assert.deepEqual(result.items, [row], `filtering ${field} must use the unchanged source value`);
    }
  } finally { await f.close(); }
});

test("HTTP snapshots retain string literals alongside native numbers and booleans", async () => {
  const f = fixture();
  const row = { id: 7, amount: 12.5, enabled: true, day: "2026-10-15", time: "12:34:56.1200", timestamp: "2026-10-15T12:30:01.123456Z", offset: "2026-10-15T12:30:01.123+08:00" };
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: [row], total: 1 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const cap: Capability = { ...capability(Object.keys(row)), path: "/records", idType: "number", totalPath: "total" };
    const source = await f.live.sources.connect({ name: "Events", protocol: "http", url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, capabilities: [cap] });
    const run = await f.snapshots.sync({ operationId: "http-values", sourceIds: [source.id] });
    assert.equal(run.status, "completed", JSON.stringify(run.content));
    const [dataset] = f.snapshots.overview().datasets;
    assert.ok(dataset, JSON.stringify(run.content));
    const binding = { sourceId: source.id, connectionVersion: source.version };
    const pinned = dataset.content.activeVersion as string;
    assert.deepEqual((await f.snapshots.readPinned(pinned, cap, binding, {}, 0, 50)).items, [row]);
    for (const [field, value] of Object.entries(row)) {
      assert.deepEqual((await f.snapshots.readPinned(pinned, cap, binding, { [field]: value }, 0, 50)).items, [row],
        `filtering ${field} must retain the source value and type`);
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});

test("snapshot string typing retains both values when source keys differ only by case", async () => {
  const f = fixture();
  try {
    f.workspace.upload("names.csv", "id,Name,name,name_1,created\nC1,First,Second,Third,2026-10-15T12:30:01.123+08:00\n");
    const run = await f.snapshots.sync({ operationId: "case-sensitive-values" });
    assert.equal(run.status, "completed", JSON.stringify(run.content));
    const [dataset] = f.snapshots.overview().datasets;
    assert.ok(dataset, JSON.stringify(run.content));
    assert.deepEqual((await f.snapshots.preview({ datasetId: dataset.id })).rows,
      [{ id: "C1", Name: "First", name_1: "Second", name_1_1: "Third", created: "2026-10-15T12:30:01.123+08:00" }]);
  } finally { await f.close(); }
});

test("nullable HTTP fields retain their values and source key order alongside case-sensitive collisions", async () => {
  const f = fixture();
  const rows = [
    { id: "C1", Name: "First", name: null, name_1: null, created: "2026-10-15T12:30:01.123+08:00" },
    { created: "2026-10-16T12:30:01.123Z", name_1: "Third", name: "Second", id: "C2", Name: "Fourth" },
  ];
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: rows, total: rows.length }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const cap: Capability = { ...capability(["id", "Name", "name", "name_1", "created"]), path: "/records", totalPath: "total" };
    const source = await f.live.sources.connect({ name: "Sparse names", protocol: "http", url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, capabilities: [cap] });
    const run = await f.snapshots.sync({ operationId: "sparse-values", sourceIds: [source.id] });
    assert.equal(run.status, "completed", JSON.stringify(run.content));
    const [dataset] = f.snapshots.overview().datasets;
    assert.ok(dataset, JSON.stringify(run.content));
    assert.deepEqual((await f.snapshots.preview({ datasetId: dataset.id })).rows, [
      { id: "C1", Name: "First", name_1: null, name_1_1: null, created: "2026-10-15T12:30:01.123+08:00" },
      { id: "C2", Name: "Fourth", name_1: "Second", name_1_1: "Third", created: "2026-10-16T12:30:01.123Z" },
    ]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});

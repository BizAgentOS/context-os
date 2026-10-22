import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { MemoryStore } from "../../src/agent/memory.ts";
import { LiveMemory } from "../../src/live/memory.ts";
import { Snapshots } from "../../src/data/snapshots.ts";
import { SyncGovernance, SyncScheduler } from "../../src/data/sync-governance.ts";
import { sourceSummary } from "../../src/agent/source-summary.ts";

async function fixture() {
  let rows = Array.from({ length: 6 }, (_, index) => ({ id: String(index), value: `记录${index}` }));
  const server = createServer((request, response) => { const url = new URL(request.url!, "http://localhost"), offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 100); response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ items: rows.slice(offset, offset + limit), total: rows.length })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = mkdtempSync(join(tmpdir(), "context-os-sync-governance-")), memory = new MemoryStore(directory), live = new LiveMemory(directory, memory), snapshots = new Snapshots(memory, live, directory);
  const governance = new SyncGovernance(memory, snapshots);
  const source = await live.sources.connect({ name: "记录目录", protocol: "http", url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, capabilities: [{ name: "records", path: "/records", fields: ["id", "value"], totalPath: "total" }] });
  return { directory, memory, live, snapshots, governance, source, setRows(value: typeof rows) { rows = value; }, async close() { await snapshots.close(); memory.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); } };
}

test("quality breakers retain the last active snapshot and require an exact human decision", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    await f.snapshots.sync({ operationId: "initial" });
    const before = f.snapshots.datasets()[0], active = before.content.activeVersion;
    f.setRows([]);
    await f.snapshots.sync({ operationId: "empty" });
    const blocked = f.snapshots.datasets()[0];
    assert.equal(blocked.content.activeVersion, active);
    assert(blocked.content.pendingVersion);
    assert.throws(() => f.snapshots.accept({ id: blocked.id, version: blocked.version, operationId: "legacy-bypass" }), /数据问题|理由/);
    assert.equal((await f.snapshots.preview({ datasetId: before.id })).rows.length, 6);
    const issue = f.governance.list()[0];
    assert.equal(issue.category, "data_issue");
    assert.match(issue.evidence, /0 行|空/);
    f.governance.resolve({ id: issue.id, version: issue.version, operationId: "retain", decision: "retain", reason: "接口故障，保留旧数据" });
    assert.equal(f.snapshots.datasets()[0].content.activeVersion, active);
    assert.equal(f.snapshots.datasets()[0].content.pendingVersion, null);
    assert.equal(f.governance.list().length, 0);
    f.setRows([{ id: "0", value: "记录0" }]);
    await f.snapshots.sync({ operationId: "drop" });
    const reduced = f.governance.list()[0];
    assert.match(reduced.evidence, /减少/);
    const result = f.governance.resolve({ id: reduced.id, version: reduced.version, operationId: "confirm", decision: "accept", reason: "已确认业务范围收缩" });
    assert.equal((await f.snapshots.preview({ datasetId: before.id })).rows.length, 1);
    assert.deepEqual(f.governance.resolve({ id: reduced.id, version: reduced.version, operationId: "confirm", decision: "accept", reason: "已确认业务范围收缩" }), result);
    assert.equal(f.governance.list().length, 0);
  } finally { await f.close(); }
});

test("daily schedules persist, run once when due and can be switched to manual", { timeout: 20000 }, async () => {
  const f = await fixture();
  let scheduler: SyncScheduler | undefined;
  try {
    const at = new Date("2026-10-21T01:00:00+08:00");
    const saved = f.governance.configure({ sourceId: f.source.id, schedule: { mode: "daily", time: "02:00" } }, at);
    assert.equal(saved.schedule.mode, "daily");
    scheduler = new SyncScheduler(f.memory, f.snapshots, f.governance);
    const due = new Date(saved.nextRunAt!);
    await scheduler.tick(new Date(due.getTime() - 1));
    assert.equal(f.memory.listArtifacts("data_sync").length, 0);
    await scheduler.tick(due);
    assert.equal(f.memory.listArtifacts("data_sync").length, 1);
    await scheduler.close(); scheduler = new SyncScheduler(f.memory, f.snapshots, new SyncGovernance(f.memory, f.snapshots));
    await scheduler.tick(due);
    assert.equal(f.memory.listArtifacts("data_sync").length, 1, "restarting after the same due slot does not duplicate it");
    f.governance.configure({ sourceId: f.source.id, schedule: { mode: "manual" } }, due);
    await scheduler.tick(new Date(due.getTime() + 86400000));
    assert.equal(f.memory.listArtifacts("data_sync").length, 1);
  } finally { await scheduler?.close(); await f.close(); }
});

test("hourly and weekly schedules read updated source data only at their stated due times", { timeout: 20000 }, async () => {
  for (const scenario of [
    { schedule: { mode: "hourly" }, before: new Date(2026, 9, 21, 10, 59, 59), due: new Date(2026, 9, 21, 11, 0, 0), label: "每小时更新" },
    { schedule: { mode: "weekly", weekday: 5, time: "09:30" }, before: new Date(2026, 9, 23, 9, 29, 59), due: new Date(2026, 9, 23, 9, 30, 0), label: "每周更新" },
  ]) {
    const f = await fixture(); let scheduler: SyncScheduler | undefined;
    try {
      await f.snapshots.sync({ operationId: "schedule-baseline" });
      const datasetId = f.snapshots.datasets()[0].id;
      f.governance.configure({ sourceId: f.source.id, schedule: scenario.schedule }, new Date(2026, 9, 21, 10, 0, 0));
      f.setRows(Array.from({ length: 6 }, (_, index) => ({ id: String(index), value: scenario.label + index })));
      scheduler = new SyncScheduler(f.memory, f.snapshots, f.governance);
      await scheduler.tick(scenario.before);
      assert.equal((await f.snapshots.preview({ datasetId })).rows[0].value, "记录0");
      await scheduler.tick(scenario.due);
      assert.equal((await f.snapshots.preview({ datasetId })).rows[0].value, scenario.label + "0");
      assert.equal(f.memory.listArtifacts("data_sync").length, 2, "one baseline plus one due synchronization");
      await scheduler.tick(scenario.due);
      assert.equal(f.memory.listArtifacts("data_sync").length, 2, "the same scheduled slot cannot run twice");
    } finally { await scheduler?.close(); await f.close(); }
  }
});

test("a daily automatic refresh advances the source cutoff only after adopting the actual updated data", { timeout: 15000 }, async () => {
  const f = await fixture(); let scheduler: SyncScheduler | undefined;
  try {
    await f.snapshots.sync({ operationId: "daily-cutoff-baseline" });
    const before = sourceSummary(f.memory).sources.find(source => source.id === f.source.id)!;
    f.governance.configure({ sourceId: f.source.id, schedule: { mode: "daily", time: "02:00" } }, new Date(2026, 9, 21, 1, 0, 0));
    f.setRows(Array.from({ length: 6 }, (_, index) => ({ id: String(index), value: `今日记录${index}` })));
    scheduler = new SyncScheduler(f.memory, f.snapshots, f.governance);
    await scheduler.tick(new Date(2026, 9, 21, 1, 59, 59));
    assert.equal(sourceSummary(f.memory).sources.find(source => source.id === f.source.id)!.dataAsOf, before.dataAsOf);
    await scheduler.tick(new Date(2026, 9, 21, 2, 0, 0));
    const current = sourceSummary(f.memory).sources.find(source => source.id === f.source.id)!;
    assert(current.dataAsOf && before.dataAsOf && current.dataAsOf > before.dataAsOf);
    assert.equal(current.readMode, "active_snapshot");
    assert.equal((await f.snapshots.preview({ datasetId: f.snapshots.datasets()[0].id })).rows[0].value, "今日记录0");
    assert.equal(f.governance.list().length, 0);
  } finally { await scheduler?.close(); await f.close(); }
});

test("interrupted page reads resume from the last durable page while the old active snapshot keeps serving", { timeout: 20000 }, async () => {
  const requests: number[] = []; let broken = false;
  const rows = Array.from({ length: 230 }, (_, index) => ({ id: String(index), value: `v${index}` }));
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost"), offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 100); requests.push(offset);
    response.setHeader("content-type", "application/json");
    if (broken && offset === 100) { response.writeHead(503).end("{}"); return; }
    response.end(JSON.stringify({ items: rows.slice(offset, offset + limit), total: rows.length }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = mkdtempSync(join(tmpdir(), "context-os-sync-resume-")), memory = new MemoryStore(directory), live = new LiveMemory(directory, memory);
  let snapshots = new Snapshots(memory, live, directory);
  try {
    const source = await live.sources.connect({ name: "分页恢复", protocol: "http", url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, capabilities: [{ name: "records", path: "/records", fields: ["id", "value"], totalPath: "total" }] });
    await snapshots.sync({ operationId: "baseline" }); const active = snapshots.datasets()[0].content.activeVersion;
    rows[0].value = "updated"; broken = true;
    const failed = await snapshots.sync({ operationId: "interrupted" });
    assert.equal(failed.content.outcome, "needs_attention");
    assert.equal(snapshots.datasets()[0].content.activeVersion, active);
    await snapshots.close(); snapshots = new Snapshots(memory, live, directory); broken = false; requests.length = 0;
    await snapshots.sync({ operationId: "resume", sourceIds: [source.id] });
    assert.equal(requests[0], 100, "the completed first page is not fetched again after restart");
    assert.equal((snapshots.datasets()[0].content.profile as any).rows, 230);
    assert.equal((await snapshots.preview({ datasetId: snapshots.datasets()[0].id })).rows[0].value, "updated");
  } finally { await snapshots.close(); memory.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});

test("configured API increments upsert by identity, preserve untouched records and allow a manual full refresh", { timeout: 30000 }, async () => {
  let rows = [{ id: "1", value: "one", updated: 1 }, { id: "2", value: "two", updated: 2 }, { id: "3", value: "three", updated: 3 }];
  const reads: Array<string | null> = []; let ignoreBoundary = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost"), since = url.searchParams.get("updated_since"); reads.push(since);
    const selected = rows.filter(row => ignoreBoundary || since === null || row.updated >= Number(since));
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 100);
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ items: selected.slice(offset, offset + limit), total: selected.length }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = mkdtempSync(join(tmpdir(), "context-os-sync-increment-")), memory = new MemoryStore(directory), live = new LiveMemory(directory, memory), snapshots = new Snapshots(memory, live, directory);
  try {
    const source = await live.sources.connect({ name: "更新时间目录", protocol: "http", url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, capabilities: [{ name: "records", path: "/records", fields: ["id", "value", "updated"], totalPath: "total", incrementalParam: "updated_since" }] });
    new SyncGovernance(memory, snapshots).configure({ sourceId: source.id, schedule: { mode: "manual" }, incrementalField: "updated" });
    await snapshots.sync({ operationId: "full-first" });
    rows = [{ id: "1", value: "one-revised", updated: 4 }, rows[1], rows[2], { id: "4", value: "four", updated: 5 }];
    await snapshots.sync({ operationId: "increment" });
    assert.equal(reads.at(-1), "3", "only records at or after the last complete watermark are requested");
    const dataset = snapshots.datasets()[0];
    assert.deepEqual((await snapshots.preview({ datasetId: dataset.id })).rows.sort((a,b) => String(a.id).localeCompare(String(b.id))).map(row => [row.id, row.value]), [["1", "one-revised"], ["2", "two"], ["3", "three"], ["4", "four"]]);
    assert.equal((dataset.content.coverage as any).complete, true);
    rows = rows.filter(row => row.id !== "2");
    await snapshots.sync({ operationId: "manual-full", full: true });
    assert.equal(reads.at(-1), null);
    assert.equal((await snapshots.preview({ datasetId: dataset.id })).rows.length, 3, "explicit full refresh reconciles upstream deletions");
    const active = snapshots.dataset(dataset.id).content.activeVersion;
    ignoreBoundary = true; rows[0] = { ...rows[0], value: "newer", updated: 6 };
    const ignored = await snapshots.sync({ operationId: "ignored-boundary" });
    assert.equal(ignored.content.outcome, "needs_attention");
    assert.equal(snapshots.dataset(dataset.id).content.activeVersion, active, "a source ignoring its update boundary cannot replace current data");
    ignoreBoundary = false;
    await snapshots.sync({ operationId: "repaired-boundary" });
    assert.equal((await snapshots.preview({ datasetId: dataset.id })).rows.find(row => row.id === "1")!.value, "newer", "a rejected complete checkpoint is not reused after repair");
  } finally { await snapshots.close(); memory.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});

test("different sources use at most three workers and one source cannot overlap across jobs", { timeout: 20000 }, async () => {
  let active = 0, maximum = 0; const perSource = new Map<string, number>(); let overlap = false;
  const server = createServer(async (request, response) => {
    const key = new URL(request.url!, "http://localhost").pathname;
    active++; maximum = Math.max(maximum, active); perSource.set(key, (perSource.get(key) ?? 0) + 1); if (perSource.get(key)! > 1) overlap = true;
    await new Promise(resolve => setTimeout(resolve, 60));
    active--; perSource.set(key, perSource.get(key)! - 1);
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ items: [{ id: "1" }], total: 1 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = mkdtempSync(join(tmpdir(), "context-os-sync-concurrency-")), memory = new MemoryStore(directory), live = new LiveMemory(directory, memory), snapshots = new Snapshots(memory, live, directory);
  try {
    const sources = [];
    for (let i = 0; i < 5; i++) sources.push(await live.sources.connect({ name: `目录${i}`, protocol: "http", url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, capabilities: [{ name: "records", path: `/records${i}`, fields: ["id"], totalPath: "total" }] }));
    const first = snapshots.sync({ operationId: "all" });
    const second = snapshots.sync({ operationId: "same-source", sourceIds: [sources[0].id] });
    const jobs = await Promise.all([first, second]);
    assert.equal(maximum, 3); assert.equal(overlap, false);
    assert(jobs.every(job => job.content.outcome === "synced"), JSON.stringify(jobs.map(job => job.content.issues)));
    assert.equal(snapshots.datasets().length, 5);
  } finally { await snapshots.close(); memory.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});

test("a persisted scheduled job interrupted by restart resumes before the next scheduled day", { timeout: 20000 }, async () => {
  const f = await fixture(); let reopened: Snapshots | undefined, scheduler: SyncScheduler | undefined;
  try {
    const policy = f.governance.configure({ sourceId: f.source.id, schedule: { mode: "daily", time: "02:00" } }, new Date());
    const completed = await f.snapshots.sync({ operationId: "prior-scheduled", sourceIds: [f.source.id] });
    // Crash injection at the persistence boundary: a started job had no completion receipt.
    const interrupted = f.memory.putArtifact({ ...completed, expectedVersion: completed.version, status: "running" });
    const stored = f.memory.listArtifacts("sync_policy")[0];
    f.memory.putArtifact({ ...stored, expectedVersion: stored.version, content: { ...stored.content, scheduledJobRef: { id: interrupted.id, version: interrupted.version } } });
    await f.snapshots.close(); reopened = new Snapshots(f.memory, f.live, f.directory);
    scheduler = new SyncScheduler(f.memory, reopened, new SyncGovernance(f.memory, reopened));
    await scheduler.tick(new Date(new Date(policy.nextRunAt!).getTime() - 1000));
    assert.equal(f.memory.listArtifacts("data_sync").length, 2);
    assert.equal(f.memory.listArtifacts("data_sync")[0].content.outcome, "synced");
    await scheduler.tick(new Date(new Date(policy.nextRunAt!).getTime() - 500));
    assert.equal(f.memory.listArtifacts("data_sync").length, 2, "completed recovery does not repeat");
  } finally { await scheduler?.close(); await reopened?.close(); await f.close(); }
});

test("enabling the scheduler initializes old default sources without an immediate historical catch-up", { timeout: 15000 }, async () => {
  const f = await fixture(); let scheduler: SyncScheduler | undefined;
  try {
    scheduler = new SyncScheduler(f.memory, f.snapshots, f.governance);
    const enabledAt = new Date(Date.now() + 10 * 86400000);
    await scheduler.tick(enabledAt);
    assert.equal(f.memory.listArtifacts("data_sync").length, 0);
    const policy = f.memory.listArtifacts("sync_policy")[0]; assert(policy);
    assert(new Date(String(policy.content.nextRunAt)) > enabledAt);
    await scheduler.close(); scheduler = new SyncScheduler(f.memory, f.snapshots, f.governance);
    await scheduler.tick(new Date(String(policy.content.nextRunAt)));
    assert.equal(f.memory.listArtifacts("data_sync").length, 1);
  } finally { await scheduler?.close(); await f.close(); }
});

test("per-source null thresholds, invalid identity and source failures remain visible without replacing active data", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    await f.snapshots.sync({ operationId: "quality-base" }); const active = f.snapshots.datasets()[0].content.activeVersion;
    f.governance.configure({ sourceId: f.source.id, schedule: { mode: "manual" }, qualityThresholds: { criticalFields: ["value"], criticalNullIncrease: 0.3 } });
    f.setRows(Array.from({ length: 6 }, (_, index) => ({ id: String(index), value: index < 2 ? null as any : `记录${index}` })));
    await f.snapshots.sync({ operationId: "critical-nulls" });
    assert.equal(f.snapshots.datasets()[0].content.activeVersion, active);
    let issue = f.governance.list()[0]; assert.match(issue.evidence, /关键字段/);
    f.governance.resolve({ id: issue.id, version: issue.version, operationId: "null-retain", decision: "retain", reason: "空值需要上游核对" });
    f.governance.configure({ sourceId: f.source.id, schedule: { mode: "manual" }, qualityThresholds: { criticalFields: ["value"], criticalNullIncrease: 0.5 } });
    await f.snapshots.sync({ operationId: "threshold-adjusted" }); assert.equal(f.governance.list().length, 0);
    const current = f.snapshots.datasets()[0].content.activeVersion;
    f.setRows([{ id: "same", value: "a" }, { id: "same", value: "b" }]);
    const failed = await f.snapshots.sync({ operationId: "duplicate-identities" });
    assert.equal(failed.content.outcome, "needs_attention"); assert.equal(f.snapshots.datasets()[0].content.activeVersion, current);
    issue = f.governance.list()[0]; assert.match(issue.evidence, /身份.*重复/);
    const invalid = f.snapshots.datasets()[0]; assert(invalid.content.pendingVersion, "invalid identities remain inspectable as an immutable pending snapshot");
    assert.equal((await f.snapshots.preview({ datasetId: invalid.id, snapshotId: invalid.content.pendingVersion })).rows.length, 2);
    await assert.rejects(f.live.sources.readRecords(f.source.id, "records"), /身份.*重复/, "ordinary object reads still reject ambiguous identities");
    f.governance.resolve({ id: issue.id, version: issue.version, operationId: "accept-invalid", decision: "accept", reason: "先保存真实异常数据，待修订身份映射" });
    assert.equal(f.snapshots.datasets()[0].content.activeVersion, invalid.content.pendingVersion);
  } finally { await f.close(); }
});

test("a blank uploaded identity is a quality issue even when its value is technically distinct", { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const { Workspace } = await import("../../src/agent/workspace.ts"); const workspace = new Workspace(f.memory);
    const source = workspace.upload("身份.csv", "id,name\n1,甲\n2,乙\n");
    f.live.sources.connectUpload(source.id, source.version, "id");
    await f.snapshots.sync({ operationId: "csv-identities", sourceIds: [source.id] });
    const dataset = f.snapshots.datasets().find(item => item.content.sourceId === source.id)!;
    workspace.upload("身份.csv", "id,name\n1,甲\n,乙\n");
    await f.snapshots.sync({ operationId: "csv-blank", sourceIds: [source.id] });
    assert.equal(f.snapshots.dataset(dataset.id).content.activeVersion, dataset.content.activeVersion);
    assert.match(f.governance.list()[0].evidence, /身份键.*空/);
  } finally { await f.close(); }
});

test("HTTP field additions and removals become inspectable pending snapshots without importing previously unselected fields", { timeout: 20000 }, async () => {
  let revised = false, reintroduceIgnored = false;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ items: revised ? [{ id: "1", region: "南区", ...(reintroduceIgnored ? { ignored: "未选择" } : {}) }, { id: "2", region: "北区", ...(reintroduceIgnored ? { ignored: "未选择" } : {}) }]
      : [{ id: "1", name: "甲", ignored: "未选择" }, { id: "2", name: "乙", ignored: "未选择" }], total: 2 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = mkdtempSync(join(tmpdir(), "context-os-sync-schema-")), memory = new MemoryStore(directory), live = new LiveMemory(directory, memory), snapshots = new Snapshots(memory, live, directory);
  try {
    const source = await live.sources.connect({ name: "字段目录", protocol: "http", url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, capabilities: [{ name: "records", path: "/records", fields: ["id", "name"], totalPath: "total" }] });
    await snapshots.sync({ operationId: "selected" }); const original = snapshots.datasets()[0];
    assert.deepEqual(Object.keys((await snapshots.preview({ datasetId: original.id })).rows[0]), ["id", "name"]);
    revised = true; await snapshots.sync({ operationId: "schema-change" });
    const pending = snapshots.dataset(original.id); assert(pending.content.pendingVersion);
    assert.equal(pending.content.activeVersion, original.content.activeVersion);
    assert.deepEqual(Object.keys((await snapshots.preview({ datasetId: original.id, snapshotId: pending.content.pendingVersion })).rows[0]), ["id", "region"]);
    const governance = new SyncGovernance(memory, snapshots), issue = governance.list()[0]; assert.match(issue.evidence, /结构变化/);
    governance.resolve({ id: issue.id, version: issue.version, operationId: "accept-schema", decision: "accept", reason: "名称列已由区域列替换" });
    assert.deepEqual((await live.sources.readRecords(source.id, "records")).items, [{ id: "1", region: "南区" }, { id: "2", region: "北区" }]);
    assert.equal(governance.list().length, 0);
    reintroduceIgnored = true; await snapshots.sync({ operationId: "ignored-field-returns" });
    assert.equal(snapshots.dataset(original.id).content.pendingVersion, null);
    assert.deepEqual(Object.keys((await snapshots.preview({ datasetId: original.id })).rows[0]), ["id", "region"], "an explicitly unselected field stays excluded after disappearing and returning");
    assert.deepEqual((await snapshots.preview({ datasetId: original.id, snapshotId: original.content.activeVersion })).rows.map(row => row.name), ["甲", "乙"]);
  } finally { await snapshots.close(); memory.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});

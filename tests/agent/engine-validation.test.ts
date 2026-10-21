import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { MemoryStore } from "../../src/agent/memory.ts";
import { FoundationService } from "../../src/agent/foundation.ts";
import { LiveMemory } from "../../src/live/memory.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { Snapshots } from "../../src/data/snapshots.ts";
import { ProgramBuilds } from "../../src/engine/program-builds.ts";
import { OntologyChanges } from "../../src/engine/changes.ts";
import { connectRelationChanges } from "../../src/engine/relation-change.ts";
import { validateDefinition } from "../../src/engine/validation.ts";
import { dataOverviewForAgent, discoveryExplainForAgent, engineTools, ontologySnapshotCheckForAgent, snapshotQueryForAgent } from "../../src/engine/tools.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ade-validation-"));
  const memory = new MemoryStore(directory);
  const live = new LiveMemory(directory, memory);
  const foundation = new FoundationService(memory, live);
  const snapshots = new Snapshots(memory, live, directory);
  const engine = new ProgramBuilds(memory, foundation, live, snapshots);
  const changes = new OntologyChanges(memory, foundation, snapshots);
  connectRelationChanges(memory, foundation, live, snapshots, changes);
  return { memory, live, snapshots, engine, changes, workspace: new Workspace(memory),
    async close() { await engine.close(); await snapshots.close(); memory.close(); rmSync(directory, { recursive: true, force: true }); } };
}

async function api(rows: () => Array<Record<string, unknown>>) {
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost"), all = rows().filter(r => [...url.searchParams].every(([k, v]) => ["offset", "limit"].includes(k) || String(r[k]) === v));
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 20);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: all.slice(offset, offset + limit), total: all.length }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

test("full-snapshot checks catch an identity duplicated across pages and a relation that matches nothing", async () => {
  const f = fixture();
  // Each page is unique, so page-level contracts pass; the duplicate only shows in the full snapshot.
  const rows = Array.from({ length: 150 }, (_, i) => ({ id: i === 120 ? "C1" : `C${i}`, region: i < 75 ? "R1" : "R9" }));
  const source = await api(() => rows);
  try {
    const conn = await f.live.sources.connect({ name: "客户", protocol: "http", url: source.url,
      capabilities: [{ name: "customers", path: "/c", fields: ["id", "region"], idField: "id", totalPath: "total", filters: { id: "id", region: "region" } }] });
    f.workspace.upload("区域.csv", "区域编号,名称\nR1,华东\nR2,华南\n");
    await f.snapshots.sync({ operationId: "s" });
    const region = f.live.sources.connectUpload(f.memory.listArtifacts("source")[0].id, 1, "区域编号");
    const report = await validateDefinition(f.snapshots, f.live, {
      types: [{ name: "客户", sourceId: conn.id, capability: "customers", fields: { 编号: "id", 区域: "region" } },
        { name: "区域", sourceId: region.id, capability: "records", fields: { 区域编号: "区域编号", 名称: "名称" } }],
      relations: [{ name: "位于", from: "客户", to: "区域", fromField: "区域", toField: "区域编号" }],
    });
    assert.equal(report.valid, false);
    const identity = report.checks.find(c => c.name === "客户：身份唯一")!;
    assert.equal(identity.passed, false);
    assert.equal(identity.metrics!.duplicates, 1);
    const relation = report.checks.find(c => c.kind === "relation")!;
    assert.equal(relation.passed, true, "half the customers match, so the relation holds");
    assert.equal(relation.severity, "warning", "but a 50% match is flagged");
    assert.equal(relation.metrics!.matched, 75);
    assert.equal(relation.metrics!.cardinality, "多对一");
    assert.ok(Object.keys(report.inputVersions).length === 2);

    const none = await validateDefinition(f.snapshots, f.live, {
      types: [{ name: "区域", sourceId: region.id, capability: "records", fields: { 区域编号: "区域编号", 名称: "名称" } }, { name: "区域2", sourceId: region.id, capability: "records", fields: { 名称: "名称" } }],
      relations: [{ name: "同名", from: "区域", to: "区域2", fromField: "区域编号", toField: "名称" }],
    });
    assert.equal(none.checks.find(c => c.kind === "relation")!.passed, false);
  } finally { await source.close(); await f.close(); }
});

test("a candidate checks explicitly adopted relations on snapshots and refuses a candidate whose snapshots changed", async () => {
  const f = fixture();
  let orders = [{ id: "O1", company_id: "A001" }, { id: "O2", company_id: "A002" }, { id: "O3", company_id: "A001" }];
  const source = await api(() => orders);
  try {
    f.workspace.upload("企业.csv", "企业编号,企业名称\nA001,青山\nA002,海川\n");
    const orderSource = await f.live.sources.connect({ name: "订单系统", protocol: "http", url: source.url,
      capabilities: [{ name: "orders", path: "/o", fields: ["id", "company_id"], idField: "id", totalPath: "total", filters: { id: "id", company_id: "company_id" } }] });
    await f.engine.build({ operationId: "b1" });
    const first = f.engine.overview().candidate!;
    assert.deepEqual(first.content.modelRelations, [], "discovered relations remain proposals until explicitly adopted");
    const initialCheck = await f.engine.check({ id: first.id, version: first.version });
    await f.engine.adopt({ id: initialCheck.id, version: initialCheck.version, operationId: "adopt-entities" });
    const orderDataset = f.snapshots.bindingDataset(orderSource.id, "orders")!;
    const companyDataset = f.snapshots.datasets().find(dataset => dataset.content.name === "企业.csv")!;
    const { change: proposed } = await f.changes.propose({ operationId: "propose-order-company", origin: "human", type: "relation", baseline: f.changes.currentBaseline(),
      subject: { from: { datasetId: orderDataset.id, column: "company_id" }, to: { datasetId: companyDataset.id, column: "企业编号" } } });
    const verified = await f.changes.verify({ id: proposed.id, version: proposed.version, operationId: "verify-order-company" });
    await f.changes.adopt({ id: verified.id, version: verified.version, operationId: "adopt-order-company" });
    await f.engine.build({ operationId: "b2" });
    const candidate = f.engine.overview().candidate!;
    const checked = await f.engine.check({ id: candidate.id, version: candidate.version });
    const checks = checked.content.checks as any;
    assert.equal(checks.valid, true, checks.description);
    assert.match(checks.description, /全量快照检查通过/);
    assert.ok(checks.snapshot.checks.some((c: any) => c.kind === "type" && c.metrics?.rows === 3), JSON.stringify(checks.snapshot.checks));
    assert.ok(checks.snapshot.checks.some((c: any) => c.kind === "relation" && c.metrics.matched === 3), JSON.stringify(checks.snapshot.checks));

    // The connection version stays the same; only the data behind it changed.
    orders = [...orders, { id: "O4", company_id: "A002" }];
    await f.snapshots.sync({ operationId: "refresh" });
    await assert.rejects(f.engine.check({ id: checked.id, version: checked.version }), /快照已更新/);
    await assert.rejects(f.engine.adopt({ id: checked.id, version: checked.version, operationId: "late" }), /快照已更新/);
  } finally { await source.close(); await f.close(); }
});

test("agent tools read snapshots without writing, explain discovery, and re-check a saved mapping", async () => {
  const f = fixture();
  try {
    f.workspace.upload("企业.csv", "企业编号,企业名称\nA001,青山\nA002,海川\n");
    f.workspace.upload("订单.csv", "订单号,企业编号\n" + Array.from({ length: 9 }, (_, i) => `O${i + 1},A00${(i % 2) + 1}`).join("\n") + "\nO10,A009\n");
    await f.engine.build({ operationId: "b" });
    const overview = dataOverviewForAgent(f.snapshots);
    assert.equal(overview.datasets.length, 2);
    const orders = overview.datasets.find(d => d.name === "订单.csv")!;
    const counted = await snapshotQueryForAgent(f.snapshots, { datasetIds: [orders.id], sql: `SELECT count(*) AS n FROM ${orders.table}` });
    assert.equal(Number(counted.rows[0].n), 10);
    const aliased = await snapshotQueryForAgent(f.snapshots, { datasetIds: [orders.id], sql: `SELECT count(*) AS n FROM "订单.csv"` });
    assert.equal(Number(aliased.rows[0].n), 10, "a dataset is also reachable by its quoted name");
    await assert.rejects(snapshotQueryForAgent(f.snapshots, { datasetIds: [orders.id], sql: `DROP TABLE ${orders.table}` }), /single SELECT/);

    const candidate = f.engine.overview().candidate!;
    const link = (candidate.content.discovery as any).links[0];
    const explained = await discoveryExplainForAgent(f.engine, f.snapshots, { linkId: link.id });
    assert.deepEqual(explained.unmatchedSample!.map((r: any) => r["订单号"]), ["O10"]);
    assert.ok(explained.notes.some(n => n.text.includes("1 条记录")));

    const report = await ontologySnapshotCheckForAgent(f.memory, f.live, f.snapshots, { id: candidate.id, version: candidate.version });
    assert.equal(report.valid, true);
    assert.equal(f.memory.getArtifact(candidate.id).version, candidate.version, "checking does not save the candidate");
    assert.ok(["data_overview", "data_sync", "snapshot_query", "discovery_explain", "ontology_snapshot_check"].every(name => engineTools.some(t => t.name === name)));
    assert.equal(engineTools.find(t => t.name === "data_sync")!.mutates, true);
    assert.ok(!engineTools.some(t => /publish|adopt/.test(t.name)), "the assistant cannot adopt or publish");
  } finally { await f.close(); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import { createServer as upstreamServer } from "node:http";
import { Releases } from "../../src/engine/releases.ts";
import { OntologyDatasets } from "../../src/live/ontology-datasets.ts";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { seedFoundation } from "./program-foundation-fixture.ts";
import { createFusionSources, primaryCapability, supplementCapability, fusionDefinition } from "./fusion-fixture.ts";

test("workspace HTTP, live_query and context_read default to the adopted snapshot while explicit live and release reads keep their own versions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-read-modes-"));
  let query: Record<string, unknown>, context: any, toolRead: any, contextRead: any;
  const service = await createServer({ directory, automaticApi: false, driver: {
    async run(request) {
      toolRead = await request.onTool("live_query", query);
      contextRead = await request.onTool("context_read", {});
      return { text: "已按回执核对。", sessionId: "read-modes", runId: "read-modes" };
    }, async stop() {}, async close() {},
  } });
  let rows = Array.from({ length: 12 }, (_, i) => ({ id: `P${i + 1}`, 名称: `产品${i}`, 价格: i === 0 ? "10" : "20" }));
  const upstream = upstreamServer((req, res) => {
    const url = new URL(req.url!, "http://localhost"), selected = rows.filter(r => !url.searchParams.has("id") || r.id === url.searchParams.get("id"));
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 20);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ items: selected.slice(offset, offset + limit), total: selected.length }));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const releases = new Releases(service.app.memory, service.app.live), datasets = new OntologyDatasets(service.app.memory, service.app.live);
  try {
    await service.app.live.sources.connect({ name: "产品目录", protocol: "http", url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, capabilities: [{ name: "products", path: "/products", fields: ["id", "名称", "价格"], idField: "id", totalPath: "total", filters: { id: "id" } }] });
    await service.app.programBuilds.build({ operationId: "initial-build" });
    const candidate = service.app.programBuilds.overview().candidate!;
    const checked = await service.app.programBuilds.check({ id: candidate.id, version: candidate.version });
    const adopted = await service.app.programBuilds.adopt({ id: checked.id, version: checked.version, operationId: "adopt-build" });
    const model = adopted.model, type = (model.content.types as any[])[0];
    const check = await releases.check({ inputHash: releases.overview().working.inputHash });
    const release = releases.publish({ operationId: "publish", checkRef: { id: check.id, version: check.version }, name: "初版" }).release;
    const connection = releases.connect({ operationId: "connect", name: "查询助手", releaseRef: { id: release.id, version: release.version },
      conceptIds: [type.conceptId], relationIds: [], business: { grants: [{ type: type.name, fields: ["$id", "名称", "价格"], relations: [] }] } });
    query = { modelId: model.id, modelVersion: model.version, type: type.name, id: "P1" };
    const first = await service.app.live.query(query);
    assert.equal(first.readMode, "active_snapshot");
    assert.equal(first.items[0]["价格"], "10");
    assert.equal(first.sources[0].snapshotId, ((release.content.definition as any).snapshots as any[])[0].snapshotId);
    assert.equal(first.versions.mapping?.version, model.version);
    assert.equal(first.versions.ontology?.version, adopted.foundation.version);
    assert.ok(first.sources[0].dataAsOf);

    rows[0] = { ...rows[0], 价格: "99" };
    await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    const post = async (path: string, body: unknown) => {
      const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-dataengine-token": service.adminToken }, body: JSON.stringify(body) });
      assert.ok(response.ok, await response.clone().text());
      return response.json() as Promise<any>;
    };
    const frozen = await post("/api/live/query", query);
    assert.equal(frozen.items[0]["价格"], "10");
    assert.equal(frozen.readMode, "active_snapshot");
    const current = await post("/api/live/query", { ...query, readMode: "live" });
    assert.equal(current.items[0]["价格"], "99");
    assert.equal(current.readMode, "live");
    assert.equal(current.sources[0].snapshotId, null);
    context = { view: "ontology.objects", revision: 1, selection: [{ spaceId: service.app.memory.workspaceId(), kind: "object", id: model.id, version: model.version, type: type.name, objectId: "P1" }],
      scope: { where: {}, offset: 0, limit: 20 }, draftRef: { id: "snapshot-selection", revision: 1 } };
    await post("/api/canvas/navigate", { page: "ontology" });
    const selected = await post("/api/canvas/context/read", { page: "ontology", context });
    assert.equal(selected.result.items[0]["价格"], "10");
    assert.equal(selected.result.readMode, "active_snapshot");
    await post("/api/canvas/message", { page: "ontology", messageId: "snapshot-question", text: "核对这个产品的价格", workContext: context });
    await service.app.idle();
    assert.equal(toolRead.items[0]["价格"], "10");
    assert.equal(contextRead.result.items[0]["价格"], "10");
    await service.app.snapshots.sync({ operationId: "refresh" });
    assert.equal((await post("/api/live/query", query)).items[0]["价格"], "99");
    const pinned = await datasets.handle("/v4/objects", new URLSearchParams({ type: type.name, id: "P1" }), "Bearer " + connection.key);
    assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
    assert.equal((pinned.body.items as any[])[0].properties["价格"].value, "10");
    assert.equal(pinned.body.readMode, "release_pinned");
    assert.deepEqual((pinned.body.versions as any).release, { id: release.id, version: release.version });
  } finally { await service.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});

test("mixed snapshot and live readings agree across discovery, HTTP and MCP tool descriptions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-mixed-readings-")), upstream = await createFusionSources();
  const service = await createServer({ directory, automaticApi: false });
  const client = new Client({ name: "reading-contract-consumer", version: "1" });
  let connected = false;
  try {
    const primary = await service.app.live.sources.connect({ name: "投诉目录", protocol: "http", url: upstream.url, capabilities: [primaryCapability] });
    const extra = await service.app.live.sources.connect({ name: "工单反馈", protocol: "mcp", url: upstream.url + "/mcp", capabilities: [supplementCapability] });
    await service.app.snapshots.sync({ operationId: "mixed-sync" });
    const dataset = service.app.snapshots.bindingDataset(extra.id, "workorders")!;
    service.app.snapshots.setPolicy({ id: dataset.id, version: dataset.version, materialization: "live" });
    const foundation = seedFoundation(service.app.memory, service.app.foundation, { enterprise: "测试企业", concepts: [{ id: "complaint", name: "投诉", description: "居民投诉" }] });
    const definition = fusionDefinition(primary.id, extra.id);
    const proposed = await service.app.live.propose({ ...definition, foundationRef: { id: foundation.id, version: foundation.version }, baseModelRef: null,
      types: definition.types.map(type => ({ ...type, conceptId: "complaint" })) });
    const model = await service.app.live.adopt(proposed.id, proposed.version);
    const releases = new Releases(service.app.memory, service.app.live), datasets = new OntologyDatasets(service.app.memory, service.app.live);
    const check = await releases.check({ inputHash: releases.overview().working.inputHash });
    assert.equal(check.status, "ready", JSON.stringify(check.content));
    const release = releases.publish({ operationId: "mixed-publish", checkRef: { id: check.id, version: check.version }, name: "混合读取" }).release;
    const connection = releases.connect({ operationId: "mixed-connect", name: "反馈助手", releaseRef: { id: release.id, version: release.version }, conceptIds: ["complaint"], relationIds: [],
      business: { grants: [{ type: "投诉", fields: ["$id", "状态", "实际反馈"], relations: [] }] } });
    upstream.primary[0].status = "来源已变";
    upstream.state.outcome = "已改善";
    const working = await service.app.live.query({ modelId: model.id, type: "投诉", id: "TS002" });
    assert.equal(working.readMode, "active_snapshot");
    assert.equal(working.consistency, "active_snapshot_with_live");
    assert.equal(working.items[0].实际反馈, "已改善");
    assert.deepEqual(working.sources.map(s => s.readMode), ["snapshot", "live"]);
    const params = new URLSearchParams({ type: "投诉", id: "TS002" });
    const read = await datasets.handle("/v4/objects", params, "Bearer " + connection.key);
    const description = await datasets.handle("/v4/types", new URLSearchParams({ type: "投诉" }), "Bearer " + connection.key);
    assert.equal(read.status, 200);
    assert.equal(read.body.consistency, "pinned_snapshot_with_on_demand");
    assert.equal(description.body.consistency, read.body.consistency);
    assert.equal(description.body.readMode, "release_pinned");
    assert.match(String(description.body.description), /mixes snapshot and live/);
    assert.deepEqual((description.body.sources as any[]).map(s => [s.readMode, s.snapshotId]), (read.body.sources as any[]).map(s => [s.readMode, s.snapshotId]));
    assert.ok((read.body.sources as any[]).every(s => typeof s.dataAsOf === "string"));
    assert.match(String(read.body.multiSourceTime), /数据截至时间可能不同/);
    await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../../scripts/dataengine-mcp.ts", import.meta.url))], env: { PATH: process.env.PATH!, DATAENGINE_URL: `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`, DATAENGINE_CONSUMER_KEY: connection.key! }, stderr: "pipe" }));
    connected = true;
    const tools = (await client.listTools()).tools;
    assert.match(tools.find(t => t.name === "query_objects")!.description!, /release_pinned/);
    assert.match(tools.find(t => t.name === "query_objects")!.description!, /dataAsOf/);
    const output = await client.callTool({ name: "query_objects", arguments: { type: "投诉", id: "TS002" } });
    assert.equal((output.structuredContent as any).consistency, "pinned_snapshot_with_on_demand");
    assert.equal((output.structuredContent as any).items[0].properties.实际反馈.value, "已改善");
    upstream.state.mode = "failure";
    const incomplete = await service.app.live.query({ modelId: model.id, type: "投诉", id: "TS002" });
    assert.equal(incomplete.consistency, "active_snapshot_with_live");
    assert.equal(incomplete.sources[1].status, "unavailable");
    assert.equal(incomplete.sources[1].dataAsOf, null, "failed reads never claim a data timestamp");
    assert.ok(incomplete.coverage.uncoveredProperties?.includes("实际反馈"));
    const narrow = releases.connect({ operationId: "narrow-connect", name: "编号助手", releaseRef: { id: release.id, version: release.version }, conceptIds: ["complaint"], relationIds: [],
      business: { grants: [{ type: "投诉", fields: ["$id", "业务编号"], relations: [] }] } });
    const narrowDescription = await datasets.handle("/v4/types", new URLSearchParams({ type: "投诉" }), "Bearer " + narrow.key);
    assert.equal((narrowDescription.body.sources as any[]).length, 1, "discovery only describes sources used by granted fields");
    assert.equal(narrowDescription.body.consistency, "pinned_snapshot");
  } finally { if (connected) await client.close(); await service.close(); await upstream.close(); rmSync(directory, { recursive: true, force: true }); }
});

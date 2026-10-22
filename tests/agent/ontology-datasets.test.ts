import {publishWorking,ref} from "./published-consumers-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createServer } from "../../src/agent/server.ts";
import { createFusionSources, primaryCapability, supplementCapability, fusionDefinition } from "./fusion-fixture.ts";

test("published ontology subsets are consumable by independent MCP clients, pinned, isolated and revocable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-datasets-"));
  let service = await createServer({ automaticApi: false, directory });
  const clients: Client[] = [];
  async function listen() {
    await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  }
  let origin = await listen();
  const request = async (path: string, body?: unknown, key?: string) => {
    const response = await fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: key ? { authorization: `Bearer ${key}`, "content-type": "application/json" } : { "x-dataengine-token": service.adminToken, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const foundation = service.app.memory.putArtifact({ kind: "foundation", title: "Fixture ontology", status: "adopted", content: {
      enterprise: { name: "测试企业", evidenceRefs: ["private-evidence"] },
      concepts: [
        { id: "product", name: "产品", description: "企业提供的产品", evidenceRefs: ["private-evidence"] },
        { id: "customer", name: "客户", description: "购买产品的客户", evidenceRefs: ["private-evidence"] },
        { id: "secret", name: "薪酬", description: "保密工资", evidenceRefs: ["private-evidence"] },
      ],
      relations: [{ id: "buys", name: "购买", description: "客户购买产品", from: "customer", to: "product", evidenceRefs: ["private-evidence"] }],
      evidence: [{ id: "private-evidence", quote: "private-token-do-not-export", sourceId: "secret-source" }], unknowns: [], conflicts: [],
    } });
    const publication = await publishWorking(service.app);
    const input = { operationId: "publish-a", name: "产品知识", releaseRef: ref(publication), conceptIds: ["product", "customer"], relationIds: ["buys"] };
    const published = await request("/api/releases/connect", input);
    assert.equal(published.status, 200);
    const { dataset, key } = published.body;
    assert.equal(dataset.status, "active");
    assert.match(key, /^de_dataset_/);
    const replay = await request("/api/releases/connect", input);
    assert.equal(replay.body.dataset.id, dataset.id);
    assert.equal(replay.body.key, null);
    assert.equal((await request("/api/releases/connect", { ...input, name: "changed" })).status, 400);
    const second = (await request("/api/releases/connect", { ...input, operationId: "publish-b", name: "仅产品", conceptIds: ["product"], relationIds: [] })).body;
    const spec = await request(`/api/releases/connection?id=${published.body.connection.id}&version=${published.body.connection.version}`);
    assert.equal(spec.status, 200);
    assert.doesNotMatch(JSON.stringify(spec.body), new RegExp(key));
    assert.doesNotMatch(JSON.stringify((await request("/api/releases")).body), /keyHash|private-token-do-not-export/);
    const config = Object.values(spec.body.mcp.mcpServers)[0] as any;
    const connect = async (consumerKey: string) => {
      const client = new Client({ name: "external-agent", version: "1" });
      await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: { ...config.env, DATAENGINE_CONSUMER_KEY: consumerKey }, stderr: "pipe" }));
      clients.push(client);
      return client;
    };
    const a = await connect(key), b = await connect(second.key);
    const checked = await request("/api/datasets/test", { id: dataset.id, key });
    assert.equal(checked.status, 200);
    assert.equal(checked.body.ok, true);
    assert.equal(checked.body.conceptCount, 2);
    assert.equal(checked.body.checkedConcepts, 1);
    assert.doesNotMatch(JSON.stringify(checked.body), /de_dataset_/);
    assert.equal((await request("/api/datasets/test", { id: second.dataset.id, key })).status, 400);
    assert.ok((await a.listTools()).tools.some(t => t.name === "describe_dataset"));
    const catalog = await a.callTool({ name: "describe_dataset", arguments: {} });
    assert.equal(catalog.isError, undefined);
    assert.deepEqual((catalog.structuredContent as any).concepts.map((c: any) => c.id), ["product", "customer"]);
    assert.doesNotMatch(JSON.stringify(catalog), /薪酬|保密工资|private-evidence|secret-source|keyHash/);
    assert.equal((await b.callTool({ name: "read_concept", arguments: { conceptId: "customer" } })).isError, true);
    assert.equal((await a.callTool({ name: "read_concept", arguments: { conceptId: "secret" } })).isError, true);
    const relations = await a.callTool({ name: "query_relations", arguments: { conceptId: "customer" } });
    assert.equal((relations.structuredContent as any).relations[0].id, "buys");
    assert.equal((await request("/api/datasets", undefined, key)).status, 403);
    assert.equal((await request("/v3/catalog", undefined, key)).status, 410);
    service.app.memory.putArtifact({ ...foundation, expectedVersion: foundation.version, status: "candidate", content: { ...foundation.content, adoptedVersion: foundation.version, concepts: [{ id: "product", name: "产品", description: "new unadopted text" }] } });
    const pinned = await a.callTool({ name: "read_concept", arguments: { conceptId: "product" } });
    assert.equal((pinned.structuredContent as any).concept.description, "企业提供的产品");
    await request("/api/releases/revoke", { operationId:"revoke-a",connectionRef:ref(published.body.connection) });
    assert.equal((await request("/api/datasets/test", { id: dataset.id, key })).status, 400);
    assert.equal((await a.callTool({ name: "describe_dataset", arguments: {} })).isError, true);
    assert.equal((await b.callTool({ name: "describe_dataset", arguments: {} })).isError, undefined);
    await Promise.all(clients.map(c => c.close())); clients.length = 0;
    await service.close();
    service = await createServer({ automaticApi: false, directory }); origin = await listen();
    assert.equal((await request("/v4/dataset", undefined, key)).status, 403);
    assert.equal((await request("/v4/dataset", undefined, second.key)).status, 200);
    assert.equal((await request("/api/releases/connect", { ...input, operationId: "invalid-relation", conceptIds: ["product"] })).status, 400);
    assert.equal((await request("/api/releases/connect", { ...input, operationId: "candidate", releaseRef: { id: foundation.id, version: 2 } })).status, 404);
    for (let i = 0; i < 40; i++) {
      assert.equal((await request("/api/releases/connect", { ...input, operationId: `more-${i}` })).status,200);
    }
    const listed = (await request("/api/releases")).body.connections;
    assert.equal(listed.length, 42);
    const oldestActive = listed.find((item: any) => item.id === second.connection.id);
    assert.equal(oldestActive.status, "active");
    assert.equal((await request("/api/releases/revoke", { operationId:"revoke-oldest",connectionRef:ref(oldestActive) })).status, 200);
    assert.equal((await request("/v4/dataset", undefined, second.key)).status, 403);
  } finally {
    await Promise.all(clients.map(c => c.close()));
    await service.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("dataset business reads reuse explicit fusion grants and reject revoked in-flight reads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-dataset-business-"));
  const source = await createFusionSources();
  const service = await createServer({ automaticApi: false, directory });
  await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const admin = async (path: string, body: unknown) => {
    const r = await fetch(origin + path, { method: "POST", headers: { "x-dataengine-token": service.adminToken, "content-type": "application/json" }, body: JSON.stringify(body) });
    const value = await r.json() as any;
    if (!r.ok) throw new Error(value.error);
    return value;
  };
  let release: (() => void) | undefined;
  const client = new Client({ name: "business-agent", version: "1" });
  try {
    const f = service.app.memory.putArtifact({ kind: "foundation", title: "业务本体", status: "adopted", content: { enterprise: { name: "测试企业" }, concepts: [{ id: "complaint", name: "投诉", description: "居民投诉" }, { id: "private", name: "内部", description: "内部数据" }], relations: [], evidence: [], unknowns: [], conflicts: [] } });
    const foundationRef = { id: f.id, version: f.version };
    const p = (await admin("/api/live/connect", { name: "primary", protocol: "http", url: source.url, capabilities: [primaryCapability] })).saved;
    const e = (await admin("/api/live/connect", { name: "extra", protocol: "mcp", url: source.url + "/mcp", capabilities: [supplementCapability] })).saved;
    const definition = fusionDefinition(p.id, e.id);
    const candidate = (await admin("/api/live/propose", { ...definition, foundationRef, baseModelRef: null, types: definition.types.map(t => ({ ...t, conceptId: "complaint" })) })).saved;
    const model = (await admin("/api/live/adopt", { id: candidate.id, version: candidate.version })).saved;
    const business = { modelRef: { id: model.id, version: model.version }, grants: [{ type: "投诉", fields: ["$id", "实际反馈", "状态"], relations: [], evidence: { fields: ["状态"], relations: [] } }] };
    const publication=await publishWorking(service.app);
    const input = { operationId: "business", name: "客户服务", releaseRef:ref(publication), conceptIds: ["complaint"], relationIds: [], business:{grants:business.grants} };
    const published = await admin("/api/releases/connect", input);
    await assert.rejects(admin("/api/releases/connect", { ...input, operationId: "bad", conceptIds: ["private"] }), /概念|所选/);
    const specRes = await fetch(origin + `/api/releases/connection?id=${published.connection.id}&version=${published.connection.version}`, { headers: { "x-dataengine-token": service.adminToken } });
    const config = Object.values((await specRes.json() as any).mcp.mcpServers)[0] as any;
    await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: { ...config.env, DATAENGINE_CONSUMER_KEY: published.key }, stderr: "pipe" }));
    const catalog = (await client.callTool({ name: "describe_dataset", arguments: {} })).structuredContent as any;
    assert.deepEqual(catalog.businessTypes.map((t: any) => t.name), ["投诉"]);
    source.state.mode = "conflict";
    const result = await client.callTool({ name: "query_objects", arguments: { type: "投诉", limit: 1 } });
    assert.equal(result.isError, undefined);
    const payload = result.structuredContent as any;
    assert.equal(payload.items[0].properties.实际反馈.value, "未改善");
    assert.equal(payload.items[0].properties.状态.status, "conflict");
    assert.doesNotMatch(JSON.stringify(payload), /sourceId|phone|上门次数/);
    assert.equal((await client.callTool({ name: "query_objects", arguments: { type: "投诉", fields: ["$id", "上门次数"] } })).isError, true);
    assert.equal((await client.callTool({ name: "read_evidence", arguments: { ref: payload.items[0].properties.状态.evidenceRef } })).isError, undefined);
    const calls = source.state.calls;
    source.state.delay = new Promise(r => { release = r; });
    const inFlight = client.callTool({ name: "query_objects", arguments: { type: "投诉", limit: 1 } });
    const deadline = Date.now() + 5000;
    while (source.state.calls === calls && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
    assert.ok(source.state.calls > calls);
    await admin("/api/releases/revoke", {operationId:"revoke-business", connectionRef:ref(published.connection) });
    release!();
    assert.equal((await inFlight).isError, true);
  } finally {
    release?.(); await client.close(); await service.close(); await source.close(); rmSync(directory, { recursive: true, force: true });
  }
});

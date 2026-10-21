import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { LiveMemory } from "../../src/live/memory.ts";
import { Snapshots } from "../../src/data/snapshots.ts";
import { OpenApiImports } from "../../src/live/openapi-import.ts";

const records = Array.from({ length: 7 }, (_, id) => ({ id: String(id), name: `客户${id}` }));
async function fixture(handler: RequestListener, host = "127.0.0.1") {
  const upstream = createServer(handler);
  await new Promise<void>(resolve => upstream.listen(0, host, resolve));
  const directory = mkdtempSync(join(tmpdir(), "ade-source-enhancement-"));
  const memory = new MemoryStore(directory), live = new LiveMemory(directory, memory), snapshots = new Snapshots(memory, live, directory);
  return { directory, memory, live, snapshots, url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    async close() { await snapshots.close(); memory.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } };
}

test("cursor, page and Link sources sync every short page and preserve bounded object reads", { timeout: 20000 }, async () => {
  const visited: string[] = [];
  const f = await fixture((request, response) => {
    const url = new URL(request.url!, "http://localhost"), strategy = url.pathname.slice(1);
    visited.push(url.pathname + url.search);
    const offset = strategy === "page" ? (Number(url.searchParams.get("page") ?? 1) - 1) * Number(url.searchParams.get("limit") ?? 100)
      : Number(url.searchParams.get(strategy === "cursor" ? "after" : "offset") ?? 0);
    const size = strategy === "page" ? Number(url.searchParams.get("limit") ?? 100) : Math.min(2, Number(url.searchParams.get("limit") ?? 100));
    const items = records.slice(offset, offset + size), next = offset + items.length < records.length ? String(offset + items.length) : null;
    if (strategy === "link" && next) response.setHeader("Link", `</link?offset=${next}&limit=${size}>; rel="next"`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ items, next, ...(strategy === "page" ? { total: records.length } : {}) }));
  });
  try {
    for (const [type, pagination] of [["cursor", { type: "cursor", cursorParam: "after", nextCursorPath: "next" }], ["page", { type: "page", pageParam: "page", startPage: 1 }], ["link", { type: "link" }]] as const) {
      const source = await f.live.sources.connect({ name: type, protocol: "http", url: f.url, capabilities: [{ name: type, path: `/${type}`, fields: ["id", "name"], ...(type === "page" ? { totalPath: "total" } : {}), pagination }] });
      const result = await f.snapshots.sync({ operationId: type, sourceIds: [source.id] });
      assert.equal(result.status, "completed", JSON.stringify(result.content));
      const dataset = f.snapshots.datasets().find(item => item.content.sourceId === source.id)!;
      assert.equal((dataset.content.profile as any).rows, records.length);
      assert.equal((dataset.content.coverage as any).complete, true);
      const read = await f.live.sources.readRecords(source.id, type, {}, 3, 2);
      assert.deepEqual(read.items.map(item => item.id), ["3", "4"]);
    }
    assert(visited.some(value => value.includes("after=6")), "a short cursor page is not mistaken for the last page");
  } finally { await f.close(); }
});

test("OAuth refresh, bounded transient retries and explicit flattening preserve secrets outside artifacts", { timeout: 20000 }, async () => {
  const grants: string[] = []; let token = "", failures = 2, denyFirst = true;
  const f = await fixture(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/token") {
      let body = ""; for await (const chunk of request) body += chunk;
      const grant = new URLSearchParams(body); grants.push(grant.get("grant_type")!);
      assert.equal(request.headers.authorization, `Basic ${Buffer.from("fixture-client:fixture-client-secret").toString("base64")}`);
      if (grants.length > 1) assert.equal(grant.get("refresh_token"), "fixture-refresh-secret");
      token = `fixture-access-${grants.length}`;
      response.end(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 300, refresh_token: "fixture-refresh-secret" })); return;
    }
    if (failures-- > 0) { response.statusCode = 503; response.end("{}"); return; }
    if (denyFirst) { denyFirst = false; response.statusCode = 401; response.end("{}"); return; }
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.end(JSON.stringify({ items: [{ id: "C1", address: { city: "上海", contact: { name: "甲" } }, tags: ["企业", "重点"], echo: token }], total: 1 }));
  });
  try {
    const source = await f.live.sources.connect({ name: "短期令牌", protocol: "http", url: f.url,
      auth: { type: "oauth2", oauth2: { tokenUrl: f.url + "/token", clientId: "fixture-client", clientSecret: "fixture-client-secret" } },
      flatten: { depth: 3, arrays: "text" }, capabilities: [{ name: "customers", path: "/customers", fields: ["id", "address.city", "address.contact.name", "tags", "echo"], totalPath: "total" }] });
    const read = await f.live.sources.readRecords(source.id, "customers");
    assert.deepEqual(grants, ["client_credentials", "refresh_token"]);
    assert.equal(read.items[0]["address.city"], "上海");
    assert.equal(read.items[0]["address.contact.name"], "甲");
    assert.equal(read.items[0].tags, '["企业","重点"]');
    assert.equal(read.items[0].echo, "[redacted]");
    assert.doesNotMatch(JSON.stringify(f.memory.listArtifacts()), /fixture-(?:client-secret|refresh-secret|access-)/);
    const { SourceConnections } = await import("../../src/live/sources.ts");
    const reopened = new SourceConnections(f.directory, f.memory);
    assert.equal((await reopened.readRecords(source.id, "customers")).items.length, 1);
    assert.equal(grants.length, 2, "a valid token survives host restart without a fresh grant");
    reopened.disable(source.id, source.version);
    assert.doesNotMatch(readFileSync(join(f.directory, "source-oauth.json"), "utf8"), /fixture-(?:client-secret|refresh-secret|access-)/);
  } finally { await f.close(); }
});

test("a token expiring between snapshot pages refreshes and completes the full synchronized dataset", { timeout: 20000 }, async () => {
  const rows = Array.from({ length: 205 }, (_, index) => ({ id: String(index), name: `完整记录${index}` }));
  const grants: string[] = [], acceptedPages: number[] = [];
  let token = "";
  const f = await fixture(async (request, response) => {
    response.setHeader("content-type", "application/json");
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname === "/token") {
      let body = ""; for await (const chunk of request) body += chunk;
      const grant = new URLSearchParams(body); grants.push(grant.get("grant_type")!);
      if (grants.length > 1) assert.equal(grant.get("refresh_token"), "snapshot-refresh-secret");
      token = `snapshot-access-${grants.length}`;
      response.end(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 300, refresh_token: "snapshot-refresh-secret" })); return;
    }
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 100);
    if (offset >= 100 && token === "snapshot-access-1") { response.writeHead(401).end("{}"); return; }
    assert.equal(request.headers.authorization, `Bearer ${token}`); acceptedPages.push(offset);
    response.end(JSON.stringify({ items: rows.slice(offset, offset + limit), total: rows.length }));
  });
  try {
    const source = await f.live.sources.connect({ name: "同步中令牌到期", protocol: "http", url: f.url,
      auth: { type: "oauth2", oauth2: { tokenUrl: f.url + "/token", clientId: "snapshot-client", clientSecret: "snapshot-client-secret" } },
      capabilities: [{ name: "records", path: "/records", fields: ["id", "name"], totalPath: "total" }] });
    const synced = await f.snapshots.sync({ operationId: "refresh-through-all-pages", sourceIds: [source.id] });
    assert.equal(synced.content.outcome, "synced", JSON.stringify(synced.content.issues));
    assert.deepEqual(grants, ["client_credentials", "refresh_token"]);
    assert.deepEqual(acceptedPages, [0, 100, 200]);
    const dataset = f.snapshots.datasets()[0];
    assert.deepEqual(dataset.content.coverage, { rows: 205, total: 205, complete: true });
    assert.equal((await f.snapshots.preview({ datasetId: dataset.id, offset: 204, limit: 1 })).rows[0].name, "完整记录204");
    assert.doesNotMatch(JSON.stringify(f.memory.listArtifacts()), /snapshot-(?:access-|refresh-secret|client-secret)/);
  } finally { await f.close(); }
});

test("an explicitly permitted non-default HTTP host returns real records and synchronizes", { timeout: 15000 }, async () => {
  let requests = 0;
  const f = await fixture((_request, response) => { requests++; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ items: [{ id: "HTTP1", name: "内网实际记录" }], total: 1 })); }, "0.0.0.0");
  try {
    const host = Object.values(networkInterfaces()).flat().find(address => address?.family === "IPv4" && !address.internal)?.address ?? "localhost.";
    const config = { name: "明确放行的HTTP", protocol: "http", url: f.url.replace("127.0.0.1", host), capabilities: [{ name: "records", path: "/records", fields: ["id", "name"], totalPath: "total" }] };
    await assert.rejects(f.live.sources.connect(config), /HTTPS/);
    assert.equal(requests, 0, "an unapproved address is rejected before network access");
    const source = await f.live.sources.connect({ ...config, allowInsecureHttp: true });
    assert.equal((await f.live.sources.readRecords(source.id, "records")).items[0].name, "内网实际记录");
    assert.equal((await f.snapshots.sync({ operationId: "permitted-http", sourceIds: [source.id] })).content.outcome, "synced");
    assert.equal((await f.snapshots.preview({ datasetId: f.snapshots.datasets()[0].id })).rows[0].id, "HTTP1");
    assert(requests >= 2, "both ordinary reads and snapshot synchronization reached the HTTP service");
  } finally { await f.close(); }
});

test("insecure remote HTTP requires explicit admin configuration and Link paging cannot leave the approved endpoint", async () => {
  const f = await fixture((_request, response) => { response.setHeader("content-type", "application/json"); response.setHeader("link", '<http://example.test/steal>; rel="next"'); response.end(JSON.stringify({ items: [{ id: "1" }] })); });
  try {
    const config = { name: "内网", protocol: "http", url: "http://10.0.0.2", capabilities: [{ name: "items", path: "/items", fields: ["id"] }] };
    await assert.rejects(f.live.sources.connect(config), /HTTPS/);
    const allowed = await f.live.sources.connect({ ...config, allowInsecureHttp: true });
    assert.equal(allowed.content.allowInsecureHttp, true);
    const source = await f.live.sources.connect({ ...config, url: f.url, pagination: { type: "link" } });
    const first = await f.live.sources.readRecordPage(source.id, "items");
    await assert.rejects(f.live.sources.readRecordPage(source.id, "items", {}, 1, 20, source.version, first.continuation!), /来源|接口/);
  } finally { await f.close(); }
});

test("OpenAPI recognizes page and cursor parameters and imports nested fields through the tested contract", async () => {
  const f = await fixture((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    assert(url.searchParams.has("page") || !url.searchParams.has("offset"));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ items: [{ id: "1", details: { city: "上海" }, tags: ["a"] }], nextCursor: null, total: 1 }));
  });
  const imports = new OpenApiImports(f.live.sources);
  try {
    for (const parameter of ["page", "cursor"]) {
      const spec = { openapi: "3.0.3", info: { title: "嵌套目录", version: "1" }, servers: [{ url: f.url }], paths: { "/records": { get: {
        parameters: [{ in: "query", name: parameter, schema: { type: parameter === "page" ? "integer" : "string" } }, { in: "query", name: "limit", schema: { type: "integer" } }],
        responses: { "200": { description: "列表", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, details: { type: "object", properties: { city: { type: "string" } } }, tags: { type: "array", items: { type: "string" } } } } }, nextCursor: { type: "string", nullable: true }, total: { type: "integer" } } } } } } }
      } } } };
      const catalog = await imports.parse({ text: JSON.stringify(spec) }), operation = catalog.operations[0];
      assert.equal(operation.supported, true, operation.reason ?? "接口未支持");
      assert.deepEqual(operation.defaults!.fields, ["id", "details.city", "tags"]);
      assert.equal(operation.defaults!.pagination!.type, parameter);
      const preview = await imports.preview({ draftId: catalog.draftId, name: parameter, baseUrl: f.url, auth: { type: "none" }, operations: [{ id: operation.id, ...operation.defaults }] });
      assert.equal(preview.results[0].sample.items[0]["details.city"], "上海");
      const source = await imports.commit({ receiptId: preview.receiptId });
      assert.equal((await f.live.sources.readRecords(source.id, operation.name)).items[0].tags, '["a"]');
    }
  } finally { imports.close(); await f.close(); }
});

test("MCP discovery and reads find approved tools beyond the first catalog page", async () => {
  let pages = 0;
  const f = await fixture(async (request, response) => {
    if (request.method === "DELETE") { response.writeHead(200).end(); return; }
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let body = ""; for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    let result;
    if (rpc.method === "initialize") result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "paged-fixture", version: "1" } };
    else if (rpc.method === "tools/list") {
      pages++;
      result = rpc.params?.cursor === "second" ? { tools: [{ name: "customers", inputSchema: { type: "object", properties: { limit: { type: "number" }, offset: { type: "number" } } } }] }
        : { tools: [{ name: "unselected", inputSchema: { type: "object" } }], nextCursor: "second" };
    } else if (rpc.method === "tools/call") result = { content: [], structuredContent: { items: [{ id: "C1" }], total: 1 } };
    else throw new Error(rpc.method);
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  try {
    const source = await f.live.sources.connect({ name: "分页MCP", protocol: "mcp", url: f.url, capabilities: [{ name: "customers", fields: ["id"], totalPath: "total" }] });
    assert.equal((await f.live.sources.readRecords(source.id, "customers")).items[0].id, "C1");
    assert.equal(pages, 4);
  } finally { await f.close(); }
});

test("source responses support more than 2 MB but stop at 20 MB and retry exhaustion stays bounded", { timeout: 10000 }, async () => {
  let size = 2_100_000, fail = false, requests = 0;
  const f = await fixture((_request, response) => {
    requests++; response.setHeader("content-type", "application/json");
    if (fail) { response.writeHead(503).end("{}"); return; }
    response.end(JSON.stringify({ items: [{ id: "1", text: "x".repeat(size) }], total: 1 }));
  });
  try {
    const source = await f.live.sources.connect({ name: "大响应", protocol: "http", url: f.url, capabilities: [{ name: "records", path: "/records", fields: ["id", "text"], totalPath: "total" }] });
    assert.equal(String((await f.live.sources.readRecords(source.id, "records")).items[0].text).length, size);
    size = 20_000_001;
    await assert.rejects(f.live.sources.readRecords(source.id, "records"), /来源读取失败/);
    fail = true; requests = 0;
    await assert.rejects(f.live.sources.readRecords(source.id, "records"), /来源读取失败/);
    assert.equal(requests, 4, "three retries after the first attempt");
  } finally { await f.close(); }
});

test("OAuth credentials in Link continuation are rejected before returning or persisting a checkpoint", async () => {
  const token = "fixture-link-secret+value";
  const f = await fixture((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/token") { response.end(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 300 })); return; }
    response.setHeader("link", `</items?next=2&access_token=${encodeURIComponent(token)}>; rel="next"`);
    response.end(JSON.stringify({ items: [{ id: "1" }] }));
  });
  try {
    const source = await f.live.sources.connect({ name: "分页秘密", protocol: "http", url: f.url,
      auth: { type: "oauth2", oauth2: { tokenUrl: f.url + "/token", clientId: "client", clientSecret: "client-secret" } },
      pagination: { type: "link" }, capabilities: [{ name: "items", path: "/items", fields: ["id"] }] });
    await assert.rejects(f.live.sources.readRecordPage(source.id, "items"), /来源读取失败/);
    await f.snapshots.sync({ operationId: "secret-link", sourceIds: [source.id] });
    assert.doesNotMatch(JSON.stringify(f.memory.listArtifacts()), /fixture-link-secret/);
    assert.equal(f.snapshots.datasets().length, 0);
  } finally { await f.close(); }
});

test("a wide upstream object keeps the approved small projection readable and snapshot materialization bounded", async () => {
  const row = { id: "1", ...Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`unselected_${i}`, `value${i}`])) };
  const f = await fixture((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ items: [row], total: 1 })); });
  try {
    const source = await f.live.sources.connect({ name: "字段子集", protocol: "http", url: f.url, capabilities: [{ name: "items", path: "/items", fields: ["id"], totalPath: "total" }] });
    assert.deepEqual((await f.live.sources.readRecords(source.id, "items")).items, [{ id: "1" }]);
    await f.snapshots.sync({ operationId: "small-projection" });
    assert.deepEqual((await f.snapshots.preview({ datasetId: f.snapshots.datasets()[0].id })).rows, [{ id: "1" }]);
  } finally { await f.close(); }
});

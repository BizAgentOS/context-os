import { historicalConsumers } from "./historical-consumers-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type RequestListener } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { readBridgeConfig } from "../../scripts/dataengine-mcp.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHeatingDemo } from "../../src/demo/server.ts";
import { Workspace } from "../../src/agent/workspace.ts";

const script = fileURLToPath(new URL("../../scripts/dataengine-mcp.ts", import.meta.url));
const key = "de_consumer_mcp_test_only";

test("MCP configuration requires a consumer key and a service origin", () => {
  assert.deepEqual(readBridgeConfig({ DATAENGINE_URL: "http://localhost:8788", DATAENGINE_CONSUMER_KEY: key }), {
    origin: "http://localhost:8788", key,
  });
  assert.throws(() => readBridgeConfig({ DATAENGINE_URL: "file:///tmp/memory.db", DATAENGINE_CONSUMER_KEY: key }));
  assert.throws(() => readBridgeConfig({ DATAENGINE_URL: "http://localhost:8788/api", DATAENGINE_CONSUMER_KEY: key }));
});

async function httpFixture(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function stdioBridge(url: string, apiKey = key) {
  const child = spawn(process.execPath, [script], {
    env: { PATH: process.env.PATH, DATAENGINE_URL: url, DATAENGINE_CONSUMER_KEY: apiKey },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let sequence = 0;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const response = JSON.parse(line);
      const request = pending.get(response.id);
      if (request) {
        pending.delete(response.id);
        request.resolve(response);
      }
    } catch {
      for (const request of pending.values()) request.reject(new Error("Non-JSON MCP stdout"));
      pending.clear();
    }
  });
  const ended = new Promise<void>((resolve) => child.once("exit", () => {
    for (const request of pending.values()) request.reject(new Error("MCP exited before responding"));
    pending.clear();
    resolve();
  }));
  return {
    async request(method: string, params: Record<string, unknown> = {}) {
      const id = ++sequence;
      return new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}`));
        }, 10_000);
        pending.set(id, {
          resolve: (value) => { clearTimeout(timeout); resolve(value); },
          reject: (error) => { clearTimeout(timeout); reject(error); },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notify(method: string) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
    output: () => ({ stdout, stderr }),
    ended,
    async close() {
      child.kill("SIGTERM");
      await ended;
      lines.close();
    },
  };
}

async function initialize(bridge: ReturnType<typeof stdioBridge>) {
  const response = await bridge.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "dataengine-stdio-test", version: "1.0.0" },
  });
  assert.equal(response.result.serverInfo.name, "dataengine-memory");
  assert.equal(response.result.protocolVersion, "2025-11-25");
  bridge.notify("notifications/initialized");
}

test("MCP stdio discovers tools and reads only the consumer HTTP surface", async () => {
  const requests: Array<{ path: string; authorization?: string }> = [];
  const schema = { name: "客服 Agent", model: { id: "model-1", version: 3 }, dataVersion: 2, types: [{ name: "投诉", fields: [{ name: "$id" }, { name: "状态" }], relations: [{ name: "回访", to: "回访" }] }] };
  const fixture = await httpFixture((request, response) => {
    requests.push({ path: request.url!, authorization: request.headers.authorization });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url === "/v1/schema" ? schema : {
      dataVersion: 2, items: [{ type: "回访", id: "HF002", fields: { 状态: "未改善" } }],
    }));
  });
  const bridge = stdioBridge(fixture.url);
  try {
    await initialize(bridge);
    const listed = await bridge.request("tools/list");
    assert.deepEqual(listed.result.tools.map((tool: any) => tool.name), ["describe_memory", "query_objects"]);
    assert.ok(listed.result.tools.every((tool: any) => tool.annotations.readOnlyHint));
    const described = await bridge.request("tools/call", { name: "describe_memory", arguments: {} });
    assert.deepEqual(JSON.parse(described.result.content[0].text), schema);
    const queried = await bridge.request("tools/call", {
      name: "query_objects",
      arguments: { type: "投诉", fields: ["$id", "状态"], id: "TS002", relation: "回访", offset: 0, limit: 12, dataVersion: 2 },
    });
    assert.equal(JSON.parse(queried.result.content[0].text).items[0].id, "HF002");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].path, "/v1/schema");
    const query = new URL(requests[1].path, fixture.url);
    assert.equal(query.pathname, "/v1/objects");
    assert.deepEqual(Object.fromEntries(query.searchParams), {
      type: "投诉", fields: "$id,状态", id: "TS002", relation: "回访", offset: "0", limit: "12", dataVersion: "2",
    });
    assert.ok(requests.every((request) => request.authorization === `Bearer ${key}`));
    assert.equal(bridge.output().stdout.includes(key), false);
    assert.equal(bridge.output().stderr, "");
  } finally {
    await bridge.close();
    await fixture.close();
  }
});

test("MCP preserves authorization and publication failures without revealing its credential", async () => {
  let status = 403;
  let code = "forbidden";
  const fixture = await httpFixture((_request, response) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: `访问范围不允许 (${key})`, code }).replaceAll("de_consumer", "\\u0064e_consumer"));
  });
  const bridge = stdioBridge(fixture.url);
  try {
    await initialize(bridge);
    for (const [value, reason] of [[403, "forbidden"], [401, "invalid_key"], [409, "data_version_changed"], [409, "memory_unavailable"]] as const) {
      status = value;
      code = reason;
      const response = await bridge.request("tools/call", { name: "query_objects", arguments: { type: "投诉", dataVersion: 1 } });
      assert.equal(response.result.isError, true);
      const failure = JSON.parse(response.result.content[0].text);
      assert.equal(failure.status, value);
      assert.equal(failure.code, reason);
      assert.match(failure.error, /访问范围不允许/);
      if (reason === "data_version_changed") assert.match(failure.hint, /describe_memory/);
      else assert.equal(failure.hint, undefined);
    }
    assert.equal(JSON.stringify(bridge.output()).includes(key), false);
  } finally {
    await bridge.close();
    await fixture.close();
  }
});

test("MCP also serves current protocol discovery and tool calls over stdio", async () => {
  const fixture = await httpFixture((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ name: "Current MCP", types: [], dataVersion: 2 }));
  });
  const bridge = stdioBridge(fixture.url);
  const _meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "current-stdio-test", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  try {
    const discovered = await bridge.request("server/discover", { _meta });
    assert.deepEqual(discovered.result.supportedVersions, ["2026-07-28"]);
    const listed = await bridge.request("tools/list", { _meta });
    assert.equal(listed.result.tools.length, 2);
    const response = await bridge.request("tools/call", { name: "describe_memory", arguments: {}, _meta });
    assert.equal(JSON.parse(response.result.content[0].text).dataVersion, 2);
    assert.equal(bridge.output().stderr, "");
  } finally {
    await bridge.close();
    await fixture.close();
  }
});

test("MCP reads a heating complaint, follows its callback, and observes only published data with the same key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-mcp-heating-"));
  const service = await createHeatingDemo(directory);
  let bridge: ReturnType<typeof stdioBridge> | undefined;
  try {
    await new Promise<void>((resolve) => service.server.listen(0, "127.0.0.1", resolve));
    const address = service.server.address();
    assert.ok(address && typeof address !== "string");
    const model = service.app.memory.listArtifacts("ontology").find((artifact) => artifact.status === "adopted");
    assert.ok(model);
    const draft = historicalConsumers(service.app.consumption, service.app.memory, directory).propose({
      name: "独立 MCP 客服助手", purpose: "按授权读取投诉与回访",
      modelId: model.id, modelVersion: model.version,
      grants: [
        { type: "投诉", fields: ["$id", "处理状态"], relations: ["居民回访"] },
        { type: "回访", fields: ["$id", "投诉编号", "反馈结果"], relations: [] },
      ],
    });
    const { consumer, apiKey } = historicalConsumers(service.app.consumption, service.app.memory, directory).activate(draft.id, draft.version);
    bridge = stdioBridge(`http://127.0.0.1:${address.port}`, apiKey);
    await initialize(bridge);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await bridge!.request("tools/call", { name, arguments: args });
      assert.equal(response.error, undefined);
      return { ...response.result, body: JSON.parse(response.result.content[0].text) };
    };
    const schema = await call("describe_memory");
    assert.equal(schema.body.dataVersion, consumer.version);
    assert.deepEqual(schema.body.types.map((type: any) => type.name), ["投诉", "回访"]);
    assert.equal(JSON.stringify(schema.body).includes("联系手机"), false);
    const complaint = await call("query_objects", { type: "投诉", id: "TS002", dataVersion: consumer.version });
    assert.equal(complaint.body.items[0].id, "TS002");
    assert.equal(complaint.body.items[0].fields.处理状态, "已办结");
    const query = { type: "投诉", id: "TS002", relation: "居民回访", dataVersion: consumer.version };
    const before = await call("query_objects", query);
    assert.equal(before.body.items[0].id, "HF002");
    assert.equal(before.body.items[0].fields.反馈结果, "未改善");

    const source = service.app.memory.listArtifacts("source").find((artifact) => artifact.title === "客服回访.csv");
    assert.ok(source);
    const replacement = String(source.content.raw).split("\n").map((line) => line.startsWith('"HF002"')
      ? '"HF002","TS002","2026-01-09 18:45","已改善","再次回访居民确认暖气改善"' : line).join("\n");
    new Workspace(service.app.memory).upload(source.title, replacement);
    const unpublished = await call("query_objects", query);
    assert.equal(unpublished.body.items[0].fields.反馈结果, "未改善");
    const preview = service.app.consumption.previewDataUpdate(consumer.id, consumer.version);
    assert.equal(preview.valid, true);
    const published = historicalConsumers(service.app.consumption, service.app.memory, directory).publishDataUpdate(consumer.id, consumer.version, preview.nextSourceVersions);
    const outdated = await call("query_objects", query);
    assert.equal(outdated.isError, true);
    assert.equal(outdated.body.status, 409);
    assert.equal(outdated.body.code, "data_version_changed");
    const refreshed = await call("describe_memory");
    assert.equal(refreshed.body.dataVersion, published.version);
    assert.deepEqual(refreshed.body.model, schema.body.model);
    const after = await call("query_objects", { ...query, dataVersion: refreshed.body.dataVersion });
    assert.equal(after.body.items[0].fields.反馈结果, "已改善");
    service.app.consumption.revoke(published.id, published.version);
    const revoked = await call("query_objects", { ...query, dataVersion: published.version });
    assert.equal(revoked.isError, true);
    assert.equal(revoked.body.status, 401);
    assert.ok(service.app.consumption.logs().filter((entry) => entry.consumerId === consumer.id).length >= 8);
    assert.equal(JSON.stringify(bridge.output()).includes(apiKey), false);
  } finally {
    await bridge?.close();
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP rejects unsupported and unbounded queries before making HTTP requests", async () => {
  let count = 0;
  const fixture = await httpFixture((_request, response) => {
    count += 1;
    response.end("{}");
  });
  const bridge = stdioBridge(fixture.url);
  try {
    await initialize(bridge);
    for (const args of [
      {}, { type: "投诉", limit: 101 }, { type: "投诉", offset: -1 },
      { type: "投诉", dataVersion: 0 }, { type: "投诉", relation: "回访" },
      { type: "投诉", fields: ["status,phone"] }, { type: "投诉", path: "/api/canvas" },
    ]) {
      const response = await bridge.request("tools/call", { name: "query_objects", arguments: args });
      assert.ok(response.error || response.result?.isError, JSON.stringify(args));
    }
    assert.equal(count, 0);
  } finally {
    await bridge.close();
    await fixture.close();
  }
});

test("MCP does not follow HTTP redirects or expose non-JSON response bodies", async () => {
  let redirect = true;
  const fixture = await httpFixture((_request, response) => {
    if (redirect) response.writeHead(302, { Location: `/other?key=${key}` });
    response.end(`<html>${key}</html>`);
  });
  const bridge = stdioBridge(fixture.url);
  try {
    await initialize(bridge);
    for (const value of [true, false]) {
      redirect = value;
      const response = await bridge.request("tools/call", { name: "describe_memory", arguments: {} });
      assert.equal(response.result.isError, true);
    }
    assert.equal(JSON.stringify(bridge.output()).includes(key), false);
  } finally {
    await bridge.close();
    await fixture.close();
  }
});

test("MCP startup refuses a management key and URL credentials without echoing either", async () => {
  for (const [url, apiKey] of [["http://127.0.0.1:8788", "admin_secret_value"], [`http://user:${key}@localhost:8788`, key]]) {
    const bridge = stdioBridge(url, apiKey);
    try {
      await bridge.ended;
      assert.equal(bridge.output().stdout, "");
      assert.match(bridge.output().stderr, /DataEngine MCP configuration/);
      assert.equal(JSON.stringify(bridge.output()).includes(key), false);
      assert.equal(JSON.stringify(bridge.output()).includes("admin_secret_value"), false);
    } finally {
      await bridge.close();
    }
  }
});

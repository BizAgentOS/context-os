import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentMcp } from "../../src/capabilities/mcp.ts";
import { createHeatingSources } from "../../src/live/heating-sources.ts";
import { createServer } from "../../src/agent/server.ts";
import { capabilityFixture } from "./capabilities-fixture.ts";

test("a URL discovers MCP capabilities without a name, tool execution or implicit grants", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-onboarding-"));
  const upstream = await createHeatingSources();
  let service = new AgentMcp(directory);
  try {
    const [connected] = await service.connect({ url: upstream.mcpUrl });
    assert.match(connected.name, /^[a-z][a-z0-9-]{1,63}$/);
    assert.equal(connected.url, upstream.mcpUrl);
    assert.equal(connected.capabilities.length, 1);
    const capability = connected.capabilities[0];
    assert.equal(capability.allowed, false);
    await assert.rejects(service.call(capability.id, { limit: 1, offset: 0 }), /授权/);
    service.grant(connected.name, [capability.id], connected.revision);
    await assert.rejects(service.connect({ url: upstream.mcpUrl, headers: { Authorization: "Bearer replacement-secret" } }), /已经连接/);
    assert.equal(service.list().length, 1);
    assert.doesNotMatch(JSON.stringify(service.list()), /replacement-secret/);
    await service.close();
    service = new AgentMcp(directory);
    assert.equal(service.list()[0].capabilities[0].allowed, true);
    assert.match(JSON.stringify(await service.call(capability.id, { limit: 1, offset: 0 })), /未改善/);
  } finally {
    await service.close();
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP directory is administrator-only and supports connect, grant, revoke and disconnect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-onboarding-http-"));
  const upstream = await createHeatingSources();
  const service = await createServer({ directory });
  await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(service.server.address() as { port: number }).port}`;
  const headers = { "X-DataEngine-Token": service.adminToken, "Content-Type": "application/json" };
  const post = (path: string, body: unknown) => fetch(url + "/api/capabilities/mcp/" + path, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(url + "/api/capabilities/mcp")).status, 403);
    const connected = await post("connect", { url: upstream.mcpUrl, headers: { "X-Test": "fixture-private" } });
    assert.equal(connected.status, 200);
    const directoryResponse = await fetch(url + "/api/capabilities/mcp", { headers });
    assert.equal(directoryResponse.status, 200);
    const directoryState = await directoryResponse.json();
    assert.doesNotMatch(JSON.stringify(directoryState), /fixture-private|headers/);
    const server = directoryState.servers[0];
    assert.equal(server.url, upstream.mcpUrl);
    assert.equal(server.capabilities[0].allowed, false);
    assert.equal((await post("grant", { name: server.name, revision: server.revision, ids: [server.capabilities[0].id] })).status, 200);
    assert.equal((await post("grant", { name: server.name, revision: server.revision, ids: [server.capabilities[0].id] })).status, 400);
    assert.equal((await post("disconnect", { name: server.name })).status, 200);
    assert.deepEqual((await (await fetch(url + "/api/capabilities/mcp", { headers })).json()).servers, []);
  } finally {
    await service.close();
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("simultaneous MCP connects cannot replace credentials or create duplicate entries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-overlap-"));
  const upstream = await createHeatingSources();
  const service = new AgentMcp(directory);
  try {
    const results = await Promise.allSettled([
      service.connect({ url: upstream.mcpUrl }),
      service.connect({ url: upstream.mcpUrl }),
    ]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(service.list().length, 1);
    const first = service.list()[0];
    service.grant(first.name, [first.capabilities[0].id], first.revision);
    assert.match(JSON.stringify(await service.call(first.capabilities[0].id, { limit: 1, offset: 0 })), /未改善/);
  } finally {
    await service.close();
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const failure of ["unreachable", "unauthorized"] as const) {
  test(`reconnecting an ${failure} MCP cannot report its cached catalog as a successful connection`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "mcp-reconnect-"));
    const upstream = await capabilityFixture({ token: "fixture-token" });
    const service = new AgentMcp(directory);
    let upstreamClosed = false;
    try {
      const [first] = await service.connect({ url: upstream.url, headers: { Authorization: "Bearer fixture-token" } });
      assert.equal(first.capabilities.length, 48);
      if (failure === "unreachable") {
        service.grant(first.name, [first.capabilities[0].id], first.revision);
        await upstream.close();
        upstreamClosed = true;
        await assert.rejects(service.refresh(first.name), /重新发现失败/);
        assert.equal(service.list()[0].capabilities.some(item => item.allowed), false);
      }
      await service.disconnect(first.name);
      await assert.rejects(service.connect({ url: upstream.url, headers: { Authorization: "Bearer incorrect-token" } }), /未能发现 MCP/);
      assert.deepEqual(service.list(), []);
      if (failure === "unauthorized") {
        const [retried] = await service.connect({ url: upstream.url, headers: { Authorization: "Bearer fixture-token" } });
        assert.equal(retried.capabilities.length, 48);
        assert.equal(retried.capabilities.some(item => item.allowed), false);
      }
    } finally {
      await service.close();
      if (!upstreamClosed) await upstream.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

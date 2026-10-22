import {publishedDefinition,publishWorking,connectPublished} from "./published-consumers-fixture.ts";
import { restoreHistoricalAccess } from "./historical-consumers-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { LiveMemory } from "../../src/live/memory.ts";

test("adopted mapping serves fresh objects to scoped consumers and rejects drift and revocation", async () => {
  let outcome = "未改善";
  let broken = false;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        items: [
          broken
            ? { id: "HF002" }
            : { id: "HF002", outcome, private: "手机号" },
        ],
        total: 1,
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "live-memory-"));
  const repo = new MemoryStore(dir);
  const live = new LiveMemory(dir, repo);
  try {
    const source = await live.sources.connect({
      name: "回访接口",
      protocol: "http",
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      capabilities: [
        {
          name: "callbacks",
          path: "/callbacks",
          fields: ["id", "outcome", "private"],
          idField: "id",
          filters: { id: "id" },
          totalPath: "total",
        },
      ],
    });
    const candidate = await live.propose({
      purpose: "判断投诉回访",
      types: [
        {
          name: "回访",
          description: "客户反馈记录",
          sourceId: source.id,
          capability: "callbacks",
          fields: { 结果: "outcome" },
        },
      ],
      relations: [],
      rationale: "回访结果代表客户反馈，不能仅用办结证明恢复。",
    });
    assert.equal(candidate.status, "candidate");
    assert.equal(live.overview().models.find(m => m.id === candidate.id)?.canAdopt, true);
    const stale = await live.propose({
      purpose: "同一基线的另一候选",
      types: [{name:"回访", description:"客户反馈记录", sourceId:source.id, capability:"callbacks", fields:{结果:"outcome"}}],
      relations: [], rationale: "用于核对采用后的旧候选可用性。",
    });
    const model = await live.adopt(candidate.id, candidate.version);
    const availability = live.overview().models.find(m => m.id === stale.id)!;
    assert.equal(availability.canAdopt, false);
    assert.match(availability.adoptionReason!, /执行子集版本已变化/);
    await assert.rejects(live.adopt(stale.id, stale.version), /已变化/);
    const draft = restoreHistoricalAccess({ memory: repo, live }, "/api/live/prepare", {
      name: "客服 Agent",
      purpose: "读取回访",
      modelId: model.id,
      grants: [{ type: "回访", fields: ["$id", "结果"], relations: [] }],
    }).saved;
    const { key } = restoreHistoricalAccess({ memory: repo, live }, "/api/live/activate", { id: draft.id, version: draft.version }).saved;
    const read = () =>
      live.handle(
        "/v2/objects",
        new URLSearchParams({ type: "回访" }),
        `Bearer ${key}`,
      );
    assert.equal((await read()).status, 200);
    assert.match(JSON.stringify((await read()).body), /未改善/);
    outcome = "已改善";
    assert.match(JSON.stringify((await read()).body), /已改善/);
    assert.doesNotMatch(JSON.stringify((await read()).body), /手机号|sourceId/);
    assert.equal(
      (
        await live.handle(
          "/v2/objects",
          new URLSearchParams({ type: "回访", fields: "private" }),
          `Bearer ${key}`,
        )
      ).status,
      403,
    );
    broken = true;
    assert.equal((await read()).status, 502);
    broken = false;
    assert.doesNotMatch(JSON.stringify(repo.listArtifacts()), /HF002|手机号/);
    live.revoke(draft.id, repo.getArtifact(draft.id).version);
    assert.equal((await read()).status, 403);
  } finally {
    repo.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP and third-party MCP traverse two sources; changes remain visible after restart", async () => {
  const { createServer: appServer } = await import("../../src/agent/server.ts");
  const { createHeatingSources, connectHeatingSources, heatingDefinition } =
    await import("../../src/live/heating-sources.ts");
  const { Client } = await import("@modelcontextprotocol/client");
  const { StdioClientTransport } =
    await import("@modelcontextprotocol/client/stdio");
  const upstream = await createHeatingSources();
  const dir = mkdtempSync(join(tmpdir(), "live-http-"));
  let service = await appServer({ directory: dir, automaticApi: false });
  let client: InstanceType<typeof Client> | undefined;
  const listen = async () => {
    await new Promise<void>((r) => service.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(service.server.address() as { port: number }).port}`;
  };
  try {
    let origin = await listen();
    const post = async (path: string, body: unknown) => {
      const response = await fetch(origin + "/api/live/" + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-contextos-token": service.adminToken,
        },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    const { api, mcp } = await connectHeatingSources(
      service.app.live.sources,
      upstream,
    );
    const candidate = (await post("propose", publishedDefinition(service.app,heatingDefinition(api.id, mcp.id))))
      .saved;
    const model = (
      await post("adopt", { id: candidate.id, version: candidate.version })
    ).saved;
    const publication=await publishWorking(service.app);
    const activated=connectPublished(service.app,publication,{name:"外部客服",purpose:"核对回访",grants:[{type:"投诉",fields:["$id","状态"],relations:["回访记录"]},{type:"回访",fields:["$id","投诉编号","结果"],relations:[]}]});
    const key = activated.key!;
    client = new Client({ name: "external-test", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve("scripts/context-os-mcp.ts")],
        env: {
          PATH: process.env.PATH!,
          CONTEXT_OS_URL: origin,
          CONTEXT_OS_CONSUMER_KEY: key,
        },
      }),
    );
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === "query_objects"));
    const query = () =>
      client!.callTool({
        name: "query_objects",
        arguments: { type: "投诉", id: "TS002", relation: "回访记录" },
      });
    assert.match(JSON.stringify(await query()), /未改善/);
    upstream.setOutcome("已改善");
    assert.match(JSON.stringify(await query()), /已改善/);
    assert.equal(
      (
        await fetch(origin + "/api/canvas", {
          headers: { Authorization: `Bearer ${key}` },
        })
      ).status,
      403,
    );
    await client.close();
    client = undefined;
    await service.close();
    service = await appServer({ directory: dir, automaticApi: false });
    origin = await listen();
    const response = await fetch(
      origin + "/v4/objects?type=" + encodeURIComponent("回访"),
      { headers: { Authorization: `Bearer ${key}` } },
    );
    assert.equal(response.status, 200);
    assert.match(await response.text(), /已改善/);
    await post("disable", { id: mcp.id, version: mcp.version });
    assert.equal(
      (
        await fetch(origin + "/v4/types?type=" + encodeURIComponent("回访"), {
          headers: { Authorization: `Bearer ${key}` },
        })
      ).status,
      502,
    );
  } finally {
    await client?.close();
    await service.close();
    await upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revocation during an in-flight read cannot disclose the late result", async () => {
  let release!: () => void;
  let entered!: () => void;
  let blocked = false;
  const seen = new Promise<void>((r) => (entered = r));
  const gate = new Promise<void>((r) => (release = r));
  const server = createServer(async (req, res) => {
    if (blocked) {
      entered();
      await gate;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ items: [{ id: "R1", value: "restricted" }], total: 1 }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "live-revoke-"));
  const repo = new MemoryStore(dir);
  const live = new LiveMemory(dir, repo);
  try {
    const source = await live.sources.connect({
      name: "业务",
      protocol: "http",
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      capabilities: [
        {
          name: "read",
          path: "/records",
          idField: "id",
          fields: ["id", "value"],
          filters: { id: "id" },
          totalPath: "total",
        },
      ],
    });
    const candidate = await live.propose({
      purpose: "核对",
      rationale: "字段值",
      types: [
        {
          name: "记录",
          description: "业务记录",
          sourceId: source.id,
          capability: "read",
          fields: { 值: "value" },
        },
      ],
      relations: [],
    });
    const model = await live.adopt(candidate.id, candidate.version);
    const draft = restoreHistoricalAccess({ memory: repo, live }, "/api/live/prepare", {
      name: "client",
      purpose: "read",
      modelId: model.id,
      grants: [{ type: "记录", fields: ["$id", "值"], relations: [] }],
    }).saved;
    const { key } = restoreHistoricalAccess({ memory: repo, live }, "/api/live/activate", { id: draft.id, version: draft.version }).saved;
    blocked = true;
    const pending = live.handle(
      "/v2/objects",
      new URLSearchParams({ type: "记录" }),
      `Bearer ${key}`,
    );
    await seen;
    live.revoke(draft.id, repo.getArtifact(draft.id).version);
    release();
    const result = await pending;
    assert.equal(result.status, 403);
    assert.doesNotMatch(JSON.stringify(result.body), /restricted/);
  } finally {
    release?.();
    repo.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("numeric object relations work and stopping the origin cancels an in-flight internal relation", async () => {
  let delayed = false;
  let entered!: () => void;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    seen = new Promise<void>((r) => (entered = r));
  const server = createServer(async (req, res) => {
    const target = req.url!.startsWith("/callbacks");
    if (target && delayed) {
      entered();
      await gate;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        items: target
          ? [{ id: 7, complaintId: 42, value: "ok" }]
          : [{ id: 42, value: "closed" }],
        total: 1,
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "live-rel-revoke-"));
  const repo = new MemoryStore(dir),
    live = new LiveMemory(dir, repo);
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const a = await live.sources.connect({
      name: "投诉",
      protocol: "http",
      url,
      capabilities: [
        {
          name: "read",
          path: "/complaints",
          idField: "id",
          idType: "number",
          fields: ["id", "value"],
          filters: { id: "id" },
          totalPath: "total",
        },
      ],
    });
    const b = await live.sources.connect({
      name: "回访",
      protocol: "http",
      url,
      capabilities: [
        {
          name: "read",
          path: "/callbacks",
          idField: "id",
          idType: "number",
          fields: ["id", "complaintId", "value"],
          filters: { id: "id", complaintId: "complaintId" },
          totalPath: "total",
        },
      ],
    });
    const candidate = await live.propose({
      purpose: "关联",
      rationale: "编号关联",
      types: [
        {
          name: "投诉",
          description: "投诉",
          sourceId: a.id,
          capability: "read",
          fields: { 状态: "value" },
        },
        {
          name: "回访",
          description: "回访",
          sourceId: b.id,
          capability: "read",
          fields: { 投诉编号: "complaintId", 结果: "value" },
        },
      ],
      relations: [
        {
          name: "回访",
          from: "投诉",
          to: "回访",
          fromField: "$id",
          toField: "投诉编号",
        },
      ],
    });
    const model = await live.adopt(candidate.id, candidate.version);
    const query = () =>
      live.query({
        modelId: model.id,
        type: "投诉",
        id: "42",
        relation: "回访",
      });
    assert.equal((await query()).items[0].$id, 7);
    delayed = true;
    const pending = query();
    await seen;
    live.sources.disable(a.id, a.version);
    release();
    await assert.rejects(pending, /停用/);
  } finally {
    release?.();
    repo.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

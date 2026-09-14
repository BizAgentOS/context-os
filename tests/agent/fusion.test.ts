import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import {
  createFusionSources,
  primaryCapability,
  supplementCapability,
  fusionDefinition,
} from "./fusion-fixture.ts";

test("one object resolves complementary values and preserves conflict, absent, ambiguous and incomplete source evidence", async () => {
  const upstream = await createFusionSources(),
    directory = mkdtempSync(join(tmpdir(), "de-fusion-"));
  let definition: any, candidate: any;
  const service = await createServer({
    directory,
    driver: {
      async run(request) {
        assert(request.tools.some((t) => t.name === "live_propose"));
        candidate = await request.onTool("live_propose", definition);
        const result = (await request.onTool("live_query", {
          modelId: (candidate as any).id,
          type: "投诉",
        })) as any;
        assert.equal(result.items[0].实际反馈, "未改善");
        assert.equal(result.evidence[0].properties.上门次数.value, 0);
        return {
          text: "融合候选已形成，保留未知与冲突",
          sessionId: "fusion",
          runId: "fusion",
        };
      },
      async stop() {},
      async close() {},
    },
  });
  await new Promise<void>((r) => service.server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const api = async (path: string, body?: unknown) => {
    const r = await fetch(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        "x-dataengine-token": service.adminToken,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await r.json()) as any;
    if (!r.ok) throw new Error(data.error);
    return data;
  };
  try {
    const primary = (
      await api("/api/live/connect", {
        name: "投诉系统",
        protocol: "http",
        url: upstream.url,
        capabilities: [primaryCapability],
      })
    ).saved;
    const extra = (
      await api("/api/live/connect", {
        name: "工单系统",
        protocol: "mcp",
        url: upstream.url + "/mcp",
        capabilities: [supplementCapability],
      })
    ).saved;
    definition = fusionDefinition(primary.id, extra.id);
    definition.types[0].supplements[0].fields.constructor = "outcome";
    await api("/api/canvas/message", {
      page: "setup",
      text: "按投诉编号融合投诉和工单属性，不覆盖不同说法",
      messageId: "fusion-request",
    });
    await service.app.idle();
    assert(candidate, JSON.stringify((await api("/api/canvas")).messages));
    const adopted = (
      await api("/api/live/adopt", {
        id: candidate.id,
        version: candidate.version,
      })
    ).saved;
    const query = {
      modelId: adopted.id,
      modelVersion: adopted.version,
      type: "投诉",
    };
    const first = await api("/api/live/query", query);
    assert.deepEqual(
      first.items.map((x: any) => x.$id),
      ["TS002", "TS003"],
    );
    assert.equal(first.items[0].状态, "已办结");
    assert.equal(first.items[0].constructor, "未改善");
    assert.equal(first.evidence[0].properties.constructor.evidence.length, 1);
    assert.equal(first.evidence[0].properties.状态.evidence.length, 2);
    assert.equal(first.evidence[0].matches[0].status, "unique");
    assert.equal(first.evidence[1].matches[0].status, "missing");
    assert.equal(first.evidence[1].properties.实际反馈.status, "missing");
    assert.equal(
      first.evidence[0].properties.实际反馈.evidence[0].recordId,
      "WO02",
    );
    upstream.state.mode = "conflict";
    const conflict = await api("/api/live/query", query);
    assert.equal(conflict.items[0].状态, null);
    assert.equal(conflict.evidence[0].properties.状态.status, "conflict");
    assert.deepEqual(
      conflict.evidence[0].properties.状态.evidence.map((e: any) => e.value),
      ["已办结", "未办结"],
    );
    for (const [mode, status] of [
      ["duplicate", "ambiguous"],
      ["unknown", "unknown"],
      ["short", "ambiguous"],
      ["failure", "unavailable"],
      ["wrong-filter", "unavailable"],
    ]) {
      upstream.state.mode = mode;
      const r = await api("/api/live/query", query);
      assert.equal(r.items[0].实际反馈, null, mode);
      assert.equal(r.evidence[0].matches[0].status, status, mode);
      assert.equal(
        r.items[0].状态,
        null,
        mode + " must not ignore an unresolved overlapping source",
      );
    }
    upstream.state.mode = "normal";
    upstream.state.outcome = "已改善";
    assert.equal(
      (await api("/api/live/query", query)).items[0].实际反馈,
      "已改善",
    );
    await assert.rejects(
      api("/api/live/query", { ...query, where: { 实际反馈: "已改善" } }),
      /过滤|主来源/,
    );
    // Explicit grants may consume the new field, but never raw provenance or ungranted properties.
    const consumer = (
      await api("/api/live/prepare", {
        name: "客服",
        purpose: "仅反馈",
        modelId: adopted.id,
        grants: [{ type: "投诉", fields: ["$id", "实际反馈"], relations: [] }],
      })
    ).saved;
    const activation = (
      await api("/api/live/activate", {
        id: consumer.id,
        version: consumer.version,
      })
    ).saved;
    const external = await fetch(
      origin + "/v2/objects?type=" + encodeURIComponent("投诉"),
      { headers: { authorization: "Bearer " + activation.key } },
    );
    assert.equal(external.status, 200);
    const text = await external.text();
    assert.match(text, /已改善/);
    assert.doesNotMatch(text, /sourceId|private|WO02|ticket|状态|上门次数/);
    const canvas = await api("/api/canvas");
    const context = {
      view: "ontology.definitions",
      revision: 1,
      selection: [
        {
          spaceId: canvas.workspaceId,
          kind: "property",
          id: adopted.id,
          version: adopted.version,
          type: "投诉",
          member: "实际反馈",
        },
      ],
      scope: { where: {}, offset: 0, limit: 20 },
      draftRef: { id: "fusion-property", revision: 1 },
    };
    const selected = await api("/api/canvas/context", {
      page: "ontology",
      context,
    });
    assert.equal(selected.target.definition.mappings[0].sourceId, extra.id);
    assert.equal(selected.target.definition.mappings[0].sourceField, "outcome");
    await assert.rejects(api("/api/live/query", { ...query, limit: 21 }), /20/);
    const calls = upstream.state.calls;
    await api("/api/live/query", { ...query, fields: ["$id", "业务编号"] });
    assert.equal(
      upstream.state.calls,
      calls,
      "unrequested supplementary fields do not trigger reads",
    );
    // Invalidate while a real supplemental HTTP/MCP read is in flight.
    let release!: () => void;
    const waitForRead = async (start: number) => {
      for (let i = 0; i < 100 && upstream.state.calls === start; i++)
        await new Promise((r) => setTimeout(r, 5));
      assert(
        upstream.state.calls > start,
        "supplement request reached upstream",
      );
    };
    upstream.state.delay = new Promise<void>((r) => {
      release = r;
    });
    let active = true;
    const cancelled = service.app.live.query(query, () => {
      if (!active) throw new Error("run cancelled");
    });
    const cancelledCheck = assert.rejects(cancelled, /run cancelled/);
    await waitForRead(calls);
    active = false;
    release();
    await cancelledCheck;
    const start = upstream.state.calls;
    upstream.state.delay = new Promise<void>((r) => {
      release = r;
    });
    const inFlight = api("/api/live/query", query);
    const revokedCheck = assert.rejects(inFlight, /停用|版本/);
    await waitForRead(start);
    await api("/api/live/disable", { id: extra.id, version: extra.version });
    release();
    await revokedCheck;
    await assert.rejects(
      api("/api/canvas/context", { page: "ontology", context }),
      /停用|版本/,
    );
    await assert.rejects(api("/api/live/query", query), /停用|版本/);
  } finally {
    await service.close();
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fusion work is bounded and missing business keys never become wildcard matches", async () => {
  const upstream = await createFusionSources(),
    directory = mkdtempSync(join(tmpdir(), "de-fusion-bounds-"));
  const service = await createServer({ directory });
  try {
    const primary = await service.app.live.sources.connect({
      name: "投诉",
      protocol: "http",
      url: upstream.url,
      capabilities: [primaryCapability],
    });
    const extra = await service.app.live.sources.connect({
      name: "工单",
      protocol: "mcp",
      url: upstream.url + "/mcp",
      capabilities: [supplementCapability],
    });
    const definition = fusionDefinition(primary.id, extra.id);
    const binding = definition.types[0].supplements[0];
    definition.types[0].supplements = [
      binding,
      { ...binding, name: "复核一" },
      { ...binding, name: "复核二" },
    ];
    const model = await service.app.live.propose(definition);
    upstream.primary[0].ticket = "";
    let result = await service.app.live.query({
      modelId: model.id,
      type: "投诉",
      fields: ["实际反馈"],
    });
    assert.equal(result.evidence![0].matches[0].status, "missing_key");
    assert.equal(result.items[0].实际反馈, null);
    upstream.primary[0].ticket = "T-02";
    for (let i = upstream.primary.length; i < 20; i++)
      upstream.primary.push({ ...upstream.primary[0], id: "TS" + i });
    const before = upstream.state.calls;
    result = await service.app.live.query({
      modelId: model.id,
      type: "投诉",
      fields: ["实际反馈"],
      limit: 20,
    });
    assert.equal(upstream.state.calls - before, 40);
    assert.equal(result.items.length, 20);
    assert.equal(
      result.evidence!.at(-1)!.properties.实际反馈.status,
      "uncertain",
    );
    assert.match(result.evidence!.at(-1)!.matches[0].reason, /预算/);
  } finally {
    await service.close();
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stopping context_read prevents queued supplemental requests through the actual Agent tool path", async () => {
  const upstream = await createFusionSources(),
    directory = mkdtempSync(join(tmpdir(), "de-fusion-stop-"));
  let release!: () => void;
  const service = await createServer({
    directory,
    driver: {
      async run(request) {
        await assert.rejects(request.onTool("context_read", {}));
        return { text: "late", sessionId: "stopped", runId: "stopped" };
      },
      async stop() {
        release();
      },
      async close() {},
    },
  });
  try {
    const primary = await service.app.live.sources.connect({
      name: "投诉",
      protocol: "http",
      url: upstream.url,
      capabilities: [
        { ...primaryCapability, filters: { id: "id", ticket: "ticket" } },
      ],
    });
    const extra = await service.app.live.sources.connect({
      name: "工单",
      protocol: "mcp",
      url: upstream.url + "/mcp",
      capabilities: [supplementCapability],
    });
    const definition: any = fusionDefinition(primary.id, extra.id);
    definition.relations = [
      {
        name: "同编号记录",
        from: "投诉",
        to: "投诉",
        fromField: "业务编号",
        toField: "业务编号",
      },
    ];
    const model = await service.app.live.propose(definition);
    for (let i = upstream.primary.length; i < 12; i++)
      upstream.primary.push({ ...upstream.primary[0], id: "TS" + i });
    upstream.state.delay = new Promise<void>((r) => {
      release = r;
    });
    const before = upstream.state.calls;
    await service.app.canvasNavigate({ page: "ontology" });
    const state = service.app.canvasState();
    await service.app.canvasMessage({
      page: "ontology",
      text: "核对同编号记录",
      messageId: "stop-fusion",
      workContext: {
        view: "ontology.objects",
        revision: 1,
        selection: [
          {
            spaceId: state.workspaceId,
            kind: "relation",
            id: model.id,
            version: model.version,
            type: "投诉",
            member: "同编号记录",
            objectId: "TS002",
          },
        ],
        scope: { where: {}, offset: 0, limit: 20 },
        draftRef: { id: "fusion-stop", revision: 1 },
      },
    });
    for (let i = 0; i < 200 && upstream.state.calls < before + 4; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(upstream.state.calls - before, 4);
    await service.app.canvasStop({ page: "ontology" });
    await service.app.idle();
    assert.equal(
      upstream.state.calls - before,
      4,
      "stopping must not start the remaining seven matching reads",
    );
  } finally {
    release?.();
    await service.close();
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import {
  createFusionSources,
  primaryCapability,
  supplementCapability,
  fusionDefinition,
} from "./fusion-fixture.ts";

test("v3 views expose only allowed fusion values and status, isolate credentials, and stop an in-flight revoked response", async () => {
  const source = await createFusionSources(),
    directory = mkdtempSync(join(tmpdir(), "de-view-"));
  const service = await createServer({
    directory,
    driver: {
      async run() {
        return { text: "idle", sessionId: "s", runId: "r" };
      },
      async stop() {},
      async close() {},
    },
  });
  await new Promise<void>((r) => service.server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const admin = async (path: string, body: any) => {
    const r = await fetch(origin + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dataengine-token": service.adminToken,
      },
      body: JSON.stringify(body),
    });
    const value = (await r.json()) as any;
    if (!r.ok) throw new Error(value.error);
    return value;
  };
  const read = async (path: string, key: string) => {
    const response = await fetch(origin + path, {
      headers: { authorization: "Bearer " + key },
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  let release: (() => void) | undefined;
  try {
    const primary = (
      await admin("/api/live/connect", {
        name: "primary",
        protocol: "http",
        url: source.url,
        capabilities: [primaryCapability],
      })
    ).saved;
    const extra = (
      await admin("/api/live/connect", {
        name: "workorders",
        protocol: "mcp",
        url: source.url + "/mcp",
        capabilities: [supplementCapability],
      })
    ).saved;
    const model = (
      await admin("/api/live/propose", fusionDefinition(primary.id, extra.id))
    ).saved;
    const adopted = (
      await admin("/api/live/adopt", { id: model.id, version: model.version })
    ).saved;
    const input = {
      operationId: "create",
      name: "agent A",
      purpose: "only feedback",
      modelRef: { id: adopted.id, version: adopted.version },
      grants: [
        { type: "投诉", fields: ["$id", "实际反馈", "状态"], relations: [] },
      ],
    };
    const draft = (await admin("/api/live/views/propose", input)).saved;
    assert.equal(draft.status, "draft");
    assert.equal(
      (await admin("/api/live/views/propose", input)).saved.id,
      draft.id,
    );
    await assert.rejects(
      admin("/api/live/views/propose", { ...input, purpose: "different" }),
      /幂等/,
    );
    const activation = (
      await admin("/api/live/views/activate", {
        id: draft.id,
        version: draft.version,
      })
    ).saved;
    const key = activation.key;
    const catalog = await read("/v3/catalog", key);
    assert.equal(catalog.status, 200);
    assert.deepEqual(catalog.body.types, [{ name: "投诉" }]);
    const description = await read(
      "/v3/types?type=" + encodeURIComponent("投诉"),
      key,
    );
    assert.equal(description.status, 200);
    assert.doesNotMatch(
      JSON.stringify(description.body),
      /sourceId|ticket|WO02|phone|上门次数/,
    );
    source.state.mode = "conflict";
    const objects = await read(
      "/v3/objects?type=" + encodeURIComponent("投诉"),
      key,
    );
    assert.equal(objects.status, 200);
    assert.equal(objects.body.items[0].objectRef.id, "TS002");
    assert.equal(objects.body.items[0].properties.状态.value, null);
    assert.equal(objects.body.items[0].properties.状态.status, "conflict");
    assert.equal(objects.body.items[0].properties.实际反馈.value, "未改善");
    assert.equal(objects.body.items[1].properties.实际反馈.status, "missing");
    assert.doesNotMatch(
      JSON.stringify(objects.body),
      /sourceId|recordId|private|WO02|ticket/,
    );
    assert.equal(
      (
        await read(
          "/v3/objects?type=" +
            encodeURIComponent("投诉") +
            "&fields=$id,phone",
          key,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await read(
          "/v3/objects?type=" + encodeURIComponent("投诉") + "&limit=21",
          key,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await read(
          "/v3/objects?type=" + encodeURIComponent("投诉") + "&type=secret",
          key,
        )
      ).status,
      400,
    );
    assert.equal((await read("/v2/schema", key)).status, 403);
    const legacy = (
      await admin("/api/live/prepare", {
        name: "old",
        purpose: "feedback",
        modelId: adopted.id,
        grants: input.grants,
      })
    ).saved;
    const legacyActivation = (
      await admin("/api/live/activate", {
        id: legacy.id,
        version: legacy.version,
      })
    ).saved;
    assert.equal((await read("/v2/schema", legacyActivation.key)).status, 200);
    assert.equal((await read("/v3/catalog", legacyActivation.key)).status, 403);
    const replay = (
      await admin("/api/live/views/activate", {
        id: draft.id,
        version: draft.version,
      })
    ).saved;
    assert.equal(replay.key, null);
    assert.equal(replay.keyAvailable, false);
    const calls = source.state.calls;
    source.state.delay = new Promise((r) => (release = r));
    const pending = read("/v3/objects?type=" + encodeURIComponent("投诉"), key);
    while (source.state.calls === calls)
      await new Promise((r) => setTimeout(r, 5));
    await admin("/api/live/views/revoke", {
      id: draft.id,
      version: activation.view.version,
    });
    release!();
    const denied = await pending;
    assert.equal(denied.status, 403);
    assert(!JSON.stringify(denied.body).includes("未改善"));
    assert.equal((await read("/v3/catalog", key)).status, 403);
  } finally {
    release?.();
    await service.close();
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("relation permits require both endpoints, survive restart, and expose no data to a narrower independent client", async () => {
  const { createHeatingSources, connectHeatingSources, heatingDefinition } =
    await import("../../src/live/heating-sources.ts");
  const source = await createHeatingSources(),
    directory = mkdtempSync(join(tmpdir(), "de-view-related-"));
  let proposal: any, agentView: any;
  const driver = {
    async run(request: any) {
      assert(
        !request.tools.some((t: any) => t.name === "consumer_view_activate"),
      );
      agentView = await request.onTool("consumer_view_propose", proposal);
      return { text: "消费范围已保存，未启用", sessionId: "s", runId: "r" };
    },
    async stop() {},
    async close() {},
  };
  let service = await createServer({ directory, driver });
  const listen = async () => {
    await new Promise<void>((r) => service.server.listen(0, "127.0.0.1", r));
  };
  await listen();
  const origin = () =>
    `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const admin = async (path: string, body: any) => {
    const r = await fetch(origin() + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dataengine-token": service.adminToken,
      },
      body: JSON.stringify(body),
    });
    const data = (await r.json()) as any;
    if (!r.ok) throw new Error(data.error);
    return data;
  };
  const read = async (path: string, key: string) => {
    const r = await fetch(origin() + path, {
      headers: { authorization: "Bearer " + key },
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  try {
    const connections = await connectHeatingSources(
        service.app.live.sources,
        source,
      ),
      c = await service.app.live.propose(
        heatingDefinition(connections.api.id, connections.mcp.id),
      ),
      m = await service.app.live.adopt(c.id, c.version);
    const input = {
      operationId: "related",
      name: "relation client",
      purpose: "follow complaint callbacks",
      modelRef: { id: m.id, version: m.version },
      grants: [
        { type: "投诉", fields: ["$id"], relations: ["回访记录"] },
        { type: "回访", fields: ["$id", "投诉编号", "结果"], relations: [] },
      ],
    };
    await assert.rejects(
      admin("/api/live/views/propose", { ...input, grants: [input.grants[0]] }),
      /关系/,
    );
    const narrow = (
      await admin("/api/live/views/propose", {
        ...input,
        operationId: "narrow",
        grants: [{ type: "投诉", fields: ["$id"], relations: [] }],
      })
    ).saved;
    const narrowKey = (
      await admin("/api/live/views/activate", {
        id: narrow.id,
        version: narrow.version,
      })
    ).saved.key;
    proposal = input;
    await admin("/api/canvas/navigate", { page: "consumption" });
    await admin("/api/canvas/message", {
      page: "consumption",
      text: "为回访查询建立指定许可草稿，不启用",
      messageId: "consumer-agent",
    });
    await service.app.idle();
    assert.equal(agentView.status, "draft");
    const active = (
      await admin("/api/live/views/activate", {
        id: agentView.id,
        version: agentView.version,
      })
    ).saved;
    const path =
      "/v3/objects?type=" +
      encodeURIComponent("投诉") +
      "&id=TS002&relation=" +
      encodeURIComponent("回访记录");
    const related = await read(path, active.key);
    assert.equal(related.status, 200);
    assert.equal(related.body.items[0].objectRef.id, "HF002");
    assert.equal(related.body.items[0].properties.结果.value, "未改善");
    assert.equal((await read(path, narrowKey)).status, 403);
    assert.equal(
      (await read("/v3/types?type=" + encodeURIComponent("回访"), narrowKey))
        .status,
      403,
    );
    await service.close();
    service = await createServer({ directory, driver });
    await listen();
    source.setOutcome("已改善");
    const fresh = await read(path, active.key);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.items[0].properties.结果.value, "已改善");
    await admin("/api/live/disable", {
      id: connections.mcp.id,
      version: connections.mcp.version,
    });
    assert.equal((await read(path, active.key)).status, 502);
  } finally {
    await service.close();
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

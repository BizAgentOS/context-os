import { restoreHistoricalAccess } from "./historical-consumers-fixture.ts";
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

test("global field revision retains shared impact, sample evidence and checked decision; retry, drift and competing adoption cannot overwrite", async () => {
  const upstream = await createFusionSources(),
    directory = mkdtempSync(join(tmpdir(), "de-mapping-"));
  const service = await createServer({ automaticApi: false,
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
  const api = async (path: string, body: any) => {
    const r = await fetch(
      `http://127.0.0.1:${(service.server.address() as AddressInfo).port}${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dataengine-token": service.adminToken,
        },
        body: JSON.stringify(body),
      },
    );
    const result = (await r.json()) as any;
    if (!r.ok) throw new Error(result.error);
    return result;
  };
  const act = async (method: string, input: any) =>
    (await api("/api/live/changes/" + method, input)).saved;
  try {
    const primary = (
      await api("/api/live/connect", {
        name: "投诉",
        protocol: "http",
        url: upstream.url,
        capabilities: [primaryCapability],
      })
    ).saved;
    const extra = (
      await api("/api/live/connect", {
        name: "工单",
        protocol: "mcp",
        url: upstream.url + "/mcp",
        capabilities: [supplementCapability],
      })
    ).saved;
    const definition: any = fusionDefinition(primary.id, extra.id);
    definition.types[0].fields.readAt = "status";
    const candidate = (await api("/api/live/propose", definition)).saved;
    const base = (
      await api("/api/live/adopt", {
        id: candidate.id,
        version: candidate.version,
      })
    ).saved;
    const draft = {
      operationId: "field-fix",
      baseRef: { id: base.id, version: base.version },
      patch: {
        kind: "property",
        type: "投诉",
        property: "实际反馈",
        supplement: "工单",
        sourceField: "status",
      },
      reason: "业务人员明确将当前属性重新绑定工单状态；仅为实验映射修改",
      evidence: "人工对照已读取字段并指定新口径",
      relatedCorrections: [],
    };
    const dependent = await act("propose", {
      ...draft,
      operationId: "dependent-key",
      patch: {
        kind: "property",
        type: "投诉",
        property: "业务编号",
        sourceField: "id",
      },
    });
    assert.equal(dependent.content.impact.dependentSupplements[0].name, "工单");
    assert.equal(
      dependent.content.impact.samples[0].before.items[0].实际反馈,
      "未改善",
    );
    assert.equal(
      dependent.content.impact.samples[0].after.items[0].实际反馈,
      null,
    );
    const businessTime = await act("propose", {
      ...draft,
      operationId: "business-time",
      patch: {
        kind: "property",
        type: "投诉",
        property: "readAt",
        sourceField: "ticket",
      },
    });
    assert.equal(businessTime.content.impact.samples[0].changed, true);
    upstream.primary[0].status = "已归档";
    await assert.rejects(
      act("check", {
        operationId: "time-drift",
        id: businessTime.id,
        version: businessTime.version,
      }),
      /来源|依据/,
    );
    upstream.primary[0].status = "已办结";
    const countBeforeOversize = (await api("/api/live/changes/list", {})).items
      .length;
    upstream.primary[0].status = "数".repeat(50000);
    await assert.rejects(
      act("propose", {
        ...draft,
        operationId: "oversize",
        patch: {
          kind: "property",
          type: "投诉",
          property: "readAt",
          sourceField: "ticket",
        },
      }),
      /256KB/,
    );
    assert.equal(
      (await api("/api/live/changes/list", {})).items.length,
      countBeforeOversize,
    );
    upstream.primary[0].status = "已办结";
    const consumer = (
      await restoreHistoricalAccess(service.app, "/api/live/prepare", {
        name: "existing client",
        purpose: "feedback",
        modelId: base.id,
        grants: [{ type: "投诉", fields: ["$id", "实际反馈"], relations: [] }],
      })
    ).saved;
    const activation = (
      await restoreHistoricalAccess(service.app, "/api/live/activate", {
        id: consumer.id,
        version: consumer.version,
      })
    ).saved;
    const p = await act("propose", draft);
    assert.equal(p.status, "candidate");
    assert.equal(p.content.diff.before, "outcome");
    assert.equal(p.content.diff.after, "status");
    assert.equal(
      p.content.impact.samples[0].before.items[0].实际反馈,
      "未改善",
    );
    assert.equal(p.content.impact.samples[0].after.items[0].实际反馈, "已办结");
    assert.equal(p.content.impact.consumption.status, "not_evaluated");
    assert.equal(p.changeRef.id, p.id);
    assert.equal((await act("propose", draft)).id, p.id);
    await assert.rejects(
      act("propose", { ...draft, reason: "different" }),
      /幂等/,
    );
    await assert.rejects(
      act("adopt", { operationId: "early", id: p.id, version: p.version }),
      /检查/,
    );
    upstream.primary.reverse();
    const c = await act("check", {
      operationId: "check",
      id: p.id,
      version: p.version,
    });
    const rival = await act("propose", { ...draft, operationId: "rival" });
    const rc = await act("check", {
      operationId: "rival-check",
      id: rival.id,
      version: rival.version,
    });
    const a = await act("adopt", {
      operationId: "adopt",
      id: c.id,
      version: c.version,
    });
    assert.equal(a.status, "adopted");
    assert.equal(
      (
        await act("adopt", {
          operationId: "adopt",
          id: c.id,
          version: c.version,
        })
      ).version,
      a.version,
    );
    await assert.rejects(
      act("adopt", {
        operationId: "rival-adopt",
        id: rc.id,
        version: rc.version,
      }),
      /基线|变化/,
    );
    const fresh = await api("/api/live/query", {
      modelId: a.content.resultModel.id,
      type: "投诉",
      id: "TS002",
    });
    assert.equal(fresh.items[0].实际反馈, "已办结");
    const original = await api("/api/live/query", {
      modelId: base.id,
      type: "投诉",
      id: "TS002",
    });
    assert.equal(original.items[0].实际反馈, "未改善");
    const external = await fetch(
      `http://127.0.0.1:${(service.server.address() as AddressInfo).port}/v2/objects?type=${encodeURIComponent("投诉")}`,
      { headers: { authorization: "Bearer " + activation.key } },
    );
    assert.equal(external.status, 200);
    assert.match(await external.text(), /未改善/);

    await assert.rejects(
      act("cancel", {
        operationId: "late-cancel",
        id: a.id,
        version: a.version,
      }),
      /已提交/,
    );
    const meta = (await api("/api/live/changes/list", {})).items[0];
    assert.equal(meta.content, undefined);
    const history = await api("/api/live/changes/read", {
      id: p.id,
      version: 1,
    });
    assert.equal(
      history.content.impact.samples[0].before.items[0].实际反馈,
      "未改善",
    );
    const next = await act("propose", {
      ...draft,
      operationId: "next",
      baseRef: a.content.resultModel,
      patch: { ...draft.patch, sourceField: "outcome" },
    });
    upstream.state.outcome = "已改善";
    await assert.rejects(
      act("check", {
        operationId: "drift",
        id: next.id,
        version: next.version,
      }),
      /来源|依据/,
    );
    const cancelled = await act("cancel", {
      operationId: "cancel",
      id: next.id,
      version: next.version,
    });
    assert.equal(cancelled.status, "cancelled");
  } finally {
    await service.close();
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("relation revision groups saved corrections, supports agent inspection and rejects concurrent or stopped writes", async () => {
  const { createHeatingSources, connectHeatingSources, heatingDefinition } =
    await import("../../src/live/heating-sources.ts");
  const { createServer: httpServer } = await import("node:http");
  const upstream = await createHeatingSources(),
    directory = mkdtempSync(join(tmpdir(), "de-rule-"));
  let gate: Promise<void> | undefined,
    release: (() => void) | undefined,
    entered: (() => void) | undefined;
  let proxyCalls = 0;
  const proxy = httpServer(async (req, res) => {
    proxyCalls++;
    entered?.();
    await gate;
    const r = await fetch(upstream.apiUrl + req.url);
    res.setHeader("content-type", "application/json");
    res.end(await r.text());
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  let draft: any,
    agent: any,
    stopping = false;
  const service = await createServer({ automaticApi: false,
    directory,
    driver: {
      async run(request) {
        assert(!request.tools.some((t) => t.name === "mapping_change_adopt"));
        const call = request.onTool("mapping_change_propose", {
          ...draft,
          operationId: stopping ? "stopped" : "agent",
        });
        if (stopping) await assert.rejects(call);
        else {
          agent = await call;
          const read = (await request.onTool("mapping_change_read", {
            id: agent.id,
            version: agent.version,
          })) as any;
          assert.equal(read.changeRef.id, agent.id);
        }
        return { text: "修订已保存", sessionId: "r", runId: "r" };
      },
      async stop() {
        release?.();
      },
      async close() {},
    },
  });
  await new Promise<void>((r) => service.server.listen(0, "127.0.0.1", r));
  const api = async (path: string, body: any) => {
    const r = await fetch(
      `http://127.0.0.1:${(service.server.address() as AddressInfo).port}${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dataengine-token": service.adminToken,
        },
        body: JSON.stringify(body),
      },
    );
    const data = (await r.json()) as any;
    if (!r.ok) throw new Error(data.error);
    return data;
  };
  const act = async (method: string, body: any) =>
    (await api("/api/live/changes/" + method, body)).saved;
  try {
    const connections = await connectHeatingSources(service.app.live.sources, {
      ...upstream,
      apiUrl: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    });
    const m = await service.app.live.propose(
        heatingDefinition(connections.api.id, connections.mcp.id),
      ),
      base = await service.app.live.adopt(m.id, m.version);
    const correction = (
      await api("/api/live/corrections/propose", {
        operationId: "local",
        target: {
          modelId: base.id,
          modelVersion: base.version,
          type: "投诉",
          objectId: "TS002",
          relation: "回访记录",
        },
        targetIds: [],
        reason: "需核查错误关联",
        evidence: "用户提出待核查问题",
      })
    ).saved;
    draft = {
      baseRef: { id: base.id, version: base.version },
      patch: {
        kind: "relation",
        type: "投诉",
        relation: "回访记录",
        fromField: "状态",
        toField: "投诉编号",
      },
      reason: "实验用户明确指定状态字段演示错误规则的影响",
      evidence: "保留原始与新关联样本供判断",
      relatedCorrections: [{ id: correction.id, version: correction.version }],
    };
    const groups = await api("/api/live/changes/issues", {
      baseRef: draft.baseRef,
    });
    assert.equal(groups.groups[0].count, 1);
    await api("/api/canvas/navigate", { page: "ontology" });
    await api("/api/canvas/message", {
      page: "ontology",
      text: "请保存指定关系规则修订",
      messageId: "mapping-agent",
    });
    await service.app.idle();
    assert.equal(agent.status, "candidate");
    const sample = agent.content.impact.samples.find(
      (s: any) => s.id === "TS002",
    );
    assert.equal(sample.before.items[0].$id, "HF002");
    assert.deepEqual(sample.after.items, []);
    const p2 = await act("propose", { ...draft, operationId: "second" });
    const c1 = await act("check", {
        operationId: "c1",
        id: agent.id,
        version: agent.version,
      }),
      c2 = await act("check", {
        operationId: "c2",
        id: p2.id,
        version: p2.version,
      });
    const results = await Promise.allSettled([
      act("adopt", { operationId: "a1", id: c1.id, version: c1.version }),
      act("adopt", { operationId: "a2", id: c2.id, version: c2.version }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const adopted = (
      results.find(
        (r) => r.status === "fulfilled",
      ) as PromiseFulfilledResult<any>
    ).value;
    const result = await api("/api/live/query", {
      modelId: adopted.content.resultModel.id,
      type: "投诉",
      id: "TS002",
      relation: "回访记录",
    });
    assert.deepEqual(result.items, []);
    draft = {
      ...draft,
      baseRef: adopted.content.resultModel,
      patch: { ...draft.patch, fromField: "$id" },
      relatedCorrections: [],
    };
    const callsBeforeStop = proxyCalls;
    stopping = true;
    const started = new Promise<void>((r) => (entered = r));
    gate = new Promise((r) => (release = r));
    const before = (await api("/api/live/changes/list", {})).items.length;
    await api("/api/canvas/message", {
      page: "ontology",
      text: "准备恢复规则，测试停止",
      messageId: "mapping-stop",
    });
    await started;
    await api("/api/canvas/stop", {});
    release!();
    await service.app.idle();
    assert.equal(
      (await api("/api/live/changes/list", {})).items.length,
      before,
    );
    assert.equal(proxyCalls - callsBeforeStop, 1);
  } finally {
    release?.();
    await service.close();
    proxy.closeAllConnections();
    await new Promise<void>((r) => proxy.close(() => r()));
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});


test("execution mapping and mapping revisions enter the shared proposal and adoption lifecycle", async () => {
  const upstream = await createFusionSources(), directory = mkdtempSync(join(tmpdir(), "de-ledger-"));
  const service = await createServer({ automaticApi: false, directory,
    driver: { async run() { return { text: "idle", sessionId: "s", runId: "r" }; }, async stop() {}, async close() {} } });
  await new Promise<void>((r) => service.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-dataengine-token": service.adminToken }, body: JSON.stringify(body) });
    const result = await r.json() as any;
    if (!r.ok) throw new Error(result.error);
    return result;
  };
  const read = async (path: string) => {
    const r = await fetch(base + path, { headers: { "x-dataengine-token": service.adminToken } });
    const result = await r.json() as any;
    if (!r.ok) throw new Error(result.error);
    return result;
  };
  try {
    const primary = (await post("/api/live/connect", { name: "投诉", protocol: "http", url: upstream.url, capabilities: [primaryCapability] })).saved;
    const extra = (await post("/api/live/connect", { name: "工单", protocol: "mcp", url: upstream.url + "/mcp", capabilities: [supplementCapability] })).saved;
    const candidate = (await post("/api/live/propose", fusionDefinition(primary.id, extra.id))).saved;
    assert.equal((await read("/api/changes?type=entity")).changes[0].status, "proposed", "a mapping proposal is visible before adoption");
    const adopted = (await post("/api/live/adopt", { id: candidate.id, version: candidate.version })).saved;
    const entities = await read("/api/changes?type=entity");
    assert.equal(entities.total, 1, "adopting an execution mapping is recorded");
    assert.equal(entities.changes[0].status, "adopted");

    const change = (await post("/api/live/changes/propose", {
      operationId: "ledger-fix", baseRef: { id: adopted.id, version: adopted.version },
      patch: { kind: "property", type: "投诉", property: "实际反馈", supplement: "工单", sourceField: "status" },
      reason: "业务人员明确当前属性应绑定工单状态", evidence: "人工核对字段后指定口径", relatedCorrections: [] })).saved;
    assert.equal((await read("/api/changes?type=binding")).changes[0].status, "proposed", "a pending revision is visible before adoption");
    const checked = (await post("/api/live/changes/check", { operationId: "ledger-check", id: change.id, version: change.version })).saved;
    await post("/api/live/changes/adopt", { operationId: "ledger-adopt", id: checked.id, version: checked.version });
    const bindings = await read("/api/changes?type=binding");
    assert.equal(bindings.total, 1, "adopting a mapping revision is recorded");
    assert.equal(bindings.changes[0].status, "adopted");
  } finally {
    await service.close();
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
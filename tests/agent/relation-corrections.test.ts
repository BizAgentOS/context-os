import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer as httpServer } from "node:http";
import { createServer } from "../../src/agent/server.ts";
import {
  createHeatingSources,
  connectHeatingSources,
  heatingDefinition,
} from "../../src/live/heating-sources.ts";

test("local relation correction preserves source baseline, requires checked decision, and rejects duplicate, stale, concurrent and stopped writes", { timeout: 25000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-relation-")),
    upstream = await createHeatingSources();
  let gate: Promise<void> | undefined,
    entered: (() => void) | undefined,
    release: (() => void) | undefined;
  const proxy = httpServer(async (req, res) => {
    proxyCalls++;
    entered?.();
    await gate;
    const r = await fetch(upstream.apiUrl + req.url);
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(await r.text());
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  let draft: any,
    agentSaved: any,
    stopPhase = false;
  let unifiedSubject: any, pendingVerification: any;
  let proxyCalls = 0;
  const service = await createServer({
    directory,
    automaticApi: false,
    driver: {
      async run(request) {
        const proposed = (await request.onTool("change_propose", {
          operationId: stopPhase ? "agent-stop" : "agent-save", type: "local_correction",
          baseline: (await request.onTool("pending_list", {}) as any).baseline, subject: unifiedSubject,
          evidence: "管理员核对原始登记，指定取消错误关联",
        }) as any).change;
        pendingVerification = proposed;
        const call = request.onTool("change_verify", { id: proposed.id, version: proposed.version, operationId: "verify-correction" });
        if (stopPhase) await assert.rejects(call, /已失效|停止|运行/);
        else {
          agentSaved = await call;
          const detail = await request.onTool("pending_read", { id: agentSaved.id, version: agentSaved.version }) as any;
          assert.equal(detail.change.content.subject.objectId, "TS002");
        }
        return {
          text: "候选处理完毕",
          sessionId: "correction",
          runId: "correction",
        };
      },
      async stop() {
        release?.();
      },
      async close() {},
    },
  });
  await new Promise<void>((r) => service.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const api = async (path: string, body?: unknown): Promise<any> => {
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        "x-dataengine-token": service.adminToken,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await r.json();
    if (!r.ok) throw new Error((value as any).error);
    return value;
  };
  const act = async (method: string, body: unknown) =>
    (await api(`/api/live/corrections/${method}`, body)).saved;
  try {
    const connections = await connectHeatingSources(service.app.live.sources, {
      ...upstream,
      apiUrl: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    });
    const proposed = await service.app.live.propose(
      heatingDefinition(connections.api.id, connections.mcp.id),
    );
    const model = await service.app.live.adopt(proposed.id, proposed.version);
    const target = {
      modelId: model.id,
      modelVersion: model.version,
      type: "投诉",
      objectId: "TS002",
      relation: "回访记录",
    };
    draft = {
      target,
      targetIds: [],
      reason: "这条回访被错误关联，应移除当前关系",
      evidence: "管理员核对原始业务登记，本测试明确指定取消关联",
    };
    const raw = await api("/api/live/query", {
      modelId: model.id,
      type: "投诉",
      id: "TS002",
      relation: "回访记录",
    });
    assert.equal(raw.items[0].$id, "HF002");
    const candidate = await act("propose", { ...draft, operationId: "p1" });
    assert.equal(candidate.status, "candidate");
    assert.equal(candidate.content.snapshot.before.items[0].$id, "HF002");
    assert.equal(
      (await act("propose", { ...draft, operationId: "p1" })).id,
      candidate.id,
    );
    await assert.rejects(
      act("propose", { ...draft, reason: "different", operationId: "p1" }),
      /幂等/,
    );
    await assert.rejects(
      act("adopt", { id: candidate.id, version: 1, operationId: "early" }),
      /检查/,
    );
    const rival = await act("propose", { ...draft, operationId: "rival" });
    const checked = await act("check", {
      id: candidate.id,
      version: candidate.version,
      operationId: "check1",
    });
    assert.equal(checked.status, "checked");
    const accepted = await act("adopt", {
      id: checked.id,
      version: checked.version,
      operationId: "adopt1",
    });
    assert.equal(accepted.status, "adopted");
    assert.equal(
      (
        await act("adopt", {
          id: checked.id,
          version: checked.version,
          operationId: "adopt1",
        })
      ).version,
      accepted.version,
    );
    await assert.rejects(
      act("check", {
        id: rival.id,
        version: rival.version,
        operationId: "rival-check",
      }),
      /纠正决定/,
    );
    await assert.rejects(
      act("cancel", {
        id: accepted.id,
        version: accepted.version,
        operationId: "cancel-accepted",
      }),
      /已提交/,
    );
    const competitors = await Promise.all(
      ["ca", "cb"].map((operationId) =>
        act("propose", { ...draft, operationId }),
      ),
    );
    const checks = await Promise.all(
      competitors.map((a, i) =>
        act("check", { id: a.id, version: a.version, operationId: `cc${i}` }),
      ),
    );
    const decisions = await Promise.allSettled(
      checks.map((a, i) =>
        act("adopt", { id: a.id, version: a.version, operationId: `cd${i}` }),
      ),
    );
    assert.equal(decisions.filter((d) => d.status === "fulfilled").length, 1);
    assert.equal(decisions.filter((d) => d.status === "rejected").length, 1);
    const corrected = await api("/api/live/query", {
      modelId: model.id,
      type: "投诉",
      id: "TS002",
      relation: "回访记录",
    });
    assert.deepEqual(corrected.items, []);
    assert.deepEqual(corrected.correction.originalIds, ["HF002"]);
    const unchanged = await service.app.live.query(
      { modelId: model.id, type: "投诉", id: "TS002", relation: "回访记录" },
      () => {},
      false,
    );
    assert.equal(unchanged.items[0].$id, "HF002");
    upstream.setOutcome("已改善");
    await assert.rejects(
      api("/api/live/query", {
        modelId: model.id,
        type: "投诉",
        id: "TS002",
        relation: "回访记录",
      }),
      /源事实已变化/,
    );
    const restore = await act("propose", {
      ...draft,
      targetIds: ["HF002"],
      operationId: "restore",
    });
    upstream.setOutcome("未改善");
    await assert.rejects(
      act("check", {
        id: restore.id,
        version: restore.version,
        operationId: "stale-check",
      }),
      /来源事实/,
    );
    const cancelled = await act("cancel", {
      id: restore.id,
      version: restore.version,
      operationId: "cancel-draft",
    });
    assert.equal(cancelled.status, "cancelled");
    const layered = service.app.live.readLayered(model.id);
    const entity = layered.semantic.entityTypes.find(item => item.name === "投诉")!;
    const relation = layered.semantic.relationTypes.find(item => item.from === entity.id && item.name === "回访记录")!;
    unifiedSubject = { kind: "relation", entityTypeId: entity.id, objectId: "TS002", relationTypeId: relation.id, targetIds: [], reason: draft.reason, evidence: draft.evidence };
    await service.app.canvasNavigate({ page: "ontology" });
    await api("/api/canvas/message", {
      page: "ontology",
      text: "为TS002关系创建待核对候选",
      messageId: "agent-propose",
    });
    await service.app.idle();
    assert.equal(agentSaved.status, "verified");
    assert.equal(agentSaved.content.verification.result, "passed");
    const countBeforeStop = (await api("/api/live/corrections/list", {})).items
      .length;
    stopPhase = true;
    const callsBeforeStop = proxyCalls;
    let started: Promise<void> = new Promise((r) => (entered = r));
    gate = new Promise((r) => (release = r));
    await api("/api/canvas/message", {
      page: "ontology",
      text: "再次准备候选",
      messageId: "stop-propose",
    });
    await started;
    await api("/api/canvas/stop", {});
    release!();
    await service.app.idle();
    const all = await api("/api/live/corrections/list", {});
    assert.equal(all.items.length, countBeforeStop);
    assert.equal(service.app.changes.read(pendingVerification.id).version, pendingVerification.version, "stopping cannot commit a late verification");
    assert.equal(proxyCalls - callsBeforeStop, 1, "stopping prevents the next source read");
    assert(!("snapshot" in all.items[0].content));
    const retained = await api("/api/live/corrections/read", {
      id: candidate.id,
      version: candidate.version,
    });
    assert.equal(retained.content.snapshot.before.items[0].$id, "HF002");
  } finally {
    release?.();
    await service.close();
    proxy.closeAllConnections();
    await new Promise<void>((r) => proxy.close(() => r()));
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("numeric source aliases cannot fork corrections or duplicate targets; corrected pages retain coverage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-correction-numeric-"));
  const rows = [
    { id: 1, group: "G", note: "small" },
    { id: 2, group: "G", note: "small" },
  ];
  const sourceServer = httpServer((req, res) => {
    const q = new URL(req.url!, "http://local").searchParams;
    const found = rows.filter(
      (r) =>
        (!q.has("id") || r.id === Number(q.get("id"))) &&
        (!q.has("group") || r.group === q.get("group")),
    );
    const offset = Number(q.get("offset") || 0),
      limit = Number(q.get("limit") || 20);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        items: found.slice(offset, offset + limit),
        total: found.length,
      }),
    );
  });
  await new Promise<void>((r) => sourceServer.listen(0, "127.0.0.1", r));
  const service = await createServer({
    directory,
    automaticApi: false,
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
    const response = await fetch(
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
    const result = (await response.json()) as any;
    if (!response.ok) throw new Error(result.error);
    return result;
  };
  const act = async (method: string, input: any) =>
    (await api(`/api/live/corrections/${method}`, input)).saved;
  try {
    const source = await service.app.live.sources.connect({
      name: "numeric records",
      protocol: "http",
      url: `http://127.0.0.1:${(sourceServer.address() as AddressInfo).port}`,
      capabilities: [
        {
          name: "records",
          path: "/records",
          fields: ["id", "group", "note"],
          idField: "id",
          idType: "number",
          filters: { id: "id", group: "group" },
          totalPath: "total",
        },
      ],
    });
    const candidate = await service.app.live.propose({
      purpose: "numeric identity",
      rationale: "independent HTTP records",
      types: [
        {
          name: "Record",
          description: "numeric object",
          sourceId: source.id,
          capability: "records",
          fields: { group: "group", note: "note" },
        },
      ],
      relations: [
        {
          name: "peers",
          from: "Record",
          to: "Record",
          fromField: "group",
          toField: "group",
        },
      ],
    });
    const model = await service.app.live.adopt(candidate.id, candidate.version);
    const target = {
      modelId: model.id,
      modelVersion: model.version,
      type: "Record",
      objectId: "1",
      relation: "peers",
    };
    const draft = {
      target,
      targetIds: ["1", "2"],
      reason: "explicit reviewed set",
      evidence: "local admin decision",
    };
    await assert.rejects(
      act("propose", {
        ...draft,
        operationId: "alias-origin",
        target: { ...target, objectId: "01" },
      }),
      /规范/,
    );
    await assert.rejects(
      act("propose", {
        ...draft,
        operationId: "alias-target",
        targetIds: ["1", "01"],
      }),
      /规范/,
    );
    const p = await act("propose", { ...draft, operationId: "canonical" });
    const c = await act("check", {
      operationId: "check",
      id: p.id,
      version: p.version,
    });
    const a = await act("adopt", {
      operationId: "adopt",
      id: c.id,
      version: c.version,
    });
    for (const id of ["1", "01"]) {
      const result = await api("/api/live/query", {
        modelId: model.id,
        type: "Record",
        id,
        relation: "peers",
        offset: 1,
        limit: 1,
      });
      assert.equal(result.correction.id, a.id);
      assert.equal(result.items.length, 1);
      assert.equal(result.coverage.complete, false);
    }
    await assert.rejects(
      api("/api/live/corrections/read", { id: p.id, version: "not-a-version" }),
      /版本/,
    );
    const receiptsBefore =
      service.app.memory.listArtifacts("relation_receipt").length;
    const correctionsBefore = (await api("/api/live/corrections/list", {}))
      .items.length;
    rows.forEach((row) => {
      row.note = "数".repeat(50000);
    });
    await assert.rejects(
      act("propose", { ...draft, operationId: "oversized" }),
      /256KB/,
    );
    assert.equal(
      (await api("/api/live/corrections/list", {})).items.length,
      correctionsBefore,
    );
    assert.equal(
      service.app.memory.listArtifacts("relation_receipt").length,
      receiptsBefore,
    );
  } finally {
    await service.close();
    sourceServer.closeAllConnections();
    await new Promise<void>((r) => sourceServer.close(() => r()));
    rmSync(directory, { recursive: true, force: true });
  }
});

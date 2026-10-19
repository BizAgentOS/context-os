import { restoreHistoricalAccess } from "./historical-consumers-fixture.ts";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
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
import {
  createKnowledgeSource,
  knowledgeCapability,
} from "./knowledge-fixture.ts";
import { createMetricSource, metricCapability } from "./metrics-fixture.ts";

test("one business investigation keeps document excerpts, metric scope and conflicting object evidence together without turning a rate into an object fact", async () => {
  const records = await createFusionSources(),
    knowledge = await createKnowledgeSource(),
    metrics = await createMetricSource();
  const directory = mkdtempSync(join(tmpdir(), "de-evidence-"));
  let request: any,
    saved: any,
    stopping = false,
    release: () => void = () => {};
  records.primary.forEach((r, i) =>
    Object.assign(r, { station: i === 0 ? "清河站" : "育新站" }),
  );
  const service = await createServer({ automaticApi: false,
    directory,
    driver: {
      async run(r) {
        assert(r.tools.some((t) => t.name === "evidence_collect"));
        const listing = (await r.onTool("evidence_list", { limit: 1 })) as any;
        assert(listing.items.length);
        const stored = (await r.onTool("evidence_read", {
          id: listing.items[0].id,
          version: listing.items[0].version,
        })) as any;
        assert.equal(stored.historical, true);
        if (stopping)
          await assert.rejects(r.onTool("evidence_collect", request));
        else saved = await r.onTool("evidence_collect", request);
        return {
          text: "已保存共同取证记录，指标不代表对象恢复",
          sessionId: "evidence",
          runId: "evidence",
        };
      },
      async stop() {
        release();
      },
      async close() {},
    },
  });
  await new Promise<void>((r) => service.server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const api = async (path: string, body: any) => {
    const res = await fetch(origin + path, {
      method: "POST",
      headers: {
        "x-dataengine-token": service.adminToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const value = (await res.json()) as any;
    if (!res.ok) throw new Error(value.error);
    return value;
  };
  try {
    const p = (
      await api("/api/live/connect", {
        name: "投诉",
        protocol: "http",
        url: records.url,
        capabilities: [
          {
            ...primaryCapability,
            fields: [...primaryCapability.fields, "station"],
          },
        ],
      })
    ).saved;
    const s = (
      await api("/api/live/connect", {
        name: "工单",
        protocol: "mcp",
        url: records.url + "/mcp",
        capabilities: [supplementCapability],
      })
    ).saved;
    const k = (
      await api("/api/live/connect", {
        name: "服务说明",
        protocol: "http",
        url: knowledge.url,
        capabilities: [knowledgeCapability],
      })
    ).saved;
    const m = (
      await api("/api/live/connect", {
        name: "办结率",
        protocol: "mcp",
        url: metrics.mcpUrl,
        capabilities: [metricCapability],
      })
    ).saved;
    const mapping = fusionDefinition(p.id, s.id);
    Object.assign(mapping.types[0].fields, { 所属站: "station" });
    const proposed = (await api("/api/live/propose", mapping)).saved;
    const model = (
      await api("/api/live/adopt", {
        id: proposed.id,
        version: proposed.version,
      })
    ).saved;
    const d = await api("/api/live/metrics/describe", {
      sourceId: m.id,
      capability: "metrics",
      connectionVersion: m.version,
    });
    records.state.mode = "conflict";
    request = {
      question:
        "投诉状态和实际反馈是否一致，服务说明与2026年1月办结率如何解释？",
      objects: {
        modelId: model.id,
        modelVersion: model.version,
        type: "投诉",
        fields: ["$id", "状态", "实际反馈", "上门次数", "所属站"],
        limit: 10,
      },
      documents: [
        {
          sourceId: k.id,
          capability: "documents",
          connectionVersion: k.version,
          segmentId: "guide-1",
          revision: "r1",
          limit: 100,
          rationale: "说明投诉处理与回访流程，适用性需核对",
        },
      ],
      metrics: [
        {
          sourceId: m.id,
          capability: "metrics",
          connectionVersion: m.version,
          definitionHash: d.definitionHash,
          start: "2026-01-01",
          end: "2026-02-01",
          limit: 1,
          rationale: "用办结率提供期间背景，不推断个体恢复",
          dimensionBindings: [],
        },
      ],
    };
    const collected = (await api("/api/live/evidence/collect", request)).saved;
    assert.equal(collected.kind, "evidence_bundle");
    const view = (
      await restoreHistoricalAccess(service.app, "/api/live/views/propose", {
        operationId: "context-scope",
        name: "背景消费者",
        purpose: "读取指定文档和期间指标",
        modelRef: { id: model.id, version: model.version },
        grants: [{ type: "投诉", fields: ["$id"], relations: [] }],
        contextEvidence: [
          {
            bundleRef: { id: collected.id, version: collected.version },
            kind: "document",
            index: 0,
          },
          {
            bundleRef: { id: collected.id, version: collected.version },
            kind: "metric",
            index: 0,
          },
        ],
      })
    ).saved;
    const active = (
      await restoreHistoricalAccess(service.app, "/api/live/views/activate", {
        id: view.id,
        version: view.version,
      })
    ).saved;
    const consume = async (path: string, key = active.key) => {
      const r = await fetch(origin + path, {
        headers: { authorization: "Bearer " + key },
      });
      return { status: r.status, body: (await r.json()) as any };
    };
    const catalog = await consume("/v3/catalog");
    assert.equal(catalog.body.contextEvidence.length, 2);
    const doc = await consume(
      "/v3/evidence?ref=" +
        catalog.body.contextEvidence.find((e: any) => e.kind === "document")
          .ref,
    );
    assert.equal(doc.status, 200);
    assert.match(doc.body.evidence.text, /处理完成后安排回访/);
    assert.equal(doc.body.evidence.location.revision, "r1");
    const metric = await consume(
      "/v3/evidence?ref=" +
        catalog.body.contextEvidence.find((e: any) => e.kind === "metric").ref,
    );
    assert.equal(metric.status, 200);
    assert.equal(metric.body.evidence.definition.grain, "month");
    assert.equal(metric.body.evidence.definition.unit, "%");
    assert.equal(metric.body.evidence.query.start, "2026-01-01");
    assert.deepEqual(metric.body.evidence.query.where, {});
    assert.equal(metric.body.evidence.query.limit, 1);
    assert.doesNotMatch(
      JSON.stringify([doc.body, metric.body]),
      /sourceId|sourceTitle|sourceHash|WO02|上门次数|"objects":|dependencies/,
    );
    const client = new Client({
      name: "context-evidence-client",
      version: "1.0",
    });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(
              new URL("../../scripts/dataengine-mcp.ts", import.meta.url),
            ),
          ],
          env: {
            PATH: process.env.PATH!,
            DATAENGINE_URL: origin,
            DATAENGINE_CONSUMER_KEY: active.key,
          },
        }),
      );
      const detail = await client.callTool({
        name: "read_evidence",
        arguments: { ref: catalog.body.contextEvidence[1].ref },
      });
      assert.equal(detail.isError, undefined);
      assert.equal(
        (detail.structuredContent as any).evidence.definition.unit,
        "%",
      );
    } finally {
      await client.close();
    }
    const another = (
      await restoreHistoricalAccess(service.app, "/api/live/views/propose", {
        operationId: "no-context",
        name: "无背景消费者",
        purpose: "只读对象",
        modelRef: { id: model.id, version: model.version },
        grants: [{ type: "投诉", fields: ["$id"], relations: [] }],
      })
    ).saved;
    const anotherKey = (
      await restoreHistoricalAccess(service.app, "/api/live/views/activate", {
        id: another.id,
        version: another.version,
      })
    ).saved.key;
    assert.equal(
      (
        await consume(
          "/v3/evidence?ref=" + catalog.body.contextEvidence[0].ref,
          anotherKey,
        )
      ).status,
      403,
    );

    await assert.rejects(
      api("/api/live/evidence/collect", {
        ...request,
        objects: {
          ...request.objects,
          where: JSON.parse('{"__proto__":"blocked"}'),
        },
      }),
      /保留/,
    );
    assert.equal(collected.content.objects.result.items[0].状态, null);
    assert.equal(
      collected.content.objects.result.evidence[0].properties.状态.status,
      "conflict",
    );
    assert.match(
      collected.content.documents[0].result.text,
      /处理完成后安排回访/,
    );
    assert.equal(
      collected.content.documents[0].result.coverage.complete,
      false,
    );
    assert.equal(collected.content.metrics[0].result.items[0].value, 80);
    assert.equal(collected.content.metrics[0].result.definition.unit, "%");
    assert.equal(collected.content.metrics[0].result.coverage.complete, false);
    assert.equal(
      collected.content.metrics[0].association.status,
      "context_only",
    );
    assert.equal(collected.status, "partial");
    knowledge.state.mode = "failure";
    const partial = (await api("/api/live/evidence/collect", request)).saved;
    assert.equal(partial.content.documents[0].status, "unavailable");
    assert.equal(partial.content.metrics[0].status, "read");
    assert.equal(partial.content.objects.status, "read");
    knowledge.state.mode = "normal";
    await api("/api/canvas/message", {
      page: "setup",
      text: "对投诉共同取证并保存",
      messageId: "evidence-agent",
    });
    await service.app.idle();
    assert(saved);
    assert.equal(saved.kind, "evidence_bundle");
    records.state.outcome = "已改善";
    const historical = await api("/api/live/evidence/read", {
      id: collected.id,
      version: collected.version,
    });
    assert.equal(
      historical.artifact.content.objects.result.items[0].实际反馈,
      "未改善",
    );
    assert.equal(historical.historical, true);
    const refreshed = (await api("/api/live/evidence/collect", request)).saved;
    assert.equal(refreshed.content.objects.result.items[0].实际反馈, "已改善");
    assert.notEqual(refreshed.id, collected.id);
    const filteredRequest = structuredClone(request);
    filteredRequest.metrics[0].where = { station: "清河站" };
    const filtered = (await api("/api/live/evidence/collect", filteredRequest))
      .saved;
    const fv = (
      await restoreHistoricalAccess(service.app, "/api/live/views/propose", {
        operationId: "filtered",
        name: "筛选指标",
        purpose: "清河站期间",
        modelRef: { id: model.id, version: model.version },
        grants: [{ type: "投诉", fields: ["$id"], relations: [] }],
        contextEvidence: [
          {
            bundleRef: { id: filtered.id, version: filtered.version },
            kind: "metric",
            index: 0,
          },
        ],
      })
    ).saved;
    const fk = (
      await restoreHistoricalAccess(service.app, "/api/live/views/activate", { id: fv.id, version: fv.version })
    ).saved.key;
    const fc = await consume("/v3/catalog", fk);
    const fe = await consume(
      "/v3/evidence?ref=" + fc.body.contextEvidence[0].ref,
      fk,
    );
    assert.deepEqual(fe.body.evidence.query.where, { station: "清河站" });
    assert.equal(fe.body.evidence.query.limit, 1);
    const linkedRequest = structuredClone(request);
    linkedRequest.metrics[0].dimensionBindings = [
      { dimension: "station", property: "所属站" },
    ];
    linkedRequest.metrics[0].limit = 20;
    const linked = (await api("/api/live/evidence/collect", linkedRequest))
      .saved;
    assert.deepEqual(linked.content.metrics[0].association.links[0].objectIds, [
      "TS002",
    ]);
    assert.deepEqual(linked.content.metrics[0].association.links[1].objectIds, [
      "TS003",
    ]);
    assert.equal(linked.content.metrics[0].result.items[1].status, "missing");
    Object.assign(records.primary[0], { station: null });
    const unknown = (await api("/api/live/evidence/collect", linkedRequest))
      .saved;
    assert.deepEqual(
      unknown.content.metrics[0].association.links[0].uncertainObjectIds,
      ["TS002"],
    );
    assert.deepEqual(
      unknown.content.metrics[0].association.links[0].objectIds,
      [],
    );
    Object.assign(records.primary[0], { station: "清河站" });
    for (const mode of ["wrong-unit", "wrong-period", "wrong-dimension"]) {
      metrics.state.mode = mode;
      const badRequest = structuredClone(request);
      badRequest.metrics[0].where = { station: "清河站" };
      const bad = (await api("/api/live/evidence/collect", badRequest)).saved;
      assert.equal(bad.content.metrics[0].status, "unavailable", mode);
      assert.equal(bad.content.objects.status, "read");
    }
    metrics.state.mode = "normal";
    // The real tool entry point must not publish an artifact after stopping during source I/O.
    stopping = true;
    const count = service.app.canvasState().evidence.length,
      calls = knowledge.state.calls,
      metricCalls = metrics.state.calls;
    knowledge.state.delay = new Promise<void>((r) => {
      release = r;
    });
    await api("/api/canvas/message", {
      page: "setup",
      text: "再次共同取证",
      messageId: "evidence-stop",
    });
    for (let i = 0; i < 100 && knowledge.state.calls === calls; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert(knowledge.state.calls > calls);
    await service.app.canvasStop({ page: "setup" });
    await service.app.idle();
    assert.equal(service.app.canvasState().evidence.length, count);
    assert.equal(
      metrics.state.calls,
      metricCalls,
      "no later metric calls after stop",
    );
    knowledge.state.delay = undefined;
    // Revocation during an in-flight document read also rejects the entire new artifact.
    const before = knowledge.state.calls;
    knowledge.state.delay = new Promise<void>((r) => {
      release = r;
    });
    const pending = api("/api/live/evidence/collect", request);
    const rejected = assert.rejects(pending, /停用|版本/);
    for (let i = 0; i < 100 && knowledge.state.calls === before; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert(knowledge.state.calls > before);
    await api("/api/live/disable", { id: k.id, version: k.version });
    release();
    await rejected;
    const blockedDoc = await consume(
      "/v3/evidence?ref=" + catalog.body.contextEvidence[0].ref,
    );
    assert.equal(blockedDoc.status, 502);
    for(const path of ['/v3/catalog','/v3/connection']) {
      const unavailable=await consume(path);assert.equal(unavailable.status,502);assert.doesNotMatch(JSON.stringify(unavailable.body),/投诉服务说明/);
    }
    assert.doesNotMatch(JSON.stringify(blockedDoc.body), /处理完成|sourceId/);
    assert.equal(service.app.canvasState().evidence.length, count);
    await assert.rejects(
      api("/api/live/evidence/collect", request),
      /停用|版本/,
    );
    const old = await api("/api/live/evidence/read", {
      id: collected.id,
      version: collected.version,
    });
    assert(
      old.dependencies.some((x: any) => x.sourceId === k.id && !x.available),
    );
    const mappingAction=async(method:string,payload:any)=>(await api('/api/live/changes/'+method,payload)).saved;
    let change=await mappingAction('propose',{operationId:'context-change',baseRef:{id:model.id,version:model.version},patch:{kind:'property',type:'投诉',property:'实际反馈',supplement:'工单',sourceField:'status'},reason:'切换状态口径',evidence:'明确选择状态映射'});
    change=await mappingAction('check',{operationId:'context-check',id:change.id,version:change.version});
    change=await mappingAction('adopt',{operationId:'context-adopt',id:change.id,version:change.version});
    const migrationInput={operationId:'keep-context',viewRef:{id:active.view.id,version:active.view.version},changeRef:{id:change.id,version:change.version},dropContextEvidence:false};
    await assert.rejects(api('/api/live/migrations/preview', migrationInput), /已冻结/);
    await assert.rejects(api('/api/live/migrations/commit', { operationId: 'context-commit', id: 'missing', version: 1 }), /已冻结/);
    assert.equal(service.app.memory.getArtifact(active.view.id).version, active.view.version);

  } finally {
    release();
    await service.close();
    await Promise.all([records.close(), knowledge.close(), metrics.close()]);
    rmSync(directory, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";
import { createMetricSource, metricCapability } from "./metrics-fixture.ts";

test("authorized HTTP and MCP metric queries keep definition, dimensions, periods, missing values and bounded coverage", async () => {
  const upstream = await createMetricSource();
  const directory = mkdtempSync(join(tmpdir(), "de-metrics-"));
  let source: any,
    checked = false;
  const driver: AgentDriver = {
    async run(request) {
      const catalog = (await request.onTool("source_catalog", {})) as any;
      assert(catalog.connections.some((s: any) => s.id === source.id));
      const args = {
        sourceId: source.id,
        capability: "metrics",
        connectionVersion: source.version,
      };
      const d = (await request.onTool("metric_describe", args)) as any;
      assert.equal(d.definition.unit, "%");
      assert.equal(d.definition.aggregation.timeAdditive, false);
      const result = (await request.onTool("metric_query", {
        ...args,
        definitionHash: d.definitionHash,
        start: "2026-01-01",
        end: "2026-02-01",
        limit: 1,
      })) as any;
      assert.equal(result.items[0].value, 80);
      assert.equal(result.items[0].dimensions.station, "清河站");
      assert.equal(result.definition.grain, "month");
      assert.equal(result.definition.timeZone, "Asia/Shanghai");
      assert.equal(result.coverage.complete, false);
      assert.equal(result.coverage.nextOffset, 1);
      assert.equal(result.coverage.dataComplete, false);
      await assert.rejects(request.onTool("live_read", args), /指标/);
      checked = true;
      return {
        text: "清河站当月投诉办结率80%，非可加总指标，不能代表供暖恢复。",
        sessionId: "metrics",
        runId: "metrics",
      };
    },
    async stop() {},
    async close() {},
  };
  const service = await createServer({ directory, driver });
  await new Promise<void>((r) => service.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const api = async (path: string, body: unknown) => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: {
        "x-dataengine-token": service.adminToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const result = (await res.json()) as any;
    if (!res.ok) throw new Error(result.error);
    return result;
  };
  try {
    for (const protocol of ["http", "mcp"]) {
      source = (
        await api("/api/live/connect", {
          name: "办结指标 " + protocol,
          protocol,
          url: protocol === "http" ? upstream.url : upstream.mcpUrl,
          capabilities: [metricCapability],
        })
      ).saved;
      checked = false;
      await api("/api/canvas/message", {
        page: "setup",
        text: "查看2026年1月投诉办结率",
        messageId: "metric-" + protocol,
      });
      await service.app.idle();
      assert(checked, JSON.stringify(service.app.canvasState().messages));
      const args = {
        sourceId: source.id,
        capability: "metrics",
        connectionVersion: source.version,
      };
      const d = await api("/api/live/metrics/describe", args);
      const q = {
        ...args,
        definitionHash: d.definitionHash,
        start: "2026-01-01",
        end: "2026-02-01",
      };
      const next = await api("/api/live/metrics/query", {
        ...q,
        offset: 1,
        limit: 1,
      });
      assert.equal(next.items[0].value, null);
      assert.equal(next.items[0].status, "missing");
      assert.equal(next.items[0].missingReason, "源系统尚未完成对账");
      assert.equal(next.coverage.nextOffset, null);
      for (const mode of [
        "wrong-unit",
        "wrong-period",
        "wrong-dimension",
        "duplicate",
        "false-additive",
        "null-observed",
      ]) {
        upstream.state.mode = mode;
        await assert.rejects(
          api("/api/live/metrics/query", {
            ...q,
            ...(mode === "wrong-dimension"
              ? { where: { station: "清河站" } }
              : {}),
          }),
        );
      }
      upstream.state.mode = "normal";
      await assert.rejects(
        api("/api/live/metrics/query", { ...q, start: "2026-01-02" }),
        /期间|粒度/,
      );
      await assert.rejects(
        api("/api/live/metrics/query", { ...q, where: { undeclared: "x" } }),
        /维度/,
      );
      await assert.rejects(
        api("/api/live/metrics/query", {
          ...q,
          where: JSON.parse('{"__proto__":"清河站"}'),
        }),
        /维度/,
      );
      upstream.state.mode = "reserved-dimension";
      await assert.rejects(api("/api/live/metrics/describe", args), /维度/);
      upstream.state.mode = "unknown-total";
      const partial = await api("/api/live/metrics/query", q);
      assert.equal(partial.coverage.complete, false);
      assert.equal(partial.coverage.total, null);
      upstream.state.mode = "short-unknown";
      const short = await api("/api/live/metrics/query", q);
      assert.equal(short.coverage.nextOffset, 1);
      const shortNext = await api("/api/live/metrics/query", {
        ...q,
        offset: short.coverage.nextOffset,
      });
      assert.equal(shortNext.items[0].dimensions.station, "育新站");
      assert.equal(shortNext.coverage.nextOffset, 2);
      const empty = await api("/api/live/metrics/query", { ...q, offset: 2 });
      assert.equal(empty.coverage.nextOffset, null);
      assert.equal(empty.coverage.complete, false);
      upstream.state.mode = "normal";
      upstream.state.revision = "r2";
      await assert.rejects(api("/api/live/metrics/query", q), /定义|口径/);
      upstream.state.revision = "r1";
      await api("/api/live/disable", {
        id: source.id,
        version: source.version,
      });
      await assert.rejects(api("/api/live/metrics/describe", args), /停用/);
    }
  } finally {
    await service.close();
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("metric responses revoked in flight are rejected, stopped runs cannot deliver late results and per-run reads are bounded", async () => {
  const upstream = await createMetricSource(),
    directory = mkdtempSync(join(tmpdir(), "de-metrics-stop-"));
  let source: any,
    release = () => {},
    started = () => {},
    mode = "stop",
    checked = false;
  let ready = new Promise<void>((r) => {
    started = r;
  });
  const driver: AgentDriver = {
    async run(request) {
      const args = {
        sourceId: source.id,
        capability: "metrics",
        connectionVersion: source.version,
      };
      if (mode === "budget") {
        for (let i = 0; i < 40; i++)
          await request.onTool("metric_describe", args);
        await assert.rejects(request.onTool("metric_describe", args), /40次/);
        checked = true;
      } else {
        const d = (await request.onTool("metric_describe", args)) as any;
        upstream.state.delay = new Promise<void>((r) => {
          release = r;
        });
        const before = upstream.state.calls;
        const pending = request.onTool("metric_query", {
          ...args,
          definitionHash: d.definitionHash,
          start: "2026-01-01",
          end: "2026-02-01",
        });
        for (let i = 0; upstream.state.calls === before && i < 100; i++)
          await new Promise((r) => setTimeout(r, 10));
        assert(upstream.state.calls > before);
        started();
        await assert.rejects(pending, /运行|停止|失效|停用/);
        checked = true;
      }
      return {
        text: "迟到完成不应入历史",
        sessionId: "bounded",
        runId: "bounded",
      };
    },
    async stop() {},
    async close() {},
  };
  const service = await createServer({ directory, driver });
  try {
    source = await service.app.live.sources.connect({
      name: "指标",
      protocol: "http",
      url: upstream.url,
      capabilities: [metricCapability],
    });
    await service.app.canvasMessage({
      page: "setup",
      text: "查询指标",
      messageId: "metric-stop",
    });
    await ready;
    const callsAtStop = upstream.state.calls;
    const stopped = service.app.canvasStop({ page: "setup" });
    release();
    await stopped;
    await service.app.idle();
    assert(checked);
    assert.equal(
      upstream.state.calls,
      callsAtStop,
      "stop must prevent the second source request",
    );
    assert(
      !service.app
        .canvasState()
        .messages.some((m: any) => m.content === "迟到完成不应入历史"),
    );
    upstream.state.delay = undefined;
    checked = false;
    ready = new Promise<void>((r) => {
      started = r;
    });
    await service.app.canvasMessage({
      page: "setup",
      text: "再查询指标",
      messageId: "metric-revoke",
    });
    await ready;
    service.app.live.sources.disable(source.id, source.version);
    release();
    await service.app.idle();
    assert(checked);
    upstream.state.delay = undefined;
    mode = "budget";
    checked = false;
    source = await service.app.live.sources.connect({
      name: "另一个指标连接",
      protocol: "http",
      url: upstream.url,
      capabilities: [metricCapability],
    });
    await service.app.canvasMessage({
      page: "setup",
      text: "检查来源预算",
      messageId: "metric-budget",
    });
    await service.app.idle();
    assert(checked);
  } finally {
    release();
    upstream.state.delay = undefined;
    await service.close();
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

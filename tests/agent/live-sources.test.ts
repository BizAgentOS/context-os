import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { SourceConnections } from "../../src/live/sources.ts";

test("connected API reads current records without storing them; credentials stay outside memory", async () => {
  let outcome = "未改善";
  const upstream = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer source-test-secret");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ items: [{ id: "HF002", outcome }] }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "de-live-"));
  const memory = new MemoryStore(dir);
  const sources = new SourceConnections(dir, memory);
  try {
    const port = (upstream.address() as { port: number }).port;
    const source = await sources.connect({
      name: "回访",
      protocol: "http",
      url: `http://127.0.0.1:${port}`,
      token: "source-test-secret",
      capabilities: [
        {
          name: "followups",
          path: "/followups",
          fields: ["id", "outcome"],
          idField: "id",
          itemsPath: "items",
          filters: {},
          limitParam: "limit",
          offsetParam: "offset",
        },
      ],
    });
    const first = await sources.read(source.id, "followups", {}, 0, 10);
    assert.equal(first.items[0].outcome, "未改善");
    outcome = "已改善";
    assert.equal(
      (await sources.read(source.id, "followups", {}, 0, 10)).items[0].outcome,
      "已改善",
    );
    const saved = JSON.stringify(memory.listArtifacts());
    assert.ok(
      !saved.includes("HF002") && !saved.includes("source-test-secret"),
    );
    sources.disable(source.id, source.version);
    await assert.rejects(
      sources.read(source.id, "followups", {}, 0, 10),
      /停用/,
    );
  } finally {
    memory.close();
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP source negotiates tools and reads changed upstream values", async () => {
  const { createHeatingSources, connectHeatingSources } =
    await import("../../src/live/heating-sources.ts");
  const upstream = await createHeatingSources();
  const dir = mkdtempSync(join(tmpdir(), "live-mcp-"));
  const memory = new MemoryStore(dir);
  const sources = new SourceConnections(dir, memory);
  try {
    const { mcp } = await connectHeatingSources(sources, upstream);
    assert.equal(
      (
        await sources.read(
          mcp.id,
          "list_callbacks",
          { complaintId: "TS002" },
          0,
          3,
        )
      ).items[0].outcome,
      "未改善",
    );
    upstream.setOutcome("已改善");
    assert.equal(
      (
        await sources.read(
          mcp.id,
          "list_callbacks",
          { complaintId: "TS002" },
          0,
          3,
        )
      ).items[0].outcome,
      "已改善",
    );
  } finally {
    memory.close();
    await upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("numeric identities and empty pages beyond the source total follow the declared contract", async () => {
  const upstream = createServer((req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        items:
          Number(url.searchParams.get("offset")) > 0
            ? []
            : [{ id: 42, value: "ok" }],
        total: 1,
      }),
    );
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "live-numeric-"));
  const repo = new MemoryStore(dir);
  const sources = new SourceConnections(dir, repo);
  try {
    const source = await sources.connect({
      name: "数值编号",
      protocol: "http",
      url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
      capabilities: [
        {
          name: "records",
          path: "/records",
          idField: "id",
          idType: "number",
          fields: ["id", "value"],
          filters: { id: "id" },
          totalPath: "total",
        },
      ],
    });
    assert.equal(
      (await sources.read(source.id, "records", { id: "42" }, 0, 20)).items[0]
        .id,
      42,
    );
    const last = await sources.read(source.id, "records", {}, 20, 20);
    assert.equal(last.items.length, 0);
    assert.equal(last.coverage.total, 1);
  } finally {
    repo.close();
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

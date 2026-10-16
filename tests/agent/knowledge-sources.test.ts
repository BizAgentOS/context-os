import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";

test("authorized knowledge directory, bounded read and cited foundation survive source revocation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-knowledge-"));
  const text = "澄川热力为居民提供供热服务。" + "服务说明。".repeat(1500);
  let revision = "2026-09-01";
  const upstream = httpServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    assert.equal(req.headers.authorization, "Bearer source-test-secret");
    const rows = [
      { id: "intro-1", documentId: "intro", title: "企业介绍", revision, text },
    ];
    const matching = rows.filter((row) =>
      [...url.searchParams]
        .filter(([k]) => !["offset", "limit"].includes(k))
        .every(([k, v]) => row[k as keyof typeof row] === v),
    );
    const offset = Number(url.searchParams.get("offset"));
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        items: matching.slice(
          offset,
          offset + Number(url.searchParams.get("limit")),
        ),
        total: matching.length,
      }),
    );
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  let connection: any,
    candidate: any,
    checked = false;
  const driver: AgentDriver = {
    async run(request) {
      const catalog = (await request.onTool("source_catalog", {})) as any;
      assert.equal(
        catalog.connections[0].content.capabilities[0].contentKind,
        "knowledge",
      );
      await request.onTool("skill_use", {
        name: "company-foundation-ontology",
      });
      const args = { sourceId: connection.id, capability: "documents" };
      await assert.rejects(request.onTool("live_read", args), /知识/);
      const query = (await request.onTool("knowledge_query", {
        ...args,
        where: { documentId: "intro" },
        limit: 1,
      })) as any;
      assert.equal(query.items[0].segmentId, "intro-1");
      assert.equal(query.items[0].text, undefined);
      const read = (await request.onTool("knowledge_read", {
        ...args,
        segmentId: "intro-1",
        revision: query.items[0].revision,
        limit: 100,
      })) as any;
      assert.equal(read.text.length, 100);
      assert.equal(read.coverage.complete, false);
      assert.equal(read.coverage.nextOffset, 100);
      revision = "2026-09-02";
      await assert.rejects(
        request.onTool("knowledge_read", {
          ...args,
          segmentId: "intro-1",
          revision: "2026-09-01",
        }),
        /版本/,
      );
      const draft = {
        baseVersion: ((await request.onTool("foundation_read", {})) as any).current.version,
        enterprise: { name: "澄川热力", evidenceRefs: ["kb1"] },
        concepts: [
          {
            id: "resident",
            name: "居民",
            description: "供热服务客户",
            evidenceRefs: ["kb1"],
          },
        ],
        relations: [],
        unknowns: [],
        conflicts: [],
        evidence: [
          {
            id: "kb1",
            kind: "knowledge",
            readId: read.readId,
            quote: "澄川热力为居民提供供热服务。",
          },
        ],
      };
      await assert.rejects(
        request.onTool("foundation_propose", {
          ...draft,
          evidence: [{ ...draft.evidence[0], readId: "made-up" }],
        }),
        /读取/,
      );
      candidate = await request.onTool("foundation_propose", draft);
      assert.deepEqual(candidate.content.concepts.map((item: any) => [item.id, item.origin]), [["resident", "program"]]);
      assert.equal(candidate.content.evidence.find((item: any) => item.id === "kb1").knowledgeSnapshot, undefined);
      checked = true;
      return {
        text: "已保存知识依据候选",
        sessionId: "knowledge",
        runId: "knowledge",
      };
    },
    async stop() {},
    async close() {},
  };
  let service = await createServer({ directory, driver, automaticApi: false });
  seedFoundation(service.app.memory, service.app.foundation, {
    enterprise: "澄川热力",
    concepts: [
      { id: "resident", name: "居民", description: "来自居民表的记录，业务含义待核对。" },
    ],
  });
  await new Promise<void>((r) => service.server.listen(0, "127.0.0.1", r));
  let base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        "x-dataengine-token": service.adminToken,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert(response.ok, await response.clone().text());
    return response.json();
  };
  try {
    connection = (
      await api("/api/live/connect", {
        name: "企业知识库",
        protocol: "http",
        url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
        token: "source-test-secret",
        capabilities: [
          {
            name: "documents",
            path: "/documents",
            contentKind: "knowledge",
            fields: ["id", "documentId", "title", "revision", "text"],
            idField: "id",
            filters: { id: "id", documentId: "documentId" },
            totalPath: "total",
          },
        ],
      })
    ).saved;
    await api("/api/canvas/message", {
      page: "setup",
      text: "请使用知识库整理企业基础定义",
      messageId: "knowledge-request",
    });
    await service.app.idle();
    assert(checked, JSON.stringify((await api("/api/canvas")).messages));
    await api("/api/live/disable", {
      id: connection.id,
      version: connection.version,
    });
    await assert.rejects(
      service.app.canvasFoundationAdopt({
        page: "setup",
        id: candidate.id,
        version: candidate.version,
      }),
      /来源|停用/,
    );
    const found = await api(
      `/api/foundation/evidence?foundationId=${candidate.id}&version=${candidate.version}&evidenceId=kb1`,
    );
    assert.equal(found.revision, "2026-09-01");
    assert.equal(found.connectionStatus, "disabled");
    assert(found.text.includes("为居民提供供热服务"));
    assert.equal(found.text.length, 100);
    await service.close();
    service = await createServer({
      directory,
      driver: {
        async run() {
          return { text: "idle", sessionId: "idle", runId: "idle" };
        },
        async stop() {},
        async close() {},
      },
    });
    await new Promise<void>((r) => service.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    const reopened = await api(
      `/api/foundation/evidence?foundationId=${candidate.id}&version=${candidate.version}&evidenceId=kb1`,
    );
    assert.equal(reopened.text, found.text);
    assert.equal(reopened.revision, "2026-09-01");
  } finally {
    await service.close();
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP knowledge contract rejects filtering, unknown identity coverage, schema changes and in-flight revocation", async () => {
  const { createKnowledgeSource, knowledgeCapability } =
    await import("./knowledge-fixture.ts");
  const upstream = await createKnowledgeSource();
  const directory = mkdtempSync(join(tmpdir(), "de-knowledge-mcp-"));
  const driver: AgentDriver = {
    async run() {
      return { text: "idle", sessionId: "idle", runId: "idle" };
    },
    async stop() {},
    async close() {},
  };
  const service = await createServer({ directory, driver, automaticApi: false });
  await new Promise<void>((r) => service.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const api = async (path: string, body: unknown) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: {
        "x-dataengine-token": service.adminToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as any;
    if (!response.ok) throw new Error(result.error);
    return result;
  };
  try {
    const source = (
      await api("/api/live/connect", {
        name: "知识 MCP",
        protocol: "mcp",
        url: upstream.mcpUrl,
        capabilities: [knowledgeCapability],
      })
    ).saved;
    await api("/api/canvas/upload", {
      page: "setup",
      name: "旧记录.csv",
      content: "id,name\n1,已上传记录",
    });
    await service.app.idle();
    await api("/api/live/connect", {
      name: "旧记录连接",
      protocol: "http",
      url: upstream.url,
      capabilities: [
        {
          name: "records",
          path: "/records",
          fields: ["id", "name"],
          idField: "id",
        },
      ],
    });
    const catalog = await api("/api/live/catalog", {});
    assert.equal(catalog.files.length, 1);
    assert.equal(catalog.files[0].title, "旧记录.csv");
    assert.equal(catalog.connections.length, 2);
    assert.equal(catalog.coverage.total, 3);
    assert(!JSON.stringify(catalog).includes("已上传记录"));
    const firstCatalog = await api("/api/live/catalog", { limit: 1 });
    assert.equal(firstCatalog.coverage.nextOffset, 1);
    await assert.rejects(
      api("/api/live/read", { sourceId: source.id, capability: "documents" }),
      /知识/,
    );
    const args = {
      sourceId: source.id,
      capability: "documents",
      connectionVersion: source.version,
    };
    const page = await api("/api/live/knowledge/query", { ...args, limit: 1 });
    assert.equal(page.items[0].title, "澄川热力企业介绍");
    assert.equal(page.coverage.complete, false);
    assert.equal(page.coverage.total, 2);
    const next = await api("/api/live/knowledge/query", {
      ...args,
      offset: 1,
      limit: 1,
    });
    assert.equal(next.items[0].documentId, "guide");
    const readArgs = { ...args, segmentId: "company-1", revision: "r1" };
    const part = await api("/api/live/knowledge/read", readArgs);
    assert.equal(
      part.text,
      "澄川热力为居民提供供热服务。供热站负责区域供热，客服部门受理居民投诉。",
    );
    await assert.rejects(
      api("/api/live/knowledge/query", {
        ...args,
        where: { unapproved: "value" },
      }),
      /过滤/,
    );
    upstream.state.mode = "ignore-filter";
    await assert.rejects(
      api("/api/live/knowledge/query", {
        ...args,
        where: { documentId: "nonexistent" },
      }),
      /过滤/,
    );
    upstream.state.mode = "unknown-total";
    const partial = await api("/api/live/knowledge/query", args);
    assert.equal(partial.coverage.total, null);
    assert.equal(partial.coverage.complete, false);
    await assert.rejects(api("/api/live/knowledge/read", readArgs), /不完整/);
    upstream.state.mode = "ambiguous";
    await assert.rejects(api("/api/live/knowledge/read", readArgs), /不完整/);
    upstream.state.mode = "oversized";
    await assert.rejects(api("/api/live/knowledge/read", readArgs), /16000/);
    upstream.state.mode = "failure";
    await assert.rejects(
      api("/api/live/knowledge/query", args),
      /来源读取失败/,
    );
    upstream.state.mode = "normal";
    upstream.state.schemaChanged = true;
    await assert.rejects(
      api("/api/live/knowledge/read", readArgs),
      /来源读取失败/,
    );
    upstream.state.schemaChanged = false;
    let release!: () => void;
    upstream.state.delay = new Promise<void>((r) => {
      release = r;
    });
    const before = upstream.state.calls;
    const pending = api("/api/live/knowledge/read", readArgs);
    const rejected = assert.rejects(pending, /停用|版本/);
    for (let i = 0; upstream.state.calls === before && i < 100; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert(upstream.state.calls > before);
    await api("/api/live/disable", { id: source.id, version: source.version });
    release();
    await rejected;
  } finally {
    upstream.state.delay = undefined;
    await service.close();
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resolved historical knowledge conflict does not lock a foundation after user replaces its active meaning", async () => {
  const { createKnowledgeSource, knowledgeCapability } =
    await import("./knowledge-fixture.ts");
  const upstream = await createKnowledgeSource();
  const directory = mkdtempSync(join(tmpdir(), "de-knowledge-history-"));
  let phase = 0,
    source: any;
  const driver: AgentDriver = {
    async run(request) {
      await request.onTool("skill_use", {
        name: "company-foundation-ontology",
      });
      const current = ((await request.onTool("foundation_read", {})) as any)
        .current;
      const user = JSON.parse(request.input)
        .recentMessages.filter((m: any) => m.role === "user")
        .at(-1);
      const draft: any = {
        baseVersion: current?.version ?? 0,
        enterprise: { name: "澄川热力", evidenceRefs: ["user0"] },
        concepts: [],
        relations: [],
        evidence: [],
        unknowns: [],
        conflicts: [],
      };
      if (phase === 1) {
        const part = (await request.onTool("knowledge_read", {
          sourceId: source.id,
          capability: "documents",
          segmentId: "company-1",
          revision: "r1",
        })) as any;
        draft.evidence = [
          {
            id: "kb",
            kind: "knowledge",
            readId: part.readId,
            quote: "供热站负责区域供热，客服部门受理居民投诉。",
          },
        ];
        draft.concepts = [
          {
            id: "service",
            name: "客服",
            description: "受理居民投诉",
            evidenceRefs: ["kb"],
          },
        ];
      } else {
        draft.evidence = [
          { id: "user" + phase, messageId: user.id, quote: user.content },
        ];
        draft.concepts = [
          {
            id: "service",
            name: "客服",
            description: phase === 0 ? "受理所有咨询" : "只登记居民咨询",
            evidenceRefs: ["user" + phase],
          },
        ];
        if (phase === 2) {
          const conflict = current.content.conflicts[0];
          draft.conflicts = [
            {
              id: conflict.id,
              description: conflict.description,
              resolvedBy: ["user2"],
            },
          ];
        }
      }
      await request.onTool("foundation_propose", draft);
      phase++;
      return { text: "已保存", sessionId: "history", runId: "history" };
    },
    async stop() {},
    async close() {},
  };
  const service = await createServer({ directory, driver, automaticApi: false });
  seedFoundation(service.app.memory, service.app.foundation, {
    enterprise: "澄川热力",
    concepts: [
      { id: "service", name: "客服", description: "来自客服表的记录，业务含义待核对。" },
    ],
  });
  try {
    source = await service.app.live.sources.connect({
      name: "知识",
      protocol: "http",
      url: upstream.url,
      capabilities: [knowledgeCapability],
    });
    for (const [index, text] of [
      "澄川热力客服受理所有咨询",
      "请检查资料中的客服含义",
      "我确认客服只登记居民咨询，替换旧定义与知识材料含义。",
    ].entries()) {
      await service.app.canvasMessage({
        page: "setup",
        text,
        messageId: "history-" + index,
      });
      await service.app.idle();
      assert.equal(
        phase,
        index + 1,
        JSON.stringify(service.app.canvasState().messages),
      );
    }
    service.app.live.sources.disable(source.id, source.version);
    const candidate = service.app.canvasState().foundation.current!;
    assert.equal((candidate.content.conflicts as any[]).length, 1);
    const adopted = await service.app.canvasFoundationAdopt({
      page: "setup",
      id: candidate.id,
      version: candidate.version,
    });
    assert.equal(adopted.foundation.adopted?.status, "adopted");
  } finally {
    await service.close();
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { FeishuDocuments } from "../../src/agent/feishu-documents.ts";
import { FoundationDocuments } from "../../src/agent/foundation-evidence.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { sourceCatalog } from "../../src/agent/knowledge.ts";
import { createServer } from "../../src/agent/server.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";
import type { AddressInfo } from "node:net";
import { seedFoundation } from "./program-foundation-fixture.ts";

test("explicit Feishu reads persist inspectable, versioned sources and retain original citations after refresh and restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-feishu-docs-"));
  let memory = new MemoryStore(directory);
  let content = "# 示例仓配\n门店负责收货。";
  const reader = { async readDocument(url: string) { return {
    provider: "feishu", documentId: "file1", title: "仓配.md", url,
    revision: null, format: "markdown", content, contentHash: undefined,
    readAt: "2026-09-17T06:00:00.000Z", coverage: "file",
  }; } };
  try {
    let documents = new FeishuDocuments(memory, reader);
    assert.equal(documents.list().length, 0);
    const first = await documents.read("https://team.feishu.cn/wiki/page1");
    assert.equal(first.sourceVersion, 1);
    assert.equal(documents.list()[0].characters, 14);
    assert.equal(documents.get(first.sourceId).content, content);
    assert.deepEqual(documents.list()[0].usage, []);
    const listing = documents.matchDirectory({ directory: { title: "数据", url: "https://team.feishu.cn/wiki/folder", parentUrl: null }, readAt: "2026-09-17T06:00:00.000Z", coverage: { shown: 2, complete: true, hasMore: false, nextPageToken: null, scope: "direct-children" }, items: [
      { title: "同一文件的另一个入口.md", url: "https://team.feishu.cn/wiki/alias", nodeToken: "alias", documentId: "file1", type: "file", hasChildren: false, readable: true },
      { title: "另一个空间的同名ID.md", url: "https://other.feishu.cn/wiki/alias", nodeToken: "alias", documentId: "file1", type: "file", hasChildren: false, readable: true },
    ] });
    assert.equal(listing.items[0].saved?.sourceId, first.sourceId);
    assert.equal(listing.items[1].saved, null);
    const reread = await documents.read("https://team.feishu.cn/wiki/page1");
    assert.equal(reread.sourceId, first.sourceId);
    assert.equal(reread.sourceVersion, 1, "identical reads do not invalidate existing evidence");
    const evidenceReader = new FoundationDocuments(memory);
    const part = evidenceReader.read({ sourceId: first.sourceId });
    const evidence = evidenceReader.cite({ id: "f1", kind: "document", readId: part.readId, quote: "门店负责收货。" });
    assert.equal(evidence.url, "https://team.feishu.cn/wiki/page1");
    assert.equal(evidence.sourceReadAt, "2026-09-17T06:00:00.000Z");
    const upload = new Workspace(memory).upload("仓配.md", "独立上传资料");
    assert.notEqual(upload.id, first.sourceId, "same filename is not the same source");
    content = "# 示例仓配\n仓库负责收货。";
    const updated = await documents.read("https://team.feishu.cn/wiki/page1");
    assert.equal(updated.sourceId, first.sourceId);
    assert.equal(updated.sourceVersion, 2);
    memory.close(); memory = new MemoryStore(directory);
    documents = new FeishuDocuments(memory, reader);
    assert.equal(documents.list().length, 1);
    assert.equal(documents.get(first.sourceId).content, content);
    assert.equal(new FoundationDocuments(memory).locate(evidence).quote, "门店负责收货。");
    assert.equal(sourceCatalog(memory, {}).files.find(f => f.id === first.sourceId)?.protocol, "feishu");
    await assert.rejects(new FeishuDocuments(memory, { async readDocument() { throw new Error("连接已断开"); } }).read("https://team.feishu.cn/wiki/page1"));
    assert.equal(documents.get(first.sourceId).sourceVersion, 2);
  } finally { memory.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("saved Feishu documents enter the shared ontology flow with pinned evidence, unified Agent wording and visible adopted usage, and no invented model success", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-feishu-flow-"));
  const memory = new MemoryStore(directory);
  const seed = new FeishuDocuments(memory, { async readDocument(url: string) { return {
    provider: "feishu", documentId: "file2", title: "企业.md", url, revision: null,
    format: "markdown", content: "澄川仓配的门店接收仓库补货。", contentHash: undefined,
    readAt: "2026-09-17T06:00:00.000Z", coverage: "file",
  }; } });
  const doc = await seed.read("https://team.feishu.cn/wiki/page2");
  memory.saveSettings({ provider: "custom", model: "test-only", protocol: "openai", baseUrl: "https://feishu-flow-test.invalid/v1" });
  memory.close();
  let service = await createServer({ directory });
  const start = async () => {
    await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    return async (path: string, body?: unknown, status = 200) => {
      const response = await fetch(base + path, { method: body ? "POST" : "GET", headers: { "x-dataengine-token": service.adminToken, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(response.status, status, await response.clone().text()); return response.json();
    };
  };
  let release!: () => void, stopped = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const driver: AgentDriver = {
    async run(request) {
      await gate;
      const input = JSON.parse(request.input);
      assert.equal(input.focus.id, doc.sourceId);
      assert.equal(input.focus.version, 1);
      await request.onTool("skill_use", { name: "company-foundation-ontology" });
      const part = await request.onTool("foundation_document_read", { sourceId: doc.sourceId, version: 1 }) as any;
      const baseline = (await request.onTool("pending_list", {}) as any).baseline;
      const proposal = { operationId: "feishu-description", type: "description", baseline,
        subject: { target: "concept", id: "store", description: "接收补货", evidence: [{ id: "f1", kind: "document", readId: part.readId, quote: "澄川仓配的门店接收仓库补货。" }] },
        evidence: "已读取飞书企业说明中的门店职责" };
      await assert.rejects(request.onTool("change_propose", { ...proposal, operationId: "fake-receipt", subject: { ...proposal.subject, evidence: [{ ...proposal.subject.evidence[0], readId: "invented" }] } }), /读取/);
      const result = await request.onTool("change_propose", proposal) as any;
      assert.equal(result.change.status, "adopted", "evidence-backed wording is applied by the host after verification");
      const view = await request.onTool("foundation_read", {}) as any;
      assert.deepEqual(view.adopted.content.concepts.map((item: any) => [item.id, item.origin]), [["store", "program"]]);
      assert.equal(view.adopted.content.evidence.find((item: any) => item.id === "f1").sourceVersion, 1);
      return { text: "已生成有原文依据的候选。", sessionId: "feishu-docs", runId: "feishu-docs" };
    }, async stop() { stopped++; release(); }, async close() { release(); },
  };
  try {
    let api = await start();
    const state = await api("/api/connectors/feishu");
    assert.equal(state.documents.length, 1);
    assert.equal(state.documents[0].title, "企业.md");
    assert.equal(state.modelConfigured, false);
    const request = { sourceId: doc.sourceId, version: 1, messageId: "feishu-request-1" };
    const blocked = await api("/api/connectors/feishu/prepare", request, 400);
    assert.match(blocked.error, /模型/);
    assert.equal((await api("/api/canvas")).foundation.current, null);
    seedFoundation(service.app.memory, service.app.foundation, {
      enterprise: "澄川仓配",
      concepts: [
        { id: "store", name: "门店", description: "来自门店表的记录，业务含义待核对。" },
      ],
    });
    await service.close(); service = await createServer({ directory, driver }); api = await start();
    const saved = await api(`/api/connectors/feishu/document?sourceId=${doc.sourceId}`);
    assert.equal(saved.content, "澄川仓配的门店接收仓库补货。");
    await api("/api/connectors/feishu/prepare", request);
    await api("/api/connectors/feishu/prepare", request);
    assert.equal(stopped, 0, "retrying a received request must not stop its active generation");
    release(); await service.app.idle();
    let usage = (await api("/api/connectors/feishu")).documents[0].usage;
    assert.equal(usage.length, 1, JSON.stringify((await api("/api/canvas")).messages)); assert.equal(usage[0].status, "adopted");
    assert.equal(usage[0].concepts[0].name, "门店");
    usage = (await api("/api/connectors/feishu")).documents[0].usage;
    assert.equal(usage[0].status, "adopted");
    const citation = await api(`/api/foundation/evidence?foundationId=${usage[0].foundationId}&version=${usage[0].foundationVersion}&evidenceId=f1`);
    assert.equal(citation.url, "https://team.feishu.cn/wiki/page2");
    assert.equal(citation.quote, "澄川仓配的门店接收仓库补货。");
    const refreshedMemory = new MemoryStore(directory);
    try {
      await new FeishuDocuments(refreshedMemory, { async readDocument(url: string) { return {
        provider: "feishu", documentId: "file2", title: "企业.md", url, revision: null, format: "markdown",
        content: "澄川仓配调整了收货规则。", contentHash: undefined, readAt: "2026-09-18T06:00:00.000Z", coverage: "file",
      }; } }).read("https://team.feishu.cn/wiki/page2");
    } finally { refreshedMemory.close(); }
    const refreshed = (await api("/api/connectors/feishu")).documents[0];
    assert.equal(refreshed.sourceVersion, 2);
    assert.deepEqual(refreshed.usage[0].sourceVersions, [1]);
    assert.equal(refreshed.usage[0].status, "adopted");
    assert.match((await api("/api/connectors/feishu/prepare", { ...request, messageId: "new-request" }, 400)).error, /资料版本已变化/);
  } finally { release(); await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a stopped agent read cannot persist a late Feishu source", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-feishu-cancel-"));
  const memory = new MemoryStore(directory);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const documents = new FeishuDocuments(memory, { async readDocument(url: string) {
      await gate;
      return { provider: "feishu", documentId: "file1", title: "资料.md", url, revision: null, format: "markdown", content: "不应保存的迟到正文", contentHash: undefined, readAt: new Date().toISOString(), coverage: "file" };
    } });
    const task = memory.createTask("读取飞书资料"); const context = memory.beginExecution(task.id);
    const reading = documents.read("https://team.feishu.cn/wiki/page1", context);
    memory.pauseTask(task.id, "用户已停止");
    const rejected = assert.rejects(reading); release(); await rejected;
    assert.equal(documents.list().length, 0);
  } finally { release(); memory.close(); rmSync(directory, { recursive: true, force: true }); }
});

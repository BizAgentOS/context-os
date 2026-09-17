import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentApplication } from "../../src/agent/app.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";

test("uploading a document automatically builds and adopts the foundation without a confirmation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-auto-foundation-"));
  const driver: AgentDriver = {
    async run(request) {
      const input = JSON.parse(request.input);
      assert.equal(input.mode, "automatic-document-ontology");
      assert.ok(!request.tools.some(tool => tool.name === "task_ask"));
      const source = input.sources[0];
      const part = await request.onTool("foundation_document_read", { sourceId: source.id, version: source.version }) as any;
      const current = await request.onTool("foundation_read", {}) as any;
      await request.onTool("foundation_propose", {
        baseVersion: current.current?.version ?? 0,
        enterprise: { name: "澄川仓配", evidenceRefs: ["doc1"] },
        concepts: [{ id: "store", name: "门店", description: "收货地点", evidenceRefs: ["doc1"] }], relations: [],
        evidence: [{ id: "doc1", kind: "document", readId: part.readId, quote: "澄川仓配的门店负责收货。" }], unknowns: [], conflicts: [],
      });
      return { text: "生成完成", sessionId: "auto", runId: "auto" };
    }, async stop() {}, async close() {},
  };
  const app = new AgentApplication(directory, driver);
  try {
    await app.canvasUpload({ page: "setup", name: "仓配.md", content: "澄川仓配的门店负责收货。" });
    await app.idle();
    const state = app.canvasState("ontology");
    assert.equal(state.foundation.current?.status, "adopted");
    assert.equal(state.foundation.current?.content.automatic, true);
    assert.equal((state.foundation.current?.content.concepts as any[])[0].name, "门店");
    assert.equal(state.pending, null);
    assert.equal(state.automaticBuild.status, "completed");
    assert.equal(state.automaticBuild.completed, 1);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

const buildDriver = (after?: () => Promise<void>): AgentDriver => ({
  async run(request) {
    const input = JSON.parse(request.input);
    const before = await request.onTool("foundation_read", {}) as any;
    const evidence: any[] = [], concepts: any[] = [];
    for (const source of input.sources) {
      const part = await request.onTool("foundation_document_read", { sourceId: source.id, version: source.version }) as any;
      const id = `doc-${source.id}-${before.current?.version ?? 0}`;
      evidence.push({ id, kind: "document", readId: part.readId, quote: part.text });
      concepts.push({ id: `concept-${source.id}`, name: source.title, description: "资料描述的业务概念", evidenceRefs: [id] });
    }
    await request.onTool("foundation_propose", { baseVersion: before.current?.version ?? 0,
      enterprise: { name: "澄川仓配", evidenceRefs: [evidence[0].id] }, concepts, relations: [], evidence, unknowns: [], conflicts: [] });
    await after?.();
    return { text: "完成", sessionId: "batch", runId: "batch" };
  }, async stop() {}, async close() {},
});

test("uploads and Feishu snapshots queue without a model, survive restart, and build every document including CSV", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-auto-queue-"));
  const key = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  let app = new AgentApplication(directory);
  try {
    await app.canvasUpload({ page: "setup", name: "仓配.md", content: "澄川仓配的门店负责收货。" });
    await app.canvasUpload({ page: "setup", name: "清单.csv", content: "company,type\n澄川仓配,门店\n" });
    app.capabilities.feishu.readDocument = async (url: string) => ({provider: "feishu", documentId: "auto-doc", title: "补货.md", url, revision: null, contentHash: undefined, format: "markdown", content: "澄川仓配的仓库负责补货。", readAt: new Date().toISOString(), coverage: "file"});
    await app.capabilities.feishuDocuments!.read("https://example.feishu.cn/wiki/example");
    assert.equal(app.canvasState().automaticBuild.status, "waiting_model");
    assert.equal(app.canvasState().automaticBuild.pending, 3);
    assert.equal(app.canvasState().foundation.current, null);
    await app.close();
    app = new AgentApplication(directory, buildDriver());
    await app.idle();
    const state = app.canvasState("ontology");
    assert.equal(state.automaticBuild.completed, 3);
    assert.equal(state.automaticBuild.status, "completed", JSON.stringify(state.automaticBuild));
    assert.equal(Object.keys(state.foundation.current!.content.documentVersions as object).length, 3);
    assert.equal(state.foundation.current!.status, "adopted");
    assert.equal(state.pending, null);
  } finally { await app.close(); if (key === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = key; rmSync(directory, {recursive: true, force: true}); }
});

test("navigation preserves an automatic run, and another upload is processed afterwards", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-auto-continuous-"));
  let release!: () => void, entered!: () => void, count = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const driver = buildDriver(async () => { if (++count === 1) { entered(); await new Promise<void>(resolve => { release = resolve; }); } });
  const app = new AgentApplication(directory, driver);
  try {
    await app.canvasUpload({page: "setup", name: "第一份.md", content: "澄川仓配的门店负责收货。"});
    await started;
    await app.canvasNavigate({page: "ontology"});
    assert.equal(app.canvasState().automaticBuild.status, "running");
    await app.canvasUpload({page: "ontology", name: "第二份.md", content: "澄川仓配的仓库负责补货。"});
    release(); await app.idle();
    const state = app.canvasState();
    assert.equal(state.currentPage, "ontology");
    assert.equal(state.automaticBuild.completed, 2, JSON.stringify(state.automaticBuild));
    assert.equal((state.foundation.current!.content.concepts as any[]).length, 2);
  } finally { release?.(); await app.close(); rmSync(directory, {recursive: true, force: true}); }
});

test("a failed build exposes its reason and retries without adoption confirmation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-auto-retry-"));
  let fail = true;
  const driver = buildDriver(async () => { if (fail) throw new Error("测试模型不可用"); });
  const app = new AgentApplication(directory, driver);
  try {
    await app.canvasUpload({page: "setup", name: "仓配.md", content: "澄川仓配的门店负责收货。"});
    await app.idle();
    assert.equal(app.canvasState().automaticBuild.status, "failed");
    assert.match(app.canvasState().automaticBuild.errors[0].message, /模型不可用/);
    assert.equal(app.canvasState().foundation.adopted, null);
    fail = false;
    app.retryAutomaticBuild(); await app.idle();
    assert.equal(app.canvasState().automaticBuild.status, "completed", JSON.stringify(app.canvasState().automaticBuild));
    assert.equal(app.canvasState().foundation.current?.status, "adopted");
    assert.equal(app.canvasState("ontology").pending, null);
  } finally { await app.close(); rmSync(directory, {recursive: true, force: true}); }
});

test("deleting an upload during construction rejects the late adoption", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-auto-delete-"));
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const driver = buildDriver(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
  driver.stop = async () => release?.();
  const app = new AgentApplication(directory, driver);
  try {
    await app.canvasUpload({page: "setup", name: "仓配.md", content: "澄川仓配的门店负责收货。"});
    await started;
    const source = app.canvasState().sources[0];
    await app.removeUpload({id: source.id, version: source.version});
    await app.idle();
    assert.equal(app.canvasState().sources.length, 0);
    assert.equal(app.canvasState().foundation.adopted, null);
    assert.equal(app.canvasState().automaticBuild.total, 0);
    driver.run = buildDriver().run;
    await app.canvasUpload({page: "setup", name: "后续.md", content: "澄川仓配的仓库负责补货。"});
    await app.idle();
    assert.equal(app.canvasState().automaticBuild.status, "completed", JSON.stringify(app.canvasState().automaticBuild));
    assert.equal((app.canvasState().foundation.current!.content.concepts as any[]).length, 1);
  } finally { release?.(); await app.close(); rmSync(directory, {recursive: true, force: true}); }
});

test("deleting a previously built upload does not block later documents or erase historical evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-auto-history-"));
  const app = new AgentApplication(directory, buildDriver());
  try {
    await app.canvasUpload({page: "setup", name: "第一份.md", content: "澄川仓配的门店负责收货。"});
    await app.idle();
    const source = app.canvasState().sources[0];
    await app.removeUpload({id: source.id, version: source.version});
    await app.canvasUpload({page: "setup", name: "第二份.md", content: "澄川仓配的仓库负责补货。"});
    await app.idle();
    const state = app.canvasState();
    assert.equal(state.automaticBuild.status, "completed", JSON.stringify(state.automaticBuild));
    assert.equal(state.automaticBuild.completed, 1);
    assert.equal(state.sources.length, 1);
    assert.equal(state.foundation.current?.status, "adopted");
    assert.equal((state.foundation.current!.content.evidence as any[]).length, 2);
  } finally { await app.close(); rmSync(directory, {recursive: true, force: true}); }
});

test("saving and testing a model connection happens before queued automatic construction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-auto-connect-"));
  const key = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  const app = new AgentApplication(directory);
  let tested = false;
  try {
    await app.canvasUpload({page: "setup", name: "仓配.md", content: "澄川仓配的门店负责收货。"});
    const driver = buildDriver();
    app.driver.run = async request => {
      if (request.title === "模型连接检查") { tested = true; return {text: "连接成功", sessionId: "test", runId: "test"}; }
      assert(tested); return driver.run(request);
    };
    const settings = await app.configure({provider: "deepseek", model: "test", apiKey: "test-only-local-key", testConnection: true});
    assert.equal(settings.connection?.ok, true);
    await app.idle();
    assert.equal(app.canvasState().automaticBuild.status, "completed");
  } finally { await app.close(); if (key === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = key; rmSync(directory, {recursive: true, force: true}); }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentApplication } from "../../src/agent/app.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";

const driver: AgentDriver = {
  async run(request) {
    const input = JSON.parse(request.input), before = await request.onTool("foundation_read", {}) as any;
    for (const source of input.sources) {
      const read = await request.onTool("foundation_document_read", { sourceId: source.id }) as any;
      await request.onTool("foundation_propose", { baseVersion: before.current.version, enterprise: before.current.content.enterprise,
        concepts: [{ id: "store", name: "门店", description: "收货地点", aliases: ["收货站"], evidenceRefs: [`doc-${source.id}`] }], relations: [],
        evidence: [{ id: `doc-${source.id}`, kind: "document", readId: read.readId, quote: read.text }], unknowns: [], conflicts: [] });
    }
    return { text: "完成", sessionId: "test", runId: "test" };
  }, async close() {}, async stop() {},
};

test("one upload batch of twenty documents refines existing structure in one workspace version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-document-batch-")), app = new AgentApplication(directory, driver);
  try {
    seedFoundation(app.memory, app.foundation, { enterprise: "澄川仓配", concepts: [{ id: "store", name: "门店", description: "收货地点" }] });
    const before = app.memory.listArtifacts("workspace_version").length;
    const workspace = new Workspace(app.memory);
    const sources = Array.from({ length: 20 }, (_, i) => workspace.upload(`门店-${i}.md`, `澄川仓配的第${i}条门店规则说明：门店是收货地点。`));
    app.automaticBuild.enqueueBatch(sources, "twenty-documents");
    const jobs = app.automaticBuild.pending();
    assert.equal(jobs.length, 20);
    const task = app.memory.createTask("批量读取门店资料"), context = app.memory.beginExecution(task.id);
    await app.automaticBuild.run(jobs, context, driver, error => (error as Error).message);
    assert.equal(app.automaticBuild.view(true).completed, 20, JSON.stringify(app.automaticBuild.view(true)));
    assert.equal(app.memory.listArtifacts("workspace_version").length, before + 1);
    const current = app.foundation.read().adopted!;
    assert.equal((current.content.concepts as any[]).length, 1);
    assert.deepEqual((current.content.concepts as any[])[0].aliases, ["收货站"]);
    assert.equal(Object.keys(current.content.documentVersions as object).length, 20);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("an upload batch cannot enter document processing before explicit finalization", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-document-upload-gate-")), app = new AgentApplication(directory, driver);
  try {
    seedFoundation(app.memory, app.foundation, { enterprise: "澄川仓配", concepts: [{ id: "store", name: "门店", description: "收货地点" }] });
    const batch = app.memory.putArtifact({ kind: "document_upload_batch", title: "待上传批次", status: "collecting", content: {} });
    const uploaded = new Workspace(app.memory).upload("first.md", "澄川仓配的门店是收货地点。");
    const source = app.memory.putArtifact({ ...uploaded, expectedVersion: uploaded.version, content: { ...uploaded.content, uploadBatchId: batch.id } });
    app.automaticBuild.enqueue(source);
    assert.equal(app.automaticBuild.pending().length, 0);
    app.memory.atomic(() => {
      app.memory.putArtifact({ ...batch, expectedVersion: batch.version, status: "finalized" });
      app.automaticBuild.enqueueBatch([source], batch.id);
    });
    assert.equal(app.automaticBuild.pending().length, 1);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a failed document and a document proposing new structure do not discard independent successful documents", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-document-partial-"));
  const partial: AgentDriver = { ...driver, async run(request) {
    const source = JSON.parse(request.input).sources[0];
    if (source.title === "new-structure.md") {
      const current = await request.onTool("foundation_read", {}) as any;
      const read = await request.onTool("foundation_document_read", { sourceId: source.id }) as any;
      await request.onTool("foundation_propose", { baseVersion: current.current.version, enterprise: current.current.content.enterprise,
        concepts: [{ id: "invented", name: "新实体", description: "文档不能生成结构", evidenceRefs: ["invented"] }], relations: [],
        evidence: [{ id: "invented", kind: "document", readId: read.readId, quote: read.text }], unknowns: [], conflicts: [] });
    }
    const result = await driver.run(request);
    if (source.title === "failed.md") throw new Error("这份文档的模型读取失败");
    return result;
  } };
  const app = new AgentApplication(directory, partial);
  try {
    seedFoundation(app.memory, app.foundation, { enterprise: "澄川仓配", concepts: [{ id: "store", name: "门店", description: "收货地点" }] });
    const before = app.memory.listArtifacts("workspace_version").length;
    const workspace = new Workspace(app.memory), sources = ["first.md", "failed.md", "new-structure.md", "last.md"].map(name => workspace.upload(name, `澄川仓配文档${name}：门店是收货地点。`));
    app.automaticBuild.enqueueBatch(sources, "partial");
    const task = app.memory.createTask("批次部分失败"), context = app.memory.beginExecution(task.id);
    await app.automaticBuild.run(app.automaticBuild.pending(), context, partial, error => (error as Error).message);
    const state = app.automaticBuild.view(true);
    assert.equal(state.completed, 2);
    assert.equal(state.errors.length, 2);
    assert.equal(app.memory.listArtifacts("workspace_version").length, before + 1);
    const adopted = app.foundation.read().adopted!;
    assert.equal((adopted.content.concepts as unknown[]).length, 1);
    assert.deepEqual(Object.keys(adopted.content.documentVersions as object).sort(), [sources[0].id, sources[3].id].sort());
    assert.equal((adopted.content.evidence as any[]).some(e => e.sourceId === sources[1].id || e.sourceId === sources[2].id), false);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

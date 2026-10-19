import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { sourceSummary } from "../../src/agent/source-summary.ts";

test("all pages share source counts, CSV aliases are deduplicated and history is paged over HTTP", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-source-summary-"));
  const service = await createServer({ directory, automaticApi: false });
  service.server.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => service.server.once("listening", resolve));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const headers = { "x-dataengine-token": service.adminToken };
  try {
    const workspace = new Workspace(service.app.memory);
    const csv = workspace.upload("tasks.csv", "id,title\nT1,交付\nT2,验收\n");
    workspace.upload("说明.md", "项目交付说明");
    service.app.memory.putArtifact({ kind: "source", title: "飞书知识", status: "ready", content: { origin: "feishu", format: "text", raw: "飞书资料" } });
    service.app.live.sources.connectUpload(csv.id, csv.version, "id");
    const response = await fetch(`${base}/api/sources/summary`, { headers });
    assert.equal(response.status, 200);
    const summary = await response.json() as any;
    assert.equal(summary.total, 3);
    assert.deepEqual(summary.counts, { table: 1, document: 2, metric: 0 });
    assert.equal(summary.sources.find((s: any) => s.title === "tasks.csv").protocol, "file");
    assert.equal(summary.sources.find((s: any) => s.title === "飞书知识").protocol, "feishu");
    for (const page of ["setup", "ontology", "consumption"]) {
      const state = await (await fetch(`${base}/api/canvas?page=${page}`, { headers })).json() as any;
      assert.deepEqual(state.sourceSummary, summary);
    }
    await service.app.canvasNavigate({ page: "setup" });
    const progress = service.app.memory.getCanvas()!;
    const task = service.app.memory.createTask("历史分页");
    service.app.memory.saveCanvas({ ...progress, taskIds: { ...progress.taskIds, setup: task.id } });
    for (let i = 0; i < 61; i++) service.app.memory.addMessage(task.id, "user", `第 ${i} 条`, `history-${i}`);
    service.app.memory.trimMessages(task.id);
    const state = await (await fetch(`${base}/api/canvas?page=setup`, { headers })).json() as any;
    assert.equal(state.messages.length, 40);
    const older = await (await fetch(`${base}/api/canvas/messages?page=setup&before=${state.messagePage.nextBefore}`, { headers })).json() as any;
    assert.equal(older.messages.length, 21);
    assert.equal(older.messages[0].content, "第 0 条");
    assert.equal(older.nextBefore, null);
    assert.equal((await fetch(`${base}/api/canvas/messages?page=setup&before=missing`, { headers })).status, 404);
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("source data cutoff is the adopted snapshot time while a new structure awaits confirmation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-source-cutoff-"));
  const service = await createServer({ directory, automaticApi: false });
  try {
    const workspace = new Workspace(service.app.memory);
    const csv = workspace.upload("tasks.csv", "id,title\nT1,交付\n");
    await service.app.snapshots.sync({ operationId: "first" });
    const dataset = service.app.snapshots.datasets()[0];
    const active = service.app.memory.getArtifact(String(dataset.content.activeVersion));
    workspace.upload("tasks.csv", "id,title,new_field\nT1,交付,新结构\n");
    await service.app.snapshots.sync({ operationId: "pending" });
    const pending = service.app.snapshots.datasets()[0];
    assert(pending.content.pendingVersion);
    assert.notEqual(pending.content.lastSync, active.content.syncedAt);
    const summary = sourceSummary(service.app.memory).sources.find(s => s.id === csv.id)!;
    assert.equal(summary.status, "pending_structure");
    assert.equal(summary.dataAsOf, active.content.syncedAt);
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

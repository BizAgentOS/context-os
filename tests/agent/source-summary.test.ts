import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {createServer as httpServer} from 'node:http';
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
    const session = service.app.memory.createSession("历史分页");
    const task = service.app.memory.getTask(session.taskId);
    for (let i = 0; i < 61; i++) service.app.memory.addMessage(task.id, "user", `第 ${i} 条`, `history-${i}`);
    service.app.memory.trimMessages(task.id);
    const state = await (await fetch(`${base}/api/canvas?page=setup&sessionId=${session.id}`, { headers })).json() as any;
    assert.equal(state.messages.length, 40);
    const older = await (await fetch(`${base}/api/sessions/${session.id}/messages?before=${state.messagePage.nextBefore}`, { headers })).json() as any;
    assert.equal(older.messages.length, 21);
    assert.equal(older.messages[0].content, "第 0 条");
    assert.equal(older.nextBefore, null);
    assert.equal((await fetch(`${base}/api/sessions/${session.id}/messages?before=missing`, { headers })).status, 404);
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a failed synchronization remains a source problem while the prior snapshot cutoff and data stay readable',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ade-source-failure-')),service=await createServer({directory,automaticApi:false});let denied=false;
 const upstream=httpServer((request,response)=>{response.setHeader('content-type','application/json');response.statusCode=denied?401:200;response.end(JSON.stringify(denied?{error:'credential expired'}:{items:[{id:'T1',title:'已采用数据'}],total:1}));});
 await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 try{
  const source=await service.app.live.sources.connect({name:'任务API',protocol:'http',url:`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,capabilities:[{name:'tasks',path:'/',fields:['id','title'],idField:'id',idType:'string',totalPath:'total'}]});
  await service.app.snapshots.sync({operationId:'source-first'});const before=sourceSummary(service.app.memory).sources.find(item=>item.id===source.id)!;
  denied=true;await service.app.snapshots.sync({operationId:'source-denied'});
  const current=sourceSummary(service.app.memory).sources.find(item=>item.id===source.id)!;
  assert.equal(current.status,'unavailable');assert.equal(current.dataAsOf,before.dataAsOf);assert.equal((current as any).problems.length,1);
  assert.equal((await service.app.snapshots.preview({datasetId:service.app.snapshots.datasets()[0].id})).rows[0].title,'已采用数据');
 }finally{await service.close();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});}
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

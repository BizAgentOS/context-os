import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentApplication } from "../../src/agent/app.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";
import { providers } from "../../src/agent/runtime.ts";
import { createServer as createAppServer } from "../../src/agent/server.ts";

async function fixture() {
  let broken = false, emptySales = false, block: Promise<void> | undefined, entered: (() => void) | undefined, modelCalls = 0;
  const server = createServer(async (req, res) => {
    entered?.(); if (block) await block;
    res.setHeader("content-type", "application/json");
    if (broken) {res.writeHead(503).end(); return;}
    const url = new URL(req.url!, "http://localhost");
    const rows = url.pathname === "/sales" ? (emptySales ? [] : [{id: "SALE1", name: "销售记录", company: "测试企业"}]) : [{id: "STORE1", name: "东城店", company: "测试企业"}];
    const filtered = rows.filter(row => !url.searchParams.has("id") || row.id === url.searchParams.get("id"));
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 20);
    res.end(JSON.stringify({items: filtered.slice(offset, offset + limit), total: filtered.length}));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = mkdtempSync(join(tmpdir(), "ade-auto-api-program-"));
  const driver: AgentDriver = {async run() {modelCalls++; throw new Error("程序构建不应调用模型");}, async stop() {}, async close() {}};
  const app = new AgentApplication(directory, driver);
  const config = {name: "门店 API", protocol: "http", url: `http://127.0.0.1:${(server.address() as {port:number}).port}`,
    capabilities: [{name: "stores", path: "/stores", fields: ["id", "name", "company"], idField: "id", filters: {id: "id"}, totalPath: "total"}]};
  return {app, config, directory, driver, calls: () => modelCalls, breakSource: () => {broken = true;}, restoreSource: () => {broken = false;}, emptySales: () => {emptySales = true;},
    pause() {let release!: () => void; const started = new Promise<void>(resolve => {entered = resolve;}); block = new Promise<void>(resolve => {release = resolve;}); return {started, release: () => {block = undefined; entered = undefined; release();}};},
    async close() {await app.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, {recursive: true, force: true});} };
}

test("API connection automatically builds queryable objects without a model loop or publication", async () => {
  const f = await fixture();
  try {
    await f.app.live.sources.connect(f.config); await f.app.idle();
    const state = f.app.canvasState("ontology");
    assert.equal(state.automaticApiBuild.status, "completed", JSON.stringify(state.automaticApiBuild));
    assert.equal(f.calls(), 0);
    const model = state.live.models.find(item => item.status === "adopted")!;
    const type = (model.content.types as any[])[0];
    const query = await f.app.live.query({modelId: model.id, conceptId: type.conceptId});
    assert.equal(query.items[0].name, "东城店");
    assert.equal((state.foundation.adopted!.content.concepts as any[])[0].mappingStatus, "bound");
    assert.equal(state.live.consumers.length, 0);
    assert.equal(f.app.memory.listArtifacts("ontology_dataset").length, 0);
  } finally {await f.close();}
});

test("a multi-capability connection reads all capabilities and never adopts a partially empty source", async () => {
  const f = await fixture();
  try {
    f.emptySales();
    await f.app.live.sources.connect({...f.config, capabilities: [...f.config.capabilities, {...f.config.capabilities[0], name: "sales", path: "/sales"}]});
    await f.app.idle();
    assert.equal(f.app.canvasState().automaticApiBuild.status, "failed");
    assert.equal(f.app.canvasState().live.models.filter(model => model.status === "adopted").length, 0);
    assert.equal(f.app.foundation.read().adopted, null);
    assert.equal(f.calls(), 0);
  } finally {await f.close();}
});

test("unavailable sources fail honestly and an explicit retry re-reads them without a model", async () => {
  const f = await fixture();
  try {
    f.breakSource(); await f.app.live.sources.connect(f.config); await f.app.idle();
    assert.equal(f.app.canvasState().automaticApiBuild.status, "failed");
    assert.equal(f.app.foundation.read().adopted, null);
    assert.match(f.app.canvasState().automaticApiBuild.errors[0].message, /来源读取失败/);
    f.restoreSource(); f.app.retryAutomaticBuild(); await f.app.idle();
    assert.equal(f.app.canvasState().automaticApiBuild.status, "completed");
    assert.equal(f.calls(), 0);
  } finally {await f.close();}
});

test("revoking a connection during its actual read prevents late adoption", async () => {
  const f = await fixture(), paused = f.pause();
  try {
    const source = await f.app.live.sources.connect(f.config); await paused.started;
    f.app.live.sources.disable(source.id, source.version); paused.release(); await f.app.idle();
    assert.equal(f.app.foundation.read().adopted, null);
    assert.equal(f.app.canvasState().live.models.filter(model => model.status === "adopted").length, 0);
    assert.equal(f.app.canvasState().automaticApiBuild.total, 0);
  } finally {paused.release(); await f.close();}
});

test("stopping the host execution rejects the late result even when the source stays authorized", async () => {
  const f = await fixture(), paused = f.pause();
  try {
    await f.app.live.sources.connect(f.config); await paused.started;
    const stopping = f.app.canvasStop({page: "ontology"}); paused.release(); await stopping; await f.app.idle();
    assert.equal(f.app.foundation.read().adopted, null);
    assert.equal(f.app.canvasState().live.models.filter(model => model.status === "adopted").length, 0);
  } finally {paused.release(); await f.close();}
});

test("all nonempty capabilities are mapped and later sources preserve the earlier mapping", async () => {
  const f = await fixture();
  try {
    const first = await f.app.live.sources.connect({...f.config, capabilities: [...f.config.capabilities, {...f.config.capabilities[0], name: "sales", path: "/sales"}]});
    await f.app.idle();
    let current = f.app.canvasState().live.models.find(model => model.status === "adopted")!;
    assert.equal((current.content.types as any[]).length, 2);
    const original = (current.content.types as any[]).find(type => type.sourceId === first.id && type.capability === "stores");
    const foundation = f.app.foundation.read().adopted!;
    const candidate = await f.app.live.propose({foundationRef: {id: foundation.id, version: foundation.version}, baseModelRef: {id: current.id, version: current.version},
      purpose: "保留人工映射", rationale: "业务字段用人工名称", types: (current.content.types as any[]).map(type => type === original ? {...type, fields: {门店名称: "name"}} : type), relations: []});
    await f.app.live.adopt(candidate.id, candidate.version);
    await f.app.live.sources.connect({...f.config, name: "第二个来源"}); await f.app.idle();
    current = f.app.canvasState().live.models.find(model => model.status === "adopted")!;
    const preserved = (current.content.types as any[]).find(type => type.conceptId === original.conceptId);
    assert.deepEqual(preserved.fields, {门店名称: "name"});
    assert.equal((current.content.types as any[]).length, 3);
    assert.equal(f.app.canvasState().automaticApiBuild.completed, 2);
    assert.equal(f.calls(), 0);
  } finally {await f.close();}
});

test("source queue reports pending foundation review without automatically adopting an Agent proposal", async () => {
  const f = await fixture();
  try {
    await f.app.live.sources.connect(f.config); await f.app.idle();
    const adopted = f.app.foundation.read().adopted!;
    const task = f.app.memory.createTask("待审核修订"), message = f.app.memory.addMessage(task.id, "user", "门店联系人还没有数据，先记为待补充并保存候选。");
    const context = f.app.memory.beginExecution(task.id);
    const repair = f.app.foundation.propose({baseVersion: adopted.version, enterprise: adopted.content.enterprise,
      concepts: [], relations: [], evidence: [{id: "repair", messageId: message.id, quote: message.content}],
      unknowns: [{id: "contact", description: "门店联系人尚无来源数据", evidenceRefs: ["repair"]}], conflicts: []}, context, "repair", "fixture-skill");
    f.app.memory.endExecution(context);
    await f.app.live.sources.connect({...f.config, name: "补充来源"}); await f.app.idle();
    assert.deepEqual(f.app.foundation.read().current, repair);
    assert.deepEqual(f.app.foundation.read().adopted, adopted);
    const state = f.app.canvasState();
    assert.equal(state.automaticApiBuild.status, "failed");
    assert.match(state.automaticApiBuild.errors[0].message, /尚未采用.*用户明确采用/);
    assert.equal(f.app.programBuilds.overview().candidate!.status, "checked");
    assert.equal(f.calls(), 0);
  } finally {await f.close();}
});

test("HTTP and CSV management endpoints construct without model credentials and preserve results across restart", async () => {
  const variables = Object.values(providers), saved = new Map(variables.map(key => [key, process.env[key]]));
  for (const key of variables) delete process.env[key];
  const directory = mkdtempSync(join(tmpdir(), "ade-no-model-build-"));
  const upstream = createServer((_req, res) => {res.setHeader("content-type", "application/json"); res.end(JSON.stringify({items: [{id: "API1", name: "接口对象"}], total: 1}));});
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  let service = await createAppServer({directory});
  const listen = async () => {
    await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(service.server.address() as {port:number}).port}`;
    return async (path: string, body: unknown) => {
      const response = await fetch(url + path, {method: "POST", headers: {"content-type": "application/json", "x-dataengine-token": service.adminToken}, body: JSON.stringify(body)});
      const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result;
    };
  };
  try {
    let post = await listen();
    assert.equal(service.app.model().configured, false);
    await post("/api/live/connect", {name: "无模型 API", protocol: "http", url: `http://127.0.0.1:${(upstream.address() as {port:number}).port}`,
      capabilities: [{name: "records", path: "/records", fields: ["id", "name"], idField: "id", filters: {id: "id"}, totalPath: "total"}]});
    await service.app.idle();
    assert.equal(service.app.canvasState().automaticApiBuild.status, "completed");
    await post("/api/canvas/upload", {page: "setup", name: "供应商.csv", content: "编号,名称\nSUP1,上传对象\n"});
    await service.app.idle();
    const state = service.app.canvasState();
    assert.equal(state.automaticApiBuild.completed, 2);
    assert.equal(state.automaticBuild.total, 0, "CSV no longer queues model construction");
    const model = state.live.models.find(item => item.status === "adopted")!;
    assert.equal((model.content.types as any[]).length, 2);
    const stableId = model.id;
    await service.close();
    service = await createAppServer({directory}); post = await listen(); await service.app.idle();
    assert.equal(service.app.model().configured, false);
    assert.equal(service.app.canvasState().live.models.find(item => item.status === "adopted")!.id, stableId);
    assert.equal(service.app.canvasState().automaticApiBuild.completed, 2);
  } finally {
    await service.close(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    rmSync(directory, {recursive: true, force: true});
    for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

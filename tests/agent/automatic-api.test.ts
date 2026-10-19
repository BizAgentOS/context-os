import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { AgentApplication } from "../../src/agent/app.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";
import { providers } from "../../src/agent/runtime.ts";
import { createServer as createAppServer } from "../../src/agent/server.ts";

async function fixture() {
  let broken = false, emptySales = false, block: Promise<void> | undefined, entered: (() => void) | undefined, modelCalls = 0, reads = 0, failAt: number | undefined;
  const server = createServer(async (req, res) => {
    if (++reads === failAt) broken = true;
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
  return {app, config, directory, driver, calls: () => modelCalls, breakSource: () => {broken = true;}, restoreSource: () => {broken = false; failAt = undefined;}, failAfterReads: (count: number) => { failAt = reads + count; }, emptySales: () => {emptySales = true;},
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

test("an adopted wording revision preserves layered bindings while showing current meaning and unresolved business conflicts", async () => {
  const f = await fixture();
  try {
    await f.app.live.sources.connect(f.config); await f.app.idle();
    const before = f.app.foundation.read().adopted!, oldModel = f.app.live.overview().models.find(item => item.status === "adopted")!;
    const concept = (before.content.concepts as any[])[0];
    const task = f.app.memory.createTask("补充门店业务说明"), message = f.app.memory.addMessage(task.id, "user", "门店是销售服务网点。营业状态在资料和系统间尚不一致，需要保留双方依据。");
    const context = f.app.memory.beginExecution(task.id);
    const candidate = f.app.foundation.propose({ baseVersion: before.version, enterprise: before.content.enterprise,
      concepts: [{ id: concept.id, name: "门店", description: "销售服务网点。", evidenceRefs: ["business-context"] }], relations: [],
      evidence: [{ id: "business-context", messageId: message.id, quote: message.content }], unknowns: [],
      conflicts: [{ id: "operating-status", description: "营业状态在资料和系统间不一致。", evidenceRefs: ["business-context"] }],
    }, context, "business-context", "test-method", undefined, { lockStructure: true });
    const revised = f.app.foundation.adopt(candidate.id, candidate.version, { automatic: true });
    f.app.memory.endExecution(context);
    const builds = f.app.programBuilds.overview().jobs.length;
    f.app.startAutomaticBuild(); await f.app.idle();

    assert.equal(f.app.canvasState().automaticApiBuild.status, "completed", JSON.stringify(f.app.canvasState().automaticApiBuild));
    assert.deepEqual(f.app.foundation.read().adopted, revised, "rebinding must not revise or resolve the adopted foundation");
    assert.equal(f.app.programBuilds.overview().jobs.length, builds, "rebinding must not run structural discovery again");
    const model = f.app.live.overview().models.find(item => item.status === "adopted")!;
    assert.equal(model.id, oldModel.id);
    assert.equal(model.version, oldModel.version, "wording changes must not create an execution model revision");
    const layered = f.app.live.readLayered(model.id);
    assert.equal(layered.semantic.entityTypes[0].name, "门店");
    assert.equal(layered.semantic.entityTypes[0].description, "销售服务网点。");
    assert.deepEqual(layered.bindings, f.app.live.readLayered(oldModel.id, oldModel.version).bindings);
    assert.equal((f.app.foundation.view().adopted!.content.concepts as any[])[0].mappingStatus, "bound");
    assert.equal((await f.app.live.query({ modelId: model.id, conceptId: concept.id })).items[0].name, "东城店");
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test("a description-only foundation adoption creates no background rebind run", async () => {
  const f = await fixture();
  try {
    await f.app.live.sources.connect(f.config); await f.app.idle();
    const before=f.app.foundation.read().adopted!, concept=(before.content.concepts as any[])[0];
    const model=f.app.live.overview().models.find(item=>item.status==="adopted")!;
    const bindings=f.app.live.readLayered(model.id).bindings;
    const jobs=f.app.memory.listArtifacts("api_build"), tasks=f.app.memory.listTasks().map(task=>task.id);
    const task=f.app.memory.createTask("仅补充门店说明"), message=f.app.memory.addMessage(task.id,"user","门店表示实际提供销售服务的网点。");
    const context=f.app.memory.beginExecution(task.id);
    try {
      const candidate=f.app.foundation.propose({baseVersion:before.version,enterprise:before.content.enterprise,
        concepts:[{id:concept.id,name:concept.name,description:"实际提供销售服务的网点。",evidenceRefs:["description"]}],relations:[],
        evidence:[{id:"description",messageId:message.id,quote:message.content}],unknowns:[],conflicts:[]},context,"description","test-method",undefined,{lockStructure:true});
      f.app.foundation.adopt(candidate.id,candidate.version,{automatic:true});
    } finally {f.app.memory.endExecution(context);}
    f.app.startAutomaticBuild();await f.app.idle();
    assert.deepEqual(f.app.memory.listArtifacts("api_build"),jobs,"no queued, running or completed job revision was created");
    assert.deepEqual(f.app.memory.listTasks().map(item=>item.id),[task.id,...tasks],"no background task was created");
    assert.equal(f.app.memory.getArtifact(model.id).version,model.version);
    assert.deepEqual(f.app.live.readLayered(model.id).bindings,bindings);
    assert.equal(f.app.live.readLayered(model.id).semantic.entityTypes[0].description,"实际提供销售服务的网点。");
    assert.equal((await f.app.live.query({modelId:model.id,conceptId:concept.id})).items[0].name,"东城店");
    assert.equal(f.calls(),0);
  } finally {await f.close();}
});

test("a pending foundation candidate still blocks automatic rebinding after a layered wording adoption", async () => {
  const f=await fixture();
  try {
    await f.app.live.sources.connect(f.config);await f.app.idle();
    const before=f.app.foundation.read().adopted!,concept=(before.content.concepts as any[])[0];
    const model=f.app.live.overview().models.find(item=>item.status==="adopted")!;
    const task=f.app.memory.createTask("先采用说明，再保留待审补充"),message=f.app.memory.addMessage(task.id,"user","门店为销售网点，联系人范围尚待核对。");
    const context=f.app.memory.beginExecution(task.id);
    let candidate;
    try {
      const wording=f.app.foundation.propose({baseVersion:before.version,enterprise:before.content.enterprise,
        concepts:[{id:concept.id,name:concept.name,description:"销售网点。",evidenceRefs:["wording"]}],relations:[],
        evidence:[{id:"wording",messageId:message.id,quote:message.content}],unknowns:[],conflicts:[]},context,"wording","test-method",undefined,{lockStructure:true});
      const adopted=f.app.foundation.adopt(wording.id,wording.version,{automatic:true});
      candidate=f.app.foundation.propose({baseVersion:adopted.version,enterprise:adopted.content.enterprise,concepts:[],relations:[],
        evidence:[{id:"pending",messageId:message.id,quote:message.content}],unknowns:[{id:"contacts",description:"联系人范围尚待核对。",evidenceRefs:["pending"]}],conflicts:[]},context,"pending","test-method",undefined,{lockStructure:true});
    } finally {f.app.memory.endExecution(context);}
    f.app.startAutomaticBuild();await f.app.idle();
    assert.deepEqual(f.app.foundation.read().current,candidate);
    assert.equal(f.app.live.overview().models.find(item=>item.status==="adopted")!.id,model.id);
    assert.equal(f.app.memory.getArtifact(model.id).version,model.version);
    assert.equal(f.app.canvasState().automaticApiBuild.status,"failed");
    assert.match(f.app.canvasState().automaticApiBuild.errors[0].message,/本体或执行映射已变化/);
  } finally {await f.close();}
});

/** These regressions exercise pre-040 artifacts. Restore their historical
 * representation directly in the fixture, preserving the exact model ID and
 * version; product writes never remove layered data or rewrite history. */
function restoreLegacyModelFixture(app: AgentApplication, directory: string) {
  const active = app.live.overview().models.find(item => item.status === "adopted")!;
  const historical = app.memory.getArtifact(active.id, active.version);
  delete historical.content.layered;
  const database = new DatabaseSync(join(directory, "memory.sqlite"));
  try { database.prepare("UPDATE artifacts SET body=? WHERE id=? AND version=?").run(JSON.stringify(historical), historical.id, historical.version); }
  finally { database.close(); }
}

function adoptBusinessConflict(app: AgentApplication, directory: string) {
  restoreLegacyModelFixture(app, directory);
  const before = app.foundation.read().adopted!;
  const task = app.memory.createTask("记录业务口径差异"), message = app.memory.addMessage(task.id, "user", "系统中的营业状态和资料描述不一致，保留双方依据待核对。");
  const context = app.memory.beginExecution(task.id);
  try {
    const candidate = app.foundation.propose({ baseVersion: before.version, enterprise: before.content.enterprise, concepts: [], relations: [],
      evidence: [{ id: "status-conflict", messageId: message.id, quote: message.content }], unknowns: [],
      conflicts: [{ id: "status-conflict", description: "营业状态来源不一致。", evidenceRefs: ["status-conflict"] }],
    }, context, "status-conflict", "test-method", undefined, { lockStructure: true });
    return app.foundation.adopt(candidate.id, candidate.version, { automatic: true });
  } finally { app.memory.endExecution(context); }
}

test("a failed rebind runs once per baseline, preserves other completed sources, and explicit retry recovers", async () => {
  const f = await fixture();
  try {
    await f.app.live.sources.connect(f.config); await f.app.idle();
    await f.app.live.sources.connect({ ...f.config, name: "另一业务来源" }); await f.app.idle();
    const revised = adoptBusinessConflict(f.app, f.directory);
    const builds = f.app.programBuilds.overview().jobs.length;
    f.breakSource(); f.app.startAutomaticBuild(); await f.app.idle();
    const failed = f.app.canvasState().automaticApiBuild;
    assert.equal(failed.completed, 1);
    assert.equal(failed.errors.length, 1);
    const jobs = f.app.memory.listArtifacts("api_build");
    f.app.startAutomaticBuild(); await f.app.idle();
    f.app.startAutomaticBuild(); await f.app.idle();
    assert.deepEqual(f.app.memory.listArtifacts("api_build"), jobs, "the same failed baseline must not consume another completed source");
    f.restoreSource(); f.app.retryAutomaticBuild(); await f.app.idle();
    assert.equal(f.app.canvasState().automaticApiBuild.completed, 2);
    assert.equal(f.app.canvasState().automaticApiBuild.status, "completed");
    assert.deepEqual(f.app.foundation.read().adopted, revised);
    assert.equal(f.app.programBuilds.overview().jobs.length, builds);
  } finally { await f.close(); }
});

test("retry recovers persisted rebind-only failures for all still-mapped sources without rediscovery", async () => {
  const f = await fixture();
  try {
    await f.app.live.sources.connect(f.config); await f.app.idle();
    await f.app.live.sources.connect({ ...f.config, name: "另一业务来源" }); await f.app.idle();
    const revised = adoptBusinessConflict(f.app, f.directory), builds = f.app.programBuilds.overview().jobs.length;
    // The pre-fix queue persisted this state after trying each completed source in turn.
    for (const job of f.app.memory.listArtifacts("api_build")) f.app.memory.putArtifact({ ...job, expectedVersion: job.version, status: "failed",
      content: { ...job.content, rebindOnly: true, error: "现有工作版本存在未解决冲突，请通过助手修复后再采用" } });
    f.app.retryAutomaticBuild(); await f.app.idle();
    assert.equal(f.app.canvasState().automaticApiBuild.completed, 2);
    assert.equal(f.app.canvasState().automaticApiBuild.status, "completed");
    assert.deepEqual(f.app.foundation.read().adopted, revised);
    assert.equal(f.app.programBuilds.overview().jobs.length, builds);
    assert.equal(f.app.memory.listArtifacts("api_build").filter(job => job.status === "running").length, 0);
  } finally { await f.close(); }
});

test("rebind preserves a usable pending mapping and full structural rebuilds still reject unresolved conflicts", async () => {
  const f = await fixture();
  try {
    await f.app.live.sources.connect(f.config); await f.app.idle();
    const revised = adoptBusinessConflict(f.app, f.directory);
    const model = f.app.live.overview().models.find(item => item.status === "adopted")!;
    const pending = await f.app.live.propose({ foundationRef: { id: revised.id, version: revised.version }, baseModelRef: { id: model.id, version: model.version },
      purpose: "人工待审映射", rationale: "采用前保留原映射", types: model.content.types, relations: model.content.relations });
    f.app.startAutomaticBuild(); await f.app.idle();
    assert.match(f.app.canvasState().automaticApiBuild.errors[0].message, /待采用的执行映射/);
    assert.equal(f.app.live.candidate(pending.id, pending.version).id, pending.id);
    assert.equal(f.app.live.overview().models.find(item => item.status === "adopted")!.id, model.id);
    const full = await f.app.programBuilds.build({ operationId: "full-with-conflict", autoAdopt: true });
    assert.notEqual(full.content.outcome, "adopted");
    assert.match(String((f.app.programBuilds.overview().candidate!.content.checks as any).description), /未解决冲突/);
    assert.deepEqual(f.app.foundation.read().adopted, revised);
  } finally { await f.close(); }
});

test("a rebind whose final source read fails discards only its own candidate and retries after recovery", async () => {
  const f = await fixture();
  try {
    await f.app.live.sources.connect(f.config); await f.app.idle();
    const revised = adoptBusinessConflict(f.app, f.directory);
    f.failAfterReads(2); // Preparing the mapping succeeds; the adoption reread fails.
    f.app.startAutomaticBuild(); await f.app.idle();
    assert.equal(f.app.canvasState().automaticApiBuild.status, "failed");
    assert.equal(f.app.live.overview().models.filter(item => item.status === "discarded").length, 1);
    assert.equal(f.app.live.overview().models.filter(item => item.status === "candidate").length, 0);
    f.restoreSource(); f.app.retryAutomaticBuild(); await f.app.idle();
    assert.equal(f.app.canvasState().automaticApiBuild.status, "completed");
    assert.deepEqual(f.app.foundation.read().adopted, revised);
  } finally { await f.close(); }
});

test("automatic rebinding rejects an adopted structural change instead of extending the old mapping", async () => {
  const f = await fixture();
  try {
    await f.app.live.sources.connect(f.config); await f.app.idle();
    const before = f.app.foundation.read().adopted!, model = f.app.live.overview().models.find(item => item.status === "adopted")!;
    const task = f.app.memory.createTask("历史结构修订"), message = f.app.memory.addMessage(task.id, "user", "人员和门店是两个独立概念。");
    const context = f.app.memory.beginExecution(task.id);
    try {
      const candidate = f.app.foundation.propose({ baseVersion: before.version, enterprise: before.content.enterprise,
        concepts: [{ id: "separate-person", name: "人员", description: "独立的人员记录。", evidenceRefs: ["structure"] }], relations: [],
        evidence: [{ id: "structure", messageId: message.id, quote: message.content }], unknowns: [], conflicts: [],
      }, context, "structure", "test-method");
      f.app.foundation.adopt(candidate.id, candidate.version);
    } finally { f.app.memory.endExecution(context); }
    f.app.startAutomaticBuild(); await f.app.idle();
    assert.equal(f.app.canvasState().automaticApiBuild.status, "failed");
    assert.match(f.app.canvasState().automaticApiBuild.errors[0].message, /结构已变化/);
    assert.equal(f.app.live.overview().models.find(item => item.status === "adopted")!.id, model.id);
  } finally { await f.close(); }
});

test("rebind coordination follows a narrowed adopted model and never completes a source it no longer covers", async () => {
  const f = await fixture();
  try {
    const retainedSource = await f.app.live.sources.connect(f.config); await f.app.idle();
    const removedSource = await f.app.live.sources.connect({ ...f.config, name: "销售来源", capabilities: [{ ...f.config.capabilities[0], name: "sales", path: "/sales" }] });
    await f.app.idle();
    const model = f.app.live.overview().models.find(item => item.status === "adopted")!;
    const smaller = await f.app.live.propose({ foundationRef: model.content.foundationRef, baseModelRef: { id: model.id, version: model.version },
      purpose: "仅保留门店", rationale: "缩小执行范围", types: (model.content.types as any[]).filter(type => type.sourceId === retainedSource.id), relations: [] });
    await f.app.live.adopt(smaller.id, smaller.version);
    const revised = adoptBusinessConflict(f.app, f.directory);
    f.app.startAutomaticBuild(); await f.app.idle();
    const rebound = f.app.live.overview().models.find(item => item.status === "adopted")!;
    assert.deepEqual(rebound.content.foundationRef, { id: revised.id, version: revised.version });
    assert.equal((rebound.content.types as any[]).length, 1);
    assert.equal(f.app.memory.listArtifacts("api_build").filter(job => job.status === "running").length, 0);

    const oldJob = f.app.memory.listArtifacts("api_build").find(job => job.content.sourceId === removedSource.id)!;
    f.app.memory.putArtifact({ ...oldJob, expectedVersion: oldJob.version, status: "failed", content: { ...oldJob.content, rebindOnly: true } });
    f.app.retryAutomaticBuild(); await f.app.idle();
    const retried = f.app.memory.getArtifact(oldJob.id);
    assert.equal(retried.status, "failed");
    assert.match(String(retried.content.error), /未映射/);
    assert.equal(f.app.live.overview().models.find(item => item.status === "adopted")!.id, rebound.id);
  } finally { await f.close(); }
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

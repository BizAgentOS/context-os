import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentApplication } from "../../src/agent/app.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";

const outcome = { text: "完成", sessionId: "automatic-api", runId: "automatic-api" };
const mappingDriver = (after?: () => Promise<void>): AgentDriver => ({
  async run(request) {
    const input = JSON.parse(request.input);
    assert.equal(input.mode, "automatic-api-ontology");
    assert(!request.tools.some(t => t.name === "task_ask"));
    const source = input.source;
    const receipt = await request.onTool("foundation_api_read", { sourceId: source.id, capability: "stores" }) as any;
    let foundation = (await request.onTool("foundation_read", {}) as any).adopted;
    if (!foundation) {
      foundation = await request.onTool("foundation_propose", {
        baseVersion: 0, enterprise: { name: "澄川仓配", evidenceRefs: ["api-store"] },
        concepts: [{id: "store", name: "门店", description: "收货地点", evidenceRefs: ["api-store"]}], relations: [],
        evidence: [{id: "api-store", kind: "api", readId: receipt.readId, quote: '"company":"澄川仓配"'}], unknowns: [], conflicts: [],
      });
    }
    const live = await request.onTool("live_overview", {}) as any;
    const base = live.models.find((m: any) => m.status === "adopted");
    const concept = foundation.content.concepts.find((c: any) => c.id === "store");
    await request.onTool("live_propose", {
      foundationRef: {id: foundation.id, version: foundation.version}, baseModelRef: base ? {id: base.id, version: base.version} : null,
      purpose: "门店 API 自动本体化", types: [{conceptId: concept.id, name: concept.name, description: concept.description, sourceId: source.id, capability: "stores", fields: {名称: "name"}}],
      relations: [], rationale: "使用真实门店记录和稳定 ID 对应门店概念。",
    });
    await after?.();
    return outcome;
  }, async stop() {}, async close() {},
});

async function fixture(driver: AgentDriver = mappingDriver()) {
  let broken = false, supplementChanged = false;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (broken) { res.writeHead(503).end(); return; }
    const url = new URL(req.url!, "http://localhost");
    const id = (url.pathname === "/different" || (url.pathname === "/supplement" && supplementChanged)) ? "S02" : "S01";
    const items = !url.searchParams.has("id") || url.searchParams.get("id") === id ? [{id, name: "东城店", company: "澄川仓配"}] : [];
    res.end(JSON.stringify({items, total: items.length}));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = mkdtempSync(join(tmpdir(), "de-automatic-api-"));
  const app = new AgentApplication(directory, driver);
  const config = {name: "门店 API", protocol: "http", url: `http://127.0.0.1:${(server.address() as {port: number}).port}`, capabilities: [{name: "stores", path: "/stores", fields: ["id", "name", "company"], idField: "id", filters: {id: "id"}, totalPath: "total"}]};
  return {app, config, directory, changeSupplement: () => {supplementChanged = true;}, breakSource: () => {broken = true;}, restoreSource: () => {broken = false;}, async close() {try {await app.close();} catch {} await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, {recursive: true, force: true});}};
}

test("connecting an API automatically builds grounded concepts and queryable mappings without confirmation", async () => {
  const f = await fixture();
  try {
    await f.app.live.sources.connect(f.config);
    await f.app.idle();
    const state = f.app.canvasState("ontology");
    assert.equal(state.foundation.adopted?.status, "adopted");
    assert.equal((state.foundation.adopted?.content.concepts as any[])[0].mappingStatus, "bound");
    const model = state.live.models.find(m => m.status === "adopted")!;
    const result = await f.app.live.query({modelId: model.id, conceptId: "store"});
    assert.equal(result.items[0].名称, "东城店");
    assert.equal(state.pending, null);
    assert.equal((state as any).automaticApiBuild.status, "completed");
    assert.equal(state.automaticBuild.total, 0);
    const evidence = (state.foundation.adopted!.content.evidence as any[])[0];
    const located = f.app.foundation.evidence(state.foundation.adopted!.id, state.foundation.adopted!.version, evidence.id);
    assert.match(JSON.stringify(located), /澄川仓配/);
    assert.equal(state.live.consumers.length, 0);
  } finally {await f.close();}
});

test("unavailable API reports failure without adoption, then explicit retry builds it", async () => {
  const f = await fixture();
  try {
    f.breakSource();
    await f.app.live.sources.connect(f.config); await f.app.idle();
    assert.equal(f.app.canvasState().automaticApiBuild.status, "failed");
    assert.equal(f.app.canvasState().live.models.filter(m => m.status === "adopted").length, 0);
    assert.match(f.app.canvasState().automaticApiBuild.errors[0].message, /来源读取失败/);
    f.restoreSource(); f.app.retryAutomaticBuild(); await f.app.idle();
    assert.equal(f.app.canvasState().automaticApiBuild.status, "completed");
  } finally {await f.close();}
});

test("disabling an API during a run rejects late mapping adoption", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const f = await fixture(mappingDriver(async () => {entered(); await new Promise<void>(resolve => {release = resolve;});}));
  try {
    const source = await f.app.live.sources.connect(f.config); await started;
    f.app.live.sources.disable(source.id, source.version); release(); await f.app.idle();
    assert.equal(f.app.canvasState().live.models.filter(m => m.status === "adopted").length, 0);
    assert.equal(f.app.canvasState().automaticApiBuild.total, 0);
  } finally {release?.(); await f.close();}
});

test("a connection with an unprocessed capability cannot be marked completed", async () => {
  const f = await fixture();
  try {
    await f.app.live.sources.connect({...f.config, capabilities: [...f.config.capabilities, {...f.config.capabilities[0], name: "sales", path: "/sales"}]});
    await f.app.idle();
    assert.equal(f.app.canvasState().automaticApiBuild.status, "failed");
    assert.match(f.app.canvasState().automaticApiBuild.errors[0].message, /每个记录能力/);
    assert.equal(f.app.canvasState().live.models.filter(m => m.status === "adopted").length, 0);
  } finally {await f.close();}
});

test("a later document rebuild refreshes the API mapping onto the new foundation version", async () => {
  const api = mappingDriver();
  const f = await fixture({...api, async run(request) {
    if (JSON.parse(request.input).mode !== "automatic-document-ontology") return api.run(request);
    const source = JSON.parse(request.input).sources[0];
    const receipt = await request.onTool("foundation_document_read", {sourceId: source.id}) as any;
    const prior = await request.onTool("foundation_read", {}) as any;
    await request.onTool("foundation_propose", {baseVersion: prior.current.version, enterprise: prior.current.content.enterprise,
      concepts: [{id: "warehouse", name: "仓库", description: "储存货物的地点", evidenceRefs: ["new-doc"]}], relations: [],
      evidence: [{id: "new-doc", kind: "document", readId: receipt.readId, quote: receipt.text}], unknowns: [], conflicts: []});
    return outcome;
  }});
  try {
    await f.app.live.sources.connect(f.config); await f.app.idle();
    const priorVersion = f.app.canvasState().foundation.adopted!.version;
    await f.app.canvasUpload({page: "setup", name: "仓库.md", content: "澄川仓配的仓库存储货物。"}); await f.app.idle();
    const state = f.app.canvasState();
    assert(state.foundation.adopted!.version > priorVersion);
    assert.equal(state.automaticApiBuild.status, "completed", JSON.stringify(state.automaticApiBuild));
    assert.equal((state.foundation.adopted!.content.concepts as any[]).find(c => c.id === "store").mappingStatus, "bound");
    assert.equal((state.foundation.adopted!.content.concepts as any[]).find(c => c.id === "warehouse").mappingStatus, "unbound");
    const model = state.live.models.find(m => m.status === "adopted")!;
    assert.equal((await f.app.live.query({modelId: model.id, conceptId: "store"})).items[0].名称, "东城店");
  } finally {await f.close();}
});

test("API jobs wait for a model and resume after restarting, without reconnecting sources", async () => {
  const key = process.env.DEEPSEEK_API_KEY; delete process.env.DEEPSEEK_API_KEY;
  const f = await fixture();
  let queued: AgentApplication | undefined, resumed: AgentApplication | undefined;
  try {
    await f.app.close();
    queued = new AgentApplication(f.directory);
    await queued.live.sources.connect(f.config);
    assert.equal(queued.canvasState().automaticApiBuild.status, "waiting_model");
    await queued.close(); queued = undefined;
    resumed = new AgentApplication(f.directory, mappingDriver()); await resumed.idle();
    assert.equal(resumed.canvasState().automaticApiBuild.status, "completed");
    assert.equal(resumed.canvasState().live.connections.length, 1);
  } finally {
    await queued?.close(); await resumed?.close(); await f.close();
    if (key === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = key;
  }
});

for (const mode of ["unique", "missing", "drift"]) test(`another API supplement validates ${mode} matches before completion`, async () => {
  const initial = mappingDriver();
  const f = await fixture({...initial, async run(request) {
    const input = JSON.parse(request.input);
    if (input.source.title !== "补充 API") return initial.run(request);
    await request.onTool("foundation_api_read", {sourceId: input.source.id, capability: "stores"});
    const foundation = (await request.onTool("foundation_read", {}) as any).adopted;
    const base = (await request.onTool("live_overview", {}) as any).models.find((m: any) => m.status === "adopted");
    await request.onTool("live_propose", {foundationRef: {id: foundation.id, version: foundation.version}, baseModelRef: {id: base.id, version: base.version}, purpose: "补充门店资料", rationale: "按相同门店身份键匹配名称", types: [{...base.content.types[0], supplements: [{name: "secondary", sourceId: input.source.id, capability: "stores", match: {primaryField: "$id", sourceField: "id"}, fields: {补充名称: "name"}, rationale: "同一门店 ID 精确匹配"}]}], relations: []});
    if (mode === "drift") f.changeSupplement();
    return outcome;
  }});
  try {
    const primary = await f.app.live.sources.connect(f.config); await f.app.idle();
    await f.app.live.sources.connect({...f.config, name: "补充 API", capabilities: f.config.capabilities.map(cap => ({...cap, path: mode === "missing" ? "/different" : "/supplement"}))}); await f.app.idle();
    const state = f.app.canvasState();
    if (mode !== "unique") {
      assert.equal(state.automaticApiBuild.status, "failed");
      assert.equal(state.automaticApiBuild.completed, 1);
      assert.match(state.automaticApiBuild.errors[0].message, /唯一匹配/);
      return;
    }
    assert.equal(state.automaticApiBuild.completed, 2, JSON.stringify(state.automaticApiBuild));
    const model = state.live.models.find(m => m.status === "adopted")!;
    assert.equal((model.content.types as any[])[0].sourceId, primary.id);
    const result = await f.app.live.query({modelId: model.id, conceptId: "store"});
    assert.equal(result.items[0].名称, "东城店");
    assert.equal(result.items[0].补充名称, "东城店");
  } finally {await f.close();}
});

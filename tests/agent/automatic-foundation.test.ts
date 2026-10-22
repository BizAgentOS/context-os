import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentApplication } from "../../src/agent/app.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";

const meaning = (foundation: any) => (foundation.content.concepts as any[]).map(c => [c.id, c.description, c.evidenceRefs]);

// Documents enrich structure the data program built; they never add concepts.
const seedStore = (app: AgentApplication) => seedFoundation(app.memory, app.foundation,
  { enterprise: "澄川仓配", concepts: [{ id: "store", name: "门店", description: "来自门店表的记录，业务含义待核对。" }], program: true });

test("an uploaded document enriches the program-built concept and is adopted without a confirmation", async () => {
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
        baseVersion: current.current.version,
        enterprise: current.current.content.enterprise,
        concepts: [{ id: "store", name: "门店", description: "收货地点", evidenceRefs: ["doc1"] }], relations: [],
        evidence: [{ id: "doc1", kind: "document", readId: part.readId, quote: "澄川仓配的门店负责收货。" }], unknowns: [], conflicts: [],
      });
      return { text: "生成完成", sessionId: "auto", runId: "auto" };
    }, async stop() {}, async close() {},
  };
  const app = new AgentApplication(directory, driver);
  try {
    seedStore(app);
    await app.canvasUpload({ page: "setup", name: "仓配.md", content: "澄川仓配的门店负责收货。" });
    await app.idle();
    const state = app.canvasState("ontology");
    assert.equal(state.foundation.current?.status, "adopted");
    assert.equal(state.foundation.current?.content.automatic, true);
    const concepts = state.foundation.current?.content.concepts as any[];
    assert.equal(concepts.length, 1, "the document adds no concept");
    assert.equal(concepts[0].description, "收货地点");
    assert.equal(concepts[0].origin, "program");
    assert.equal(state.pending, null);
    assert.equal(state.automaticBuild.status, "completed");
    assert.equal(state.automaticBuild.completed, 1);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

const buildDriver = (after?: () => Promise<void>): AgentDriver => ({
  async run(request) {
    const input = JSON.parse(request.input);
    const before = await request.onTool("foundation_read", {}) as any;
    const evidence: any[] = [];
    for (const source of input.sources) {
      const part = await request.onTool("foundation_document_read", { sourceId: source.id, version: source.version }) as any;
      evidence.push({ id: `doc-${source.id}-${before.current.version}`, kind: "document", readId: part.readId, quote: part.text });
    }
    const prior = (before.current.content.concepts as any[]).find(c => c.id === "store");
    await request.onTool("foundation_propose", { baseVersion: before.current.version, enterprise: before.current.content.enterprise,
      concepts: [{ id: "store", name: "门店", description: "资料描述的业务概念", evidenceRefs: [...prior.evidenceRefs, ...evidence.map(e => e.id)] }],
      relations: [], evidence, unknowns: [], conflicts: [] });
    await after?.();
    return { text: "完成", sessionId: "batch", runId: "batch" };
  }, async stop() {}, async close() {},
});

test("text and Feishu documents wait for a model across restart while CSV identity issues stay in the program queue", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-auto-queue-"));
  const key = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  let app = new AgentApplication(directory);
  try {
    const seeded = seedStore(app);
    await app.canvasUpload({ page: "setup", name: "仓配.md", content: "澄川仓配的门店负责收货。" });
    await app.canvasUpload({ page: "setup", name: "清单.csv", content: "company,type\n澄川仓配,门店\n" });
    app.capabilities.feishu.readDocument = async (url: string) => ({provider: "feishu", documentId: "auto-doc", title: "补货.md", url, revision: null, contentHash: undefined, format: "markdown", content: "澄川仓配的仓库负责补货。", readAt: new Date().toISOString(), coverage: "file"});
    await app.capabilities.feishuDocuments!.read("https://example.feishu.cn/wiki/example");
    assert.equal(app.canvasState().automaticBuild.status, "waiting_model");
    assert.equal(app.canvasState().automaticBuild.pending, 2);
    await app.idle();
    assert.equal(app.canvasState().automaticApiBuild.status, "failed");
    assert.match(app.canvasState().automaticApiBuild.errors[0].message, /身份键/);
    assert.equal(app.canvasState().foundation.current!.version, seeded.version, "a failed CSV build leaves the structure as it was");
    await app.close();
    app = new AgentApplication(directory, buildDriver());
    await app.idle();
    const state = app.canvasState("ontology");
    assert.equal(state.automaticBuild.completed, 2);
    assert.equal(state.automaticBuild.status, "completed", JSON.stringify(state.automaticBuild));
    assert.equal(Object.keys(state.foundation.current!.content.documentVersions as object).length, 2);
    assert.equal(state.automaticApiBuild.status, "failed", "model document work does not fabricate a CSV identity");
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
    seedStore(app);
    await app.canvasUpload({page: "setup", name: "第一份.md", content: "澄川仓配的门店负责收货。"});
    await started;
    await app.canvasNavigate({page: "ontology"});
    assert.equal(app.canvasState().automaticBuild.status, "running");
    await app.canvasUpload({page: "ontology", name: "第二份.md", content: "澄川仓配的仓库负责补货。"});
    release(); await app.idle();
    const state = app.canvasState("ontology");
    assert.equal(state.currentPage, "ontology");
    assert.equal(state.automaticBuild.completed, 2, JSON.stringify(state.automaticBuild));
    assert.equal((state.foundation.current!.content.concepts as any[]).length, 1, "documents add evidence, not concepts");
    assert.equal((state.foundation.current!.content.concepts as any[])[0].evidenceRefs.length, 3);
  } finally { release?.(); await app.close(); rmSync(directory, {recursive: true, force: true}); }
});

test("a failed build exposes its reason and retries without adoption confirmation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-auto-retry-"));
  let fail = true;
  const driver = buildDriver(async () => { if (fail) throw new Error("测试模型不可用"); });
  const app = new AgentApplication(directory, driver);
  try {
    const seeded = seedStore(app);
    await app.canvasUpload({page: "setup", name: "仓配.md", content: "澄川仓配的门店负责收货。"});
    await app.idle();
    assert.equal(app.canvasState().automaticBuild.status, "failed");
    assert.match(app.canvasState().automaticBuild.errors[0].message, /模型不可用/);
    assert.deepEqual(meaning(app.canvasState().foundation.adopted), meaning(seeded));
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
    const seeded = seedStore(app);
    await app.canvasUpload({page: "setup", name: "仓配.md", content: "澄川仓配的门店负责收货。"});
    await started;
    const source = app.canvasState().sources[0];
    await app.removeUpload({id: source.id, version: source.version,operationId:"remove-upload",acknowledgeImpact:true});
    await app.idle();
    assert.equal(app.canvasState().sources.length, 0);
    assert.deepEqual(meaning(app.canvasState().foundation.adopted), meaning(seeded), "the late result is not adopted");
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
    seedStore(app);
    await app.canvasUpload({page: "setup", name: "第一份.md", content: "澄川仓配的门店负责收货。"});
    await app.idle();
    const source = app.canvasState().sources[0];
    await app.removeUpload({id: source.id, version: source.version,operationId:"remove-upload",acknowledgeImpact:true});
    await app.canvasUpload({page: "setup", name: "第二份.md", content: "澄川仓配的仓库负责补货。"});
    await app.idle();
    const state = app.canvasState();
    assert.equal(state.automaticBuild.status, "completed", JSON.stringify(state.automaticBuild));
    assert.equal(state.automaticBuild.completed, 1);
    assert.equal(state.sources.length, 1);
    assert.equal(state.foundation.current?.status, "adopted");
    assert.equal((state.foundation.current!.content.evidence as any[]).length, 3, "the seed and both documents keep their evidence");
  } finally { await app.close(); rmSync(directory, {recursive: true, force: true}); }
});

test("saving and testing a model connection happens before queued automatic construction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-auto-connect-"));
  const key = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  const app = new AgentApplication(directory);
  let tested = false;
  try {
    seedStore(app);
    await app.canvasUpload({page: "setup", name: "仓配.md", content: "澄川仓配的门店负责收货。"});
    const driver = buildDriver();
    const run:AgentDriver["run"] = async request => {
      if (request.title === "模型连接检查") { tested = true; return {text: "连接成功", sessionId: "test", runId: "test"}; }
      assert(tested); return driver.run(request);
    };
    app.driver.run=run;
    app.driver.fork=()=>({run,async stop(){},async close(){}});
    const settings = await app.configure({provider: "deepseek", model: "test", apiKey: "test-only-local-key", testConnection: true});
    assert.equal(settings.connection?.ok, true);
    await app.idle();
    assert.equal(app.canvasState().automaticBuild.status, "completed");
  } finally { await app.close(); if (key === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = key; rmSync(directory, {recursive: true, force: true}); }
});

test("automatic documents page the real semantic catalog without whole-foundation tool output", {timeout: 15000}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-auto-catalog-"));
  let toolError: unknown, pages = 0;
  const driver: AgentDriver = {
    async run(request) {
      try {
        assert.deepEqual(request.tools.map(tool => tool.name).sort(), ["foundation_document_read", "foundation_propose", "foundation_read"]);
        await assert.rejects(request.onTool("memory_read", {id:"foundation"}), /仅允许/);
        const input = JSON.parse(request.input), source = input.sources[0], ids: string[] = [];
        let offset: number | null = 0, latest: any;
        do {
          const page = await request.onTool("foundation_read", {section:"concepts",offset,limit:10}) as any;
          assert(JSON.stringify(page).length < 12000, "a model tool reply must fit before runtime truncation");
          assert.equal(page.adopted, undefined, "do not duplicate the full adopted foundation");
          assert.equal(page.page.total, 25);
          ids.push(...page.current.content.concepts.map((item:any)=>item.id));
          latest=page; offset=page.page.nextOffset; pages++;
        } while(offset !== null);
        assert.deepEqual(ids,Array.from({length:25},(_,i)=>`store${i}`));
        const props = await request.onTool("foundation_read", {section:"properties",offset:0,limit:10}) as any;
        assert.deepEqual(props.current.content.properties.map((item:any)=>[item.id,item.entityTypeId]),[["store24_address","store24"]]);
        const rels = await request.onTool("foundation_read", {section:"relations",offset:0,limit:10}) as any;
        assert.deepEqual(rels.current.content.relations.map((item:any)=>[item.id,item.from,item.to]),[["delivery","store0","store24"]]);
        const part = await request.onTool("foundation_document_read",{sourceId:source.id,version:source.version}) as any;
        const saved = await request.onTool("foundation_propose",{baseVersion:latest.current.version,enterprise:latest.current.content.enterprise,
          concepts:[{id:"store24",name:"门店24",description:"末页门店负责收货",evidenceRefs:["last-page-doc"]}],relations:[],
          evidence:[{id:"last-page-doc",kind:"document",readId:part.readId,quote:part.text}],unknowns:[],conflicts:[]}) as any;
        assert(JSON.stringify(saved).length<3000,"proposal returns a receipt, not the whole foundation");
        return {text:"完成",sessionId:"catalog",runId:"catalog"};
      } catch(error) {toolError=error;throw error;}
    }, async stop(){},async close(){},
  };
  const app=new AgentApplication(directory,driver);
  try {
    const seeded=seedFoundation(app.memory,app.foundation,{enterprise:"分页仓配",concepts:Array.from({length:25},(_,i)=>({id:`store${i}`,name:`门店${i}`,description:"完整业务说明".repeat(200)})),relations:[{id:"delivery",name:"调拨至",description:"已确认调拨关系",from:"store0",to:"store24"}]});
    app.memory.putArtifact({...seeded,expectedVersion:seeded.version,content:{...seeded.content,properties:[{id:"store24_address",entityTypeId:"store24",name:"地址",valueType:"string",description:"实际门店地址"}]}});
    await app.canvasUpload({page:"ontology",name:"末页门店.md",content:"分页仓配的末页门店负责收货。"});await app.idle();
    if(toolError) throw toolError;
    assert(pages>1);
    assert.equal(app.canvasState().automaticBuild.status,"completed");
    const current=app.foundation.read().current!;
    assert.equal((current.content.concepts as any[]).length,25);
    assert.equal((current.content.concepts as any[]).find(item=>item.id==="store24").description,"末页门店负责收货");
    assert.equal((current.content.relations as any[]).length,1);
    assert.equal((current.content.properties as any[])[0].id,"store24_address");
  } finally {await app.close();rmSync(directory,{recursive:true,force:true});}
});

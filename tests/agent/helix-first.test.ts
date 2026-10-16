import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentApplication } from "../../src/agent/app.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";
import { MemoryStore } from "../../src/agent/memory.ts";
import { FoundationService } from "../../src/agent/foundation.ts";
import { LiveMemory } from "../../src/live/memory.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { Snapshots } from "../../src/data/snapshots.ts";
import { ProgramBuilds } from "../../src/engine/program-builds.ts";
import { validateDefinition } from "../../src/engine/validation.ts";

const people = "employee_no,name,team_id\nE1,王晨,T1\nE2,李琪,T1\nE3,高远,T2\n";
const teams = "team_id,team_name\nT1,研发组\nT2,平台组\n";
const document = "研发组负责 FlowPilot 的交付。";

/** Records the order of model runs; a document run only enriches an existing program concept. */
function enrichingDriver(log: string[], app: () => AgentApplication) {
  return {
    async run(request) {
      log.push(`model:api=${app().canvasState().automaticApiBuild.status}`);
      const input = JSON.parse(request.input);
      const current = (await request.onTool("foundation_read", {}) as any).current;
      const source = input.sources[0];
      const part = await request.onTool("foundation_document_read", { sourceId: source.id, version: source.version }) as any;
      const concept = (current.content.concepts as any[]).find(c => c.origin === "program");
      await request.onTool("foundation_propose", { baseVersion: current.version, enterprise: current.content.enterprise,
        concepts: [{ id: concept.id, name: concept.name, description: "研发组负责 FlowPilot 的交付。", evidenceRefs: ["doc"] }], relations: [],
        evidence: [{ id: "doc", kind: "document", readId: part.readId, quote: "研发组负责 FlowPilot 的交付。" }], unknowns: [], conflicts: [] });
      return { text: "完成", sessionId: "doc", runId: "doc" };
    }, async stop() {}, async close() {},
  } satisfies AgentDriver;
}

test("structured uploads are built by the program before queued documents, which then only enrich its concepts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-helix-first-"));
  const log: string[] = [];
  let app!: AgentApplication;
  app = new AgentApplication(directory, enrichingDriver(log, () => app));
  try {
    await app.canvasUpload({ page: "setup", name: "说明.md", content: document });
    assert.equal(app.canvasState().automaticBuild.status, "waiting_data", "documents wait for structured data");
    await app.idle();
    assert.deepEqual(log, [], "nothing to enrich yet, so the model is not called");
    await app.canvasUpload({ page: "setup", name: "teams.csv", content: teams });
    await app.idle();
    assert.deepEqual(log, ["model:api=completed"], "the program build finishes before the document run starts");
    const state = app.canvasState("ontology");
    assert.equal(state.automaticBuild.status, "completed");
    const concepts = state.foundation.current!.content.concepts as any[];
    assert.equal(concepts.length, 1, "the document added no concept");
    assert.equal(concepts[0].origin, "program", "enrichment keeps program provenance");
    assert.equal(concepts[0].description, "研发组负责 FlowPilot 的交付。");
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("the assistant and documents cannot add concepts or move relation endpoints", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-helix-lock-"));
  const memory = new MemoryStore(directory), live = new LiveMemory(directory, memory), foundation = new FoundationService(memory, live);
  const snapshots = new Snapshots(memory, live, directory), engine = new ProgramBuilds(memory, foundation, live, snapshots);
  try {
    const workspace = new Workspace(memory);
    workspace.upload("people.csv", people); workspace.upload("teams.csv", teams);
    assert.equal((await engine.build({ operationId: "build", autoAdopt: true })).content.outcome, "adopted");
    const adopted = foundation.read().adopted!;
    const { id, name, from, to, description } = (adopted.content.relations as any[])[0];
    const relation = { id, name, from, to, description };
    const task = memory.createTask("修订"), message = memory.addMessage(task.id, "user", "增加客户概念。");
    const context = memory.beginExecution(task.id);
    const propose = (change: { concepts?: any[]; relations?: any[] }, id: string) => foundation.propose({ baseVersion: adopted.version,
      enterprise: adopted.content.enterprise, concepts: change.concepts ?? [], relations: change.relations ?? [],
      evidence: [{ id: "said", messageId: message.id, quote: message.content }], unknowns: [], conflicts: [] }, context, id, "skill", undefined, { lockStructure: true });
    assert.throws(() => propose({ concepts: [{ id: "customer", name: "客户", description: "客户", evidenceRefs: ["said"] }] }, "new-concept"), /由数据程序根据结构化数据构建/);
    assert.throws(() => propose({ relations: [{ ...relation, id: "new-relation", evidenceRefs: ["said"] }] }, "new-relation"), /由数据程序根据结构化数据构建/);
    assert.throws(() => propose({ relations: [{ ...relation, to: relation.from, evidenceRefs: ["said"] }] }, "moved"), /端点由数据程序的匹配结果决定/);
    const renamed = propose({ relations: [{ ...relation, name: "隶属", evidenceRefs: ["said"] }] }, "renamed");
    const kept = (renamed.content.relations as any[]).find(r => r.id === relation.id);
    assert.equal(kept.name, "隶属");
    assert.equal(kept.origin, "program");
    memory.endExecution(context);
  } finally { await engine.close(); await snapshots.close(); memory.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a revision may only use data the program processed, and a relation must match on the snapshots when proposed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-helix-scope-"));
  const memory = new MemoryStore(directory), live = new LiveMemory(directory, memory), foundation = new FoundationService(memory, live);
  const snapshots = new Snapshots(memory, live, directory), engine = new ProgramBuilds(memory, foundation, live, snapshots);
  live.snapshotCheck = definition => validateDefinition(snapshots, live, definition) as never;
  try {
    const workspace = new Workspace(memory);
    workspace.upload("people.csv", people); workspace.upload("teams.csv", teams);
    await engine.build({ operationId: "build", autoAdopt: true });
    const model = live.overview().models.find(item => item.status === "adopted")!, base = foundation.read().adopted!;
    const unseen = workspace.upload("badges.csv", "badge,employee_no\nB1,E1\n");
    const connection = live.sources.connectUpload(unseen.id, unseen.version, "badge");
    const revise = (types: any[], relations: any[]) => live.propose({ foundationRef: { id: base.id, version: base.version },
      baseModelRef: { id: model.id, version: model.version }, purpose: "修订", rationale: "测试", types, relations });
    const types = model.content.types as any[];
    const [person, team] = [types.find(t => Object.values(t.fields).includes("employee_no")), types.find(t => Object.values(t.fields).includes("team_name"))];
    const nameOf = (type: any, column: string) => Object.entries(type.fields).find(([, field]) => field === column)![0];
    const badge = { name: "工牌", sourceId: connection.id, capability: "records", match: { primaryField: nameOf(person, "employee_no"), sourceField: "employee_no" },
      fields: { 工牌号: "badge" }, rationale: "按工号附加工牌" };
    await assert.rejects(revise(types.map(t => t === person ? { ...t, supplements: [badge] } : t), model.content.relations as any[]), /不在数据程序发现的数据集中/);
    // Pointing the program's relation at the person's name instead of the team code matches nothing.
    const relations = (model.content.relations as any[]).map(r => r.from === person.name && r.to === team.name ? { ...r, fromField: nameOf(person, "name") } : r);
    assert.notDeepEqual(relations, model.content.relations);
    await assert.rejects(revise(types, relations), /全量快照上引入新的问题/);
  } finally { await engine.close(); await snapshots.close(); memory.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("an adopted foundation keeps the program discovery: merged sources, link match counts and review state per concept", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-helix-projection-"));
  const memory = new MemoryStore(directory), live = new LiveMemory(directory, memory), foundation = new FoundationService(memory, live);
  const snapshots = new Snapshots(memory, live, directory), engine = new ProgramBuilds(memory, foundation, live, snapshots);
  try {
    const workspace = new Workspace(memory);
    workspace.upload("people.csv", people); workspace.upload("teams.csv", teams);
    await engine.build({ operationId: "build", autoAdopt: true });
    // A later build keeps the adopted relation; the projection must still know which link it came from.
    workspace.upload("sites.csv", "site_id,city\nS1,杭州\n");
    assert.equal((await engine.build({ operationId: "rebuild", autoAdopt: true })).content.outcome, "adopted");
    assert.equal(engine.overview().candidate, null, "the candidate itself is no longer offered after adoption");
    const view = foundation.view().current!;
    const helix = view.content.helix as any;
    assert.deepEqual(helix.stats, { tables: 3, sources: 1, entities: 3, links: 1 });
    const concepts = view.content.concepts as any[];
    const person = concepts.find(c => c.helix?.entity.key === "employee_no")!;
    assert.equal(person.helix.entity.rows, 3);
    assert.deepEqual(person.helix.entity.members.map((m: any) => [m.datasetName, m.anchor]), [["people.csv", true]]);
    const link = person.helix.links[0];
    assert.equal(link.direction, "out");
    assert.deepEqual([link.from.column, link.to.column, link.matchedRows, link.totalRows], ["team_id", "team_id", 3, 3]);
    assert.equal(link.executable, true);
    assert.equal(link.relationId, (view.content.relations as any[])[0].id);
    const team = concepts.find(c => c.helix?.entity.key === "team_id")!;
    assert.equal(team.helix.links[0].direction, "in");
    assert.equal(team.helix.links[0].other.conceptId, person.id);
  } finally { await engine.close(); await snapshots.close(); memory.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a manual sync with new data and an accepted schema change rebuild through the program; an unchanged sync does not", async () => {
  let rows = [{ id: "S1", name: "东城店" }];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const selected = rows.filter(row => !url.searchParams.has("id") || row.id === url.searchParams.get("id"));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: selected.slice(Number(url.searchParams.get("offset") ?? 0)), total: selected.length }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = mkdtempSync(join(tmpdir(), "de-helix-sync-"));
  const driver: AgentDriver = { async run() { throw new Error("程序构建不应调用模型"); }, async stop() {}, async close() {} };
  const app = new AgentApplication(directory, driver);
  try {
    await app.live.sources.connect({ name: "门店", protocol: "http", url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      capabilities: [{ name: "stores", path: "/stores", fields: ["id", "name"], idField: "id", filters: { id: "id" }, totalPath: "total" }] });
    await app.idle();
    const builds = () => app.memory.listArtifacts("api_build").filter(job => job.status === "completed").length;
    assert.equal(builds(), 1);
    await app.snapshots.sync({ operationId: "same" }); await app.idle();
    assert.equal(builds(), 1, "unchanged data does not rebuild");
    rows = [...rows, { id: "S2", name: "西城店" }];
    await app.snapshots.sync({ operationId: "more" }); await app.idle();
    assert.equal(builds(), 2, "new data rebuilds through the program");
    assert.equal(app.canvasState().automaticApiBuild.status, "completed");
  } finally { await app.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});

test("the legacy upload endpoint sends CSV to the program build instead of a model run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-helix-legacy-"));
  let calls = 0;
  const driver: AgentDriver = { async run() { calls++; throw new Error("不应调用模型"); }, async stop() {}, async close() {} };
  const app = new AgentApplication(directory, driver);
  try {
    await app.upload({ name: "teams.csv", content: teams });
    await app.idle();
    assert.equal(app.canvasState().automaticApiBuild.status, "completed");
    assert.equal(calls, 0);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("replacing an uploaded CSV rebuilds on the new file under the same identity, and a broken identity is reported", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-helix-replace-"));
  const memory = new MemoryStore(directory), live = new LiveMemory(directory, memory), foundation = new FoundationService(memory, live);
  const snapshots = new Snapshots(memory, live, directory), engine = new ProgramBuilds(memory, foundation, live, snapshots);
  try {
    const workspace = new Workspace(memory);
    workspace.upload("people.csv", people); workspace.upload("teams.csv", teams);
    assert.equal((await engine.build({ operationId: "first", autoAdopt: true })).content.outcome, "adopted");
    const before = live.overview().models.find(item => item.status === "adopted")!;
    workspace.upload("teams.csv", teams + "T3,数据组\n");
    const rebuilt = await engine.build({ operationId: "replaced", autoAdopt: true });
    assert.equal(rebuilt.content.outcome, "adopted", JSON.stringify(rebuilt.content.issues));
    const model = live.overview().models.find(item => item.status === "adopted")!;
    const team = (model.content.types as any[]).find(t => Object.values(t.fields).includes("team_name"));
    assert.equal(team.sourceId, (before.content.types as any[]).find(t => t.conceptId === team.conceptId).sourceId, "mappings keep their connection");
    assert.equal((await live.query({ modelId: model.id, type: team.name, id: "T3" })).items.length, 1, "queries read the new file");
    workspace.upload("teams.csv", "team_id,team_name\nT1,研发组\nT1,重复\n");
    const broken = await engine.build({ operationId: "broken", autoAdopt: true });
    assert.notEqual(broken.content.outcome, "adopted");
    assert((broken.content.issues as any[]).some(issue => issue.code === "identity_unknown" && /team_id/.test(issue.message)), JSON.stringify(broken.content.issues));
  } finally { await engine.close(); await snapshots.close(); memory.close(); rmSync(directory, { recursive: true, force: true }); }
});

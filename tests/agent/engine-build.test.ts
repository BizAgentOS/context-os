import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { FoundationService } from "../../src/agent/foundation.ts";
import { LiveMemory } from "../../src/live/memory.ts";
import { ProgramBuilds } from "../../src/engine/program-builds.ts";
import { createServer } from "node:http";
import { Workspace } from "../../src/agent/workspace.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ade-engine-build-"));
  const memory = new MemoryStore(directory);
  const live = new LiveMemory(directory, memory);
  const foundation = new FoundationService(memory, live);
  const engine = new ProgramBuilds(memory, foundation, live);
  return { memory, live, foundation, engine, directory,
    close() { memory.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("an empty workspace completes honestly without inventing ontology or invoking a model", async () => {
  const f = fixture();
  try {
    const run = await f.engine.build({ operationId: "empty" });
    assert.equal(run.status, "completed");
    assert.equal(run.content.outcome, "empty");
    assert.equal(f.foundation.read().current, null);
    assert.equal(f.live.overview().models.length, 0);
    assert.equal(f.engine.overview().datasets.length, 0);
    assert.equal((await f.engine.build({ operationId: "empty" })).id, run.id);
  } finally { f.close(); }
});

test("program discovery creates a reviewable candidate and atomically adopts queryable source mappings", async () => {
  const f = fixture();
  const rows = [{ id: "CO1", name: "青山" }, { id: "CO2", name: "海川" }];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const selected = rows.filter(row => !url.searchParams.has("id") || row.id === url.searchParams.get("id"));
    res.setHeader("content-type", "application/json");
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 20);
    res.end(JSON.stringify({ items: selected.slice(offset, offset + limit), total: selected.length }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const source = await f.live.sources.connect({name: "企业目录", protocol: "http", url: `http://127.0.0.1:${(server.address() as {port:number}).port}`,
      capabilities: [{name: "companies", path: "/companies", fields: ["id", "name"], idField: "id", totalPath: "total", filters: {id: "id"}}]});
    const run = await f.engine.build({operationId: "api-build", sourceIds: [source.id], expectedFoundationVersion: 0});
    assert.equal(run.status, "completed", JSON.stringify(run.content));
    assert.equal(run.content.outcome, "candidate");
    assert.equal(f.foundation.read().current, null, "review does not alter adopted work");
    const candidate = f.engine.overview().candidate!;
    assert.equal((candidate.content.concepts as any[]).length, 1);
    assert.deepEqual(candidate.content.relations, []);
    const checked = await f.engine.check({id: candidate.id, version: candidate.version});
    assert.equal((checked.content.checks as any).valid, true);
    const result = await f.engine.adopt({id: checked.id, version: checked.version, operationId: "api-adopt"});
    assert.equal(result.foundation.status, "adopted");
    const type = (result.model.content.types as any[])[0];
    const query = await f.live.query({modelId: result.model.id, conceptId: type.conceptId, fields: ["name"]});
    assert.deepEqual(query.items.map(row => row.name), ["青山", "海川"]);
    assert.equal((await f.engine.adopt({id: checked.id, version: checked.version, operationId: "api-adopt"})).model.id, result.model.id);
    const evidence = (result.foundation.content.evidence as any[])[0];
    const located = f.foundation.evidence(result.foundation.id, result.foundation.version, evidence.id);
    assert.match(JSON.stringify(located), /青山/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); f.close(); }
});

test("uploaded CSV becomes a real local record source and replacing its bytes invalidates old mappings", async () => {
  const f = fixture();
  try {
    const upload = new Workspace(f.memory).upload("企业.csv", "企业编号,企业名称\nA001,青山\nA002,海川\n");
    const run = await f.engine.build({operationId: "csv", sourceIds: [upload.id]});
    assert.equal(run.content.outcome, "candidate", JSON.stringify(run.content));
    const candidate = f.engine.overview().candidate!;
    const checked = await f.engine.check({id: candidate.id, version: candidate.version});
    const adopted = await f.engine.adopt({id: checked.id, version: checked.version, operationId: "csv-adopt"});
    const type = (adopted.model.content.types as any[])[0];
    const objects = await f.live.query({modelId: adopted.model.id, type: type.name, id: "A002"});
    assert.equal(objects.items.length, 1);
    assert.equal(objects.items[0].企业名称, "海川");
    new Workspace(f.memory).upload("企业.csv", "企业编号,企业名称\nA001,青山更新\n");
    await assert.rejects(f.live.query({modelId: adopted.model.id, type: type.name}), /版本|更新/);
  } finally { f.close(); }
});

test("automatic adoption only changes the working ontology and preserves subsequently edited mappings", async () => {
  const f = fixture();
  try {
    new Workspace(f.memory).upload("companies.csv", "id,name\nA1,青山\nA2,海川\n");
    const first = await f.engine.build({operationId: "automatic", autoAdopt: true});
    assert.equal(first.content.outcome, "adopted", JSON.stringify(first));
    const foundation = f.foundation.read().adopted!, model = f.live.overview().models.find(item => item.status === "adopted")!;
    const type = (model.content.types as any[])[0];
    const edited = await f.live.propose({foundationRef: {id: foundation.id, version: foundation.version}, baseModelRef: {id: model.id, version: model.version},
      purpose: "人工修正字段", rationale: "保留正式业务字段名称", types: [{...type, fields: {公司名称: "name"}}], relations: []});
    await f.live.adopt(edited.id, edited.version);
    const second = await f.engine.build({operationId: "repeat", autoAdopt: true});
    assert.equal(second.content.outcome, "adopted", JSON.stringify(second));
    const current = f.live.overview().models.find(item => item.status === "adopted")!;
    assert.deepEqual((current.content.types as any[])[0].fields, {公司名称: "name"});
    assert.equal((current.content.types as any[])[0].conceptId, type.conceptId);
    assert.equal(f.memory.listArtifacts("ontology_dataset").length, 0, "adoption does not publish consumer access");
  } finally { f.close(); }
});

test("rebuilding an updated upload refreshes evidence without changing concept identity or user field aliases", async () => {
  const f = fixture();
  try {
    const workspace = new Workspace(f.memory);
    workspace.upload("companies.csv", "id,name\nA1,青山\nA2,海川\n");
    await f.engine.build({operationId: "initial", autoAdopt: true});
    const before = f.foundation.read().adopted!;
    workspace.upload("companies.csv", "id,name\nA1,青山更新\nA2,海川\nA3,新公司\n");
    const updated = await f.engine.build({operationId: "updated", autoAdopt: true});
    assert.equal(updated.content.outcome, "adopted", JSON.stringify(updated));
    const after = f.foundation.read().adopted!;
    assert.equal((after.content.concepts as any[])[0].id, (before.content.concepts as any[])[0].id);
    const current = f.live.overview().models.find(model => model.status === "adopted")!;
    const type = (current.content.types as any[])[0];
    const query = await f.live.query({modelId: current.id, type: type.name});
    assert.deepEqual(query.items.map(row => row.name), ["青山更新", "海川", "新公司"]);
  } finally { f.close(); }
});

test("automatic source refresh preserves an unadopted foundation repair until explicit adoption", async () => {
  const f = fixture();
  try {
    const workspace = new Workspace(f.memory);
    workspace.upload("companies.csv", "id,name\nA1,青山\n");
    await f.engine.build({operationId: "initial", autoAdopt: true});
    const adopted = f.foundation.read().adopted!;
    const task = f.memory.createTask("修订概念含义");
    const message = f.memory.addMessage(task.id, "user", "公司的联系人员还没有数据，先记为待补充并保存候选。");
    const context = f.memory.beginExecution(task.id);
    const repair = f.foundation.propose({baseVersion: adopted.version, enterprise: adopted.content.enterprise,
      concepts: [], relations: [], evidence: [{id: "repair", messageId: message.id, quote: message.content}],
      unknowns: [{id: "contact", description: "公司的联系人员尚无来源数据", evidenceRefs: ["repair"]}], conflicts: []}, context, "repair", "fixture-skill");
    f.memory.endExecution(context);
    workspace.upload("companies.csv", "id,name\nA1,青山更新\n");
    const refreshed = await f.engine.build({operationId: "refresh", autoAdopt: true});
    assert.equal(refreshed.content.outcome, "candidate");
    assert.deepEqual(f.foundation.read().current, repair);
    assert.deepEqual(f.foundation.read().adopted, adopted);
    assert((refreshed.content.issues as any[]).some(issue => issue.code === "pending_foundation_review"), JSON.stringify(f.engine.overview().candidate));
    const candidate = f.engine.overview().candidate!;
    assert.equal(candidate.status, "checked");
    assert(((candidate.content.foundation as any).unknowns as any[]).some(u => u.id === "contact"));
    const result = await f.engine.adopt({id: candidate.id, version: candidate.version, operationId: "explicit"});
    assert((result.foundation.content.unknowns as any[]).some(u => u.id === "contact"));
    const type = (result.model.content.types as any[])[0];
    assert.equal((await f.live.query({modelId: result.model.id, type: type.name})).items[0].name, "青山更新");
  } finally { f.close(); }
});

test("overlapping keys are review issues, integer ID coincidences never merge entities, and ambiguous CSV identity blocks adoption", async () => {
  const f = fixture();
  try {
    const workspace = new Workspace(f.memory);
    workspace.upload("companies.csv", "id,name\nCO1,青山\nCO2,海川\n");
    workspace.upload("reports.csv", "id,company_id,year\nR1,CO1,2025\nR2,CO2,2025\n");
    const run = await f.engine.build({operationId: "links"});
    assert.equal(run.content.outcome, "candidate");
    const candidate = f.engine.overview().candidate!;
    assert.equal((candidate.content.concepts as any[]).length, 2);
    assert.deepEqual(candidate.content.relations, []);
    assert((candidate.content.issues as any[]).some(issue => issue.code === "relationship_candidate"));
    const checked = await f.engine.check({id: candidate.id, version: candidate.version});
    const updated = workspace.upload("companies.csv", "id,name\nCO1,青山\nCO1,重复编号\n");
    await assert.rejects(f.engine.adopt({id: checked.id, version: checked.version, operationId: "stale"}), /来源版本/);
    const invalid = await f.engine.build({operationId: "invalid", sourceIds: [updated.id], autoAdopt: true});
    assert.notEqual(invalid.content.outcome, "adopted");
    assert((invalid.content.issues as any[]).some(issue => issue.code === "identity_unknown"));
    assert.equal(f.foundation.read().adopted, null);
  } finally { f.close(); }
});

test("start exposes a durable job and cancellation prevents late source responses from producing a candidate", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (_req, res) => {
    entered(); await blocked;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({items: [{id: "1", name: "等待中的来源"}], total: 1}));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const source = await f.live.sources.connect({name: "慢来源", protocol: "http", url: `http://127.0.0.1:${(server.address() as {port:number}).port}`,
      capabilities: [{name: "records", path: "/records", fields: ["id", "name"], idField: "id", filters: {id: "id"}, totalPath: "total"}]});
    const job = f.engine.start({operationId: "cancel", sourceIds: [source.id], autoAdopt: true});
    assert.equal(job.status, "queued");
    await started;
    const running = f.engine.overview().jobs[0];
    assert.equal(running.status, "running");
    f.engine.cancel({id: running.id, version: running.version}); release(); await f.engine.idle();
    assert.equal(f.engine.overview().jobs[0].status, "cancelled");
    assert.equal(f.engine.overview().candidate, null);
    assert.equal(f.foundation.read().adopted, null);
  } finally {release(); await f.engine.close(); await new Promise<void>(resolve => server.close(() => resolve())); f.close();}
});

test("a stopped host execution cannot adopt late results, and persisted queued jobs recover as interrupted", async () => {
  const f = fixture();
  try {
    new Workspace(f.memory).upload("companies.csv", "id,name\nA1,青山\n");
    let active = true;
    const job = f.engine.start({operationId: "host-stop", autoAdopt: true}, () => {if (!active) throw new Error("执行已停止");});
    active = false;
    await f.engine.idle();
    assert.equal(f.engine.overview().jobs[0].status, "failed");
    assert.equal(f.foundation.read().adopted, null);
    f.memory.putArtifact({kind: "engine_build", title: "重启前任务", status: "running", content: {operationId: "restart", steps: [], issues: []}});
    const restarted = new ProgramBuilds(f.memory, f.foundation, f.live);
    assert.equal(restarted.overview().jobs[0].status, "interrupted");
    assert.equal(f.memory.getArtifact(job.id).status, "failed");
  } finally { f.close(); }
});

test("rebuilding a supplemental source preserves the fusion rule and its unresolved conflicting values", async () => {
  const f = fixture();
  try {
    const workspace = new Workspace(f.memory);
    const primary = workspace.upload("companies.csv", "id,name\nCO1,青山\nCO2,海川\n");
    await f.engine.build({operationId: "primary", sourceIds: [primary.id], autoAdopt: true});
    const secondary = workspace.upload("crm.csv", "id,name\nCO1,青山集团\nCO2,海川集团\n");
    // Data reaches mappings through the program first; the manual fusion then refines what it found.
    await f.engine.build({operationId: "crm-seen", sourceIds: [secondary.id]});
    const connection = f.live.sources.connectUpload(secondary.id, secondary.version, "id");
    const foundation = f.foundation.read().adopted!, model = f.live.overview().models.find(item => item.status === "adopted")!;
    const type = (model.content.types as any[])[0];
    const supplement = {name: "CRM补充", sourceId: connection.id, capability: "records", match: {primaryField: "$id", sourceField: "id"}, fields: {name: "name"}, rationale: "相同企业编号，仅附加来源并保留冲突"};
    const edited = await f.live.propose({foundationRef: {id: foundation.id, version: foundation.version}, baseModelRef: {id: model.id, version: model.version},
      purpose: "人工融合", rationale: "保留两个来源的冲突", types: [{...type, supplements: [supplement]}], relations: []});
    await f.live.adopt(edited.id, edited.version);
    const rebuilt = await f.engine.build({operationId: "supplement-refresh", sourceIds: [secondary.id], autoAdopt: true});
    assert.equal(rebuilt.content.outcome, "adopted", JSON.stringify(rebuilt));
    const current = f.live.overview().models.find(item => item.status === "adopted")!;
    assert.equal((current.content.types as any[]).length, 1);
    assert.deepEqual((current.content.types as any[])[0].supplements, [supplement]);
    const result = await f.live.query({modelId: current.id, type: type.name, fields: ["name"]});
    assert.equal(result.items[0].name, null);
    assert.equal(result.evidence?.[0].properties.name.status, "conflict");
  } finally { f.close(); }
});

test("CSV field names cannot collide with adapter pagination or filtering parameters", async () => {
  const f = fixture();
  try {
    const file = new Workspace(f.memory).upload("limits.csv", "id,limit,offset,__ade_limit\nA1,高,东,甲\nA2,低,西,乙\n");
    const source = f.live.sources.connectUpload(file.id, file.version, "id");
    const page = await f.live.sources.readRecords(source.id, "records", {}, 0, 100);
    assert.equal(page.items.length, 2);
    const filtered = await f.live.sources.readRecords(source.id, "records", {limit: "低", offset: "西", __ade_limit: "乙"}, 0, 1);
    assert.equal(filtered.items[0].id, "A2");
  } finally { f.close(); }
});

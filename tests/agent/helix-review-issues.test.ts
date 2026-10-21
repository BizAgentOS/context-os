import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { FoundationService } from "../../src/agent/foundation.ts";
import { FoundationDocuments } from "../../src/agent/foundation-evidence.ts";
import { LiveMemory } from "../../src/live/memory.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { Snapshots } from "../../src/data/snapshots.ts";
import { ProgramBuilds } from "../../src/engine/program-builds.ts";
import { Releases } from "../../src/engine/releases.ts";
import { OntologyDatasets } from "../../src/live/ontology-datasets.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";
import { discoverFromSnapshots } from "../../src/engine/snapshot-discovery.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ade-discovery-review-"));
  const memory = new MemoryStore(directory), live = new LiveMemory(directory, memory), foundation = new FoundationService(memory, live);
  const snapshots = new Snapshots(memory, live, directory), engine = new ProgramBuilds(memory, foundation, live, snapshots);
  return { memory, live, foundation, snapshots, engine, workspace: new Workspace(memory),
    discover: () => discoverFromSnapshots(snapshots, id => { try { return memory.getArtifact(id); } catch { return undefined; } }),
    async close() { await engine.close(); await snapshots.close(); memory.close(); rmSync(directory, { recursive: true, force: true }); } };
}

const people = "employee_id,email,contact,status\nE1,a@example.test,addr-a,active\nE2,b@example.test,addr-b,active\nE3,c@example.test,addr-c,active\nE4,d@example.test,addr-d,inactive\n";
const users = "user_id,email,address,status\nU1,A@example.test,addr-a,active\nU2,b@example.test,addr-b,active\nU3,c@example.test,addr-c,active\nU4,d@example.test,addr-d,inactive\n";

test("ordinary text and email overlap becomes a per-concept review without merging identities or adding relations", async () => {
  const f = fixture();
  try {
    f.workspace.upload("employees.csv", people); f.workspace.upload("users.csv", users);
    const job = await f.engine.build({ operationId: "build", autoAdopt: true });
    assert.equal(job.content.outcome, "adopted", JSON.stringify(job.content.issues));
    const view = f.foundation.view().current!, concepts = view.content.concepts as any[];
    assert.equal(concepts.length, 2);
    assert.equal((view.content.relations as any[]).length, 0);
    assert(concepts.every(c => c.helix.entity.members.length === 1));
    const issues = job.content.issues as any[];
    const overlap = issues.filter(issue => issue.code === "possible_identity_overlap");
    assert.equal(overlap.length, 2, "deduplicates symmetric column pairs; low-cardinality status is not a lead");
    const mail = overlap.find(i => i.details.from.column === "email");
    assert(mail);
    assert.deepEqual([mail.details.matchedRows, mail.details.totalRows, mail.details.matchedDistinct], [4, 4, 4]);
    assert.equal(mail.details.caseInsensitive, true);
    assert.match(mail.message, /不证明同一身份/);
    assert(overlap.some(i => new Set([i.details.from.column, i.details.to.column]).has("contact")));
    for (const c of concepts) {
      assert.equal(c.helix.issues.filter((i: any) => i.code === "possible_identity_overlap").length, 2);
      const name = c.helix.issues.find((i: any) => i.code === "entity_name_review");
      assert(name);
      assert.deepEqual(name.details.concepts, [c.id], "the naming task points at the stable concept identity");
      assert.match(name.message, /只修正该概念的名称与说明/);
    }
    // A user-provided Chinese name is retained by the next program build and no longer flagged.
    const current = f.foundation.read().current!, c = (current.content.concepts as any[])[0];
    const task = f.memory.createTask("确认业务名称"), message = f.memory.addMessage(task.id, "user", `将 ${c.name} 命名为员工档案。`);
    const context = f.memory.beginExecution(task.id);
    const named = f.foundation.propose({ baseVersion: current.version, enterprise: current.content.enterprise,
      concepts: [{ id: c.id, name: "员工档案", description: c.description, evidenceRefs: ["name"] }], relations: [],
      evidence: [{ id: "name", messageId: message.id, quote: message.content }], unknowns: [], conflicts: [] }, context, "name", "skill", undefined, { lockStructure: true });
    f.foundation.adopt(named.id, named.version); f.memory.endExecution(context);
    const immediate = (f.foundation.view().current!.content.concepts as any[]).find(x => x.id === c.id);
    assert(!immediate.helix.issues.some((i: any) => i.code === "entity_name_review"), "a confirmed rename clears the stale review before another build");
    const rebuilt = await f.engine.build({ operationId: "rebuild", autoAdopt: true });
    assert.equal(rebuilt.content.outcome, "adopted", JSON.stringify(rebuilt.content.issues));
    const renamed = (f.foundation.view().current!.content.concepts as any[]).find(x => x.id === c.id);
    assert.equal(renamed.name, "员工档案");
    assert(!renamed.helix.issues.some((i: any) => i.code === "entity_name_review"));
  } finally { await f.close(); }
});

test("a shared email across independent source systems is only a review lead", async () => {
  const f = fixture();
  const rows = Array.from({ length: 4 }, (_, i) => ({ user_id: `U${i}`, email: `${String.fromCharCode(97 + i)}@example.test` }));
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const selected = rows.filter(row => !url.searchParams.has("user_id") || row.user_id === url.searchParams.get("user_id"));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: selected.slice(Number(url.searchParams.get("offset") ?? 0)), total: selected.length }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    f.workspace.upload("employees.csv", people);
    await f.live.sources.connect({ name: "项目系统", protocol: "http", url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      capabilities: [{ name: "users", path: "/users", fields: ["user_id", "email"], idField: "user_id", filters: { user_id: "user_id" }, totalPath: "total" }] });
    await f.snapshots.sync({ operationId: "sync" });
    const found = await f.discover();
    assert.equal(found.entities.length, 2);
    assert(found.entities.every(e => e.members.length === 1));
    assert.equal(found.links.length, 0);
    assert.equal(found.reviews!.filter(r => r.kind === "value_overlap").length, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});

function chain(f: ReturnType<typeof fixture>, diverged: boolean) {
  f.workspace.upload("accounts.csv", "account_id,name\n" + Array.from({ length: 10 }, (_, i) => `ac${i},n${i}`).join("\n") + "\n");
  f.workspace.upload("subscriptions.csv", "subscription_id,account_id\n" + Array.from({ length: 20 }, (_, i) => `sb${i},ac${i % 10}`).join("\n") + "\n");
  f.workspace.upload("invoices.csv", "invoice_id,subscription_id,account_id\n" + Array.from({ length: 40 }, (_, i) => `in${i},sb${i % 20},ac${diverged && i < 10 ? (i + 1) % 10 : i % 10}`).join("\n") + "\n");
}

test("deprecation proposals retain the direct link, verified path and row counts in the review projection", async () => {
  const f = fixture();
  try {
    chain(f, false);
    const job = await f.engine.build({ operationId: "build", autoAdopt: true });
    assert.equal(job.content.outcome, "adopted", JSON.stringify(job.content.issues));
    const issue = (job.content.issues as any[]).find(i => i.code === "relationship_deprecation");
    assert(issue, JSON.stringify(job.content.issues));
    assert.deepEqual([issue.details.from.datasetName, issue.details.to.datasetName], ["invoices.csv", "accounts.csv"]);
    assert.deepEqual([issue.details.matchedRows, issue.details.totalRows], [40, 40]);
    assert.deepEqual(issue.details.path.map((c: any) => c.column), ["subscription_id", "subscription_id", "account_id", "account_id"]);
    const view = f.foundation.view().current!;
    assert.equal((view.content.relations as any[]).length, 0, "all discovered relationships await explicit adoption");
    assert.equal((f.memory.listArtifacts("engine_candidate")[0].content.discovery as any).links.length, 3, "the direct edge remains discoverable");
    assert((view.content.concepts as any[]).every(c => c.helix.issues.some((i: any) => i.code === "relationship_deprecation")), "both endpoints and the intermediate entity show the actual review");
    assert.match(issue.message, /数据吻合不代表业务关系含义相同/);
  } finally { await f.close(); }
});

test("a path that fails row comparison is retained and never reported as pruned", async () => {
  const f = fixture();
  try {
    chain(f, true);
    await f.snapshots.sync({ operationId: "sync" });
    const found = await f.discover();
    assert.equal(found.links.length, 3);
    assert(!found.reviews!.some(r => r.kind === "implied_link"));
  } finally { await f.close(); }
});


test("rebuilding a legacy workspace replaces interpreted structure only in the new version and keeps published readers", async () => {
  const f = fixture(), ref = (a: { id: string; version: number }) => ({ id: a.id, version: a.version });
  try {
    const old = seedFoundation(f.memory, f.foundation, { enterprise: "历史投研工作区", program: false,
      concepts: [{ id: "specific_person", name: "王晨", description: "历史上误当概念的具体员工" },
        { id: "specific_company", name: "某家上市公司", description: "历史上误当概念的具体公司" }],
      relations: [{ id: "guessed_link", name: "所属公司", from: "specific_person", to: "specific_company", description: "旧模型解读的关联" }] });
    const source = f.workspace.upload("employees.csv", people);
    const connected = f.live.sources.connectUpload(source.id, source.version, "employee_id");
    const draft = await f.live.propose({ foundationRef: ref(old), baseModelRef: null, purpose: "旧版本映射", rationale: "历史夹具",
      types: [{ name: "王晨", description: "历史上误当概念的具体员工", conceptId: "specific_person", sourceId: connected.id, capability: "records", fields: { email: "email" } }], relations: [] });
    const oldModel = await f.live.adopt(draft.id, draft.version);
    await f.snapshots.sync({ operationId: "pin-old" });
    const releases = new Releases(f.memory, f.live);
    const checked = await releases.check({ inputHash: releases.overview().working.inputHash });
    const published = releases.publish({ operationId: "publish-old", checkRef: ref(checked), name: "旧版" }).release;
    const consumer = releases.connect({ operationId: "consumer-old", name: "旧版消费者", releaseRef: ref(published), conceptIds: ["specific_person"], relationIds: [] });
    const readOld = () => new OntologyDatasets(f.memory, f.live).handle("/v4/concept", new URLSearchParams({ conceptId: "specific_person" }), "Bearer " + consumer.key);
    assert.equal((await readOld()).status, 200);
    const oldDefinition = JSON.stringify(published.content.definition);
    const job = await f.engine.build({ operationId: "manual-rebuild", autoAdopt: false, expectedFoundationVersion: old.version });
    assert.equal(job.content.outcome, "candidate", JSON.stringify(job.content.issues));
    assert.deepEqual(f.foundation.read().current, old, "generation is only a reviewable candidate");
    const candidate = f.memory.getArtifact(String((job.content.candidateRef as any).id));
    assert.deepEqual((candidate.content.diff as any).retiredConcepts.sort(), ["specific_company", "specific_person"]);
    assert.deepEqual((candidate.content.diff as any).retiredRelations, ["guessed_link"]);
    assert.deepEqual((candidate.content.diff as any).retiredMappings, ["specific_person"]);
    assert.deepEqual((candidate.content.diff as any).legacyFoundationRef, ref(old));
    const ready = await f.engine.check(ref(candidate));
    assert.equal(ready.status, "checked", JSON.stringify(ready.content.checks));
    const adopted = await f.engine.adopt({ ...ref(ready), operationId: "adopt-replacement" });
    assert.equal((adopted.foundation.content.concepts as any[]).length, 1);
    assert((adopted.foundation.content.concepts as any[]).every(c => c.origin === "program"));
    assert.equal((adopted.foundation.content.relations as any[]).length, 0);
    assert((adopted.model.content.types as any[]).every(t => t.conceptId !== "specific_person"));
    assert.deepEqual(f.memory.getArtifact(old.id, old.version), old, "the old semantic version is immutable");
    assert.deepEqual(f.memory.getArtifact(oldModel.id, oldModel.version), oldModel, "the old mapping version is immutable");
    assert.equal(JSON.stringify(releases.read(ref(published)).content.definition), oldDefinition);
    const after = await readOld();
    assert.equal(after.status, 200);
    assert.equal((after.body.concept as any).name, "王晨", "the published consumer keeps its original semantic version");
  } finally { await f.close(); }
});


test("retiring a legacy concept releases its obsolete document dependency without changing historical evidence", async () => {
  const f = fixture(), ref = (a: { id: string; version: number }) => ({ id: a.id, version: a.version });
  try {
    const original = seedFoundation(f.memory, f.foundation, { enterprise: "测试企业", program: false,
      concepts: [{ id: "legacy", name: "旧定义", description: "旧资料中的业务定义。" }] });
    const document = f.workspace.upload("旧资料.md", "旧资料中的业务定义。");
    const task = f.memory.createTask("旧文档建模"), context = f.memory.beginExecution(task.id);
    let historical;
    try {
      const documents = new FoundationDocuments(f.memory, context), read = documents.read({ sourceId: document.id });
      const candidate = f.foundation.propose({ baseVersion: original.version, enterprise: original.content.enterprise,
        concepts: [{ id: "legacy", name: "旧定义", description: "旧资料中的业务定义。", evidenceRefs: ["legacy-doc"] }], relations: [],
        evidence: [{ id: "legacy-doc", kind: "document", readId: read.readId, quote: read.text }], unknowns: [], conflicts: [] },
      context, "old-document", "skill", documents);
      historical = f.foundation.adopt(candidate.id, candidate.version);
    } finally { f.memory.endExecution(context); }
    f.workspace.upload("旧资料.md", "更新后的资料，旧解读已不适用。");
    f.workspace.upload("employees.csv", people);
    const job = await f.engine.build({ operationId: "migrate-updated-doc", autoAdopt: false });
    const candidate = f.memory.getArtifact(String((job.content.candidateRef as any).id));
    assert.deepEqual((candidate.content.diff as any).retiredConcepts, ["legacy"]);
    assert.deepEqual((candidate.content.foundation as any).documentVersions, {});
    assert(!(candidate.content.foundation as any).evidence.some((e: any) => e.id === "legacy-doc"));
    const checked = await f.engine.check(ref(candidate));
    assert.equal(checked.status, "checked", JSON.stringify(checked.content.checks));
    const result = await f.engine.adopt({ ...ref(checked), operationId: "adopt-without-retired-doc" });
    assert.equal(result.status, "adopted");
    assert.deepEqual(f.memory.getArtifact(historical.id, historical.version), historical);
    assert.equal((historical.content.documentVersions as any)[document.id], document.version);
    assert.equal((historical.content.evidence as any[]).find(e => e.id === "legacy-doc").quote, "旧资料中的业务定义。");
  } finally { await f.close(); }
});

test("rule rebuild retains enterprise, program definitions and governance evidence, including their document guards", async () => {
  const f = fixture(), ref = (a: { id: string; version: number }) => ({ id: a.id, version: a.version });
  try {
    const original = seedFoundation(f.memory, f.foundation, { enterprise: "测试企业",
      concepts: [{ id: "kept_a", name: "保留甲", description: "保留甲定义。" }, { id: "kept_b", name: "保留乙", description: "保留乙定义。" }],
      relations: [{ id: "kept_relation", name: "保留关联", from: "kept_a", to: "kept_b", description: "保留关联定义。" }] });
    const texts: Record<string, string> = { enterprise: "测试企业的企业主体说明。", concept: "保留甲定义。", relation: "保留关联定义。",
      unknown: "待核对的业务口径。", resolved: "业务口径已有补充说明。", conflict: "历史冲突的依据说明。", legacy: "只用于旧解读定义。" };
    const documentsById = Object.fromEntries(Object.entries(texts).map(([id, text]) => [id, f.workspace.upload(`${id}.md`, text)]));
    const task = f.memory.createTask("补充定义依据"), message = f.memory.addMessage(task.id, "user", "我确认本轮冲突已经核对。"), context = f.memory.beginExecution(task.id);
    let historical;
    try {
      const documents = new FoundationDocuments(f.memory, context);
      const evidence = Object.entries(documentsById).map(([id, source]) => {
        const read = documents.read({ sourceId: source.id });
        return { id, kind: "document", readId: read.readId, quote: read.text };
      });
      const candidate = f.foundation.propose({ baseVersion: original.version, enterprise: { name: "测试企业", evidenceRefs: ["enterprise"] },
        concepts: [{ id: "kept_a", name: "保留甲", description: "保留甲定义。", evidenceRefs: ["concept"] },
          { id: "legacy", name: "旧解读", description: texts.legacy, evidenceRefs: ["legacy"] }],
        relations: [{ id: "kept_relation", name: "保留关联", from: "kept_a", to: "kept_b", description: "保留关联定义。", evidenceRefs: ["relation"] }],
        evidence: [...evidence, { id: "decision", messageId: message.id, quote: message.content }],
        unknowns: [{ id: "unknown_item", description: texts.unknown, evidenceRefs: ["unknown"], resolvedBy: ["resolved"] }],
        conflicts: [{ id: "conflict_item", description: texts.conflict, evidenceRefs: ["conflict"], resolvedBy: ["decision"] }] },
      context, "retained-evidence", "skill", documents);
      historical = f.foundation.adopt(candidate.id, candidate.version);
    } finally { f.memory.endExecution(context); }
    f.workspace.upload("legacy.md", "更新后不再使用的旧资料。");
    f.workspace.upload("employees.csv", people);
    const job = await f.engine.build({ operationId: "keep-active-dependencies", autoAdopt: false });
    const candidate = f.memory.getArtifact(String((job.content.candidateRef as any).id));
    const foundation = candidate.content.foundation as any;
    for (const id of ["enterprise", "concept", "relation", "unknown", "resolved", "conflict"]) {
      assert(foundation.evidence.some((e: any) => e.id === id), `${id} evidence remains reachable`);
      assert.equal(foundation.documentVersions[documentsById[id].id], documentsById[id].version);
    }
    assert(foundation.evidence.some((e: any) => e.id === "program-seed"), "program provenance and unchanged concept evidence remain available");
    assert(foundation.evidence.some((e: any) => e.id === "decision"), "conflict resolution remains explainable");
    assert(!foundation.evidence.some((e: any) => e.id === "legacy"));
    assert.equal(foundation.documentVersions[documentsById.legacy.id], undefined);
    const checked = await f.engine.check(ref(candidate));
    assert.equal(checked.status, "checked", JSON.stringify(checked.content.checks));
    assert.deepEqual(f.memory.getArtifact(historical.id, historical.version), historical);
    // A document still used by a retained program concept must keep its normal adoption guard.
    f.workspace.upload("concept.md", "保留甲定义已变化，需要重新核对。");
    await assert.rejects(f.engine.adopt({ ...ref(checked), operationId: "must-not-bypass-retained-doc" }), /候选引用的资料已更新/);
    assert.deepEqual(f.foundation.read().current, historical, "a failed adoption does not replace the current version");
  } finally { await f.close(); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { MemoryStore } from "../../src/agent/memory.ts";
import { FoundationService } from "../../src/agent/foundation.ts";
import { LiveMemory } from "../../src/live/memory.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { Snapshots } from "../../src/data/snapshots.ts";
import { ProgramBuilds } from "../../src/engine/program-builds.ts";
import { Releases } from "../../src/engine/releases.ts";
import { OntologyChanges } from "../../src/engine/changes.ts";
import { connectIdentityChanges } from "../../src/engine/identity-changes.ts";
import type { Data } from "../../src/agent/contracts.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "context-os-snapshot-build-"));
  const memory = new MemoryStore(directory);
  const live = new LiveMemory(directory, memory);
  const foundation = new FoundationService(memory, live);
  const snapshots = new Snapshots(memory, live, directory);
  const engine = new ProgramBuilds(memory, foundation, live, snapshots);
  const changes = new OntologyChanges(memory, foundation, snapshots);
  connectIdentityChanges(memory, foundation, live, changes);
  let sequence = 0;
  const adoptIdentity = async (kind: "same_as" | "belongs_to", leftConcept: string, leftColumn: string, rightConcept: string, rightColumn: string, relationName?: string) => {
    const model = live.overview().models.find(model => model.status === "adopted")!;
    const layered = live.readLayered(model.id);
    const binding = (concept: string) => layered.bindings.entities.find(b => b.entityTypeId === concept && b.role === "primary")!.id;
    const operation = "identity-" + (++sequence);
    const {change: proposed} = await changes.propose({operationId: operation, origin: "human", type: "identity_rule", baseline: changes.currentBaseline(), subject: {
      kind, left: {bindingId: binding(leftConcept), columns: [leftColumn]}, right: {bindingId: binding(rightConcept), columns: [rightColumn]},
      reason: "业务已核实来源对应", evidence: "逐项核对公司编号与原始记录", ...(relationName ? {relationName} : {})
    }});
    const verified = await changes.verify({operationId: operation + "-verify", id: proposed.id, version: proposed.version});
    assert.equal(verified.status, "verified", JSON.stringify(verified.content.verification));
    const adopted = await changes.adopt({operationId: operation + "-adopt", id: verified.id, version: verified.version, acknowledgeReview: true});
    const modelRef = (adopted.content.effect as Data).modelRef as Data;
    return memory.getArtifact(String(modelRef.id), Number(modelRef.version));
  };
  return { memory, live, foundation, snapshots, engine, adoptIdentity, workspace: new Workspace(memory),
    async close() { await engine.close(); await snapshots.close(); memory.close(); rmSync(directory, { recursive: true, force: true }); } };
}

const code = (i: number) => `A${String(i).padStart(3, "0")}`;
async function crm() {
  const rows = Array.from({ length: 30 }, (_, i) => ({ code: code(i), owner: `销售${i % 4}` }));
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const selected = rows.filter(row => !url.searchParams.has("code") || row.code === url.searchParams.get("code"));
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 20);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: selected.slice(offset, offset + limit), total: selected.length }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

test("full snapshots produce independent entities; explicit same_as and belongs_to adoption remain queryable after rebuilding", async () => {
  const f = fixture();
  const api = await crm();
  try {
    f.workspace.upload("企业.csv", "企业编号,企业名称\n" + Array.from({ length: 30 }, (_, i) => `${code(i)},企业${i}`).join("\n") + "\n");
    f.workspace.upload("订单.csv", "订单号,企业编号,金额\n" + Array.from({ length: 60 }, (_, i) => `O${i},${code(i % 30)},${i * 10}`).join("\n") + "\n");
    const source = await f.live.sources.connect({ name: "CRM", protocol: "http", url: api.url,
      capabilities: [{ name: "companies", path: "/companies", fields: ["code", "owner"], idField: "code", totalPath: "total", filters: { code: "code" } }] });

    const run = await f.engine.build({ operationId: "full-build" });
    assert.equal(run.status, "completed", JSON.stringify(run.content));
    assert.equal(run.content.outcome, "candidate", JSON.stringify(run.content.issues));
    assert.equal(f.snapshots.datasets().length, 3, "the build synced every selected source");

    const candidate = f.engine.overview().candidate!;
    const types = candidate.content.types as any[], relations = candidate.content.modelRelations as any[];
    assert.deepEqual(types.map(t => t.name).sort(), ["Company", "企业", "订单"]);
    assert.ok(types.every(t => !/\d+ 条/.test(t.description)), "stored definitions do not freeze row counts that change on sync");
    const company = types.find(t => t.name === "企业");
    const crmCompany = types.find(t => t.sourceId === source.id), order = types.find(t => t.name === "订单");
    assert.ok(types.every(t => !t.supplements?.length), "matching strings never silently combine business objects");
    assert.deepEqual(relations, []);
    assert.equal((candidate.content.foundation as any).relations.length, 0);
    assert.ok((candidate.content.coverage as any[]).every(c => c.complete && c.snapshotId), "coverage reports full snapshots");
    assert.ok((candidate.content.issues as any[]).some(issue => issue.code === "possible_identity_overlap"));

    const checked = await f.engine.check({ id: candidate.id, version: candidate.version });
    assert.equal((checked.content.checks as any).valid, true, JSON.stringify(checked.content.checks));
    const adopted = await f.engine.adopt({ id: checked.id, version: checked.version, operationId: "adopt" });
    await f.adoptIdentity("same_as", crmCompany.conceptId, "code", company.conceptId, "企业编号");
    const combined = await f.adoptIdentity("belongs_to", order.conceptId, "企业编号", company.conceptId, "企业编号", "属于企业");
    const objects = await f.live.query({ modelId: combined.id, type: "企业", id: code(3) });
    const record = objects.items[0];
    assert.ok(record, JSON.stringify(objects).slice(0, 400));
    assert.ok(JSON.stringify(record).includes("销售3"), "the merged CRM owner is read through the supplement");

    // Rebuilding keeps the adopted concepts and mappings instead of duplicating them.
    const again = await f.engine.build({ operationId: "rebuild" });
    const next = f.engine.overview().candidate;
    assert.equal(again.content.outcome, next ? "candidate" : again.content.outcome);
    if (next) {
      assert.deepEqual((next.content.diff as any).addedConcepts, []);
      assert.equal((next.content.types as any[]).length, 3);
      const checkedAgain = await f.engine.check({id: next.id, version: next.version});
      const rebuilt = await f.engine.adopt({id: checkedAgain.id, version: checkedAgain.version, operationId: "adopt-rebuilt"});
      assert.ok(JSON.stringify((await f.live.query({modelId: rebuilt.model.id, type: "企业", id: code(3)})).items[0]).includes("销售3"));
      assert.equal((await f.live.query({modelId: rebuilt.model.id, type: "订单", id: "O3", relation: "属于企业"})).items[0].$id, code(3));
    }
  } finally { await api.close(); await f.close(); }
});

test("a later source remains independently queryable until its identity rule is explicitly adopted", async () => {
  const f = fixture();
  const api = await crm();
  try {
    const source = await f.live.sources.connect({ name: "CRM", protocol: "http", url: api.url,
      capabilities: [{ name: "companies", path: "/companies", fields: ["code", "owner"], idField: "code", totalPath: "total", filters: { code: "code" } }] });
    await f.engine.build({ operationId: "crm-only" });
    let candidate = f.engine.overview().candidate!;
    let checked = await f.engine.check({ id: candidate.id, version: candidate.version });
    await f.engine.adopt({ id: checked.id, version: checked.version, operationId: "adopt-crm" });

    f.workspace.upload("企业.csv", "企业编号,企业名称\n" + Array.from({ length: 30 }, (_, i) => `${code(i)},企业${i}`).join("\n") + "\n");
    const run = await f.engine.build({ operationId: "with-file" });
    assert.equal(run.content.outcome, "candidate", JSON.stringify(run.content.issues));
    candidate = f.engine.overview().candidate!;
    const types = candidate.content.types as any[], diff = candidate.content.diff as any;
    assert.equal(types.length, 2, "the later file stays independent before the identity decision");
    const originalType = types.find(type => type.sourceId === source.id), extraType = types.find(type => type.sourceId !== source.id);
    assert.equal(diff.addedMappings.length, 1);
    assert.deepEqual(diff.addedSupplements, []);

    checked = await f.engine.check({ id: candidate.id, version: candidate.version });
    assert.equal((checked.content.checks as any).valid, true, JSON.stringify(checked.content.checks));
    const adopted = await f.engine.adopt({ id: checked.id, version: checked.version, operationId: "adopt-file" });
    const combined = await f.adoptIdentity("same_as", extraType.conceptId, "企业编号", originalType.conceptId, "code");
    const objects = await f.live.query({ modelId: combined.id, type: String(originalType.name), id: code(3) });
    assert.ok(JSON.stringify(objects.items[0]).includes("企业3"), JSON.stringify(objects).slice(0, 400));
  } finally { await api.close(); await f.close(); }
});

test("a larger discovered source does not replace the adopted primary binding before explicit identity adoption", async () => {
  const f = fixture();
  const api = await crm();
  try {
    f.workspace.upload("企业.csv", "企业编号,企业名称\n" + Array.from({ length: 20 }, (_, i) => `${code(i)},企业${i}`).join("\n") + "\n");
    await f.engine.build({ operationId: "file-only" });
    let candidate = f.engine.overview().candidate!;
    let checked = await f.engine.check({ id: candidate.id, version: candidate.version });
    const first = await f.engine.adopt({ id: checked.id, version: checked.version, operationId: "adopt-file" });
    const fileType = (first.model.content.types as any[])[0];

    const source = await f.live.sources.connect({ name: "CRM", protocol: "http", url: api.url,
      capabilities: [{ name: "companies", path: "/companies", fields: ["code", "owner"], idField: "code", totalPath: "total", filters: { code: "code" } }] });
    const run = await f.engine.build({ operationId: "with-crm" });
    assert.equal(run.content.outcome, "candidate", JSON.stringify(run.content.issues));
    candidate = f.engine.overview().candidate!;
    const discovery = candidate.content.discovery as any;
    assert.ok(JSON.stringify(discovery).includes("CRM"), "the larger CRM dataset is the discovered anchor");
    const types = candidate.content.types as any[];
    assert.equal(types.length, 2, JSON.stringify(types.map(t => t.name)));
    const originalType = types.find(type => type.conceptId === fileType.conceptId), extraType = types.find(type => type.sourceId === source.id);
    assert.ok(originalType);
    assert.equal((candidate.content.diff as any).addedConcepts.length, 1);

    checked = await f.engine.check({ id: candidate.id, version: candidate.version });
    assert.equal((checked.content.checks as any).valid, true, JSON.stringify(checked.content.checks));
    const adopted = await f.engine.adopt({ id: checked.id, version: checked.version, operationId: "adopt-crm" });
    const combined = await f.adoptIdentity("same_as", extraType.conceptId, "code", originalType.conceptId, "企业编号");
    const objects = await f.live.query({ modelId: combined.id, type: String(originalType.name), id: code(3) });
    assert.ok(JSON.stringify(objects.items[0]).includes("销售3"), JSON.stringify(objects).slice(0, 400));
  } finally { await api.close(); await f.close(); }
});

test("datasets without a usable identity are reported instead of guessed, and live datasets stay out of discovery", async () => {
  const f = fixture();
  try {
    f.workspace.upload("日志.csv", "时间,内容\n2026-01-01,a\n2026-01-01,b\n");
    f.workspace.upload("产品.csv", "产品编号,名称\nP1,甲\nP2,乙\n");
    await f.snapshots.sync({ operationId: "pre" });
    const product = f.snapshots.datasets().find(d => d.content.name === "产品.csv")!;
    f.snapshots.setPolicy({ id: product.id, version: product.version, materialization: "live" });
    const run = await f.engine.build({ operationId: "b" });
    const issues = run.content.issues as any[];
    assert.ok(issues.some(i => i.code === "identity_unknown"), JSON.stringify(issues));
    assert.ok(issues.some(i => i.code === "live_dataset"));
    assert.equal(run.content.outcome, "needs_attention");
  } finally { await f.close(); }
});

test("a larger discovered anchor preserves both sources' same-named properties and their evidence on the adopted mapping", async () => {
  const f = fixture();
  try {
    f.workspace.upload("customers.csv", "id,name\nC0,CRM0\nC1,CRM1\nC2,CRM2\nC3,CRM3\n");
    const first = await f.engine.build({ operationId: "customers", autoAdopt: true });
    assert.equal(first.content.outcome, "adopted", JSON.stringify(first.content.issues));
    const original = f.live.overview().models.find(model => model.status === "adopted")!;
    const originalType = (original.content.types as any[])[0];

    f.workspace.upload("customer_registry.csv", "id,crm_customer_id,name\nE0,C0,ERP0\nE1,C1,ERP1\nE2,C2,ERP2\nE3,C3,ERP3\nE4,C4,ERP4\n");
    const rebuilt = await f.engine.build({ operationId: "accounts", autoAdopt: true });
    // FEATURE_041 R2: a source that merges into an adopted object waits for a decision.
    assert.equal(rebuilt.content.outcome, "candidate", JSON.stringify(rebuilt.content.issues));
    const pendingMerge = f.engine.overview().candidate!;
    const checkedMerge = await f.engine.check({ id: pendingMerge.id, version: pendingMerge.version });
    await f.engine.adopt({ id: checkedMerge.id, version: checkedMerge.version, operationId: "accounts-adopt" });
    const independent = f.live.overview().models.find(model => model.status === "adopted")!;
    const extraType = (independent.content.types as any[]).find(type => type.conceptId !== originalType.conceptId)!;
    assert.equal((independent.content.types as any[]).length, 2);
    const model = await f.adoptIdentity("same_as", extraType.conceptId, "crm_customer_id", originalType.conceptId, "id");
    const type = (model.content.types as any[]).find(type => type.conceptId === originalType.conceptId)!;
    assert.equal(type.sourceId, originalType.sourceId);
    assert.deepEqual(type.fields, originalType.fields, "the adopted primary properties keep their meaning");
    const result = await f.live.query({ modelId: model.id, type: type.name, id: "C0" });
    assert.equal(result.items[0].name, null, "conflicting source values stay unresolved");
    const property = result.evidence![0].properties.name;
    assert.equal(property.status, "conflict");
    assert.deepEqual(property.evidence.map(item => item.value).sort(), ["CRM0", "ERP0"]);
    assert.equal(property.evidence.find(item => item.value === "ERP0")!.sourceTitle, "customer_registry.csv");
    assert.equal(property.evidence.find(item => item.value === "ERP0")!.recordId, "E0");

  } finally { await f.close(); }
});

test("explicit identity adoption preserves manual properties and exposes conflicts with original source evidence", async () => {
  const f = fixture();
  try {
    f.workspace.upload("customers.csv", "id,name\nC0,CRM0\nC1,CRM1\nC2,CRM2\nC3,CRM3\n");
    await f.engine.build({ operationId: "customers", autoAdopt: true });
    const original = f.live.overview().models.find(model => model.status === "adopted")!;
    const foundation = f.foundation.read().adopted!;
    const originalType = (original.content.types as any[])[0];
    const file = f.workspace.upload("registry.csv", "id,name\nC0,REG0\nC1,REG1\nC2,REG2\nC3,REG3\n");
    // The program processes the registry first; the manual mapping then refines what it found.
    await f.engine.build({ operationId: "registry-seen", sourceIds: [file.id] });
    const connection = f.live.sources.connectUpload(file.id, file.version, "id");
    const manualFields = { ...originalType.fields, account_name: "name" };
    const manualSupplement = { name: "人工登记名称", sourceId: connection.id, capability: "records", match: { primaryField: "id", sourceField: "id" },
      fields: { account_id: "name" }, rationale: "保留人工命名与已采用的来源" };
    const edited = await f.live.propose({ foundationRef: { id: foundation.id, version: foundation.version }, baseModelRef: { id: original.id, version: original.version },
      purpose: "人工命名", rationale: "保留既有业务属性", types: [{ ...originalType, fields: manualFields, supplements: [manualSupplement] }], relations: [] });
    await f.live.adopt(edited.id, edited.version);

    f.workspace.upload("customer_registry.csv", "id,crm_customer_id,name\nE0,C0,ERP0\nE1,C1,ERP1\nE2,C2,ERP2\nE3,C3,ERP3\nE4,C4,ERP4\n");
    const rebuilt = await f.engine.build({ operationId: "accounts", autoAdopt: true });
    // FEATURE_041 R2: the new merge waits for a decision; the manual mapping is still what gets adopted.
    assert.equal(rebuilt.content.outcome, "candidate", JSON.stringify(rebuilt.content.issues));
    const pendingNames = f.engine.overview().candidate!;
    const checkedNames = await f.engine.check({ id: pendingNames.id, version: pendingNames.version });
    await f.engine.adopt({ id: checkedNames.id, version: checkedNames.version, operationId: "accounts-adopt-2" });
    const independent = f.live.overview().models.find(model => model.status === "adopted")!;
    const extraType = (independent.content.types as any[]).find(type => type.name.toLowerCase().includes("registry") && type.conceptId !== originalType.conceptId)!;
    const model = await f.adoptIdentity("same_as", extraType.conceptId, "crm_customer_id", originalType.conceptId, "id");
    const type = (model.content.types as any[]).find(type => type.conceptId === originalType.conceptId)!;
    assert.deepEqual(type.fields, manualFields);
    assert.deepEqual(type.supplements[0], manualSupplement);
    const result = await f.live.query({ modelId: model.id, type: type.name, id: "C0" });
    assert.equal(result.items[0].account_name, "CRM0");
    assert.equal(result.items[0].account_id, "REG0");
    assert.equal(result.items[0].name, null);
    assert.equal(result.evidence![0].properties.name.status, "conflict");
    assert.equal(result.evidence![0].properties.name.evidence.find(item => item.value === "ERP0")!.sourceTitle, "customer_registry.csv");

  } finally { await f.close(); }
});

test("case-insensitive relationship discoveries stay candidates and disclose that published consumption cannot execute them", async () => {
  const f = fixture();
  try {
    f.workspace.upload("customers.csv", "customer_id,name\nc0,Customer0\nc1,Customer1\n");
    f.workspace.upload("orders.csv", "order_id,customer_id\nO0,C0\nO1,C1\nO2,C0\nO3,C1\n");
    const run = await f.engine.build({ operationId: "case-insensitive" });
    assert.equal(run.content.outcome, "candidate");
    const candidate = f.engine.overview().candidate!;
    const link = (candidate.content.discovery as any).links[0];
    assert.equal(link.caseInsensitive, true);
    assert.deepEqual(candidate.content.modelRelations, []);
    const checked = await f.engine.check({ id: candidate.id, version: candidate.version });
    assert.equal((checked.content.checks as any).valid, true);
    const adopted = await f.engine.adopt({ id: checked.id, version: checked.version, operationId: "adopt-case-insensitive" });
    assert.deepEqual(adopted.model.content.relations, []);
    const releases = new Releases(f.memory, f.live);
    const releaseCheck = await releases.check({ inputHash: releases.overview().working.inputHash });
    assert.equal(releaseCheck.status, "ready");
    const published = releases.publish({ operationId: "publish-case-insensitive", name: "候选关系边界", checkRef: { id: releaseCheck.id, version: releaseCheck.version } });
    assert.deepEqual((releases.read({ id: published.release.id, version: published.release.version }).content.definition as any).model.relations, []);
    const issue = (candidate.content.issues as any[]).find(issue => issue.code === "relationship_candidate");
    assert.ok(issue);
    assert.match(issue.message, /未加入执行映射/);
    assert.match(issue.message, /未接入.*消费/);
    assert.doesNotMatch(issue.message, /按快照执行时使用/);
  } finally { await f.close(); }
});

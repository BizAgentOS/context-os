import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../../src/agent/server.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import type { Artifact, Data } from "../../src/agent/contracts.ts";
import { RelationCorrections } from "../../src/live/relation-corrections.ts";

const ref = (a: Artifact) => ({ id: a.id, version: a.version });
const files = ["hr/people.csv", "hr/teams.csv", ...["users", "products", "projects", "releases", "requirements", "tasks"].map(x => `tracker/${x}.csv`)];

async function adopt(app: Awaited<ReturnType<typeof createServer>>["app"], proposal: Artifact, operation: string) {
  const verified = await app.changes.verify({ ...ref(proposal), operationId: `verify-${operation}` });
  assert.equal(verified.status, "verified", JSON.stringify(verified.content.verification));
  return app.changes.adopt({ ...ref(verified), operationId: `adopt-${operation}`, acknowledgeReview: true });
}

test("Starbridge sources keep eight independent entities and govern foreign keys, responsibilities and self links before query", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-discovery-governance-"));
  const service = await createServer({ directory, automaticApi: false }), { app } = service;
  try {
    const workspace = new Workspace(app.memory);
    for (const name of files) workspace.upload(name.split("/").at(-1)!, readFileSync(fileURLToPath(new URL(`../../data/samples/starbridge-demo/sources/${name}`, import.meta.url)), "utf8"));
    const job = await app.programBuilds.build({ operationId: "starbridge", autoAdopt: true });
    assert.equal(job.content.outcome, "adopted", JSON.stringify(job.content.issues));
    assert.equal((app.foundation.read().adopted!.content.concepts as Data[]).length, 8);
    assert.equal((app.foundation.read().adopted!.content.relations as Data[]).length, 0, "discovered relationships require adoption even on the first build");
    const data = (name: string) => app.snapshots.datasets().find(d => d.content.name === `${name}.csv`)!;
    const cases = [
      ["projects", "product_key", "products", "product_key", "FP32", "FLOWPILOT"],
      ["releases", "project_key", "projects", "project_key", "FP-3.2", "FP32"],
      ["tasks", "assignee", "users", "username", "FP-TASK-3203", "sunran_sec"],
      ["tasks", "blocked_by", "tasks", "task_key", "FP-TASK-3203", "FP-TASK-3204"],
      ["people", "manager_employee_no", "people", "employee_no", "SB005", "SB004"],
      ["teams", "parent_team_id", "teams", "team_id", "TEAM-FLOWPILOT", "TEAM-ENGINEERING"],
    ];
    for (const [from, column, to, targetColumn, start, target] of cases) {
      await app.programBuilds.idle();
      const proposal = app.changes.list({ type: "relation" }).changes.find(c => {
        const s = c.subject as Data;
        return (s.from as Data)?.datasetId === data(from).id && (s.from as Data).column === column && (s.to as Data)?.datasetId === data(to).id && (s.to as Data).column === targetColumn;
      });
      assert.ok(proposal, `missing ${from}.${column} → ${to}.${targetColumn}: ${JSON.stringify(app.memory.listArtifacts("discovery_recovery"))}`);
      const verified = await app.changes.verify({ id: proposal.id, version: proposal.version, operationId: `verify-${column}` });
      assert.equal(verified.status, "verified", JSON.stringify(verified.content.verification));
      const adopted = await app.changes.adopt({ ...ref(verified), operationId: `adopt-${column}`, acknowledgeReview: true });
      const model = app.live.overview().models.find(m => m.status === "adopted")!;
      const relation = (model.content.relations as Data[]).find(r => r.relationId === (adopted.content.effect as Data).relationId)!;
      const result = await app.live.query({ modelId: model.id, modelVersion: model.version, type: relation.from, id: start, relation: relation.name });
      assert.equal(result.items[0]?.$id, target, `${from}.${column} resolves through its adopted relationship`);
    }
    await app.programBuilds.idle();
    const identity = app.changes.list({ type: "identity_rule" }).changes.find(c => (c.subject as Data).kind === "belongs_to" && (((c.subject as Data).left as Data).columns as string[])?.[0] === "email");
    assert.ok(identity, "email overlap is actionable identity governance, not an issue only");
    const subject = identity.subject as Data;
    const wrong = await app.changes.propose({ operationId: "accounts-are-not-people", type: "identity_rule", origin: "human", baseline: app.changes.currentBaseline(), subject: { ...subject, kind: "same_as" } });
    const incompatible = await app.changes.verify({ ...ref(wrong.change), operationId: "check-identity-types" });
    assert.equal(incompatible.status, "failed", "a matching mailbox cannot make an account the same business object as a person");
    const adoptedIdentity = await adopt(app, app.changes.read(identity.id), "account-person");
    const effect = adoptedIdentity.content.effect as Data;
    const queryPerson = async (id: string) => {
      const model = app.live.overview().models.find(m => m.status === "adopted")!;
      const relation = (model.content.relations as Data[]).find(r => r.relationId === effect.relationTypeId)!;
      return app.live.query({ modelId: model.id, type: relation.from, id, relation: relation.name });
    };
    assert.equal((await queryPerson("zming")).items[0]?.$id, "SB001");
    assert.equal((await queryPerson("zhangwei_pm")).items[0]?.status, "left", "an active account does not overwrite the person's employment status");
    assert.equal((await queryPerson("chen.wang")).items.length, 0, "a changed mailbox remains unmatched until explicitly resolved");
    for (const [id, person, decision] of [["chen.wang", "SB005", "match"], ["ci-bot", null, "no_match"]]) {
      const proposed = await app.changes.propose({ operationId: `resolve-${id}`, type: "identity_decision", origin: "human", baseline: app.changes.currentBaseline(), subject: {
        ruleId: effect.ruleId, left: { bindingId: (subject.left as Data).bindingId, recordId: id }, right: person ? { bindingId: (subject.right as Data).bindingId, recordId: person } : null,
        decision, reason: person ? "核对人员旧账号与邮箱变更" : "CI 机器人不是员工", evidence: person ? "公开来源中的账号及人员记录，人工明确决定" : "公开来源 ci-bot 账号记录，人工明确排除",
      } });
      await adopt(app, proposed.change, `decision-${id}`);
    }
    assert.equal((await queryPerson("chen.wang")).items[0]?.$id, "SB005");
    assert.equal((await queryPerson("ci-bot")).items.length, 0);
    const rebuilt = await app.programBuilds.build({ operationId: "starbridge-again", autoAdopt: true });
    assert.equal(rebuilt.content.outcome, "adopted", JSON.stringify(rebuilt.content.issues));
    assert.equal((app.foundation.read().adopted!.content.relations as Data[]).length, 7, "only explicitly adopted relationships survive rebind");
    assert.equal((await queryPerson("chen.wang")).items[0]?.$id, "SB005", "record decisions survive same-input build");
    assert.equal((await queryPerson("ci-bot")).items.length, 0);
    const current = app.live.overview().models.find(m => m.status === "adopted")!;
    for (const [name, id, field, value] of [["users", "zhangwei_pm", "account_status", "active"], ["requirements", "FP-REQ-3204", "target_release", "FP-3.3"], ["releases", "FP-3.2", "forecast_date", "2026-10-15"], ["products", "FLOWPILOT", "former_name", "WorkflowX"]]) {
      const type = (current.content.types as Data[]).find(t => app.snapshots.bindingDataset(String(t.sourceId), String(t.capability))?.id === data(name).id)!;
      assert.equal((await app.live.query({ modelId: current.id, type: type.name, id })).items[0]?.[field], value);
    }
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("two-hop deprecation waits for adopted hops and full agreement; rejection survives builds and restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-discovery-deprecation-"));
  let service = await createServer({ directory, automaticApi: false });
  try {
    const { app } = service, workspace = new Workspace(app.memory);
    workspace.upload("accounts.csv", "account_id,name\nA1,甲\nA2,乙\n");
    workspace.upload("subscriptions.csv", "subscription_id,account_id\nS1,A1\nS2,A2\n");
    workspace.upload("invoices.csv", "invoice_id,subscription_id,account_id\n" + Array.from({ length: 20 }, (_, i) => `I${i},S${i % 2 + 1},A${i % 2 + 1}`).join("\n"));
    await app.programBuilds.build({ operationId: "chain", autoAdopt: true });
    for (const proposal of app.changes.list({ type: "relation" }).changes) {
      await app.programBuilds.idle();
      await adopt(app, app.changes.read(proposal.id), proposal.id);
    }
    await app.programBuilds.idle();
    const proposed = app.changes.list({ type: "deprecation" }).changes[0];
    assert.ok(proposed, "a redundant adopted direct edge has an actionable deprecation");
    const before = app.live.overview().models.find(m => m.status === "adopted")!;
    const direct = (before.content.relations as Data[]).find(r => r.relationId === (proposed.subject as Data).relationId)!;
    assert.equal((await app.live.query({ modelId: before.id, type: direct.from, id: "I0", relation: direct.name })).items[0]?.$id, "A1");
    const declined = app.changes.reject({ id: proposed.id, version: proposed.version, operationId: "keep-direct", reason: "此直接业务关系有独立含义" });
    await app.programBuilds.build({ operationId: "chain-again", autoAdopt: true });
    assert.equal(app.changes.list({ type: "deprecation" }).changes.filter(c => c.status !== "rejected").length, 0);
    assert.equal(app.changes.read(declined.id).status, "rejected");
    await service.close();
    service = await createServer({ directory, automaticApi: false });
    await service.app.programBuilds.idle();
    assert.equal(service.app.changes.list({ type: "deprecation" }).changes.length, 1, "startup recovery respects the durable refusal");

    // A separate, explicit human choice may reconsider; the adopted result must survive another build.
    const p = await service.app.changes.propose({ operationId: "reconsider", type: "deprecation", origin: "human", baseline: service.app.changes.currentBaseline(), subject: proposed.subject });
    await adopt(service.app, p.change, "remove-direct");
    await service.app.programBuilds.build({ operationId: "after-deprecation", autoAdopt: true });
    const model = service.app.live.overview().models.find(m => m.status === "adopted")!;
    assert.ok(!(model.content.relations as Data[]).some(r => r.relationId === direct.relationId), "the compiler must not recreate the deprecated edge");
    assert.equal((model.content.relations as Data[]).length, 2);
    const first = (model.content.relations as Data[]).find(r => r.from === direct.from)!;
    const hop = await service.app.live.query({ modelId: model.id, type: first.from, id: "I0", relation: first.name });
    const second = (model.content.relations as Data[]).find(r => r.from === first.to)!;
    assert.equal((await service.app.live.query({ modelId: model.id, type: second.from, id: hop.items[0].$id, relation: second.name })).items[0]?.$id, "A1");
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a large event table remains queryable record until activity classification is explicitly accepted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-discovery-activity-"));
  const service = await createServer({ directory, automaticApi: false }), { app } = service;
  try {
    const workspace = new Workspace(app.memory);
    workspace.upload("accounts.csv", "account_id,name\nA1,甲\nA2,乙\n");
    workspace.upload("events.csv", "event_id,account_id,occurred_at\n" + Array.from({ length: 2001 }, (_, i) => `E${i},A${i % 2 + 1},2026-01-01`).join("\n"));
    const run = await app.programBuilds.build({ operationId: "events", autoAdopt: true });
    assert.equal(run.content.outcome, "adopted", JSON.stringify(run.content.issues));
    const proposal = app.changes.list({ type: "data_issue" }).changes[0];
    assert.ok(proposal, "event-shaped data gets a classification proposal");
    const entityId = (proposal.subject as Data).entityTypeId;
    let model = app.live.overview().models.find(m => m.status === "adopted")!;
    let layered = app.live.readLayered(model.id);
    assert.equal(layered.semantic.entityTypes.find(e => e.id === entityId)?.kind, "record");
    const type = (model.content.types as Data[]).find(t => t.conceptId === entityId)!;
    assert.equal((await app.live.query({ modelId: model.id, type: type.name, id: "E2000" })).items[0]?.$id, "E2000");
    await adopt(app, app.changes.read(proposal.id), "classify-activity");
    await app.programBuilds.build({ operationId: "events-again", autoAdopt: true });
    model = app.live.overview().models.find(m => m.status === "adopted")!;
    layered = app.live.readLayered(model.id);
    assert.equal(layered.semantic.entityTypes.find(e => e.id === entityId)?.kind, "activity");
    assert.equal((await app.live.query({ modelId: model.id, type: type.name, id: "E2000" })).items[0]?.$id, "E2000", "classification preserves source records and queryable identity");
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("95 percent two-hop agreement cannot remove the one direct route that differs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-discovery-partial-path-"));
  const service = await createServer({ directory, automaticApi: false }), { app } = service;
  try {
    const workspace = new Workspace(app.memory);
    workspace.upload("accounts.csv", "account_id,name\nA1,甲\nA2,乙\n");
    workspace.upload("subscriptions.csv", "subscription_id,account_id\nS1,A1\nS2,A2\n");
    workspace.upload("invoices.csv", "invoice_id,subscription_id,account_id\n" + Array.from({ length: 20 }, (_, i) => `I${i},S${i % 2 + 1},A${i === 0 ? 2 : i % 2 + 1}`).join("\n"));
    await app.programBuilds.build({ operationId: "partial-path", autoAdopt: true });
    for (const proposal of app.changes.list({ type: "relation" }).changes) {
      await app.programBuilds.idle();
      await adopt(app, app.changes.read(proposal.id), proposal.id);
    }
    await app.programBuilds.idle();
    const proposal = app.changes.list({ type: "deprecation" }).changes[0];
    assert.ok(proposal);
    const checked = await app.changes.verify({ id: proposal.id, version: proposal.version, operationId: "check-partial" });
    assert.equal(checked.status, "failed");
    assert.equal(((checked.content.verification as Data).metrics as Data).matched, 19);
    await assert.rejects(app.changes.adopt({ ...ref(checked), operationId: "reject-partial", acknowledgeReview: true }), /先复验/);
    const model = app.live.overview().models.find(m => m.status === "adopted")!;
    const direct = (model.content.relations as Data[]).find(r => r.relationId === (proposal.subject as Data).relationId)!;
    assert.equal((await app.live.query({ modelId: model.id, type: direct.from, id: "I0", relation: direct.name })).items[0]?.$id, "A2");
    assert.equal((model.content.relations as Data[]).length, 3);
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a corrected alternate path cannot justify removing a useful direct relationship", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-discovery-corrected-path-"));
  const service = await createServer({ directory, automaticApi: false }), { app } = service;
  try {
    const workspace = new Workspace(app.memory);
    workspace.upload("accounts.csv", "account_id,name\nA1,甲\nA2,乙\n");
    workspace.upload("subscriptions.csv", "subscription_id,account_id\nS1,A1\nS2,A2\n");
    workspace.upload("invoices.csv", "invoice_id,subscription_id,account_id\n" + Array.from({ length: 20 }, (_, i) => `I${i},S${i % 2 + 1},A${i % 2 + 1}`).join("\n"));
    await app.programBuilds.build({ operationId: "corrected-path", autoAdopt: true });
    for (const proposal of app.changes.list({ type: "relation" }).changes) {
      await app.programBuilds.idle();
      await adopt(app, app.changes.read(proposal.id), proposal.id);
    }
    await app.programBuilds.idle();
    const proposal = app.changes.list({ type: "deprecation" }).changes[0];
    assert.ok(proposal);
    const model = app.live.overview().models.find(m => m.status === "adopted")!;
    const direct = (model.content.relations as Data[]).find(r => r.relationId === (proposal.subject as Data).relationId)!;
    const first = (model.content.relations as Data[]).find(r => r.from === direct.from && r.relationId !== direct.relationId)!;
    const corrections = new RelationCorrections(app.memory, app.live);
    const correction = await corrections.execute("propose", { operationId: "exclude-hop", target: { modelId: model.id, modelVersion: model.version, type: first.from, objectId: "I0", relation: first.name }, targetIds: [], reason: "该发票关联不是这份订阅", evidence: "人工核对该发票与订阅" });
    const checked = await corrections.execute("check", { ...ref(correction), operationId: "check-hop" });
    await corrections.execute("adopt", { ...ref(checked), operationId: "adopt-hop" });
    assert.equal((await app.live.query({ modelId: model.id, type: first.from, id: "I0", relation: first.name })).items.length, 0);
    assert.equal((await app.live.query({ modelId: model.id, type: direct.from, id: "I0", relation: direct.name })).items[0]?.$id, "A1");
    await app.programBuilds.idle();
    const verified = await app.changes.verify({ ...ref(app.changes.read(proposal.id)), operationId: "check-corrected-deprecation" });
    assert.equal(verified.status, "failed", "raw source equality does not prove equivalence after a path was corrected");
    assert.match(((verified.content.verification as Data).notes as string[]).join(""), /纠正|治理/);
    await assert.rejects(app.changes.adopt({ ...ref(verified), operationId: "keep-useful-direct", acknowledgeReview: true }), /先复验/);
    assert.equal((await app.live.query({ modelId: model.id, type: direct.from, id: "I0", relation: direct.name })).items[0]?.$id, "A1");
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a scoped or identity-governed alternate path cannot use raw joins to remove the direct route", async () => {
  for (const mode of ["rowFilter", "identity"] as const) {
    const directory = mkdtempSync(join(tmpdir(), `context-os-discovery-${mode}-path-`));
    const service = await createServer({ directory, automaticApi: false }), { app } = service;
    try {
      const workspace = new Workspace(app.memory);
      workspace.upload("accounts.csv", "account_id,name\nA1,甲\nA2,乙\n");
      workspace.upload("subscriptions.csv", "subscription_id,account_id\nS1,A1\nS2,A2\n");
      workspace.upload("invoices.csv", "invoice_id,subscription_id,account_id\n" + Array.from({ length: 20 }, (_, i) => `I${i},S${i % 2 + 1},A${i % 2 + 1}`).join("\n"));
      await app.programBuilds.build({ operationId: "governed-path", autoAdopt: true });
      for (const proposal of app.changes.list({ type: "relation" }).changes) {
        await app.programBuilds.idle();
        await adopt(app, app.changes.read(proposal.id), proposal.id);
      }
      await app.programBuilds.idle();
      const proposal = app.changes.list({ type: "deprecation" }).changes[0];
      assert.ok(proposal);
      let model = app.live.overview().models.find(m => m.status === "adopted")!;
      const direct = (model.content.relations as Data[]).find(r => r.relationId === (proposal.subject as Data).relationId)!;
      const first = (model.content.relations as Data[]).find(r => r.from === direct.from && r.relationId !== direct.relationId)!;
      if (mode === "rowFilter") {
        const candidate = await app.live.propose({ foundationRef: ref(app.foundation.read().adopted!), baseModelRef: ref(model), purpose: "限定订阅范围", rationale: "仅第二份订阅属于当前范围",
          types: (model.content.types as Data[]).map(type => type.name === first.to ? { ...type, rowFilter: { subscription_id: "S2" } } : type), relations: model.content.relations });
        await app.live.adopt(candidate.id, candidate.version);
      } else {
        const layered = app.live.readLayered(model.id);
        const binding = layered.bindings.relations.find(r => r.relationTypeId === first.relationId)!;
        const proposed = await app.changes.propose({ type: "identity_rule", origin: "human", operationId: "govern-hop", baseline: app.changes.currentBaseline(), subject: {
          kind: "belongs_to", relationTypeId: first.relationId, left: { bindingId: binding.fromBindingId, columns: binding.fromColumns }, right: { bindingId: binding.toBindingId, columns: binding.toColumns }, reason: "明确发票归属订阅", evidence: "核对归属来源",
        } });
        const governed = await adopt(app, proposed.change, "govern-hop");
        const excluded = await app.changes.propose({ type: "identity_decision", origin: "human", operationId: "exclude-identity-hop", baseline: app.changes.currentBaseline(), subject: {
          ruleId: (governed.content.effect as Data).ruleId, left: { bindingId: binding.fromBindingId, recordId: "I0" }, right: null, decision: "no_match", reason: "该发票不归属于该订阅", evidence: "明确记录级排除",
        } });
        await adopt(app, excluded.change, "exclude-identity-hop");
      }
      model = app.live.overview().models.find(m => m.status === "adopted")!;
      const queryHop = () => app.live.query({ modelId: model.id, type: first.from, id: "I0", relation: first.name });
      if (mode === "rowFilter") await assert.rejects(queryHop(), /超出实体绑定的行过滤范围/);
      else assert.equal((await queryHop()).items.length, 0, mode);
      await app.programBuilds.idle();
      const checked = await app.changes.verify({ ...ref(app.changes.read(proposal.id)), operationId: "check-governed-path" });
      assert.equal(checked.status, "failed", mode);
      assert.match(((checked.content.verification as Data).notes as string[]).join(""), /范围筛选|身份治理/);
      await assert.rejects(app.changes.adopt({ ...ref(checked), operationId: "preserve-direct", acknowledgeReview: true }), /先复验/);
      assert.equal((await app.live.query({ modelId: model.id, type: direct.from, id: "I0", relation: direct.name })).items[0]?.$id, "A1", mode);
    } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test("a same-structure rebuild rechecks adopted hierarchy constraints against the new snapshot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-discovery-hierarchy-rebuild-"));
  const service = await createServer({ directory, automaticApi: false }), { app } = service;
  try {
    const workspace = new Workspace(app.memory);
    workspace.upload("teams.csv", "team_id,parent_team_id,name\nT1,,总公司\nT2,T1,分公司\nT3,T2,团队\n");
    await app.programBuilds.build({ operationId: "hierarchy", autoAdopt: true });
    const proposal = app.changes.list({ type: "relation" }).changes.find(c => (c.subject as Data).acyclic === true)!;
    assert.ok(proposal);
    await adopt(app, app.changes.read(proposal.id), "hierarchy");
    const before = app.live.overview().models.find(m => m.status === "adopted")!;
    workspace.upload("teams.csv", "team_id,parent_team_id,name\nT1,T3,总公司\nT2,T1,分公司\nT3,T2,团队\n");
    const rebuilt = await app.programBuilds.build({ operationId: "cyclic-hierarchy", autoAdopt: true });
    assert.notEqual(rebuilt.content.outcome, "adopted", "a new cycle cannot pass as an unchanged semantic refresh");
    assert.equal(app.live.overview().models.find(m => m.status === "adopted")!.id, before.id);
    const candidate = app.programBuilds.overview().candidate!;
    assert.match(String((candidate.content.checks as Data).description), /环|层级/);
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

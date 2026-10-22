import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { FoundationService } from "../../src/agent/foundation.ts";
import { FoundationDocuments } from "../../src/agent/foundation-evidence.ts";
import { Onboarding } from "../../src/agent/onboarding.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { LiveMemory } from "../../src/live/memory.ts";
import { Snapshots } from "../../src/data/snapshots.ts";
import { ProgramBuilds } from "../../src/engine/program-builds.ts";

function fixture(snapshot = true) {
  const directory = mkdtempSync(join(tmpdir(), "context-os-profile-build-"));
  const memory = new MemoryStore(directory), live = new LiveMemory(directory, memory);
  const foundation = new FoundationService(memory, live), workspace = new Workspace(memory);
  const snapshots = snapshot ? new Snapshots(memory, live, directory) : undefined;
  const engine = new ProgramBuilds(memory, foundation, live, snapshots);
  const onboarding = new Onboarding(memory, foundation);
  return { memory, live, foundation, workspace, engine, onboarding,
    company(name: string) {
      const state = onboarding.view();
      onboarding.company({ expectedVersion: state.version, profileVersion: state.currentProfileVersion, name, industry: state.packs[0].id });
      return memory.listArtifacts("profile")[0];
    },
    async close() { await engine.close(); await snapshots?.close(); memory.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("a program build uses the confirmed profile identity and documents can refine it with traceable profile evidence", async () => {
  const f = fixture();
  try {
    const profile = f.company("星桥软件");
    f.workspace.upload("people.csv", "employee_no,name\nE01,王晨\nE02,李宁\n");
    const run = await f.engine.build({ operationId: "profile-first", autoAdopt: true });
    assert.equal(run.content.outcome, "adopted", JSON.stringify(run.content));
    const built = f.foundation.read().adopted!;
    const enterprise = built.content.enterprise as any;
    assert.equal(enterprise.name, "星桥软件");
    assert.equal(enterprise.evidenceRefs.length, 1);
    const identity = f.foundation.evidence(built.id, built.version, enterprise.evidenceRefs[0]);
    assert.equal(identity.kind, "profile");
    assert.equal(identity.sourceId, profile.id);
    assert.equal(identity.sourceVersion, profile.version);
    assert.equal(identity.quote, "星桥软件");
    assert.deepEqual([identity.start, identity.end], [0, 4], "the evidence locator supplies the exact highlighted field range");
    assert.equal(identity.messageId, undefined, "a saved form field is not a fabricated user message");

    const source = f.workspace.upload("人员说明.md", "人员表示组织内的员工，系统账号是独立的登录凭据。");
    const documents = new FoundationDocuments(f.memory);
    const part = documents.read({ sourceId: source.id });
    const task = f.memory.createTask("补充资料中的人员定义"), context = f.memory.beginExecution(task.id);
    try {
      const concept = (built.content.concepts as any[])[0];
      const candidate = f.foundation.propose({ baseVersion: built.version, enterprise,
        concepts: [{ id: concept.id, name: "人员", description: "组织内的员工。", evidenceRefs: ["people-description"] }], relations: [],
        evidence: [{ id: "people-description", kind: "document", readId: part.readId, quote: part.text }], unknowns: [], conflicts: [],
      }, context, "document-refinement", "test-method", documents, { lockStructure: true });
      const adopted = f.foundation.adopt(candidate.id, candidate.version, { automatic: true });
      assert.equal((adopted.content.enterprise as any).name, "星桥软件");
      assert.equal((adopted.content.concepts as any[])[0].name, "人员");
      assert.equal((adopted.content.documentVersions as any)[source.id], source.version);
      f.workspace.editProfile("company.business", "企业软件服务");
      assert.equal(f.foundation.evidence(adopted.id, adopted.version, enterprise.evidenceRefs[0]).sourceVersion, profile.version,
        "historical identity evidence continues to locate the exact confirmed profile version");
    } finally { f.memory.endExecution(context); }
  } finally { await f.close(); }
});

for (const snapshot of [true, false]) test(`an unknown ${snapshot ? "snapshot" : "legacy"} foundation can receive a confirmed profile and keeps its prior version`, async () => {
  const f = fixture(snapshot);
  try {
    f.workspace.upload("people.csv", "employee_no,name\nE01,王晨\nE02,李宁\n");
    await f.engine.build({ operationId: "before-profile", autoAdopt: true });
    const before = f.foundation.read().adopted!;
    assert.deepEqual(before.content.enterprise, { name: "未设置企业", evidenceRefs: [] });
    f.company("星桥软件");
    const run = await f.engine.build({ operationId: "after-profile", autoAdopt: true });
    assert.equal(run.content.outcome, "adopted", JSON.stringify(run.content));
    const after = f.foundation.read().adopted!;
    assert.equal((after.content.enterprise as any).name, "星桥软件");
    assert.deepEqual((after.content.concepts as any[]).map(item => item.id), (before.content.concepts as any[]).map(item => item.id));
    assert.deepEqual(f.memory.getArtifact(before.id, before.version).content.enterprise, { name: "未设置企业", evidenceRefs: [] });
    assert.throws(() => f.company("其他企业"), /另一企业/);
    assert.equal((f.foundation.read().adopted!.content.enterprise as any).name, "星桥软件");
  } finally { await f.close(); }
});

for (const origin of ["source", "suggestion"]) test(`confirming the same ${origin} company name in onboarding establishes the program identity`, async () => {
  const f = fixture();
  try {
    const document = f.workspace.upload("企业资料.md", "星桥软件提供企业协作软件。");
    const task = f.memory.createTask("保存资料中的企业名称"), context = f.memory.beginExecution(task.id);
    try {
      new Workspace(f.memory, context).execute("profile_update", { statements: [
        { key: "company.name", text: "星桥软件", origin, ...(origin === "source" ? { evidence: [{ sourceId: document.id, version: document.version }] } : {}) },
        { key: "company.industry", text: f.onboarding.view().packs[0].name, origin: "suggestion" },
      ] });
    } finally { f.memory.endExecution(context); }
    f.workspace.upload("people.csv", "employee_no,name\nE01,王晨\nE02,李宁\n");
    await f.engine.build({ operationId: "unconfirmed-company", autoAdopt: true });
    assert.deepEqual(f.foundation.read().adopted!.content.enterprise, { name: "未设置企业", evidenceRefs: [] }, "an unconfirmed source name is not a confirmed identity");

    const confirmed = f.company("星桥软件");
    assert.equal((confirmed.content.statements as any[]).find(item => item.key === "company.name").userEdited, true);
    assert.equal((confirmed.content.statements as any[]).find(item => item.key === "company.industry").userEdited, false, "confirming the name does not upgrade unrelated identical suggestions");
    const run = await f.engine.build({ operationId: "confirmed-company", autoAdopt: true });
    assert.equal(run.content.outcome, "adopted", JSON.stringify(run.content));
    const built = f.foundation.read().adopted!, enterprise = built.content.enterprise as any;
    assert.equal(enterprise.name, "星桥软件");
    assert.equal(f.foundation.evidence(built.id, built.version, enterprise.evidenceRefs[0]).sourceVersion, confirmed.version);
  } finally { await f.close(); }
});

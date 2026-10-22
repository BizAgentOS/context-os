import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentApplication } from "../../src/agent/app.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { FoundationDocuments } from "../../src/agent/foundation-evidence.ts";
import { freezeAgentTurn } from "../../src/agent/agent-modes.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";
import type { Artifact } from "../../src/agent/contracts.ts";
import { createServer } from "../../src/agent/server.ts";
import type { AddressInfo } from "node:net";

const ref = (value: Artifact) => ({ id: value.id, version: value.version });

test("enterprise profile proposals preview authenticated facts and require explicit human adoption", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-profile-change-")), app = new AgentApplication(directory, undefined, new Set(), false);
  try {
    const workspace = new Workspace(app.memory);
    workspace.editProfile("company.name", "澄川热力");
    const profile = workspace.editProfile("company.business", "居民供热");
    const foundation = seedFoundation(app.memory, app.foundation, { enterprise: "澄川热力", concepts: [{ id: "customer", name: "客户", description: "供热客户" }] });
    const source = workspace.upload("业务说明.md", "澄川热力提供居民供热及设备维护。");
    const session = app.memory.createSession(), context = app.memory.beginExecution(session.taskId);
    const turn = freezeAgentTurn(app.memory, context, { mode: "build" }), documents = new FoundationDocuments(app.memory, context);
    try {
      const document = documents.read({ sourceId: source.id });
      const proposal = { operationId: "business", type: "enterprise_profile", baseline: app.changes.currentBaseline(), evidence: "真实业务说明中包含设备维护",
        subject: { profileRef: ref(profile), updates: [{ key: "company.business", text: "居民供热及设备维护", kind: "fact", action: "replace", evidence: [{ id: "business-document", kind: "document", readId: document.readId, quote: document.text }] }] } };
      const proposed = await app.agentChanges.execute("change_propose", proposal, context, turn, documents) as { change: Artifact };
      assert.equal(proposed.change.status, "proposed");
      assert.equal(app.memory.getArtifact(profile.id).version, profile.version, "a model proposal is not an enterprise fact");
      assert.equal((await app.agentChanges.execute("change_propose", proposal, context, turn, documents) as any).change.id, proposed.change.id);
      const checked = await app.agentChanges.execute("change_verify", { ...ref(proposed.change), operationId: "check-business" }, context, turn) as Artifact;
      assert.equal(checked.status, "verified", JSON.stringify(checked.content.verification));
      assert.equal((checked.content.verification as any).result, "review");
      const preview = await app.agentChanges.execute("change_preview_query", { ...ref(checked), impact: true }, context, turn) as any;
      assert.equal(preview.adopted, false);
      assert.equal(preview.impact.updates[0].before.text, "居民供热");
      assert.equal(preview.impact.updates[0].after.text, "居民供热及设备维护");
      assert.equal(preview.impact.updates[0].evidence[0].quote, document.text);
      assert.equal(app.memory.getArtifact(profile.id).version, profile.version);
      await assert.rejects(app.agentChanges.execute("change_adopt", { ...ref(checked) }, context, turn), /模式/);
      await assert.rejects(app.changes.adopt({ ...ref(checked), operationId: "without-ack" }), /确认/);
      const beforeVersions = app.memory.listArtifacts("workspace_version").length;
      const adopted = await app.changes.adopt({ ...ref(checked), operationId: "confirm-business", acknowledgeReview: true });
      const saved = app.memory.getArtifact(profile.id), statement = (saved.content.statements as any[]).find(item => item.key === "company.business");
      assert.equal(statement.text, "居民供热及设备维护");
      assert.equal(statement.origin, "source", "manual confirmation must not fabricate a user quotation");
      assert.equal(statement.confirmation.actor, "local-admin");
      assert.equal(statement.userEdited, true);
      assert.equal(statement.userEvidence, undefined);
      assert.equal(statement.evidence[0].sourceId, source.id);
      assert.equal(app.foundation.read().adopted!.version, foundation.version + 1);
      assert.equal(app.memory.listArtifacts("workspace_version").length, beforeVersions + 1);
      assert.deepEqual(app.foundation.read().adopted!.content.profileRef, ref(saved));
      assert.deepEqual((await app.changes.adopt({ ...ref(checked), operationId: "confirm-business", acknowledgeReview: true })).id, adopted.id);
      assert.equal(app.memory.getArtifact(profile.id).version, saved.version);
    } finally { app.memory.endExecution(context); }
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a concurrent profile edit invalidates verification and impact preview without changing the proposal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-profile-race-")), app = new AgentApplication(directory, undefined, new Set(), false);
  try {
    const workspace = new Workspace(app.memory), original = workspace.editProfile("company.business", "居民供热");
    const proposed = await app.changes.propose({ operationId: "suggest", origin: "human", type: "enterprise_profile", baseline: app.changes.currentBaseline(),
      subject: { profileRef: ref(original), updates: [{ key: "company.goal", text: "考虑设备运维", kind: "suggestion" }] } });
    const checking = app.changes.verify({ ...ref(proposed.change), operationId: "verify" });
    const current = workspace.editProfile("company.business", "居民供热与工业供热");
    await assert.rejects(checking, /档案版本/);
    assert.equal(app.changes.read(proposed.change.id).version, proposed.change.version);
    const next = await app.changes.propose({ operationId: "next", origin: "human", type: "enterprise_profile", baseline: app.changes.currentBaseline(),
      subject: { profileRef: ref(current), updates: [{ key: "company.goal", text: "考虑设备运维", kind: "suggestion" }] } });
    const previewing = app.changes.preparePreview(ref(next.change));
    workspace.editProfile("company.business", "工业供热");
    await assert.rejects(previewing, /档案版本/);
    assert.equal(app.changes.read(next.change.id).version, next.change.version);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("unbacked claims remain suggestions, conflicting facts retain both accounts, and changed documents cannot be adopted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-profile-evidence-")), app = new AgentApplication(directory, undefined, new Set(), false);
  try {
    const workspace = new Workspace(app.memory), original = workspace.editProfile("company.business", "居民供热");
    const source = workspace.upload("业务范围.md", "企业提供设备维护服务。");
    const session = app.memory.createSession(), context = app.memory.beginExecution(session.taskId), turn = freezeAgentTurn(app.memory, context, { mode: "build" });
    const documents = new FoundationDocuments(app.memory, context), document = documents.read({ sourceId: source.id });
    const propose = async (operationId: string, updates: any[]) => (await app.agentChanges.execute("change_propose", { operationId, type: "enterprise_profile", baseline: app.changes.currentBaseline(),
      subject: { profileRef: ref(app.memory.getArtifact(original.id)), updates }, evidence: "核对业务范围" }, context, turn, documents) as { change: Artifact }).change;
    const verify = (change: Artifact, operationId: string) => app.changes.verify({ ...ref(change), operationId });
    try {
      await assert.rejects(propose("fake", [{ key: "company.business", text: "设备维护", kind: "fact", evidence: [{ id: "fake", kind: "document", readId: "invented", quote: "设备维护" }] }]), /读取|回执|不存在/);
      const unsupported = await verify(await propose("unsupported", [{ key: "company.goal", text: "全国领先", kind: "fact" }]), "unsupported-check");
      assert.equal(unsupported.status, "failed");
      assert.match((unsupported.content.verification as any).notes.join(" "), /真实|依据/);
      const suggested = await verify(await propose("suggestion", [{ key: "company.goal", text: "可考虑扩大维护范围", kind: "suggestion" }]), "suggestion-check");
      await app.changes.adopt({ ...ref(suggested), operationId: "suggestion-confirm", acknowledgeReview: true });
      const suggestion = (app.memory.getArtifact(original.id).content.statements as any[]).find(item => item.key === "company.goal");
      assert.equal(suggestion.origin, "suggestion");
      assert.equal(suggestion.userEdited, false);
      const update = { key: "company.business", text: "设备维护", kind: "fact", evidence: [{ id: "maintenance", kind: "document", readId: document.readId, quote: document.text }] };
      const retained = await verify(await propose("retain", [update]), "retain-check");
      await app.changes.adopt({ ...ref(retained), operationId: "retain-confirm", acknowledgeReview: true });
      const retainedProfile = app.memory.getArtifact(original.id);
      assert.equal((retainedProfile.content.statements as any[]).find(item => item.key === "company.business").text, "居民供热");
      assert.equal((retainedProfile.content.conflicts as any[])[0].proposed, "设备维护");
      const replacement = await verify(await propose("replace", [{ ...update, action: "replace" }]), "replace-check");
      await app.changes.adopt({ ...ref(replacement), operationId: "replace-confirm", acknowledgeReview: true });
      const replaced = app.memory.getArtifact(original.id);
      assert.equal((replaced.content.statements as any[]).find(item => item.key === "company.business").text, "设备维护");
      assert.equal((replaced.content.conflicts as any[])[0].resolved.actor, "local-admin");
      const stale = await verify(await propose("stale", [{ ...update, key: "company.industry", text: "设备服务", action: "replace" }]), "stale-check");
      workspace.upload("业务范围.md", "设备维护已停止。");
      await assert.rejects(app.changes.adopt({ ...ref(stale), operationId: "stale-confirm", acknowledgeReview: true }), /版本|变化|依据/);
      assert.equal(app.memory.getArtifact(original.id).version, replaced.version);
    } finally { app.memory.endExecution(context); }
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("company name correction requires the same subject and a fresh user statement while preserving historical meaning", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-profile-identity-")), app = new AgentApplication(directory, undefined, new Set(), false);
  try {
    const workspace = new Workspace(app.memory), profile = workspace.editProfile("company.name", "澄川热力");
    const foundation = seedFoundation(app.memory, app.foundation, { enterprise: "澄川热力", concepts: [{ id: "customer", name: "客户", description: "供热客户" }] });
    const source = workspace.upload("企业名称.md", "澄川能源服务提供居民供热服务。");
    const session = app.memory.createSession(), message = app.memory.addMessage(session.taskId, "user", "同一家公司更名为澄川能源服务，业务主体未变。"), context = app.memory.beginExecution(session.taskId);
    const turn = freezeAgentTurn(app.memory, context, { mode: "build" }), documents = new FoundationDocuments(app.memory, context), document = documents.read({ sourceId: source.id });
    const propose = async (operationId: string, evidence: any[], identityCorrection?: any) => (await app.agentChanges.execute("change_propose", { operationId, type: "enterprise_profile", baseline: app.changes.currentBaseline(), evidence: "核对企业名称",
      subject: { profileRef: ref(profile), updates: [{ key: "company.name", text: "澄川能源服务", kind: "fact", action: "replace", evidence }], ...(identityCorrection ? { identityCorrection } : {}) } }, context, turn, documents) as { change: Artifact }).change;
    const verify = (change: Artifact, operationId: string) => app.changes.verify({ ...ref(change), operationId });
    try {
      const external = [{ id: "new-company-document", kind: "document", readId: document.readId, quote: document.text }];
      const missingIdentity = await verify(await propose("missing-identity", external), "missing-check");
      assert.equal(missingIdentity.status, "failed");
      assert.match((missingIdentity.content.verification as any).notes.join(" "), /同主体/);
      const identityCorrection = { previousName: "澄川热力", sameSubject: true };
      const missingStatement = await verify(await propose("missing-statement", external, identityCorrection), "statement-check");
      assert.equal(missingStatement.status, "failed");
      assert.match((missingStatement.content.verification as any).notes.join(" "), /新增.*用户原话/);
      const fresh = await verify(await propose("fresh", [{ id: "new-company-statement", messageId: message.id, quote: message.content }], identityCorrection), "fresh-check");
      assert.equal(fresh.status, "verified", JSON.stringify(fresh.content.verification));
      const preview = await app.changes.preparePreview(ref(fresh));
      assert.equal((preview.impact!.updates as any[])[0].before.text, "澄川热力");
      const before = app.memory.listArtifacts("workspace_version").length;
      await app.changes.adopt({ ...ref(fresh), operationId: "confirm-name", acknowledgeReview: true });
      assert.equal((app.foundation.read().adopted!.content.enterprise as any).name, "澄川能源服务");
      assert.equal((app.memory.getArtifact(profile.id).content.statements as any[])[0].text, "澄川能源服务");
      assert.equal((app.memory.getArtifact(foundation.id, foundation.version).content.enterprise as any).name, "澄川热力");
      assert.deepEqual(app.foundation.read().adopted!.content.concepts, foundation.content.concepts);
      assert.equal(app.memory.listArtifacts("workspace_version").length, before + 1);
    } finally { app.memory.endExecution(context); }
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("public profile changes enforce administrator review and return 409 when the profile baseline expires", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-profile-http-")), service = await createServer({ directory, automaticApi: false });
  await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown, authorized = true) => {
    const response = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(authorized ? { "X-ContextOS-Token": service.adminToken } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const workspace = new Workspace(service.app.memory), profile = workspace.editProfile("company.business", "居民供热");
    const input = { operationId: "public", origin: "human", type: "enterprise_profile", baseline: service.app.changes.currentBaseline(),
      subject: { profileRef: ref(profile), updates: [{ key: "company.goal", text: "考虑维护服务", kind: "suggestion" }] } };
    assert((await post("/api/changes/propose", input, false)).status >= 400);
    const proposed = await post("/api/changes/propose", input);
    assert.equal(proposed.status, 201, JSON.stringify(proposed));
    const checked = await post("/api/changes/verify", { ...ref(proposed.body.change), operationId: "check" });
    assert.equal(checked.status, 200);
    assert.equal(checked.body.change.content.verification.result, "review");
    const impact=await fetch(base+'/api/changes/impact?'+new URLSearchParams({id:checked.body.change.id,version:String(checked.body.change.version)}),{headers:{'X-ContextOS-Token':service.adminToken}});
    assert.equal(impact.status,200);assert.equal(((await impact.json()) as any).impact.updates[0].proposed.text,'考虑维护服务');
    assert.equal((await post("/api/changes/adopt", { ...ref(checked.body.change), operationId: "not-confirmed" })).status, 409);
    workspace.editProfile("company.business", "工业供热");
    const stale = await post("/api/changes/adopt", { ...ref(checked.body.change), operationId: "stale", acknowledgeReview: true });
    assert.equal(stale.status, 409, JSON.stringify(stale));
    assert.equal(stale.body.code, "profile_changed");
    assert.equal(service.app.memory.getArtifact(profile.id).version, profile.version + 1);
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("QA cannot propose profile facts and stopping a build prevents late verification", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-profile-mode-")), app = new AgentApplication(directory, undefined, new Set(), false);
  try {
    const session = app.memory.createSession(), context = app.memory.beginExecution(session.taskId);
    const qa = freezeAgentTurn(app.memory, context, { mode: "qa" }), build = freezeAgentTurn(app.memory, context, { mode: "build" });
    const input = { operationId: "mode", type: "enterprise_profile", baseline: app.changes.currentBaseline(), evidence: "业务方向建议", subject: { profileRef: null, updates: [{ key: "company.goal", text: "考虑维护服务", kind: "suggestion" }] } };
    await assert.rejects(app.agentChanges.execute("change_propose", input, context, qa), /问答模式/);
    assert.equal(app.memory.listArtifacts("ontology_change").length, 0);
    const proposed = await app.agentChanges.execute("change_propose", input, context, build) as { change: Artifact };
    const verifying = app.agentChanges.execute("change_verify", { ...ref(proposed.change), operationId: "verify" }, context, build);
    app.memory.pauseTask(context.taskId);
    await assert.rejects(verifying, /停止|任务|运行/);
    assert.equal(app.changes.read(proposed.change.id).version, proposed.change.version);
    assert.equal(app.memory.listArtifacts("profile").length, 0);
    await assert.rejects(app.agentChanges.execute("change_preview_query", { ...ref(proposed.change), impact: true }, context, build), /停止|任务|运行/);
    app.memory.endExecution(context);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

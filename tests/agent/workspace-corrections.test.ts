import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import { createHeatingSources, connectHeatingSources, heatingDefinition } from "../../src/live/heating-sources.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";

const ref = (a: { id: string; version: number }) => ({ id: a.id, version: a.version });

/** Heating complaints with a callback relation, mapped onto an adopted foundation so a release can be published. */
async function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "ade-ws-corrections-"));
  const upstream = await createHeatingSources();
  const service = await createServer({ directory, automaticApi: false });
  await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const manage = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "X-DataEngine-Token": service.adminToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as any;
    if (!response.ok) throw new Error(value.error);
    return value;
  };
  const external = async (key: string, path: string) => {
    const response = await fetch(base + path, { headers: { authorization: "Bearer " + key } });
    return { status: response.status, body: await response.json() as any };
  };
  const foundation = seedFoundation(service.app.memory, service.app.foundation, { enterprise: "澄川热力",
    concepts: [{ id: "complaint", name: "投诉", description: "客户投诉及处理状态" }, { id: "callback", name: "回访", description: "客户对处理后的反馈" }],
    relations: [{ id: "rel_callback", name: "回访记录", from: "complaint", to: "callback", description: "投诉对应的回访" }] });
  const connections = await connectHeatingSources(service.app.live.sources, upstream);
  const definition = heatingDefinition(connections.api.id, connections.mcp.id);
  const proposed = await service.app.live.propose({ ...definition, foundationRef: ref(foundation), baseModelRef: null,
    types: definition.types.map(type => ({ ...type, conceptId: type.name === "投诉" ? "complaint" : "callback" })),
    relations: definition.relations.map(relation => ({ ...relation, relationId: "rel_callback" })) });
  const model = await service.app.live.adopt(proposed.id, proposed.version);
  const publish = async (name: string) => {
    const overview = await manage("/api/releases");
    const checked = await manage("/api/releases/check", { inputHash: overview.working.inputHash });
    assert.equal(checked.status, "ready", JSON.stringify(checked.content.issues));
    return (await manage("/api/releases/publish", { operationId: "pub-" + name, checkRef: ref(checked), name })).release;
  };
  const connect = async (release: any, name: string) => (await manage("/api/releases/connect", { operationId: "conn-" + name, name, releaseRef: ref(release),
    conceptIds: ["complaint", "callback"], relationIds: ["rel_callback"], business: { grants: [
      { type: "投诉", fields: ["$id"], relations: ["回访记录"] }, { type: "回访", fields: ["$id", "投诉编号", "结果"], relations: [] }] } })).key as string;
  const callbacks = "/v4/objects?" + new URLSearchParams({ type: "投诉", id: "TS002", relation: "回访记录" });
  return { service, manage, external, model, upstream, publish, connect, callbacks,
    async close() { await service.close(); await upstream.close(); rmSync(directory, { recursive: true, force: true }); } };
}

async function adoptCorrection(w: Awaited<ReturnType<typeof workspace>>, targetIds: string[], tag: string) {
  const target = { modelId: w.model.id, modelVersion: w.model.version, type: "投诉", objectId: "TS002", relation: "回访记录" };
  const proposed = (await w.manage("/api/live/corrections/propose", { operationId: "p-" + tag, target, targetIds, reason: "回访被错误关联", evidence: "管理员核对原始登记" })).saved;
  const checked = (await w.manage("/api/live/corrections/check", { operationId: "c-" + tag, id: proposed.id, version: proposed.version })).saved;
  return (await w.manage("/api/live/corrections/adopt", { operationId: "a-" + tag, id: checked.id, version: checked.version })).saved;
}

test("an adopted local correction reaches consumers of releases published after it, while earlier releases keep their original result", async () => {
  const w = await workspace();
  try {
    const first = await w.publish("v1");
    const keyV1 = await w.connect(first, "v1-reader");
    const before = await w.external(keyV1, w.callbacks);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.items[0].objectRef.id, "HF002");

    const correction = await adoptCorrection(w, [], "empty");
    const working = (await w.manage("/api/releases")).working;
    assert.deepEqual(working.definition.corrections.map((item: any) => item.id), [correction.id], "the working version carries the adopted correction");
    assert.ok(working.diff.some((entry: any) => entry.path.startsWith("/corrections/")), "the release difference shows the correction");

    const second = await w.publish("v2");
    const keyV2 = await w.connect(second, "v2-reader");
    const after = await w.external(keyV2, w.callbacks);
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.deepEqual(after.body.items, [], "a consumer of the new release reads the corrected relation");

    const old = await w.external(keyV1, w.callbacks);
    assert.equal(old.body.items[0].objectRef.id, "HF002", "the release published before the correction is unchanged");
  } finally { await w.close(); }
});

test("a release pins the correction it was published with, so a later correction does not change it", async () => {
  const w = await workspace();
  try {
    await adoptCorrection(w, [], "first");
    const second = await w.publish("v1");
    const key = await w.connect(second, "reader");
    assert.deepEqual((await w.external(key, w.callbacks)).body.items, []);
    // The correction is replaced by one that restores the callback; the published release must not follow it.
    await adoptCorrection(w, ["HF002"], "restore");
    assert.deepEqual((await w.external(key, w.callbacks)).body.items, [], "the pinned release keeps the correction it was published with");
    const third = await w.publish("v2");
    const keyV2 = await w.connect(third, "reader-2");
    assert.equal((await w.external(keyV2, w.callbacks)).body.items[0].objectRef.id, "HF002", "the next release carries the new decision");
  } finally { await w.close(); }
});

test("pending structural changes no longer block a release, and are reported as not included", async () => {
  const w = await workspace();
  try {
    const proposed = await w.service.app.changes.propose({ operationId: "pending", origin: "human", type: "naming", baseline: w.service.app.changes.currentBaseline(),
      subject: { target: "concept", id: "complaint", name: "客户投诉" } });
    await w.service.app.foundation.read();
    // An unadopted foundation candidate is the pre-existing kind of pending work.
    const current = w.service.app.foundation.read().current!;
    w.service.app.memory.putArtifact({ id: current.id, expectedVersion: current.version, kind: "foundation", title: current.title, status: "candidate",
      content: { ...current.content, adoptedVersion: current.version } });
    const overview = await w.manage("/api/releases");
    assert.ok(overview.working.pending.length >= 1);
    const issue = overview.working.issues.find((item: any) => item.code === "pending_changes");
    assert.equal(issue.severity, "warning", "pending work warns instead of blocking");
    assert.match(issue.message, /不包含在本次发布/);
    const checked = await w.manage("/api/releases/check", { inputHash: overview.working.inputHash });
    assert.equal(checked.status, "ready", JSON.stringify(checked.content.issues));
    assert.ok(proposed.change.id);
  } finally { await w.close(); }
});

test("every adoption records a workspace version in the same transaction, and unchanged state records none", async () => {
  const w = await workspace();
  try {
    const versions = async () => (await w.manage("/api/workspace-versions")).versions as any[];
    const baseline = await versions();
    assert.ok(baseline.length >= 1, "adopted state has a version");
    assert.equal(baseline[0].number, baseline.length, "newest first, numbers consecutive");
    const before = baseline[0].number;

    await w.publish("v1");
    assert.equal((await versions())[0].number, before, "publishing or reading creates no workspace version");

    const correction = await adoptCorrection(w, [], "ws");
    const after = await versions();
    assert.equal(after[0].number, before + 1, "adopting a correction creates exactly one new version");
    assert.deepEqual(after[0].cause, ["ontology_change", "relation_correction"]);
    const read = (await w.manage(`/api/workspace-versions/read?number=${after[0].number}`)).version;
    assert.ok(read.content.composition.corrections.includes(`${correction.id}@${correction.version}`), "the version names the correction it contains");
    const older = (await w.manage(`/api/workspace-versions/read?number=${before}`)).version;
    assert.deepEqual(older.content.composition.corrections, [], "the earlier version is unchanged");
  } finally { await w.close(); }
});

test("a failed adoption leaves no workspace version behind", async () => {
  const w = await workspace();
  try {
    const count = async () => (await w.manage("/api/workspace-versions")).versions.length;
    const before = await count();
    const target = { modelId: w.model.id, modelVersion: w.model.version, type: "投诉", objectId: "TS002", relation: "回访记录" };
    const proposed = (await w.manage("/api/live/corrections/propose", { operationId: "p", target, targetIds: [], reason: "x", evidence: "y" })).saved;
    // Adopting without a check is refused; nothing may be recorded for the refused attempt.
    await assert.rejects(w.manage("/api/live/corrections/adopt", { operationId: "a", id: proposed.id, version: proposed.version }), /检查/);
    assert.equal(await count(), before);
  } finally { await w.close(); }
});

test("a write that leaves the composition unchanged records no new workspace version", async () => {
  const w = await workspace();
  try {
    const count = async () => (await w.manage("/api/workspace-versions")).versions.length;
    const before = await count();
    // A candidate-status write is not adopted state, so it is not a cause at all.
    const foundation = w.service.app.foundation.read().adopted!;
    // A candidate is a later version of the same foundation artifact; `adoptedVersion` always points at a version of it.
    const candidate = w.service.app.memory.putArtifact({ id: foundation.id, expectedVersion: foundation.version, kind: "foundation", title: "candidate", status: "candidate", content: { ...foundation.content, adoptedVersion: foundation.version } });
    assert.equal(await count(), before, "an unadopted candidate is not a workspace change");
    // Re-adopting identical content under a new version is a different semantic ref, so it does record one.
    w.service.app.memory.putArtifact({ id: foundation.id, expectedVersion: candidate.version, kind: "foundation", title: foundation.title, status: "adopted", content: { ...foundation.content } });
    const after = await count();
    assert.equal(after, before + 1);
    // Recording again with nothing changed since must return the existing version instead of numbering a new one.
    const latest = w.service.app.workspaceVersions.latest()!;
    const again = w.service.app.workspaceVersions.record([latest]);
    assert.equal(again.id, latest.id);
    assert.equal(await count(), after, "an unchanged composition is never numbered twice");
  } finally { await w.close(); }
});


test("a release pins the working version it was published from, and a later adoption only advances the working version", async () => {
  const w = await workspace();
  try {
    const versions = async () => (await w.manage("/api/workspace-versions")).versions as any[];
    const first = await w.publish("v1");
    const pinned = first.content.workspaceVersion;
    assert.ok(pinned, "the release records the working version it was published from");
    assert.equal(pinned.number, (await versions())[0].number, "the release pins the working version current at publish time");

    await adoptCorrection(w, [], "advance");
    const latest = (await versions())[0];
    assert.equal(latest.number, pinned.number + 1, "adopting advances the working version");

    const reread = await w.manage(`/api/releases/read?id=${first.id}&version=${first.version}`);
    assert.equal(reread.content.workspaceVersion.number, pinned.number, "a published release keeps the version it pinned");
    assert.deepEqual(reread.content.definition.corrections, [], "the old release does not carry corrections adopted afterwards");
  } finally { await w.close(); }
});

test("an adopted correction is recorded in the change ledger in the same transaction", async () => {
  const w = await workspace();
  try {
    assert.equal((await w.manage("/api/changes?type=local_correction")).total, 0, "an untouched workspace has no correction changes");
    const correction = await adoptCorrection(w, [], "ledger");
    const listed = await w.manage("/api/changes?type=local_correction");
    assert.equal(listed.total, 1, "adopting a correction records exactly one change");
    const entry = listed.changes[0];
    assert.equal(entry.type, "local_correction");
    assert.equal(entry.status, "adopted");
    assert.equal(entry.origin, "human");
    const read = (await w.manage(`/api/changes/read?id=${entry.id}&version=${entry.version}`)).change;
    assert.equal(read.content.subject.ownerRef.id, correction.id, "the change names the proposed correction");
    assert.deepEqual(read.content.effect.ownerRef, { id: correction.id, version: correction.version });
    assert.equal(read.content.verification.result, "passed", "the owning service verifies before the shared state transition");
  } finally { await w.close(); }
});

test("a proposed correction is pending in the change ledger until a decision", async () => {
  const w = await workspace();
  try {
    const target = { modelId: w.model.id, modelVersion: w.model.version, type: "投诉", objectId: "TS002", relation: "回访记录" };
    await w.manage("/api/live/corrections/propose", { operationId: "p-only", target, targetIds: [], reason: "尚未决定", evidence: "管理员登记" });
    const pending = await w.manage("/api/changes?type=local_correction");
    assert.equal(pending.total, 1);
    assert.equal(pending.changes[0].status, "proposed", "a candidate is visible but is not an adopted decision");
  } finally { await w.close(); }
});

test("a wording change preserves adopted corrections and the binding identity", async () => {
  const w = await workspace();
  try {
    const correction = await adoptCorrection(w, [], "wording");
    const baseline = (await w.manage("/api/changes")).baseline;
    const proposed = await w.manage("/api/changes/propose", { operationId: "wording", origin: "human", type: "description", baseline,
      subject: { target: "concept", id: "complaint", description: "客户提交的供暖投诉" } });
    const checked = (await w.manage("/api/changes/verify", { operationId: "wording-check", ...ref(proposed.change) })).change;
    await w.manage("/api/changes/adopt", { operationId: "wording-adopt", ...ref(checked) });
    const working = (await w.manage("/api/workspace-versions")).composition;
    assert.deepEqual(working.bindings, ref(w.model));
    assert.ok(working.corrections.includes(`${correction.id}@${correction.version}`));
    const release = await w.publish("wording"), key = await w.connect(release, "wording");
    assert.deepEqual((await w.external(key, w.callbacks)).body.items, []);
  } finally { await w.close(); }
});

test("a unified change alone warns at publication while the adopted working version remains publishable", async () => {
  const w = await workspace();
  try {
    const baseline = (await w.manage("/api/changes")).baseline;
    const proposal = await w.manage("/api/changes/propose", { operationId: "publish-pending", origin: "human", type: "naming", baseline,
      subject: { target: "concept", id: "complaint", name: "供暖投诉" } });
    const working = (await w.manage("/api/releases")).working;
    assert.equal(working.pending.filter((p: any) => p.id === proposal.change.id).length, 1);
    assert.ok(working.issues.some((i: any) => i.code === "pending_changes" && i.severity === "warning"));
    const check = await w.manage("/api/releases/check", { inputHash: working.inputHash });
    assert.equal(check.status, "ready");
    assert.match(check.content.issues.find((i: any) => i.code === "pending_changes").message, /不包含在本次发布/);
  } finally { await w.close(); }
});

test("a correction proposed by the old endpoint is verified and adopted through the shared change endpoint", async () => {
  const w = await workspace();
  try {
    const target = { modelId: w.model.id, modelVersion: w.model.version, type: "投诉", objectId: "TS002", relation: "回访记录" };
    await w.manage("/api/live/corrections/propose", { operationId: "unified-p", target, targetIds: [], reason: "不应关联此回访", evidence: "人工核对" });
    const pending = (await w.manage("/api/changes?type=local_correction")).changes[0];
    const checked = (await w.manage("/api/changes/verify", { operationId: "unified-v", ...ref(pending) })).change;
    assert.equal(checked.status, "verified", JSON.stringify(checked.content.verification));
    const adopted = (await w.manage("/api/changes/adopt", { operationId: "unified-a", ...ref(checked) })).change;
    assert.equal(adopted.status, "adopted");
    const release = await w.publish("unified"), key = await w.connect(release, "unified");
    assert.deepEqual((await w.external(key, w.callbacks)).body.items, []);
  } finally { await w.close(); }
});

test("rejecting a checked correction prevents adoption through the old endpoint", async () => {
  const w = await workspace();
  try {
    const target = { modelId: w.model.id, modelVersion: w.model.version, type: "投诉", objectId: "TS002", relation: "回访记录" };
    const candidate = (await w.manage("/api/live/corrections/propose", { operationId: "reject-p", target, targetIds: [], reason: "待定纠正", evidence: "人工核对" })).saved;
    const checked = (await w.manage("/api/live/corrections/check", { operationId: "reject-v", ...ref(candidate) })).saved;
    const change = (await w.manage("/api/changes?type=local_correction")).changes[0];
    assert.equal(change.status, "verified");
    await w.manage("/api/changes/reject", { operationId: "reject-r", ...ref(change), reason: "核对后维持原值" });
    const before = (await w.manage("/api/workspace-versions")).versions[0].number;
    await assert.rejects(w.manage("/api/live/corrections/adopt", { operationId: "reject-a", ...ref(checked) }), /已处理/);
    assert.equal((await w.manage("/api/workspace-versions")).versions[0].number, before);
  } finally { await w.close(); }
});


test("cancelling through either legacy governance entry point withdraws its unified change", async () => {
  const w = await workspace();
  try {
    const drafts = [
      { path: "/api/live/corrections", body: { operationId: "cancel-correction", target: { modelId: w.model.id, modelVersion: w.model.version, type: "投诉", objectId: "TS002", relation: "回访记录" }, targetIds: [], reason: "待核对", evidence: "本轮撤回" } },
      { path: "/api/live/changes", body: { operationId: "cancel-mapping", baseRef: ref(w.model), patch: { kind: "property", type: "投诉", property: "状态", sourceField: "description" }, reason: "待核对属性规则", evidence: "本轮撤回" } },
    ];
    for (const [index, draft] of drafts.entries()) {
      const owner = (await w.manage(draft.path + "/propose", draft.body)).saved;
      const before = (await w.manage("/api/changes")).changes.find((change: any) => change.owner?.id === owner.id);
      assert.equal(before.status, "proposed");
      await w.manage(draft.path + "/cancel", { operationId: "cancel-" + index, ...ref(owner) });
      const after = (await w.manage("/api/changes/read?id=" + before.id)).change;
      assert.equal(after.status, "rejected");
      assert.equal(after.content.disposition, "withdrawn");
    }
  } finally { await w.close(); }
});

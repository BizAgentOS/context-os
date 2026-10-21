import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { snapshotFile } from "../../src/data/executor/paths.ts";
import { createHeatingSources, connectHeatingSources, heatingDefinition } from "../../src/live/heating-sources.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";

const ref = (artifact: { id: string; version: number }) => ({ id: artifact.id, version: artifact.version });

async function fixture(uploadedCallbacks = false, initialSnapshots = true) {
  const directory = mkdtempSync(join(tmpdir(), "ade-workspace-restore-"));
  const upstream = await createHeatingSources();
  const service = await createServer({ directory, automaticApi: false });
  await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "X-DataEngine-Token": service.adminToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const manage = async (path: string, body?: unknown) => {
    const result = await request(path, body);
    assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result.body));
    return result.body;
  };
  const foundation = seedFoundation(service.app.memory, service.app.foundation, { enterprise: "澄川热力",
    concepts: [{ id: "complaint", name: "投诉", description: "客户投诉及处理状态" }, { id: "callback", name: "回访", description: "客户对处理后的反馈" }],
    relations: [{ id: "rel_callback", name: "回访记录", from: "complaint", to: "callback", description: "投诉对应的回访" }] });
  const connections = await connectHeatingSources(service.app.live.sources, upstream);
  const uploadCallbacks = (outcome: string) => {
    const uploaded = new Workspace(service.app.memory).upload("callbacks.csv", `id,complaintId,outcome\nHF002,TS002,${outcome}\n`);
    return service.app.live.sources.connectUpload(uploaded.id, uploaded.version, "id");
  };
  if (uploadedCallbacks) connections.mcp = uploadCallbacks("未改善");
  if (initialSnapshots) await service.app.snapshots.sync({ operationId: "initial-data" });
  const definition = heatingDefinition(connections.api.id, connections.mcp.id);
  if (uploadedCallbacks) definition.types.find(type => type.name === "回访")!.capability = "records";
  const candidate = await service.app.live.propose({ ...definition, foundationRef: ref(foundation), baseModelRef: null,
    types: definition.types.map(type => ({ ...type, conceptId: type.name === "投诉" ? "complaint" : "callback" })),
    relations: definition.relations.map(relation => ({ ...relation, relationId: "rel_callback" })) });
  const model = await service.app.live.adopt(candidate.id, candidate.version);
  const correct = async (targetIds: string[], tag: string) => {
    const target = { modelId: model.id, modelVersion: model.version, type: "投诉", objectId: "TS002", relation: "回访记录" };
    const proposed = (await manage("/api/live/corrections/propose", { operationId: `p-${tag}`, target, targetIds, reason: "核对回访关联", evidence: "管理员核对原始记录" })).saved;
    const checked = (await manage("/api/live/corrections/check", { operationId: `c-${tag}`, ...ref(proposed) })).saved;
    return (await manage("/api/live/corrections/adopt", { operationId: `a-${tag}`, ...ref(checked) })).saved;
  };
  const proposeRestore = async (version: { id: string; version: number }, operationId = "restore") =>
    (await manage("/api/changes/propose", { operationId, origin: "human", type: "restore", baseline: (await manage("/api/changes")).baseline,
      subject: { workspaceVersionRef: ref(version) } })).change;
  return { service, directory, upstream, connections, foundation, model, manage, request, correct, proposeRestore, uploadCallbacks,
    async close() { await service.close(); await upstream.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("restoring a checked historical workspace creates a new working version and preserves its semantics, correction and snapshot without changing a published release", async () => {
  const w = await fixture();
  try {
    await w.correct([], "original");
    const original = (await w.manage("/api/workspace-versions")).versions[0];
    const historical = (await w.manage(`/api/workspace-versions/read?number=${original.number}`)).version;
    w.upstream.setOutcome("已改善");
    await w.service.app.snapshots.sync({ operationId: "new-data" });
    await w.correct(["HF002"], "later");
    const description = (await w.manage("/api/changes/propose", { operationId: "description", origin: "human", type: "description", baseline: (await w.manage("/api/changes")).baseline,
      subject: { target: "concept", id: "complaint", description: "后续修订的投诉定义" } })).change;
    const descriptionCheck = (await w.manage("/api/changes/verify", { operationId: "verify-description", ...ref(description) })).change;
    await w.manage("/api/changes/adopt", { operationId: "adopt-description", ...ref(descriptionCheck) });
    const working = (await w.manage("/api/releases")).working;
    const checked = await w.manage("/api/releases/check", { inputHash: working.inputHash });
    assert.equal(checked.status, "ready", JSON.stringify(checked.content.issues));
    const released = (await w.manage("/api/releases/publish", { operationId: "publish", checkRef: ref(checked), name: "后续发布" })).release;
    const connected = await w.manage("/api/releases/connect", { operationId: "connect", name: "已发布接入方", releaseRef: ref(released),
      conceptIds: ["complaint", "callback"], relationIds: ["rel_callback"], business: { grants: [
        { type: "投诉", fields: ["$id"], relations: ["回访记录"] }, { type: "回访", fields: ["$id", "投诉编号", "结果"], relations: [] }] } });
    const before = (await w.manage("/api/workspace-versions")).versions[0];
    const proposal = await w.proposeRestore(original);
    const verified = (await w.manage("/api/changes/verify", { operationId: "verify-restore", ...ref(proposal) })).change;
    assert.equal((await w.manage("/api/workspace-versions")).versions[0].number, before.number, "proposing and verifying leave working state unchanged");
    const adopted = (await w.manage("/api/changes/adopt", { operationId: "adopt-restore", ...ref(verified) })).change;
    assert.equal(adopted.status, "adopted");
    const after = (await w.manage("/api/workspace-versions")).versions[0];
    assert.equal(after.number, before.number + 1, "restoration records exactly one new workspace");
    const replay = (await w.manage("/api/changes/adopt", { operationId: "adopt-restore", ...ref(verified) })).change;
    assert.deepEqual(ref(replay), ref(adopted), "retrying the same adoption returns its original decision");
    assert.equal((await w.manage("/api/workspace-versions")).versions[0].number, after.number);
    const restored = (await w.manage(`/api/workspace-versions/read?number=${after.number}`)).version;
    assert.deepEqual(restored.content.composition.snapshots, historical.content.composition.snapshots);
    assert.equal((w.service.app.foundation.read().adopted!.content.concepts as any[])[0].description, "客户投诉及处理状态", "the historical semantic definition becomes the new working definition");
    const modelRef = restored.content.composition.bindings;
    const callbacks = await w.service.app.live.query({ modelId: modelRef.id, modelVersion: modelRef.version, type: "投诉", id: "TS002", relation: "回访记录" });
    assert.deepEqual(callbacks.items, [], "the historical correction is effective on the restored binding");
    const outcome = await w.service.app.live.query({ modelId: modelRef.id, modelVersion: modelRef.version, type: "回访", id: "HF002" });
    assert.equal(outcome.items[0].结果, "未改善", "working reads use the historical immutable snapshot");
    assert.deepEqual((await w.manage(`/api/workspace-versions/read?number=${original.number}`)).version, historical, "historical workspace remains immutable");
    const url = `/v4/objects?${new URLSearchParams({ type: "投诉", id: "TS002", relation: "回访记录" })}`;
    const external = await fetch(`http://127.0.0.1:${(w.service.server.address() as AddressInfo).port}` + url, { headers: { authorization: `Bearer ${connected.key}` } });
    const body = await external.json() as any;
    assert.equal(external.status, 200, JSON.stringify(body));
    assert.equal(body.items[0].objectRef.id, "HF002", "an existing release keeps the later correction");
    assert.equal(body.items[0].properties.结果.value, "已改善", "an existing release keeps the later snapshot");
  } finally { await w.close(); }
});

test("a verified restore cannot revive a source revoked before adoption", async () => {
  const w = await fixture();
  try {
    const original = (await w.manage("/api/workspace-versions")).versions[0];
    const proposal = await w.proposeRestore(original);
    const checked = (await w.manage("/api/changes/verify", { operationId: "verify", ...ref(proposal) })).change;
    const before = await w.manage("/api/workspace-versions");
    w.service.app.live.sources.disable(w.connections.api.id, w.connections.api.version);
    const result = await w.request("/api/changes/adopt", { operationId: "adopt", ...ref(checked) });
    assert.ok(result.status >= 400, JSON.stringify(result.body));
    assert.match(result.body.error, /来源.*停用/);
    assert.deepEqual(await w.manage("/api/workspace-versions"), before, "authorization failure produces no working version");
  } finally { await w.close(); }
});

test("a restore refuses unavailable historical snapshot data even when its artifact metadata still exists", async () => {
  const w = await fixture();
  try {
    const original = (await w.manage("/api/workspace-versions")).versions[0];
    const proposal = await w.proposeRestore(original);
    const checked = (await w.manage("/api/changes/verify", { operationId: "verify", ...ref(proposal) })).change;
    const version = (await w.manage(`/api/workspace-versions/read?number=${original.number}`)).version;
    const before = await w.manage("/api/workspace-versions");
    const snapshotId = version.content.composition.snapshots[0].snapshotId;
    rmSync(snapshotFile(w.service.app.snapshots.executor.root, "workspace", snapshotId));
    const result = await w.request("/api/changes/adopt", { operationId: "adopt", ...ref(checked) });
    assert.ok(result.status >= 400, JSON.stringify(result.body));
    assert.deepEqual(await w.manage("/api/workspace-versions"), before, "missing data does not leave partial semantic or binding versions");
  } finally { await w.close(); }
});

test("a historical binding cannot restore fields removed from the current source contract", async () => {
  const w = await fixture(true);
  try {
    const original = (await w.manage("/api/workspace-versions")).versions[0];
    const uploaded = new Workspace(w.service.app.memory).upload("callbacks.csv", "id,complaintId\nHF002,TS002\n");
    w.service.app.live.sources.connectUpload(uploaded.id, uploaded.version, "id");
    const proposal = await w.proposeRestore(original);
    const before = await w.manage("/api/workspace-versions");
    const result = await w.request("/api/changes/verify", { operationId: "verify", ...ref(proposal) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.change.status, "failed");
    assert.match(result.body.change.content.verification.notes.join(" "), /授权或字段契约已收窄/);
    const refused = await w.request("/api/changes/adopt", { operationId: "adopt", ...ref(result.body.change) });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "not_verified");
    assert.deepEqual(await w.manage("/api/workspace-versions"), before);
  } finally { await w.close(); }
});

test("new data after verification invalidates a restore instead of discarding an unchecked snapshot update", async () => {
  const w = await fixture();
  try {
    const original = (await w.manage("/api/workspace-versions")).versions[0];
    const proposal = await w.proposeRestore(original);
    const checked = (await w.manage("/api/changes/verify", { operationId: "verify", ...ref(proposal) })).change;
    w.upstream.setOutcome("之后的新记录");
    await w.service.app.snapshots.sync({ operationId: "after-verification" });
    const before = await w.manage("/api/workspace-versions");
    const result = await w.request("/api/changes/adopt", { operationId: "adopt", ...ref(checked) });
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.code, "verification_changed");
    assert.deepEqual(await w.manage("/api/workspace-versions"), before);
  } finally { await w.close(); }
});

test("a correction adopted after restore verification requires a fresh review before it can be replaced", async () => {
  const w = await fixture();
  try {
    const original = (await w.manage("/api/workspace-versions")).versions[0];
    const proposal = await w.proposeRestore(original);
    const checked = (await w.manage("/api/changes/verify", { operationId: "verify", ...ref(proposal) })).change;
    const correction = await w.correct([], "after-restore-verification");
    const before = await w.manage("/api/workspace-versions");
    const result = await w.request("/api/changes/adopt", { operationId: "adopt-stale", ...ref(checked) });
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.code, "verification_changed");
    assert.deepEqual(await w.manage("/api/workspace-versions"), before, "the rejected restore cannot create a version or erase the newer decision");
    const active = await w.service.app.live.query({ modelId: w.model.id, type: "投诉", id: "TS002", relation: "回访记录" });
    assert.deepEqual(active.items, []);
    assert.deepEqual(w.service.app.memory.getArtifact(correction.id, correction.version), correction);
    const refreshed = (await w.manage("/api/changes/verify", { operationId: "reverify", ...ref(checked) })).change;
    assert.equal(refreshed.status, "verified");
    const adopted = (await w.manage("/api/changes/adopt", { operationId: "adopt-reviewed", ...ref(refreshed) })).change;
    assert.equal(adopted.status, "adopted", "a new review can deliberately restore the selected historical state");
  } finally { await w.close(); }
});

test("restoring retained uploaded data revalidates the current connection so the restored workspace remains publishable", async () => {
  const w = await fixture(true);
  try {
    const original = (await w.manage("/api/workspace-versions")).versions[0];
    w.uploadCallbacks("已改善");
    await w.service.app.snapshots.sync({ operationId: "new-upload" });
    const proposal = await w.proposeRestore(original);
    const checked = (await w.manage("/api/changes/verify", { operationId: "verify", ...ref(proposal) })).change;
    await w.manage("/api/changes/adopt", { operationId: "adopt", ...ref(checked) });
    const working = (await w.manage("/api/releases")).working;
    const publishCheck = await w.manage("/api/releases/check", { inputHash: working.inputHash });
    assert.equal(publishCheck.status, "ready", JSON.stringify(publishCheck.content.issues));
    const result = await w.service.app.live.query({ modelId: working.modelRef.id, type: "回访", id: "HF002" });
    assert.equal(result.items[0].结果, "未改善");
  } finally { await w.close(); }
});

test("restoring a workspace that used live sources restores that reading mode and labels current data honestly", async () => {
  const w = await fixture(false, false);
  try {
    const original = (await w.manage("/api/workspace-versions")).versions[0];
    w.upstream.setOutcome("已改善");
    await w.service.app.snapshots.sync({ operationId: "later-materialization" });
    const proposal = await w.proposeRestore(original);
    const checked = (await w.manage("/api/changes/verify", { operationId: "verify", ...ref(proposal) })).change;
    assert.ok(checked.content.verification.notes.some((note: string) => note.includes("不承诺历史重放")));
    const adopted = (await w.manage("/api/changes/adopt", { operationId: "adopt", ...ref(checked) })).change;
    const result = await w.service.app.live.query({ modelId: adopted.content.effect.modelRef.id, type: "回访", id: "HF002" });
    assert.equal(result.items[0].结果, "已改善", "a live historical binding still reads current upstream data");
    assert.equal(result.sources[0].readMode, "live");
    const current = (await w.manage("/api/workspace-versions")).versions[0];
    assert.deepEqual((await w.manage(`/api/workspace-versions/read?number=${current.number}`)).version.content.composition.snapshots, []);
  } finally { await w.close(); }
});

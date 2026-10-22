import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";

const companies = "企业编号,企业名称\n" + Array.from({ length: 10 }, (_, i) => `C${i},企业${i}`).join("\n") + "\n";
const ordersFull = "订单号,企业编号\n" + Array.from({ length: 10 }, (_, i) => `O${i},C${i}`).join("\n") + "\n";
// Five of ten orders point at a company that does not exist.
const ordersHalf = "订单号,企业编号\n" + Array.from({ length: 10 }, (_, i) => `O${i},${i < 5 ? `C${i}` : `X${i}`}`).join("\n") + "\n";

async function workspace(orders: string) {
  const directory = mkdtempSync(join(tmpdir(), "context-os-changes-"));
  const service = await createServer({ directory, automaticApi: false });
  await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "X-ContextOS-Token": service.adminToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const files = new Workspace(service.app.memory);
  files.upload("企业.csv", companies); files.upload("订单.csv", orders);
  await service.app.snapshots.sync({ operationId: "sync" });
  const datasets = service.app.snapshots.datasets();
  const id = (name: string) => datasets.find(d => String(d.content.name).includes(name))!.id;
  return { service, call, directory, company: id("企业"), order: id("订单"),
    async close() { await service.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const relation = (w: { company: string; order: string }) => ({ from: { datasetId: w.order, column: "企业编号" }, to: { datasetId: w.company, column: "企业编号" } });
const proposal = (w: any, extra: object = {}) => ({ operationId: "p1", origin: "program", type: "relation", baseline: w.baseline, subject: relation(w), evidence: "程序发现：订单.企业编号 → 企业.企业编号", ...extra });
const baselineOf = async (w: any) => (await w.call("/api/changes")).body.baseline;
async function adoptEntities(w: any) {
  await w.service.app.programBuilds.build({ operationId: "entity-base", autoAdopt: false });
  const candidate = w.service.app.programBuilds.overview().candidate;
  const checked = await w.service.app.programBuilds.check({ id: candidate.id, version: candidate.version });
  await w.service.app.programBuilds.adopt({ id: checked.id, version: checked.version, operationId: "entity-adopt", selection: { entities: checked.content.diff.addedConcepts, relations: [], merges: [] } });
}


test("a relation proposal is verified from snapshot data and recomputed by the server, not taken from the proposer", async () => {
  const w = await workspace(ordersFull) as any;
  try {
    await adoptEntities(w);
    w.baseline = await baselineOf(w);
    // The proposer claims a poor match; the verification must measure the real one.
    const proposed = await w.call("/api/changes/propose", proposal(w, { observed: { matchRate: 0.1, targetUnique: false } }));
    assert.equal(proposed.status, 201);
    assert.equal(proposed.body.change.status, "proposed");
    const verified = await w.call("/api/changes/verify", { operationId: "v1", id: proposed.body.change.id, version: proposed.body.change.version });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    const check = verified.body.change.content.verification;
    assert.equal(verified.body.change.status, "verified");
    assert.equal(check.result, "passed");
    assert.deepEqual([check.metrics.total, check.metrics.matched, check.metrics.matchRate, check.metrics.targetUnique], [10, 10, 1, true]);
  } finally { await w.close(); }
});

test("a relation matching below the review line fails with a stated reason and cannot be adopted", async () => {
  const w = await workspace(ordersHalf) as any;
  try {
    w.baseline = await baselineOf(w);
    const proposed = await w.call("/api/changes/propose", proposal(w));
    const verified = await w.call("/api/changes/verify", { operationId: "v1", id: proposed.body.change.id, version: proposed.body.change.version });
    assert.equal(verified.body.change.content.verification.metrics.matchRate, 0.5);
    assert.equal(verified.body.change.status, "failed", "a 50% match is below the review line");
    assert.match(verified.body.change.content.verification.notes.join(""), /需人工判断|低于|无法/ , "failure reasons are given");
    const adopt = await w.call("/api/changes/adopt", { operationId: "a1", id: verified.body.change.id, version: verified.body.change.version });
    assert.equal(adopt.status, 409);
    assert.equal(adopt.body.code, "not_verified", "a failed change cannot be adopted");
  } finally { await w.close(); }
});

test("a stale baseline is a 409 with a code; unknown change types are refused instead of being accepted unverified", async () => {
  const w = await workspace(ordersFull) as any;
  try {
    w.baseline = await baselineOf(w);
    const stale = await w.call("/api/changes/propose", proposal(w, { baseline: { foundationRef: { id: "gone", version: 9 }, modelRef: null } }));
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.code, "stale_baseline");
    const reserved = await w.call("/api/changes/propose", { ...proposal(w), type: "unrecognized_change", subject: {} });
    assert.equal(reserved.status, 400);
    assert.match(reserved.body.error, /Invalid option|无效/);
    const unaudited = await w.call("/api/changes/propose", proposal(w, { evidence: undefined }));
    assert.equal(unaudited.status, 400, "program and agent proposals must carry evidence");
  } finally { await w.close(); }
});

test("operation ids replay the original result and cannot be reused for a different request", async () => {
  const w = await workspace(ordersFull) as any;
  try {
    w.baseline = await baselineOf(w);
    const first = await w.call("/api/changes/propose", proposal(w));
    const again = await w.call("/api/changes/propose", proposal(w));
    assert.equal(again.body.change.id, first.body.change.id);
    assert.equal(again.body.change.version, first.body.change.version);
    assert.equal((await w.call("/api/changes")).body.total, 1, "a replay does not create a second change");
    const reused = await w.call("/api/changes/propose", proposal(w, { subject: { from: { datasetId: w.company, column: "企业编号" }, to: { datasetId: w.order, column: "订单号" } } }));
    assert.equal(reused.status, 400);
    assert.match(reused.body.error, /幂等/);
  } finally { await w.close(); }
});

test("a rejected program proposal is not raised again until the match rate moves by more than 20 points or uniqueness changes", async () => {
  const w = await workspace(ordersFull) as any;
  try {
    w.baseline = await baselineOf(w);
    const first = await w.call("/api/changes/propose", proposal(w, { observed: { matchRate: 0.9, targetUnique: true } }));
    const rejected = await w.call("/api/changes/reject", { operationId: "r1", id: first.body.change.id, version: first.body.change.version, reason: "业务上不是这个关联" });
    assert.equal(rejected.body.change.status, "rejected");
    // Same fingerprint, similar numbers: remembered, so nothing new is created.
    const quiet = await w.call("/api/changes/propose", proposal(w, { operationId: "p2", observed: { matchRate: 0.85, targetUnique: true } }));
    assert.equal(quiet.body.suppressed, true);
    assert.equal(quiet.body.change.id, first.body.change.id);
    assert.equal((await w.call("/api/changes", undefined)).body.total, 1);
    const forged = await w.call("/api/changes/propose", proposal(w, { operationId: "forged", observed: { matchRate: 0.5, targetUnique: false } }));
    assert.equal(forged.body.suppressed, true, "supplied metrics cannot override remembered rejection");
    // Real data changed materially: the proposal may come back.
    new Workspace(w.service.app.memory).upload("订单.csv", ordersHalf);
    await w.service.app.snapshots.sync({ operationId: "changed-orders" });
    const moved = await w.call("/api/changes/propose", proposal(w, { operationId: "p3" }));
    assert.equal(moved.body.suppressed, false);
    assert.notEqual(moved.body.change.id, first.body.change.id);
    new Workspace(w.service.app.memory).upload("企业.csv", companies + "C0,重复企业\n");
    await w.service.app.snapshots.sync({ operationId: "changed-uniqueness" });
    const uniq = await w.call("/api/changes/propose", proposal(w, { operationId: "p4" }));
    assert.equal(uniq.body.suppressed, false, "a change in target uniqueness also reopens it");
  } finally { await w.close(); }
});

test("withdrawing a program proposal does not suppress it later, and a decided change cannot be decided again", async () => {
  const w = await workspace(ordersFull) as any;
  try {
    w.baseline = await baselineOf(w);
    const first = await w.call("/api/changes/propose", proposal(w, { observed: { matchRate: 0.9, targetUnique: true } }));
    const withdrawn = await w.call("/api/changes/withdraw", { operationId: "w1", id: first.body.change.id, version: first.body.change.version, reason: "提错了" });
    assert.equal(withdrawn.body.change.content.disposition, "withdrawn");
    const back = await w.call("/api/changes/propose", proposal(w, { operationId: "p2", observed: { matchRate: 0.9, targetUnique: true } }));
    assert.equal(back.body.suppressed, false, "only an explicit rejection is remembered");
    const twice = await w.call("/api/changes/reject", { operationId: "r2", id: first.body.change.id, version: withdrawn.body.change.version, reason: "再次" });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.code, "invalid_transition");
  } finally { await w.close(); }
});

test("naming and description changes verify against the adopted foundation", async () => {
  const w = await workspace(ordersFull) as any;
  try {
    seedFoundation(w.service.app.memory, w.service.app.foundation, { enterprise: "测试公司",
      concepts: [{ id: "c_order", name: "订单", description: "客户订单" }, { id: "c_company", name: "企业", description: "客户企业" }] });
    w.baseline = await baselineOf(w);
    const ok = await w.call("/api/changes/propose", { operationId: "n1", origin: "human", type: "naming", baseline: w.baseline, subject: { target: "concept", id: "c_order", name: "销售订单" } });
    const good = await w.call("/api/changes/verify", { operationId: "nv1", id: ok.body.change.id, version: ok.body.change.version });
    assert.equal(good.body.change.content.verification.result, "passed");
    const dup = await w.call("/api/changes/propose", { operationId: "n2", origin: "human", type: "naming", baseline: w.baseline, subject: { target: "concept", id: "c_order", name: "企业" } });
    const bad = await w.call("/api/changes/verify", { operationId: "nv2", id: dup.body.change.id, version: dup.body.change.version });
    assert.equal(bad.body.change.status, "failed");
    assert.equal(bad.body.change.content.verification.metrics.nameUnique, false);
    const missing = await w.call("/api/changes/propose", { operationId: "d1", origin: "human", type: "description", baseline: w.baseline, subject: { target: "concept", id: "c_nope", description: "x" } });
    const none = await w.call("/api/changes/verify", { operationId: "dv1", id: missing.body.change.id, version: missing.body.change.version });
    assert.equal(none.body.change.content.verification.metrics.targetExists, false);
  } finally { await w.close(); }
});

test("a verified wording change is really adopted with one working version and the same change receipt", async () => {
  const w = await workspace(ordersFull) as any;
  try {
    seedFoundation(w.service.app.memory, w.service.app.foundation, { enterprise: "测试公司", concepts: [{ id: "c_order", name: "订单", description: "客户订单" }] });
    const before = (await w.call("/api/workspace-versions")).body.versions;
    const proposed = await w.call("/api/changes/propose", { operationId: "rename", origin: "human", type: "naming", baseline: await baselineOf(w), subject: { target: "concept", id: "c_order", name: "销售订单" } });
    const checked = (await w.call("/api/changes/verify", { operationId: "rename-check", id: proposed.body.change.id, version: proposed.body.change.version })).body.change;
    const adopted = await w.call("/api/changes/adopt", { operationId: "rename-adopt", id: checked.id, version: checked.version });
    assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
    assert.equal(w.service.app.foundation.read().adopted.content.concepts[0].name, "销售订单");
    const after = (await w.call("/api/workspace-versions")).body.versions;
    assert.equal(after.length, before.length + 1);
    assert.ok(after[0].changeRefs.some((r: any) => r.id === checked.id), "working version identifies the adopted change");
  } finally { await w.close(); }
});

test("program structure changes persist individually; partial adoption leaves the other item available and rejection stays quiet on rebuild", async () => {
  const w = await workspace(ordersFull) as any;
  try {
    await w.service.app.programBuilds.build({ operationId: "initial", autoAdopt: true });
    const files = new Workspace(w.service.app.memory);
    files.upload("products.csv", "product_id,label\nP1,甲\nP2,乙\n");
    files.upload("teams.csv", "team_id,label\nT1,一组\nT2,二组\n");
    await w.service.app.programBuilds.build({ operationId: "new-objects", autoAdopt: true });
    let pending = (await w.call("/api/changes?status=proposed&type=entity")).body.changes.filter((a: any) => a.origin === "program");
    assert.equal(pending.length, 2, "each new object is a persistent pending change");
    const checked = (await w.call("/api/changes/verify", { operationId: "check-one", id: pending[0].id, version: pending[0].version })).body.change;
    const adopted = await w.call("/api/changes/adopt", { operationId: "adopt-one", id: checked.id, version: checked.version });
    assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
    pending = (await w.call("/api/changes?status=proposed&type=entity")).body.changes.filter((a: any) => a.origin === "program");
    assert.equal(pending.length, 1, "the unselected item is still available without a rebuild");
    const remaining = pending[0];
    const next = await w.call("/api/changes/verify", { operationId: "check-other", id: remaining.id, version: remaining.version });
    assert.equal(next.status, 200, JSON.stringify(next.body));
    const rejected = await w.call("/api/changes/reject", { operationId: "reject-other", id: next.body.change.id, version: next.body.change.version, reason: "此表暂不建模" });
    assert.equal(rejected.status, 200);
    await w.service.app.programBuilds.build({ operationId: "repeat", autoAdopt: true });
    pending = (await w.call("/api/changes?status=proposed&type=entity")).body.changes.filter((a: any) => a.origin === "program");
    assert.equal(pending.length, 0, "the rejected item is not silently proposed again");
  } finally { await w.close(); }
});

test("a verified column relation creates an executable relation in the working ontology", async () => {
  const w = await workspace(ordersFull) as any;
  try {
    await w.service.app.programBuilds.build({ operationId: "relation-base", autoAdopt: false });
    const candidate = w.service.app.programBuilds.overview().candidate;
    const checked = await w.service.app.programBuilds.check({ id: candidate.id, version: candidate.version });
    await w.service.app.programBuilds.adopt({ id: checked.id, version: checked.version, operationId: "entities-only", selection: { entities: checked.content.diff.addedConcepts, relations: [], merges: [] } });
    w.baseline = await baselineOf(w);
    const proposed = await w.call("/api/changes/propose", proposal(w));
    const verified = await w.call("/api/changes/verify", { operationId: "relation-check", id: proposed.body.change.id, version: proposed.body.change.version });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    const adopted = await w.call("/api/changes/adopt", { operationId: "relation-adopt", id: verified.body.change.id, version: verified.body.change.version });
    assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
    const active = w.service.app.live.overview().models.find((item: any) => item.status === "adopted");
    const relation = active.content.relations[0];
    assert.ok(relation.relationId, "the relation has a stable semantic identity");
    const origins = await w.service.app.live.query({ modelId: active.id, modelVersion: active.version, type: relation.from, limit: 1 });
    const objects = await w.service.app.live.query({ modelId: active.id, modelVersion: active.version, type: relation.from, id: origins.items[0].$id, relation: relation.name });
    assert.equal(objects.items.length, 1);
    assert.ok(Object.values(objects.items[0]).includes("C0"));
  } finally { await w.close(); }
});

const ordersReview = "订单号,企业编号\n" + Array.from({ length: 10 }, (_, i) => `O${i},${i < 8 ? `C${i}` : `X${i}`}`).join("\n") + "\n";

test("a relation between the review and pass lines needs explicit acknowledgement before it can be adopted", async () => {
  const w = await workspace(ordersReview) as any;
  try {
    await adoptEntities(w);
    w.baseline = await baselineOf(w);
    const proposed = await w.call("/api/changes/propose", proposal(w));
    const verified = await w.call("/api/changes/verify", { operationId: "v1", id: proposed.body.change.id, version: proposed.body.change.version });
    assert.equal(verified.body.change.content.verification.result, "review");
    assert.equal(verified.body.change.status, "verified");
    const refused = await w.call("/api/changes/adopt", { operationId: "a1", id: verified.body.change.id, version: verified.body.change.version });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "review_required");
    const before = (await w.call("/api/workspace-versions")).body.versions.length;
    const adopted = await w.call("/api/changes/adopt", { operationId: "a2", id: verified.body.change.id, version: verified.body.change.version, acknowledgeReview: true });
    assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
    assert.equal(adopted.body.change.status, "adopted");
    assert.equal(adopted.body.change.content.decision.acknowledgedReview, true);
    assert.equal((await w.call("/api/workspace-versions")).body.versions.length, before + 1);
    const replay = await w.call("/api/changes/adopt", { operationId: "a2", id: verified.body.change.id, version: verified.body.change.version, acknowledgeReview: true });
    assert.equal(replay.body.change.version, adopted.body.change.version);
    assert.equal((await w.call("/api/workspace-versions")).body.versions.length, before + 1, "a replay does not apply the change twice");
  } finally { await w.close(); }
});

test("adoption re-reads the data: a change verified before the source moved is not adopted on the old result", async () => {
  const w = await workspace(ordersFull) as any;
  try {
    await adoptEntities(w);
    w.baseline = await baselineOf(w);
    const proposed = await w.call("/api/changes/propose", proposal(w));
    const verified = await w.call("/api/changes/verify", { operationId: "v1", id: proposed.body.change.id, version: proposed.body.change.version });
    assert.equal(verified.body.change.content.verification.result, "passed");
    // The orders are replaced by a file where half no longer match, and synced as a new snapshot.
    new Workspace(w.service.app.memory).upload("订单.csv", ordersHalf);
    await w.service.app.snapshots.sync({ operationId: "sync-2" });
    const stale = await w.call("/api/changes/adopt", { operationId: "a1", id: verified.body.change.id, version: verified.body.change.version });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.code, "verification_changed");
    assert.equal((await w.call(`/api/changes/read?id=${verified.body.change.id}`)).body.change.status, "verified", "the change is left as it was");
  } finally { await w.close(); }
});


test("a numeric relation match cannot verify before both endpoint entities are adopted", async () => {
  const w = await workspace(ordersFull) as any;
  try {
    w.baseline = await baselineOf(w);
    const proposed = await w.call("/api/changes/propose", proposal(w));
    const checked = await w.call("/api/changes/verify", { operationId: "no-endpoints", id: proposed.body.change.id, version: proposed.body.change.version });
    assert.equal(checked.body.change.status, "failed");
    assert.equal(checked.body.change.content.verification.metrics.matchRate, 1);
    assert.match(checked.body.change.content.verification.notes.join(""), /端点实体/);
  } finally { await w.close(); }
});

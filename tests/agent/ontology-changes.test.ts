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
  const directory = mkdtempSync(join(tmpdir(), "ade-changes-"));
  const service = await createServer({ directory, automaticApi: false });
  await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "X-DataEngine-Token": service.adminToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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

test("a relation proposal is verified from snapshot data and recomputed by the server, not taken from the proposer", async () => {
  const w = await workspace(ordersFull) as any;
  try {
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
    const reserved = await w.call("/api/changes/propose", { ...proposal(w), type: "identity_rule", subject: {} });
    assert.equal(reserved.status, 400);
    assert.match(reserved.body.error, /尚未接入/);
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
    // The data changed materially: the proposal may come back.
    const moved = await w.call("/api/changes/propose", proposal(w, { operationId: "p3", observed: { matchRate: 0.5, targetUnique: true } }));
    assert.equal(moved.body.suppressed, false);
    assert.notEqual(moved.body.change.id, first.body.change.id);
    const uniq = await w.call("/api/changes/propose", proposal(w, { operationId: "p4", observed: { matchRate: 0.9, targetUnique: false } }));
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

const ordersReview = "订单号,企业编号\n" + Array.from({ length: 10 }, (_, i) => `O${i},${i < 8 ? `C${i}` : `X${i}`}`).join("\n") + "\n";

test("a relation between the review and pass lines needs explicit acknowledgement before it can be adopted", async () => {
  const w = await workspace(ordersReview) as any;
  const applied: string[] = [];
  try {
    w.service.app.changes.registerApplier("relation", (change: any) => { applied.push(change.id); return { applied: true }; });
    w.baseline = await baselineOf(w);
    const proposed = await w.call("/api/changes/propose", proposal(w));
    const verified = await w.call("/api/changes/verify", { operationId: "v1", id: proposed.body.change.id, version: proposed.body.change.version });
    assert.equal(verified.body.change.content.verification.result, "review");
    assert.equal(verified.body.change.status, "verified");
    const refused = await w.call("/api/changes/adopt", { operationId: "a1", id: verified.body.change.id, version: verified.body.change.version });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "review_required");
    assert.deepEqual(applied, [], "nothing is applied without acknowledgement");
    const adopted = await w.call("/api/changes/adopt", { operationId: "a2", id: verified.body.change.id, version: verified.body.change.version, acknowledgeReview: true });
    assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
    assert.equal(adopted.body.change.status, "adopted");
    assert.equal(adopted.body.change.content.decision.acknowledgedReview, true);
    assert.deepEqual(applied, [verified.body.change.id]);
    const replay = await w.call("/api/changes/adopt", { operationId: "a2", id: verified.body.change.id, version: verified.body.change.version, acknowledgeReview: true });
    assert.equal(replay.body.change.version, adopted.body.change.version);
    assert.equal(applied.length, 1, "a replay does not apply the change twice");
  } finally { await w.close(); }
});

test("adoption re-reads the data: a change verified before the source moved is not adopted on the old result", async () => {
  const w = await workspace(ordersFull) as any;
  try {
    w.service.app.changes.registerApplier("relation", () => ({ applied: true }));
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

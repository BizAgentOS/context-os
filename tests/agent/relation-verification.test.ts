import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer as httpServer } from "node:http";
import type { Artifact, Data } from "../../src/agent/contracts.ts";
import { createServer } from "../../src/agent/server.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { identityWorkspace } from "./identity-fixture.ts";

const ref = (a: Artifact) => ({ id: a.id, version: a.version });
async function setup(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "context-os-relation-rules-"));
  const service = await createServer({ directory, automaticApi: false });
  await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const workspace = new Workspace(service.app.memory);
  for (const [name, contents] of Object.entries(files)) workspace.upload(name, contents);
  await service.app.snapshots.sync({ operationId: "initial-sync" });
  const dataset = (name: string) => service.app.snapshots.datasets().find(d => d.content.name === name)!;
  const call = async (path: string, body: unknown) => {
    const response = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "X-ContextOS-Token": service.adminToken }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const verify = async (subject: Data, operationId = "relation") => {
    const proposed = await call("/api/changes/propose", { operationId, origin: "human", type: "relation", subject, baseline: service.app.changes.currentBaseline() });
    assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
    const checked = await call("/api/changes/verify", { ...ref(proposed.body.change), operationId: operationId + "-check" });
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    return checked.body.change as Artifact;
  };
  return { service, dataset, call, verify, async close() { await service.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("relation verification does not equate numeric values with string identifiers", async () => {
  const w = await identityWorkspace();
  try {
    w.rows.accounts = [{ id: "A1", email: 1, username: "one" }, { id: "A2", email: 2, username: "two" }];
    w.rows.people = [{ id: "P1", email: "1", name: "甲" }, { id: "P2", email: "2", name: "乙" }];
    await w.service.app.snapshots.sync({ operationId: "typed-values" });
    for (const dataset of w.service.app.snapshots.datasets()) if (dataset.content.pendingVersion)
      await w.service.app.snapshots.accept({ ...ref(dataset), operationId: `accept-${dataset.id}` });
    const source = w.service.app.snapshots.bindingDataset(w.sources.accounts.id, "accounts")!;
    const target = w.service.app.snapshots.bindingDataset(w.sources.people.id, "people")!;
    const proposed = await w.call("/api/changes/propose", { operationId: "typed-relation", origin: "human", type: "relation", baseline: w.service.app.changes.currentBaseline(), subject: { from: { datasetId: source.id, column: "email" }, to: { datasetId: target.id, column: "email" } } });
    assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
    const response = await w.call("/api/changes/verify", { ...ref(proposed.body.change), operationId: "typed-check" });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const checked = response.body.change;
    assert.equal((checked.content.verification as Data).metrics && ((checked.content.verification as Data).metrics as Data).typeCompatible, false);
    assert.equal(checked.status, "failed");
    assert.match(String((checked.content.verification as Data).notes), /类型/);
  } finally { await w.close(); }
});

test("declared acyclic hierarchies reject loops and excessive depth using the full snapshot", async t => {
  for (const [name, csv, metric] of [
    ["self-loop", "person_id,manager_id\nP1,P1\nP2,\n", "acyclic"],
    ["two-record-cycle", "person_id,manager_id\nP1,P2\nP2,P1\n", "acyclic"],
    ["eleven-level-chain", "person_id,manager_id\n" + Array.from({ length: 12 }, (_, i) => `P${i},${i === 11 ? "" : `P${i + 1}`}`).join("\n") + "\n", "withinMaxDepth"],
  ]) await t.test(name, async () => {
    const w = await setup({ "people.csv": csv });
    try {
      const id = w.dataset("people.csv").id;
      const checked = await w.verify({ from: { datasetId: id, column: "manager_id" }, to: { datasetId: id, column: "person_id" }, acyclic: true });
      assert.equal(checked.status, "failed");
      const verification = checked.content.verification as Data;
      assert.equal((verification.metrics as Data)[metric], false, JSON.stringify(verification));
      const attempt = await w.call("/api/changes/adopt", { ...ref(checked), operationId: "must-refuse" });
      assert.equal(attempt.status, 409);
    } finally { await w.close(); }
  });
});

test("valid hierarchy adopts with its acyclic declaration, queryable parent and measured empty-root coverage", async () => {
  const w = await setup({ "people.csv": "person_id,manager_id,name\nP1,,总经理\nP2,P1,主管\nP3,P2,员工\n" });
  try {
    await w.service.app.programBuilds.build({ operationId: "people", autoAdopt: false });
    const candidate = w.service.app.programBuilds.overview().candidate!;
    const checkedCandidate = await w.service.app.programBuilds.check(ref(candidate));
    await w.service.app.programBuilds.adopt({ ...ref(checkedCandidate), operationId: "people-adopt", selection: { entities: (candidate.content.diff as Data).addedConcepts, relations: [], merges: [] } });
    const id = w.dataset("people.csv").id;
    const checked = await w.verify({ from: { datasetId: id, column: "manager_id" }, to: { datasetId: id, column: "person_id" }, acyclic: true, maxDepth: 10 });
    assert.equal(checked.status, "verified", JSON.stringify(checked.content.verification));
    const metrics = (checked.content.verification as Data).metrics as Data;
    assert.deepEqual([metrics.total, metrics.matched, metrics.acyclic, metrics.maxDepth], [2, 2, true, 2]);
    assert.ok(Math.abs(Number(metrics.sourceNonNullRate) - 2 / 3) < 0.001);
    const result = await w.call("/api/changes/adopt", { ...ref(checked), operationId: "hierarchy-adopt" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const active = w.service.app.live.overview().models.find(model => model.status === "adopted")!;
    const layered = active.content.layered as Data;
    const relation = ((layered.semantic as Data).relationTypes as Data[]).find(r => r.id === result.body.change.content.effect.relationId)!;
    assert.deepEqual([relation.allowSelf, relation.acyclic, relation.maxDepth], [true, true, 10]);
    const type = (active.content.types as Data[])[0];
    const queried = await w.service.app.live.query({ modelId: active.id, modelVersion: active.version, type: type.name, id: "P3", relation: relation.name });
    assert.equal(queried.items[0].$id, "P2");
  } finally { await w.close(); }
});

test("one-to-one verification refuses repeated source keys and empty keys never count as matching objects", async () => {
  const w = await setup({ "orders.csv": "order_id,customer_id\nO1,C1\nO2,C1\nO3,\n", "customers.csv": "customer_id,name\nC1,甲\nC2,乙\n" });
  try {
    const checked = await w.verify({ from: { datasetId: w.dataset("orders.csv").id, column: "customer_id" }, to: { datasetId: w.dataset("customers.csv").id, column: "customer_id" }, cardinality: "1:1" });
    assert.equal(checked.status, "failed");
    const metrics = (checked.content.verification as Data).metrics as Data;
    assert.deepEqual([metrics.total, metrics.matched, metrics.cardinalityValid], [2, 2, false]);
    assert.equal(metrics.sourceNonNullRate, 0.6667);
  } finally { await w.close(); }
});

test("numeric hierarchies detect cycles when child and parent columns have different numeric storage types", async () => {
  const w = await identityWorkspace();
  const server = httpServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ items: [{ id: 1, parent: 2 }, { id: 2, parent: 1 }, { id: 3, parent: 2.5 }], total: 3 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const source = await w.service.app.live.sources.connect({ name: "numeric hierarchy", protocol: "http", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, capabilities: [{ name: "hierarchy", path: "/", fields: ["id", "parent"], idField: "id", idType: "number", totalPath: "total" }] });
    await w.service.app.snapshots.sync({ operationId: "numeric-hierarchy" });
    const dataset = w.service.app.snapshots.bindingDataset(source.id, "hierarchy")!;
    const proposed = await w.call("/api/changes/propose", { operationId: "numeric-loop", origin: "human", type: "relation", baseline: w.service.app.changes.currentBaseline(), subject: { from: { datasetId: dataset.id, column: "parent" }, to: { datasetId: dataset.id, column: "id" }, acyclic: true } });
    assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
    const response = await w.call("/api/changes/verify", { ...ref(proposed.body.change), operationId: "numeric-loop-check" });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.change.status, "failed");
    assert.equal(response.body.change.content.verification.metrics.cycleDetected, true, JSON.stringify(response.body.change.content.verification));
    assert.equal(response.body.change.content.verification.metrics.acyclic, false);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await w.close(); }
});

test("relation adoption refuses a snapshot that changes while its remaining preparation is in flight", async t => {
  const w = await identityWorkspace();
  try {
    const app = w.service.app;
    const source = app.snapshots.bindingDataset(w.sources.staff.id, "staff")!;
    const target = app.snapshots.bindingDataset(w.sources.people.id, "people")!;
    const proposed = await w.call("/api/changes/propose", { operationId: "race-propose", origin: "human", type: "relation", baseline: app.changes.currentBaseline(), subject: { from: { datasetId: source.id, column: "email" }, to: { datasetId: target.id, column: "email" } } });
    const checked = await w.call("/api/changes/verify", { ...ref(proposed.body.change), operationId: "race-verify" });
    assert.equal(checked.body.change.status, "verified", JSON.stringify(checked.body));
    const baseline = app.changes.currentBaseline();
    let versionsAfterSync = 0;
    const prepare = app.live.prepareDefinitionAgainst.bind(app.live);
    t.mock.method(app.live, "prepareDefinitionAgainst", async (...args: Parameters<typeof prepare>) => {
      const prepared = await prepare(...args);
      w.rows.staff[1].email = "nobody@example.test";
      await app.snapshots.sync({ operationId: "during-relation-adoption" });
      versionsAfterSync = app.memory.listArtifacts("workspace_version").length;
      return prepared;
    });
    const adopted = await w.call("/api/changes/adopt", { ...ref(checked.body.change), operationId: "race-adopt" });
    assert.equal(adopted.status, 409, JSON.stringify(adopted.body));
    assert.equal(adopted.body.code, "verification_changed");
    assert.deepEqual(app.changes.currentBaseline(), baseline);
    assert.equal(app.memory.listArtifacts("workspace_version").length, versionsAfterSync);
  } finally { await w.close(); }
});

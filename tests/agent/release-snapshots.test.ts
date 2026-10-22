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
import { OntologyDatasets } from "../../src/live/ontology-datasets.ts";
import { Snapshots } from "../../src/data/snapshots.ts";
import { ProgramBuilds } from "../../src/engine/program-builds.ts";
import { Releases } from "../../src/engine/releases.ts";
import { OntologyChanges } from "../../src/engine/changes.ts";
import { connectIdentityChanges } from "../../src/engine/identity-changes.ts";

const ref = (a: { id: string; version: number }) => ({ id: a.id, version: a.version });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "context-os-release-snapshots-"));
  const memory = new MemoryStore(directory);
  const live = new LiveMemory(directory, memory);
  const foundation = new FoundationService(memory, live);
  const snapshots = new Snapshots(memory, live, directory);
  const engine = new ProgramBuilds(memory, foundation, live, snapshots);
  const changes = new OntologyChanges(memory, foundation, snapshots);
  connectIdentityChanges(memory, foundation, live, changes);
  const releases = new Releases(memory, live), datasets = new OntologyDatasets(memory, live);
  return { memory, live, snapshots, engine, changes, releases, datasets, workspace: new Workspace(memory),
    read: async (key: string, type: string, id: string) => datasets.handle("/v4/objects", new URLSearchParams({ type, id }), "Bearer " + key),
    async adoptBuild(operationId: string) {
      await engine.build({ operationId });
      const candidate = engine.overview().candidate!;
      const checked = await engine.check({ id: candidate.id, version: candidate.version });
      assert.equal((checked.content.checks as any).valid, true, JSON.stringify(checked.content.checks));
      return engine.adopt({ id: checked.id, version: checked.version, operationId: operationId + ":adopt" });
    },
    async publish(name: string) {
      const check = await releases.check({ inputHash: releases.overview().working.inputHash });
      assert.equal(check.status, "ready", JSON.stringify(check.content.issues));
      return releases.publish({ operationId: "publish:" + name, checkRef: ref(check), name }).release;
    },
    async close() { await engine.close(); await snapshots.close(); memory.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("a published release keeps serving its locked snapshot after the source changes; the next release shows the data diff and an upgrade reads it", async () => {
  const f = fixture();
  let rows = Array.from({ length: 12 }, (_, i) => ({ id: `C${i}`, name: `公司${i}`, tier: "gold" }));
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const selected = rows.filter(r => !url.searchParams.has("id") || r.id === url.searchParams.get("id"));
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 20);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: selected.slice(offset, offset + limit), total: selected.length }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await f.live.sources.connect({ name: "企业目录", protocol: "http", url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      capabilities: [{ name: "companies", path: "/companies", fields: ["id", "name", "tier"], idField: "id", totalPath: "total", filters: { id: "id" } }] });
    const adopted = await f.adoptBuild("b1");
    const type = (adopted.model.content.types as any[])[0], concept = String(type.conceptId);
    const working = f.releases.overview().working;
    assert.equal((working.definition.snapshots as any[]).length, 1);
    assert.deepEqual(working.definition.accessPolicy, { facts: "per_source_strategy", snapshot: "pinned", consistency: "pinned_snapshot", historicalReplay: true });
    assert.equal((working.definition.sourceAccess as any[])[0].strategy, "snapshot");
    const v1 = await f.publish("v1");

    const grants = [{ type: type.name, fields: ["$id", "name", "tier"], relations: [] }];
    const a = f.releases.connect({ operationId: "a", name: "A", releaseRef: ref(v1), conceptIds: [concept], relationIds: [], business: { grants } });
    const first = await f.read(a.key!, type.name, "C1");
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal((first.body as any).items[0].properties.tier.value, "gold");

    rows = rows.map(r => r.id === "C1" ? { ...r, tier: "platinum" } : r).concat([{ id: "C99", name: "新公司", tier: "silver" }]);
    await f.snapshots.sync({ operationId: "refresh" });
    const stillOld = await f.read(a.key!, type.name, "C1");
    assert.equal((stillOld.body as any).items[0].properties.tier.value, "gold", "the v1 consumer keeps reading the locked snapshot");
    assert.equal((stillOld.body as any).consistency, "pinned_snapshot");
    assert.ok((stillOld.body as any).reads.every((r: any) => r.historicalReplay === true));

    const diff = await f.releases.dataDiff({});
    const changed = (diff.datasets as unknown as any[])[0];
    assert.equal(changed.status, "changed");
    assert.deepEqual([changed.added, changed.removed, changed.changed], [1, 0, 1]);
    assert.deepEqual(changed.samples, [
      { kind: "added", k: "C99", before: null, after: { id: "C99", name: "新公司", tier: "silver" } },
      { kind: "changed", k: "C1", before: { id: "C1", name: "公司1", tier: "gold" }, after: { id: "C1", name: "公司1", tier: "platinum" } },
    ]);
    assert.ok(f.releases.overview().working.diff.some(d => String(d.path).includes("snapshots")), "the definition diff shows the new snapshot version");

    const v2 = await f.publish("v2");
    const between = await f.releases.dataDiff({ from: ref(v1), to: ref(v2) });
    assert.equal((between.datasets as unknown as any[])[0].changed, 1);
    const upgraded = f.releases.upgrade({ operationId: "up", connectionRef: ref(a.connection), releaseRef: ref(v2) });
    const fresh = await f.read(upgraded.key!, type.name, "C1");
    assert.equal((fresh.body as any).items[0].properties.tier.value, "platinum");
    assert.equal((await f.read(a.key!, type.name, "C1")).status, 403, "the replaced dataset key is revoked");
  } finally { await new Promise(resolve => server.close(resolve)); await f.close(); }
});

test("an old release keeps reading a re-uploaded CSV's locked version, and a pending schema change blocks the next release", async () => {
  const f = fixture();
  try {
    f.workspace.upload("产品.csv", "产品编号,名称,价格\nP1,甲,10\nP2,乙,20\n");
    const adopted = await f.adoptBuild("b1");
    const type = (adopted.model.content.types as any[])[0];
    const v1 = await f.publish("v1");
    const a = f.releases.connect({ operationId: "a", name: "A", releaseRef: ref(v1), conceptIds: [String(type.conceptId)], relationIds: [], business: { grants: [{ type: type.name, fields: ["$id", "名称", "价格"], relations: [] }] } });

    f.workspace.upload("产品.csv", "产品编号,名称,价格\nP1,甲,99\nP2,乙,20\n");
    await f.snapshots.sync({ operationId: "s2" });
    const old = await f.read(a.key!, type.name, "P1");
    assert.equal(old.status, 200, JSON.stringify(old.body));
    assert.equal((old.body as any).items[0].properties["价格"].value, "10");

    f.workspace.upload("产品.csv", "产品编号,名称,价格,库存\nP1,甲,99,5\nP2,乙,20,7\n");
    await f.snapshots.sync({ operationId: "s3" });
    const issues = f.releases.overview().working.issues;
    assert.ok(issues.some(i => i.code === "pending_schema"), JSON.stringify(issues));
    assert.equal((await f.releases.check({ inputHash: f.releases.overview().working.inputHash })).status, "blocked");
    assert.equal(((await f.read(a.key!, type.name, "P1")).body as any).items[0].properties["价格"].value, "10", "drift never reaches published consumers");
  } finally { await f.close(); }
});

test("a release whose object merges a second source can be checked and read through both pinned snapshots", async () => {
  const f = fixture();
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: `C${i}`, tier: i % 2 ? "gold" : "silver" }));
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const selected = rows.filter(r => !url.searchParams.has("id") || r.id === url.searchParams.get("id"));
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 20);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: selected.slice(offset, offset + limit), total: selected.length }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await f.live.sources.connect({ name: "企业目录", protocol: "http", url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      capabilities: [{ name: "companies", path: "/companies", fields: ["id", "tier"], idField: "id", totalPath: "total", filters: { id: "id" } }] });
    f.workspace.upload("企业.csv", "企业编号,企业名称\n" + rows.map((r, i) => `${r.id},公司${i}`).join("\n") + "\n");
    const adopted = await f.adoptBuild("merged");
    const independentTypes = adopted.model.content.types as any[];
    assert.equal(independentTypes.length, 2, "matching identifiers remain separate objects until an identity rule is adopted");
    assert.ok(independentTypes.every(type => !type.supplements?.length));
    const layered = f.live.readLayered(adopted.model.id);
    const primary = layered.bindings.entities.find(binding => binding.dataset.capability === "companies")!;
    const supplement = layered.bindings.entities.find(binding => binding.role === "primary" && binding.id !== primary.id)!;
    const proposal = await f.changes.propose({ operationId: "company-identity", origin: "human", type: "identity_rule", baseline: f.changes.currentBaseline(),
      subject: { kind: "same_as", left: { bindingId: supplement.id, columns: ["企业编号"] }, right: { bindingId: primary.id, columns: ["id"] },
        reason: "企业目录与企业名册描述同一家公司", evidence: "逐项核对企业编号和名称" } });
    const verified = await f.changes.verify({ operationId: "verify-company-identity", ...ref(proposal.change) });
    assert.equal(verified.status, "verified", JSON.stringify(verified.content.verification));
    const governed = await f.changes.adopt({ operationId: "adopt-company-identity", ...ref(verified), acknowledgeReview: true });
    const modelRef = (governed.content.effect as any).modelRef;
    const model = f.memory.getArtifact(modelRef.id, modelRef.version);
    const type = (model.content.types as any[]).find(type => type.conceptId === primary.entityTypeId);
    assert.equal(type.supplements?.length, 1, JSON.stringify(adopted.model.content.types));
    const v1 = await f.publish("v1");
    const props = [...Object.keys(type.fields), ...Object.keys(type.supplements[0].fields)];
    const a = f.releases.connect({ operationId: "a", name: "A", releaseRef: ref(v1), conceptIds: [String(type.conceptId)], relationIds: [],
      business: { grants: [{ type: type.name, fields: ["$id", ...props], relations: [] }] } });
    const read = await f.read(a.key!, type.name, "C3");
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.ok(JSON.stringify(read.body).includes("公司3") && JSON.stringify(read.body).includes("gold"), JSON.stringify(read.body).slice(0, 600));
    assert.equal((read.body as any).consistency, "pinned_snapshot");
  } finally { await new Promise(resolve => server.close(resolve)); await f.close(); }
});

test("creating and switching release consumers after a CSV update uses the locked contract and still respects revocation", async () => {
  const f = fixture();
  try {
    f.workspace.upload("产品.csv", "产品编号,名称,价格\nP1,甲,10\nP2,乙,20\n");
    const adopted = await f.adoptBuild("original");
    const type = (adopted.model.content.types as any[])[0];
    const v1 = await f.publish("v1"), v2 = await f.publish("v2");
    const selection = { releaseRef: ref(v1), conceptIds: [String(type.conceptId)], relationIds: [],
      business: { grants: [{ type: type.name, fields: ["$id", "名称", "价格"], relations: [] }] } };
    const first = f.releases.connect({ ...selection, operationId: "first", name: "更新前接入" });

    f.workspace.upload("产品.csv", "产品编号,名称,价格\nP1,甲,99\nP2,乙,20\n");
    await f.snapshots.sync({ operationId: "refresh" });
    const added = f.releases.connect({ ...selection, operationId: "added", name: "更新后接入旧版" });
    const oldValue = await f.read(added.key!, type.name, "P1");
    assert.equal(oldValue.status, 200, JSON.stringify(oldValue.body));
    assert.equal((oldValue.body as any).items[0].properties["价格"].value, "10");

    const switched = f.releases.upgrade({ operationId: "switch", connectionRef: ref(first.connection), releaseRef: ref(v2) });
    assert.equal((await f.read(first.key!, type.name, "P1")).status, 403);
    assert.equal(((await f.read(switched.key!, type.name, "P1")).body as any).items[0].properties["价格"].value, "10");

    const source = f.live.sources.list().find(s => s.id === type.sourceId)!;
    f.live.sources.disable(source.id, source.version);
    assert.throws(() => f.releases.connect({ ...selection, operationId: "denied", name: "已停用来源" }), /停用/);
    assert.notEqual((await f.read(added.key!, type.name, "P1")).status, 200);
    assert.notEqual((await f.read(switched.key!, type.name, "P1")).status, 200);
  } finally { await f.close(); }
});

test("partial source snapshots keep their limited coverage through checks, publication and consumer reads", async () => {
  const f = fixture(), previousLimit = process.env.CONTEXT_OS_SNAPSHOT_MAX_ROWS;
  process.env.CONTEXT_OS_SNAPSHOT_MAX_ROWS = "3";
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: `C${i}`, name: `公司${i}` }));
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const selected = rows.filter(r => !url.searchParams.has("id") || r.id === url.searchParams.get("id"));
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 20);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: selected.slice(offset, offset + limit), total: selected.length }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await f.live.sources.connect({ name: "客户目录", protocol: "http", url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      capabilities: [{ name: "customers", path: "/customers", fields: ["id", "name"], idField: "id", totalPath: "total", filters: { id: "id" } }] });
    await f.engine.build({ operationId: "limited" });
    const candidate = f.engine.overview().candidate!;
    const checked = await f.engine.check(ref(candidate));
    const checks = checked.content.checks as any;
    assert.equal(checks.valid, true, checks.description);
    assert.doesNotMatch(checks.description, /全量快照检查通过/);
    assert.match(checks.description, /覆盖不完整/);
    assert.equal(checks.snapshot.coverage.complete, false);
    assert.ok(checks.snapshot.checks.some((c: any) => c.severity === "warning" && c.detail.includes("3 / 5")));
    const adopted = await f.engine.adopt({ ...ref(checked), operationId: "adopt-limited" });
    const type = (adopted.model.content.types as any[])[0];
    const releaseCheck = await f.releases.check({ inputHash: f.releases.overview().working.inputHash });
    assert.equal(releaseCheck.status, "ready", JSON.stringify(releaseCheck.content.issues));
    assert.ok((releaseCheck.content.issues as any[]).some(i => i.code === "snapshot_incomplete" && i.severity === "warning"));
    const release = f.releases.publish({ operationId: "publish-limited", checkRef: ref(releaseCheck), name: "有限覆盖版本" }).release;
    assert.deepEqual((release.content.definition as any).snapshots[0].coverage, { rows: 3, total: 5, complete: false });
    const connection = f.releases.connect({ operationId: "limited-consumer", name: "有限覆盖接入", releaseRef: ref(release),
      conceptIds: [String(type.conceptId)], relationIds: [], business: { grants: [{ type: type.name, fields: ["$id", "name"], relations: [] }] } });
    const result = await f.datasets.handle("/v4/objects", new URLSearchParams({ type: type.name }), "Bearer " + connection.key);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual((result.body.items as any[]).map(i => i.objectRef.id), ["C0", "C1", "C2"]);
    assert.deepEqual(result.body.coverage, { offset: 0, shown: 3, total: null, complete: false, sourceComplete: false, snapshotTotal: 3 });
    const missing = await f.read(connection.key!, type.name, "C4");
    assert.deepEqual(missing.body.items, []);
    assert.equal((missing.body.coverage as any).complete, false, "not present in a partial snapshot does not prove absent at the source");
  } finally {
    if (previousLimit === undefined) delete process.env.CONTEXT_OS_SNAPSHOT_MAX_ROWS;
    else process.env.CONTEXT_OS_SNAPSHOT_MAX_ROWS = previousLimit;
    await new Promise(resolve => server.close(resolve)); await f.close();
  }
});

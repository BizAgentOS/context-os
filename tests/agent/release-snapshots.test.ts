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

const ref = (a: { id: string; version: number }) => ({ id: a.id, version: a.version });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ade-release-snapshots-"));
  const memory = new MemoryStore(directory);
  const live = new LiveMemory(directory, memory);
  const foundation = new FoundationService(memory, live);
  const snapshots = new Snapshots(memory, live, directory);
  const engine = new ProgramBuilds(memory, foundation, live, snapshots);
  const releases = new Releases(memory, live), datasets = new OntologyDatasets(memory, live);
  return { memory, live, snapshots, engine, releases, datasets, workspace: new Workspace(memory),
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
    assert.deepEqual(changed.samples, [{ kind: "added", k: "C99" }, { kind: "changed", k: "C1" }]);
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

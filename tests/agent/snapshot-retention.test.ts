import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { FoundationService } from "../../src/agent/foundation.ts";
import { LiveMemory } from "../../src/live/memory.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { OntologyDatasets } from "../../src/live/ontology-datasets.ts";
import { Snapshots } from "../../src/data/snapshots.ts";
import { ProgramBuilds } from "../../src/engine/program-builds.ts";
import { Releases } from "../../src/engine/releases.ts";

test("a published snapshot keeps serving its original values after five newer snapshots trigger retention", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-snapshot-retention-"));
  const memory = new MemoryStore(directory), live = new LiveMemory(directory, memory);
  const snapshots = new Snapshots(memory, live, directory), workspace = new Workspace(memory);
  const engine = new ProgramBuilds(memory, new FoundationService(memory, live), live, snapshots);
  const releases = new Releases(memory, live), datasets = new OntologyDatasets(memory, live);
  try {
    workspace.upload("产品.csv", "产品编号,名称,价格\nP1,甲,10\nP2,乙,20\n");
    await engine.build({ operationId: "original" });
    const candidate = engine.overview().candidate!;
    const checked = await engine.check({ id: candidate.id, version: candidate.version });
    assert.equal((checked.content.checks as any).valid, true, JSON.stringify(checked.content.checks));
    const adopted = await engine.adopt({ id: checked.id, version: checked.version, operationId: "adopt" });
    const type = (adopted.model.content.types as any[])[0];
    const check = await releases.check({ inputHash: releases.overview().working.inputHash });
    assert.equal(check.status, "ready", JSON.stringify(check.content.issues));
    const { release } = releases.publish({ operationId: "publish", checkRef: { id: check.id, version: check.version }, name: "原始产品" });
    const connection = releases.connect({ operationId: "connect", name: "历史消费者", releaseRef: { id: release.id, version: release.version },
      conceptIds: [String(type.conceptId)], relationIds: [], business: { grants: [{ type: type.name, fields: ["$id", "价格"], relations: [] }] } });

    for (let i = 1; i <= 5; i++) {
      workspace.upload("产品.csv", `产品编号,名称,价格\nP1,甲,${10 + i}\nP2,乙,20\n`);
      const synced = await snapshots.sync({ operationId: `refresh:${i}` });
      assert.equal(synced.content.outcome, "synced", JSON.stringify(synced.content));
    }

    const read = await datasets.handle("/v4/objects", new URLSearchParams({ type: type.name, id: "P1" }), "Bearer " + connection.key);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal((read.body as any).items[0].properties["价格"].value, "10");
    assert.equal(read.body.consistency, "pinned_snapshot");
  } finally {
    await engine.close(); await snapshots.close(); memory.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("a release retains its partial source coverage when a later snapshot of the same rows becomes complete", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-snapshot-coverage-")), priorLimit = process.env.ADE_SNAPSHOT_MAX_ROWS;
  const memory = new MemoryStore(directory), live = new LiveMemory(directory, memory);
  const snapshots = new Snapshots(memory, live, directory), workspace = new Workspace(memory);
  const engine = new ProgramBuilds(memory, new FoundationService(memory, live), live, snapshots);
  const releases = new Releases(memory, live), datasets = new OntologyDatasets(memory, live);
  process.env.ADE_SNAPSHOT_MAX_ROWS = "2";
  try {
    workspace.upload("产品.csv", "产品编号,名称,价格\nP1,甲,10\nP2,乙,20\nP3,丙,30\n");
    await engine.build({ operationId: "partial" });
    const candidate = engine.overview().candidate!;
    const checked = await engine.check({ id: candidate.id, version: candidate.version });
    const adopted = await engine.adopt({ id: checked.id, version: checked.version, operationId: "adopt" });
    const type = (adopted.model.content.types as any[])[0];
    const check = await releases.check({ inputHash: releases.overview().working.inputHash });
    assert.equal(check.status, "ready", JSON.stringify(check.content.issues));
    const { release } = releases.publish({ operationId: "publish", checkRef: { id: check.id, version: check.version }, name: "有限产品目录" });
    const connection = releases.connect({ operationId: "connect", name: "历史消费者", releaseRef: { id: release.id, version: release.version },
      conceptIds: [String(type.conceptId)], relationIds: [], business: { grants: [{ type: type.name, fields: ["$id", "价格"], relations: [] }] } });
    const read = () => datasets.handle("/v4/objects", new URLSearchParams({ type: type.name }), "Bearer " + connection.key);
    const original = await read();
    assert.equal(original.status, 200, JSON.stringify(original.body));
    assert.deepEqual(original.body.coverage, { offset: 0, shown: 2, total: null, complete: false, sourceComplete: false, snapshotTotal: 2 });

    workspace.upload("产品.csv", "产品编号,名称,价格\nP1,甲,10\nP2,乙,20\n");
    await snapshots.sync({ operationId: "complete" });
    assert.deepEqual(snapshots.overview().datasets[0].content.coverage, { rows: 2, total: 2, complete: true });
    const historical = await read();
    assert.equal(historical.status, 200, JSON.stringify(historical.body));
    assert.deepEqual(historical.body.coverage, original.body.coverage, "later observations cannot rewrite the coverage of a published snapshot");

    const missing = await datasets.handle("/v4/objects", new URLSearchParams({ type: type.name, id: "P3" }), "Bearer " + connection.key);
    assert.equal(missing.status, 200, JSON.stringify(missing.body));
    assert.deepEqual(missing.body.coverage, { offset: 0, shown: 0, total: null, complete: false, sourceComplete: false, snapshotTotal: 0 });
  } finally {
    if (priorLimit === undefined) delete process.env.ADE_SNAPSHOT_MAX_ROWS; else process.env.ADE_SNAPSHOT_MAX_ROWS = priorLimit;
    await engine.close(); await snapshots.close(); memory.close(); rmSync(directory, { recursive: true, force: true });
  }
});

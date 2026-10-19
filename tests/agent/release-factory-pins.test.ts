import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { MemoryStore } from "../../src/agent/memory.ts";
import { FoundationService } from "../../src/agent/foundation.ts";
import { LiveMemory, pinKey } from "../../src/live/memory.ts";
import { ConsumerViews } from "../../src/live/consumer-views.ts";
import { OntologyDatasets } from "../../src/live/ontology-datasets.ts";
import { Snapshots } from "../../src/data/snapshots.ts";
import { ProgramBuilds } from "../../src/engine/program-builds.ts";
import { Releases } from "../../src/engine/releases.ts";
import type { Data } from "../../src/agent/contracts.ts";

const ref = (artifact: { id: string; version: number }) => ({ id: artifact.id, version: artifact.version });
const nameValue = (body: Data) => ((((body.items as Data[])[0].properties as Data).name) as Data).value;

async function fixture(explicitLive = false) {
  const directory = mkdtempSync(join(tmpdir(), "ade-release-factory-"));
  const memory = new MemoryStore(directory), live = new LiveMemory(directory, memory);
  const snapshots = new Snapshots(memory, live, directory);
  const builds = new ProgramBuilds(memory, new FoundationService(memory, live), live, snapshots);
  const releases = new Releases(memory, live), views = new ConsumerViews(memory, live), datasets = new OntologyDatasets(memory, live);
  let value = "发布时的名称";
  const sourceServer = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ items: [{ id: "A", name: value }], total: 1 }));
  });
  await new Promise<void>(resolve => sourceServer.listen(0, "127.0.0.1", resolve));
  try {
    const source = await live.sources.connect({ name: "企业目录", protocol: "http", url: `http://127.0.0.1:${(sourceServer.address() as { port: number }).port}`,
      capabilities: [{ name: "companies", path: "/companies", fields: ["id", "name"], idField: "id", totalPath: "total", filters: { id: "id" } }] });
    await builds.build({ operationId: "build" });
    const candidate = builds.overview().candidate!;
    const checked = await builds.check(ref(candidate));
    await builds.adopt({ ...ref(checked), operationId: "adopt" });
    if (explicitLive) {
      const dataset = snapshots.datasets()[0];
      snapshots.setPolicy({ ...ref(dataset), materialization: "live" });
    }
    const check = await releases.check({ inputHash: releases.overview().working.inputHash });
    assert.equal(check.status, "ready", JSON.stringify(check.content));
    const release = releases.publish({ operationId: "publish", name: "固定发布", checkRef: ref(check) }).release;
    const definition = release.content.definition as Data;
    const type = ((definition.model as Data).types as Data[])[0];
    const modelRef = release.content.modelRef as { id: string; version: number };
    const grants = [{ type: String(type.name), fields: ["$id", "name"], relations: [] }];
    return { memory, live, snapshots, views, datasets, release, source, type, modelRef, grants,
      update(valueAfter: string) { value = valueAfter; },
      viewInput(operationId: string) { return { operationId, name: operationId, purpose: "发布工厂验证", modelRef, grants }; },
      datasetInput(operationId: string) { return { operationId, name: operationId, foundationRef: release.content.foundationRef, conceptIds: [String(type.conceptId)], relationIds: [], business: { modelRef, grants } }; },
      async close() { await builds.close(); await snapshots.close(); memory.close(); await new Promise<void>(resolve => sourceServer.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); },
    };
  } catch (error) {
    await builds.close(); await snapshots.close(); memory.close(); await new Promise<void>(resolve => sourceServer.close(() => resolve())); rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

test("published factories derive fixed semantics and old snapshot pins even with omitted or hostile caller options", async () => {
  const f = await fixture();
  try {
    const publishedSnapshots = (f.release.content.definition as Data).snapshots as Data[];
    assert.equal(publishedSnapshots.length, 1);
    const originalSnapshot = String(publishedSnapshots[0].snapshotId);
    f.update("来源已改变");
    await f.snapshots.sync({ operationId: "new-source-values" });
    const currentSnapshot = String(f.snapshots.datasets()[0].content.activeVersion);
    assert.notEqual(currentSnapshot, originalSnapshot);
    const overrides = [undefined, { fixedSemantic: false, snapshotPins: {} }, { fixedSemantic: false, snapshotPins: { [pinKey(f.source.id, "companies")]: currentSnapshot } }];
    for (const [index, override] of overrides.entries()) {
      const view = f.views.createForRelease(f.viewInput("view-" + index), ref(f.release), override);
      const reading = await f.views.readLinkedView(ref(view), "/v3/objects", new URLSearchParams({ type: String(f.type.name), id: "A" }), () => {});
      assert.equal(reading.status, 200, JSON.stringify(reading.body));
      assert.equal(nameValue(reading.body), "发布时的名称");
      assert.equal(view.content.fixedSemantic, true);
      assert.equal(reading.body.readMode, "release_pinned");
      assert.equal((reading.body.sources as Data[])[0].snapshotId, originalSnapshot);
      const published = f.datasets.publishForRelease(f.datasetInput("dataset-" + index), ref(f.release), override);
      const response = await f.datasets.handle("/v4/objects", new URLSearchParams({ type: String(f.type.name), id: "A" }), "Bearer " + published.key);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(nameValue(response.body), "发布时的名称");
      assert.equal((response.body.sources as Data[])[0].snapshotId, originalSnapshot);
      assert.deepEqual((response.body.versions as Data).ontology, f.release.content.foundationRef);
    }
  } finally { await f.close(); }
});

test("a release explicitly using live data still fixes semantics while its factories read current source values", async () => {
  const f = await fixture(true);
  try {
    assert.deepEqual((f.release.content.definition as Data).snapshots, []);
    f.update("当前实时名称");
    const view = f.views.createForRelease(f.viewInput("live-view"), ref(f.release));
    assert.equal(view.content.fixedSemantic, true);
    assert.deepEqual(view.content.snapshotPins, {});
    const reading = await f.views.readLinkedView(ref(view), "/v3/objects", new URLSearchParams({ type: String(f.type.name), id: "A" }), () => {});
    assert.equal(reading.status, 200, JSON.stringify(reading.body));
    assert.equal(nameValue(reading.body), "当前实时名称");
    assert.equal((reading.body.sources as Data[])[0].readMode, "live");
    assert.deepEqual((reading.body.versions as Data).ontology, f.release.content.foundationRef);
    const priorSnapshot = String(f.snapshots.datasets()[0].content.activeVersion);
    const published = f.datasets.publishForRelease(f.datasetInput("live-dataset"), ref(f.release), { fixedSemantic: false, snapshotPins: { [pinKey(f.source.id, "companies")]: priorSnapshot } });
    const response = await f.datasets.handle("/v4/objects", new URLSearchParams({ type: String(f.type.name), id: "A" }), "Bearer " + published.key);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(nameValue(response.body), "当前实时名称");
    assert.equal((response.body.sources as Data[])[0].readMode, "live");
  } finally { await f.close(); }
});

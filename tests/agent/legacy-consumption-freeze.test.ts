import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import { ConsumerViews } from "../../src/live/consumer-views.ts";
import { ConsumerMigrations } from "../../src/live/consumer-migrations.ts";
import { OntologyDatasets } from "../../src/live/ontology-datasets.ts";

const frozen = /已冻结.*发布.*接入方/;

test("legacy writes are frozen at HTTP and public domain boundaries without creating records", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-legacy-freeze-"));
  const service = await createServer({ directory, automaticApi: false, driver: {
    async run() { return { text: "idle", sessionId: "s", runId: "r" }; }, async stop() {}, async close() {},
  } });
  await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  try {
    for (const path of ["/api/consumers/prepare", "/api/consumers/activate", "/api/consumers/data-publish", "/api/live/prepare", "/api/live/activate", "/api/live/views/propose", "/api/live/views/activate", "/api/live/migrations/preview", "/api/live/migrations/commit", "/api/datasets/publish"]) {
      const response = await fetch(origin + path, { method: "POST", headers: { "content-type": "application/json", "x-contextos-token": service.adminToken }, body: "{}" });
      assert.equal(response.status, 409, path);
      const body = await response.json() as { error: string; code: string };
      assert.equal(body.code, "legacy_consumption_frozen"); assert.match(body.error, frozen);
    }
    const { app } = service, views = new ConsumerViews(app.memory, app.live), datasets = new OntologyDatasets(app.memory, app.live);
    for (const write of [() => app.consumption.propose({}), () => app.consumption.activate("missing", 1), () => app.consumption.publishDataUpdate("missing", 1, {}), () => app.live.prepare({}), () => app.live.activate("missing", 1), () => views.propose({}), () => views.activate({}), () => datasets.publish({}), () => new ConsumerMigrations(app.memory, app.live).execute("commit", {})]) assert.throws(write, frozen);
    for (const kind of ["consumer", "live_consumer", "consumer_view", "ontology_dataset", "consumer_migration"]) assert.equal(app.memory.listArtifacts(kind).length, 0, kind);
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("historical access is paged independently of more than forty v4 business views and remains revocable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-legacy-history-"));
  const service = await createServer({ directory, automaticApi: false, driver: {
    async run() { return { text: "idle", sessionId: "s", runId: "r" }; }, async stop() {}, async close() {},
  } });
  await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const memory = service.app.memory;
  const read = async (query = "") => {
    const response = await fetch(origin + "/api/consumers/history" + query, { headers: { "x-contextos-token": service.adminToken } });
    assert.equal(response.status, 200); return await response.json() as any;
  };
  try {
    for (let i = 0; i < 45; i++) memory.putArtifact({ kind: "consumer_view", title: "历史范围 " + i, status: "active", content: { keyHash: "private-old-hash", grants: [] } });
    for (let i = 0; i < 45; i++) {
      const view = memory.putArtifact({ kind: "consumer_view", title: "v4 内嵌范围 " + i, status: "active", content: { keyHash: "private-v4-hash", grants: [] } });
      const dataset = memory.putArtifact({ kind: "ontology_dataset", title: "v4 内嵌数据集 " + i, status: "active", content: { keyHash: "private-dataset-hash", business: { viewRef: { id: view.id, version: view.version } } } });
      memory.putArtifact({ kind: "release_connection", title: "接入方 " + i, status: "active", content: { datasetRef: { id: dataset.id, version: dataset.version } } });
    }
    // A pre-v4 dataset owns its own business view; show its dataset once, not a duplicate view.
    const owned = memory.putArtifact({ kind: "consumer_view", title: "旧数据集内嵌范围", status: "active", content: { keyHash: "private-owned-hash" } });
    memory.putArtifact({ kind: "ontology_dataset", title: "历史数据集", status: "active", content: { keyHash: "private-old-dataset", business: { viewRef: { id: owned.id, version: owned.version } } } });
    const first = await read(), second = await read("?offset=" + first.nextOffset);
    assert.equal(first.total, 46); assert.equal(first.items.length, 40); assert.equal(second.items.length, 6); assert.equal(second.nextOffset, null);
    const all = [...first.items, ...second.items];
    assert.equal(new Set(all.map(item => item.id)).size, 46);
    assert.equal(all.filter(item => item.kind === "consumer_view").length, 45);
    assert.equal(all.filter(item => item.kind === "ontology_dataset").length, 1);
    assert.doesNotMatch(JSON.stringify(all), /keyHash|private-|v4 内嵌/);
    const historical = all.find(item => item.kind === "consumer_view");
    const revoked = await fetch(origin + "/api/live/views/revoke", { method: "POST", headers: { "content-type": "application/json", "x-contextos-token": service.adminToken }, body: JSON.stringify({ id: historical.id, version: historical.version }) });
    assert.equal(revoked.status, 200);
    const updated = [...(await read()).items, ...(await read("?offset=40")).items].find(item => item.id === historical.id);
    assert.equal(updated.status, "revoked");
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

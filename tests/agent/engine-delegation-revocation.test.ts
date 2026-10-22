import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import { ConsumerViews } from "../../src/live/consumer-views.ts";
import { createFusionSources, primaryCapability } from "./fusion-fixture.ts";
import { Releases } from "../../src/engine/releases.ts";
import type { Data } from "../../src/agent/contracts.ts";

const ref = (a: { id: string; version: number }) => ({ id: a.id, version: a.version });

for (const revoked of ["source", "business_view"] as const) {
  test(`delegated saved readings and idempotent replay respect current ${revoked} revocation`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "context-os-delegation-revocation-"));
    const source = await createFusionSources();
    const service = await createServer({ directory, automaticApi: false, driver: {
      async run(request) {
        await request.onTool("query_objects", { type: "投诉", fields: ["$id", "状态"], limit: 1 });
        return { text: "已读取当前投诉状态。", sessionId: "fixture", runId: "fixture" };
      }, async stop() {}, async close() {},
    } });
    await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    const call = async (path: string, key: string, body?: unknown) => {
      const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as any };
    };
    try {
      const memory = service.app.memory, live = service.app.live, releases = new Releases(memory, live);
      const foundation = memory.putArtifact({ kind: "foundation", title: "隔离测试本体", status: "adopted", content: { enterprise: { name: "隔离测试" }, concepts: [{ id: "complaint", name: "投诉", description: "居民投诉" }], relations: [], evidence: [], unknowns: [], conflicts: [] } });
      const connectedSource = await live.sources.connect({ name: "source", protocol: "http", url: source.url, capabilities: [primaryCapability] });
      const draft = await live.propose({ purpose: "隔离测试映射", foundationRef: ref(foundation), baseModelRef: null, types: [{ conceptId: "complaint", name: "投诉", description: "居民投诉", sourceId: connectedSource.id, capability: "complaints", fields: { 状态: "status" } }], relations: [], rationale: "固定测试数据" });
      await live.adopt(draft.id, draft.version);
      const checked = await releases.check({ inputHash: releases.overview().working.inputHash });
      const release = releases.publish({ operationId: "publish", checkRef: ref(checked), name: "v1" }).release;
      const connection = releases.connect({ operationId: "connect", name: "caller", releaseRef: ref(release), conceptIds: ["complaint"], relationIds: [], business: { grants: [{ type: "投诉", fields: ["$id", "状态"], relations: [] }] }, agentEnabled: true });
      const request = { operationId: "task", prompt: "读取投诉状态" };
      const submitted = await call("/v4/agent/tasks", connection.key!, request);
      assert.equal(submitted.status, 202);
      await service.app.idle();
      const path = "/v4/agent/tasks/" + submitted.body.task.id;
      const initial = await call(path, connection.key!);
      assert.equal(initial.body.task.status, "completed");
      assert.equal(initial.body.task.content.readings[0].result.items[0].properties.状态.value, "已办结");
      if (revoked === "source") live.sources.disable(connectedSource.id, connectedSource.version);
      else {
        const dataset = memory.getArtifact(String((connection.connection.content.datasetRef as Data).id));
        new ConsumerViews(memory, live).revoke((dataset.content.business as Data).viewRef);
      }
      assert.notEqual((await call("/v4/objects?type=" + encodeURIComponent("投诉"), connection.key!)).status, 200);
      const denied = await call(path, connection.key!);
      assert.equal(denied.status, 403, "saved task results must not bypass current business authorization");
      assert.doesNotMatch(JSON.stringify(denied.body), /已办结|readings/);
      const replay = await call("/v4/agent/tasks", connection.key!, request);
      assert.equal(replay.status, 403, "idempotency must not return old authorized data after revocation");
      assert.doesNotMatch(JSON.stringify(replay.body), /已办结|readings/);
    } finally { await service.close(); await source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

test("cancelling one delegated task starts the queued caller without a poll or another submission", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-delegation-queue-"));
  let runs = 0, unblock: (() => void) | undefined, firstStarted!: () => void, secondStarted!: () => void;
  const first = new Promise<void>(resolve => { firstStarted = resolve; });
  const second = new Promise<void>(resolve => { secondStarted = resolve; });
  const service = await createServer({ directory, automaticApi: false, driver: {
    async run() {
      runs++;
      if (runs === 1) { firstStarted(); await new Promise<void>(resolve => { unblock = resolve; }); }
      else secondStarted();
      return { text: "已完成", sessionId: "fixture", runId: "fixture" };
    }, async stop() { unblock?.(); }, async close() {},
  } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const memory = service.app.memory, releases = new Releases(memory, service.app.live);
    memory.putArtifact({ kind: "foundation", title: "队列测试", status: "adopted", content: { enterprise: { name: "队列测试" }, concepts: [{ id: "company", name: "公司", description: "组织" }], relations: [], evidence: [], unknowns: [], conflicts: [] } });
    const check = await releases.check({ inputHash: releases.overview().working.inputHash });
    const release = releases.publish({ operationId: "publish", checkRef: ref(check), name: "v1" }).release;
    const connection = releases.connect({ operationId: "connect", name: "caller", releaseRef: ref(release), conceptIds: ["company"], relationIds: [], agentEnabled: true });
    const a = service.app.delegations.submit({ operationId: "a", prompt: "第一个任务" }, connection.key!);
    await first;
    const b = service.app.delegations.submit({ operationId: "b", prompt: "第二个任务" }, connection.key!);
    assert.equal(b.task.status, "queued");
    await service.app.delegations.cancel(a.task.id, connection.key!);
    await Promise.race([second, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("queued task did not start after cancellation")), 3000); })]);
    assert.equal(runs, 2, "queue advancement must not depend on read(), idle(), or a new submit()");
  } finally { if (timer) clearTimeout(timer); unblock?.(); await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

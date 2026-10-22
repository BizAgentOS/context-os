import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "context-os-pending-"));
  const service = await createServer({ directory, automaticApi: false });
  await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "X-ContextOS-Token": service.adminToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  seedFoundation(service.app.memory, service.app.foundation, { enterprise: "待处理测试企业", concepts: [
    { id: "customer", name: "客户", description: "与企业发生交易的客户" },
    { id: "order", name: "订单", description: "销售订单" },
  ] });
  const baseline = (await call("/api/changes")).body.baseline;
  return { service, call, baseline, async close() { await service.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("one pending count serves every page, filters retain the global total, and decided items leave the queue", async () => {
  const w = await fixture();
  try {
    const a = await w.call("/api/changes/propose", { operationId: "rename", origin: "human", type: "naming", baseline: w.baseline,
      subject: { target: "concept", id: "customer", name: "企业客户" } });
    const b = await w.call("/api/changes/propose", { operationId: "relate", origin: "agent", type: "relation", baseline: w.baseline,
      subject: { from: { datasetId: "orders", column: "customer_id" }, to: { datasetId: "customers", column: "id" } }, evidence: "订单中的客户编号指向客户" });
    assert.equal(a.status, 201); assert.equal(b.status, 201);
    const all = await w.call("/api/pending");
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.equal(all.body.total, 2);
    assert.deepEqual(all.body.counts, { structure: 1, naming: 1, adjudication: 0, gap: 0, data_issue: 0 });
    assert.equal(all.body.items.find((x: any) => x.id === a.body.change.id).title, "命名 · 客户");
    const filtered = (await w.call("/api/pending?category=naming&source=human&object=customer")).body;
    assert.equal(filtered.total, 2); assert.equal(filtered.filteredTotal, 1);
    assert.equal(filtered.items[0].id, a.body.change.id);
    for (const page of ["setup", "ontology", "consumption"]) {
      const snapshot = (await w.call(`/api/snapshot?scope=shell&page=${page}`)).body;
      assert.equal(snapshot.pendingSummary.total, 2, page);
      assert.deepEqual(snapshot.pendingSummary.counts, all.body.counts);
    }
    const rejected = await w.call("/api/changes/reject", { operationId: "no-rename", id: a.body.change.id, version: a.body.change.version, reason: "沿用已确认名称" });
    assert.equal(rejected.status, 200);
    assert.equal((await w.call("/api/pending")).body.total, 1);
    assert.equal((await w.call(`/api/pending/read?id=${a.body.change.id}`)).body.item.status, "rejected", "a prior queue link stays readable");
    assert.equal((await w.call("/api/pending?category=unknown")).status, 400);
  } finally { await w.close(); }
});

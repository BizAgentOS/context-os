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
import { MappingChanges } from "../../src/live/mapping-changes.ts";
import { Snapshots } from "../../src/data/snapshots.ts";
import { ProgramBuilds } from "../../src/engine/program-builds.ts";
import { validateDefinition } from "../../src/engine/validation.ts";

const code = (i: number) => `A${String(i).padStart(3, "0")}`;

test("a mapping revision reports its full-snapshot effect, and one that breaks a relation cannot pass its check", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-mapping-snapshot-"));
  const memory = new MemoryStore(directory), live = new LiveMemory(directory, memory);
  const foundation = new FoundationService(memory, live), snapshots = new Snapshots(memory, live, directory);
  const engine = new ProgramBuilds(memory, foundation, live, snapshots), changes = new MappingChanges(memory, live);
  live.snapshotCheck = definition => validateDefinition(snapshots, live, definition) as never;
  try {
    const workspace = new Workspace(memory);
    workspace.upload("企业.csv", "企业编号,企业名称,城市\n" + Array.from({ length: 20 }, (_, i) => `${code(i)},企业${i},城市${i % 3}`).join("\n") + "\n");
    workspace.upload("订单.csv", "订单号,企业编号,金额\n" + Array.from({ length: 40 }, (_, i) => `O${i},${code(i % 20)},${i * 10}`).join("\n") + "\n");
    await engine.build({ operationId: "build" });
    const candidate = engine.overview().candidate!;
    const checked = await engine.check({ id: candidate.id, version: candidate.version });
    const { model } = await engine.adopt({ id: checked.id, version: checked.version, operationId: "adopt" });
    const relation = (model.content.relations as any[])[0];
    assert.ok(relation, "the build linked orders to companies");
    const baseRef = { id: model.id, version: model.version };

    const broken = await changes.execute("propose", { operationId: "break", baseRef, reason: "测试", evidence: "测试",
      patch: { kind: "relation", type: relation.from, relation: relation.name, fromField: "金额", toField: relation.toField } });
    const full = (broken.content.impact as any).snapshotCheck;
    assert.equal(full.status, "checked", JSON.stringify(full));
    assert.equal(full.validBefore, true);
    assert.equal(full.validAfter, false);
    assert.equal(full.newErrors.length, 1, JSON.stringify(full.changes));
    assert.match(full.changes[0].detail, /关系不成立/);
    await assert.rejects(changes.execute("check", { operationId: "break-check", id: broken.id, version: broken.version }), /全量快照上引入新的问题/);

    const company = (model.content.types as any[]).find(t => t.name !== relation.from);
    const harmless = await changes.execute("propose", { operationId: "rename", baseRef, reason: "测试", evidence: "测试",
      patch: { kind: "property", type: company.name, property: "企业名称", sourceField: "城市" } });
    assert.deepEqual((harmless.content.impact as any).snapshotCheck.newErrors, []);
    const ok = await changes.execute("check", { operationId: "rename-check", id: harmless.id, version: harmless.version });
    assert.equal(ok.status, "checked");
  } finally { await engine.close(); await snapshots.close(); memory.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("adopting a mapping with a relation that matches nothing in the full data is refused by the full-snapshot check", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-adopt-snapshot-"));
  const memory = new MemoryStore(directory), live = new LiveMemory(directory, memory), snapshots = new Snapshots(memory, live, directory);
  live.snapshotCheck = definition => validateDefinition(snapshots, live, definition) as never;
  const companies = Array.from({ length: 10 }, (_, i) => ({ code: code(i), owner: `销售${i}` }));
  const orders = Array.from({ length: 30 }, (_, i) => ({ order_id: `O${i}`, company_id: code(i % 10), note: `备注${i}` }));
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const rows: Record<string, string>[] = url.pathname === "/companies" ? companies : orders;
    const selected = rows.filter(r => [...url.searchParams].every(([k, v]) => ["offset", "limit"].includes(k) || r[k] === v));
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 20);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: selected.slice(offset, offset + limit), total: selected.length }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const crm = await live.sources.connect({ name: "CRM", protocol: "http", url,
      capabilities: [{ name: "companies", path: "/companies", fields: ["code", "owner"], idField: "code", totalPath: "total", filters: { code: "code" } }] });
    const erp = await live.sources.connect({ name: "订单", protocol: "http", url,
      capabilities: [{ name: "orders", path: "/orders", fields: ["order_id", "company_id", "note"], idField: "order_id", totalPath: "total", filters: { order_id: "order_id" } }] });
    assert.equal((await snapshots.sync({ operationId: "sync" })).content.outcome, "synced");
    const propose = (fromField: string) => live.propose({ purpose: "订单与企业", rationale: "测试",
      types: [{ name: "企业", description: "CRM 企业", sourceId: crm.id, capability: "companies", fields: { 编号: "code", 负责人: "owner" } },
        { name: "订单", description: "订单", sourceId: erp.id, capability: "orders", fields: { 订单号: "order_id", 企业编号: "company_id", 备注: "note" } }],
      relations: [{ name: "属于", from: "订单", to: "企业", fromField, toField: "编号" }] });
    // The online adoption check reads three sample records per type and never measures relation match rates.
    const wrong = await propose("备注");
    await assert.rejects(live.adopt(wrong.id, wrong.version), /全量快照上引入新的问题：关系：订单 属于 企业/);
    const right = await propose("企业编号");
    assert.equal((await live.adopt(right.id, right.version)).status, "adopted");
  } finally { await new Promise(resolve => server.close(resolve)); await snapshots.close(); memory.close(); rmSync(directory, { recursive: true, force: true }); }
});

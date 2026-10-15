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
import { Snapshots } from "../../src/data/snapshots.ts";
import { ProgramBuilds } from "../../src/engine/program-builds.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ade-snapshot-build-"));
  const memory = new MemoryStore(directory);
  const live = new LiveMemory(directory, memory);
  const foundation = new FoundationService(memory, live);
  const snapshots = new Snapshots(memory, live, directory);
  const engine = new ProgramBuilds(memory, foundation, live, snapshots);
  return { memory, live, foundation, snapshots, engine, workspace: new Workspace(memory),
    async close() { await engine.close(); await snapshots.close(); memory.close(); rmSync(directory, { recursive: true, force: true }); } };
}

const code = (i: number) => `A${String(i).padStart(3, "0")}`;
async function crm() {
  const rows = Array.from({ length: 30 }, (_, i) => ({ code: code(i), owner: `销售${i % 4}` }));
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const selected = rows.filter(row => !url.searchParams.has("code") || row.code === url.searchParams.get("code"));
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 20);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: selected.slice(offset, offset + limit), total: selected.length }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

test("a build syncs full snapshots, merges the same company across sources, links orders, and adopts a queryable mapping", async () => {
  const f = fixture();
  const api = await crm();
  try {
    f.workspace.upload("企业.csv", "企业编号,企业名称\n" + Array.from({ length: 30 }, (_, i) => `${code(i)},企业${i}`).join("\n") + "\n");
    f.workspace.upload("订单.csv", "订单号,企业编号,金额\n" + Array.from({ length: 60 }, (_, i) => `O${i},${code(i % 30)},${i * 10}`).join("\n") + "\n");
    const source = await f.live.sources.connect({ name: "CRM", protocol: "http", url: api.url,
      capabilities: [{ name: "companies", path: "/companies", fields: ["code", "owner"], idField: "code", totalPath: "total", filters: { code: "code" } }] });

    const run = await f.engine.build({ operationId: "full-build" });
    assert.equal(run.status, "completed", JSON.stringify(run.content));
    assert.equal(run.content.outcome, "candidate", JSON.stringify(run.content.issues));
    assert.equal(f.snapshots.datasets().length, 3, "the build synced every selected source");

    const candidate = f.engine.overview().candidate!;
    const types = candidate.content.types as any[], relations = candidate.content.modelRelations as any[];
    assert.deepEqual(types.map(t => t.name).sort(), ["企业", "订单"]);
    const company = types.find(t => t.name === "企业");
    assert.equal(company.supplements.length, 1);
    assert.equal(company.supplements[0].sourceId, source.id);
    assert.deepEqual(company.supplements[0].match, { primaryField: "企业编号", sourceField: "code" });
    assert.ok(Object.values(company.supplements[0].fields).includes("owner"));
    assert.deepEqual(relations.map(r => [r.from, r.name, r.to, r.fromField, r.toField]), [["订单", "属于", "企业", "企业编号", "企业编号"]]);
    assert.equal((candidate.content.foundation as any).relations.length, 1);
    assert.ok((candidate.content.coverage as any[]).every(c => c.complete && c.snapshotId), "coverage reports full snapshots");
    assert.ok((candidate.content.discovery as any).notes.some((n: any) => n.kind === "merged"));

    const checked = await f.engine.check({ id: candidate.id, version: candidate.version });
    assert.equal((checked.content.checks as any).valid, true, JSON.stringify(checked.content.checks));
    const adopted = await f.engine.adopt({ id: checked.id, version: checked.version, operationId: "adopt" });
    const objects = await f.live.query({ modelId: adopted.model.id, type: "企业", id: code(3) });
    const record = objects.items[0];
    assert.ok(record, JSON.stringify(objects).slice(0, 400));
    assert.ok(JSON.stringify(record).includes("销售3"), "the merged CRM owner is read through the supplement");

    // Rebuilding keeps the adopted concepts and mappings instead of duplicating them.
    const again = await f.engine.build({ operationId: "rebuild" });
    const next = f.engine.overview().candidate;
    assert.equal(again.content.outcome, next ? "candidate" : again.content.outcome);
    if (next) {
      assert.deepEqual((next.content.diff as any).addedConcepts, []);
      assert.equal((next.content.types as any[]).length, 2);
    }
  } finally { await api.close(); await f.close(); }
});

test("datasets without a usable identity are reported instead of guessed, and live datasets stay out of discovery", async () => {
  const f = fixture();
  try {
    f.workspace.upload("日志.csv", "时间,内容\n2026-01-01,a\n2026-01-01,b\n");
    f.workspace.upload("产品.csv", "产品编号,名称\nP1,甲\nP2,乙\n");
    await f.snapshots.sync({ operationId: "pre" });
    const product = f.snapshots.datasets().find(d => d.content.name === "产品.csv")!;
    f.snapshots.setPolicy({ id: product.id, version: product.version, materialization: "live" });
    const run = await f.engine.build({ operationId: "b" });
    const issues = run.content.issues as any[];
    assert.ok(issues.some(i => i.code === "identity_unknown"), JSON.stringify(issues));
    assert.ok(issues.some(i => i.code === "live_dataset"));
    assert.equal(run.content.outcome, "needs_attention");
  } finally { await f.close(); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { MemoryStore } from "../../src/agent/memory.ts";
import { LiveMemory } from "../../src/live/memory.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { Snapshots } from "../../src/data/snapshots.ts";
import { discoverFromSnapshots } from "../../src/engine/snapshot-discovery.ts";
import { profileColumns } from "../../src/engine/discovery.ts";
import { confirmOntology, ontologyBundle } from "../../src/engine/helix-discovery.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ade-discovery-"));
  const memory = new MemoryStore(directory);
  const live = new LiveMemory(directory, memory);
  const snapshots = new Snapshots(memory, live, directory);
  const source = (id: string) => { try { return memory.getArtifact(id); } catch { return undefined; } };
  return { memory, live, snapshots, workspace: new Workspace(memory), discover: (ids?: string[]) => discoverFromSnapshots(snapshots, source, ids),
    async close() { await snapshots.close(); memory.close(); rmSync(directory, { recursive: true, force: true }); } };
}

async function api(routes: Record<string, Array<Record<string, unknown>>>) {
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost"), rows = routes[url.pathname] ?? [];
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 20);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: rows.slice(offset, offset + limit), total: rows.length }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

test("the same company in an upload and a CRM API merges into one entity; orders link to it by a Chinese key column", async () => {
  const f = fixture();
  const crm = await api({ "/companies": Array.from({ length: 30 }, (_, i) => ({ code: `A${String(i).padStart(3, "0")}`, owner: `销售${i % 4}` })) });
  try {
    f.workspace.upload("企业.csv", "企业编号,企业名称\n" + Array.from({ length: 30 }, (_, i) => `A${String(i).padStart(3, "0")},企业${i}`).join("\n") + "\n");
    f.workspace.upload("订单.csv", "订单号,企业编号,金额\n" + Array.from({ length: 60 }, (_, i) => `O${i},A${String(i % 30).padStart(3, "0")},${i * 10}`).join("\n") + "\n");
    await f.live.sources.connect({ name: "CRM", protocol: "http", url: crm.url,
      capabilities: [{ name: "companies", path: "/companies", fields: ["code", "owner"], idField: "code", totalPath: "total" }] });
    const run = await f.snapshots.sync({ operationId: "all" });
    assert.equal(run.content.outcome, "synced", JSON.stringify(run.content));

    const o = await f.discover();
    const company = o.entities.find(e => e.members.length === 2)!;
    assert.ok(company, JSON.stringify(o.entities.map(e => [e.name, e.members.length])));
    assert.equal(company.name, "企业");
    assert.equal(company.key, "企业编号");
    assert.deepEqual(company.members.map(m => m.datasetName).sort(), ["CRM · companies", "企业.csv"]);
    assert.equal(company.members[1].via!.column, "code");
    assert.equal(company.members[1].matched, 30);
    const order = o.entities.find(e => e.name === "订单")!;
    assert.equal(order.key, "订单号");
    const link = o.links.find(l => l.from === order.id && l.to === company.id)!;
    assert.equal(link.fromColumn, "企业编号");
    assert.equal(link.name, "属于");
    assert.equal(link.matchedRows, 60);
    assert.ok(o.notes.some(n => n.kind === "merged" && n.text.includes("30 条中 30 条匹配")));
    assert.match(o.summary, /2 个实体/);

    const reversed = await f.discover(f.snapshots.datasets().map(d => d.id).reverse());
    assert.equal(reversed.hash, o.hash, "deterministic regardless of input order");

    const bundle = ontologyBundle(o, new Map(f.snapshots.datasets().map(d => [d.id, { id: d.id, name: d.content.name as string, data: { activeVersion: d.content.activeVersion as string, profile: d.content.profile as any } }])));
    const pipeline = bundle.pipelines.find(p => p.entityId === company.id)!;
    assert.match(pipeline.sql, /LEFT JOIN/);
    const result = await f.snapshots.query(pipeline.inputs, pipeline.sql, { limit: 100 });
    assert.equal(result.profile.rows, 30);
    assert.ok(result.profile.columns.some(c => c.name.endsWith("_owner")), "merged source columns keep a source prefix");
    assert.deepEqual(bundle.capacity, { omittedEntities: [], anchorOnlyEntities: [], omittedRelationships: [] });
    assert.throws(() => confirmOntology(o, { hash: o.hash, excluded: ["missing"], names: {} }), /不在建议中/);
  } finally { await crm.close(); await f.close(); }
});

test("a direct link that a two-hop path already gives is left to traversal", async () => {
  const f = fixture();
  try {
    f.workspace.upload("accounts.csv", "account_id,name\n" + Array.from({ length: 10 }, (_, i) => `ac${i},n${i}`).join("\n") + "\n");
    f.workspace.upload("subscriptions.csv", "subscription_id,account_id\n" + Array.from({ length: 20 }, (_, i) => `sb${i},ac${i % 10}`).join("\n") + "\n");
    f.workspace.upload("invoices.csv", "invoice_id,subscription_id,account_id\n" + Array.from({ length: 40 }, (_, i) => `in${i},sb${i % 20},ac${i % 20 % 10}`).join("\n") + "\n");
    await f.snapshots.sync({ operationId: "s" });
    const o = await f.discover();
    const id = (name: string) => o.entities.find(e => e.name.toLowerCase() === name)!.id;
    assert.ok(o.links.some(l => l.from === id("invoice") && l.to === id("subscription")));
    assert.ok(o.links.some(l => l.from === id("subscription") && l.to === id("account")));
    assert.ok(!o.links.some(l => l.from === id("invoice") && l.to === id("account")), JSON.stringify(o.links.map(l => l.id)));
  } finally { await f.close(); }
});

test("serial integer ids in different systems do not merge records by coincidence", async () => {
  const f = fixture();
  const other = await api({ "/tickets": Array.from({ length: 20 }, (_, i) => ({ id: i + 1, title: `t${i}` })) });
  try {
    f.workspace.upload("users.csv", "id,name\n" + Array.from({ length: 20 }, (_, i) => `${i + 1},u${i}`).join("\n") + "\n");
    await f.live.sources.connect({ name: "Helpdesk", protocol: "http", url: other.url,
      capabilities: [{ name: "tickets", path: "/tickets", fields: ["id", "title"], idField: "id", idType: "number", totalPath: "total" }] });
    await f.snapshots.sync({ operationId: "s" });
    const o = await f.discover();
    assert.equal(o.entities.length, 2);
    assert.ok(o.entities.every(e => e.members.length === 1));
  } finally { await other.close(); await f.close(); }
});


test("a blank value does not make an otherwise unique key non-unique", () => {
  const columns = profileColumns(["team_id", "name"], [
    { team_id: "T1", name: "总部" }, { team_id: "", name: "华东" }, { team_id: "T2", name: "华南" },
  ]);
  const id = columns.find(column => column.name === "team_id")!;
  assert.equal(id.distinct, 2);
  assert.equal(id.nulls, 1, "the blank row counts as missing");
  assert.equal(id.unique, true, "a missing value is not a duplicate value");
});

test("a table that references itself becomes a self link instead of being excluded", async () => {
  const f = fixture();
  try {
    f.workspace.upload("teams.csv", "team_id,name,parent_team_id\nT1,总部,\nT2,华东,T1\nT3,华南,T1\nT4,上海,T2\n");
    f.workspace.upload("people.csv", "person_id,name,team_id\nP1,张三,T2\nP2,李四,T3\nP3,王五,T4\n");
    const run = await f.snapshots.sync({ operationId: "self" });
    assert.equal(run.content.outcome, "synced", JSON.stringify(run.content));
    const o = await f.discover();
    const team = o.entities.find(e => e.key === "team_id");
    assert.ok(team, JSON.stringify(o.entities.map(e => [e.name, e.key])));
    const link = o.links.find(l => l.from === team!.id && l.to === team!.id);
    assert.ok(link, JSON.stringify(o.links.map(l => [l.from, l.to, l.fromColumn])));
    assert.equal(link!.fromColumn, "parent_team_id");
    assert.notEqual(link!.fromColumn, "team_id", "the identity column is not the self link");
  } finally { await f.close(); }
});
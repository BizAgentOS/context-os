/** Snapshot chain acceptance over the admin and consumer HTTP boundary; no model calls. `npm run verify:snapshots [-- --keep]` */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";

const keep = process.argv.includes("--keep");
const directory = mkdtempSync(join(tmpdir(), "ade-snapshot-chain-"));
const steps: { step: string; result: string }[] = [];
const record = (step: string, result: string) => { steps.push({ step, result }); console.log(`✓ ${step}：${result}`); };

// Fictional sources. /admin/update changes one company and adds another; /admin/drift turns order amounts into text.
const code = (i: number) => `A${String(i).padStart(3, "0")}`;
let crm = Array.from({ length: 30 }, (_, i) => ({ code: code(i), owner: `销售${i % 4}`, tier: i % 3 ? "标准" : "重点" }));
const registry = Array.from({ length: 30 }, (_, i) => ({ company_code: code(i), name: `链路验收企业${i}`, city: ["上海", "杭州", "苏州"][i % 3] }));
let orders: Record<string, unknown>[] = Array.from({ length: 80 }, (_, i) => ({ order_id: `O${1000 + i}`, company_id: code(i % 30), amount: (i % 9 + 1) * 1000 }));
const sources = httpServer((req, res) => {
  const url = new URL(req.url!, "http://localhost");
  const page = (rows: Record<string, unknown>[]) => {
    const selected = rows.filter(r => [...url.searchParams].every(([k, v]) => ["offset", "limit"].includes(k) || String(r[k]) === v));
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 20);
    return { items: selected.slice(offset, offset + limit), total: selected.length };
  };
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/admin/update") { crm = crm.map(r => r.code === code(1) ? { ...r, tier: "重点" } : r).concat([{ code: "A100", owner: "销售1", tier: "标准" }]); res.end("{}"); return; }
  if (url.pathname === "/admin/drift") { orders = orders.map(r => ({ ...r, amount: `${r.amount}元` })); res.end("{}"); return; }
  const rows = ({ "/companies": crm, "/registry": registry, "/orders": orders } as Record<string, Record<string, unknown>[]>)[url.pathname];
  if (!rows) { res.statusCode = 404; res.end("{}"); return; }
  res.end(JSON.stringify(page(rows)));
});
await new Promise<void>(resolve => sources.listen(0, "127.0.0.1", resolve));
const sourceUrl = `http://127.0.0.1:${(sources.address() as AddressInfo).port}`;

const service = await createServer({ directory, automaticApi: false });
await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
const call = async (path: string, body?: unknown, headers: Record<string, string> = { "x-dataengine-token": service.adminToken }) => {
  const r = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
  return { status: r.status, body: await r.json() as any };
};
const api = async (path: string, body?: unknown) => {
  const r = await call(path, body);
  if (r.status >= 300) throw new Error(`${path}: HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const ref = (a: { id: string; version: number }) => ({ id: a.id, version: a.version });
const finished = async (path: string, id: string) => {
  for (let i = 0; i < 600; i++) {
    const job = (await api(path)).jobs.find((j: any) => j.id === id);
    if (job && !["queued", "running"].includes(job.status)) return job;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`${path} 任务超时`);
};
const sync = async (operationId: string) => finished("/api/data", (await api("/api/data/sync", { operationId })).job.id);
const dataset = async (name: string) => (await api("/api/data")).datasets.find((d: any) => String(d.content.name).startsWith(name));
const read = (key: string, type: string, id: string) => call(`/v4/objects?type=${encodeURIComponent(type)}&id=${id}`, undefined, { authorization: `Bearer ${key}` });
const props = (r: any) => Object.fromEntries(Object.entries(r.body.items[0].properties).map(([k, v]: any) => [k, v.value]));

let failed = false;
try {
  for (const [name, capability] of [
    ["CRM", { name: "companies", path: "/companies", fields: ["code", "owner", "tier"], idField: "code", totalPath: "total", filters: { code: "code" } }],
    ["工商登记", { name: "registry", path: "/registry", fields: ["company_code", "name", "city"], idField: "company_code", totalPath: "total", filters: { company_code: "company_code" } }],
    ["订单系统", { name: "orders", path: "/orders", fields: ["order_id", "company_id", "amount"], idField: "order_id", totalPath: "total", filters: { order_id: "order_id", company_id: "company_id" } }],
  ] as const) await api("/api/live/connect", { name, protocol: "http", url: sourceUrl, capabilities: [capability] });

  const first = await sync("sync-1");
  assert.equal(first.status, "completed", JSON.stringify(first.content));
  const counts = (await api("/api/data")).datasets.map((d: any) => `${d.content.name} ${d.content.profile.rows} 行`);
  assert.equal(counts.length, 3);
  record("同步快照", counts.join("、"));

  const build = await finished("/api/engine", (await api("/api/engine/build", { operationId: "build-1" })).job.id);
  assert.equal(build.content.outcome, "candidate", JSON.stringify(build.content.issues));
  let candidate = (await api("/api/engine")).candidate;
  const types = candidate.content.types as any[], relations = candidate.content.modelRelations as any[];
  const company = types.find(t => t.supplements?.length);
  assert.ok(company, `没有形成跨来源合并：${JSON.stringify(types.map(t => t.name))}`);
  assert.equal(types.length, 2);
  assert.equal(relations.length, 1);
  record("构建本体", `${types.length} 个对象；${company.name} 合并 ${company.supplements.map((s: any) => s.name).join("、")}；关系 ${relations[0].from}→${relations[0].to}`);

  candidate = await api("/api/engine/check", ref(candidate));
  assert.equal(candidate.content.checks.valid, true, JSON.stringify(candidate.content.checks));
  const adopted = await api("/api/engine/adopt", { ...ref(candidate), operationId: "adopt-1" });
  assert.ok(adopted.model);
  record("全量检查并采用", "通过");

  const publish = async (name: string) => {
    const check = await api("/api/releases/check", { inputHash: (await api("/api/releases")).working.inputHash });
    if (check.status !== "ready") return { check, release: null };
    return { check, release: (await api("/api/releases/publish", { operationId: `publish-${name}`, checkRef: ref(check), name })).release };
  };
  const v1 = (await publish("v1")).release;
  assert.ok(v1, "v1 发布检查未通过");
  const working = (await api("/api/releases")).working;
  const conceptIds = working.definition.concepts.map((c: any) => c.id), relationIds = working.definition.relations.map((r: any) => r.id);
  const grants = (working.definition.model.types as any[]).map(t => ({ type: t.name, fields: ["$id", ...Object.keys(t.fields), ...(t.supplements ?? []).flatMap((s: any) => Object.keys(s.fields))],
    relations: (working.definition.model.relations as any[]).filter(r => r.from === t.name).map(r => r.name) }));
  const connection = await api("/api/releases/connect", { operationId: "connect", name: "链路验收接入方", releaseRef: ref(v1), conceptIds, relationIds, business: { grants } });
  const v1Key = connection.key as string;
  let r = await read(v1Key, company.name, code(1));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.consistency, "pinned_snapshot");
  assert.equal(props(r).tier, "标准");
  const merged = Object.keys(company.supplements[0].fields)[0];
  assert.ok(props(r)[merged], `合并字段 ${merged} 没有值`);
  assert.ok(merged.startsWith("工商登记_"), `合并属性应以来源名称为前缀：${merged}`);
  record("发布 v1 并接入", `${code(1)} tier=标准，${merged}=${props(r)[merged]}，pinned_snapshot`);

  await fetch(sourceUrl + "/admin/update");
  assert.equal((await sync("sync-2")).status, "completed");
  r = await read(v1Key, company.name, code(1));
  assert.equal(props(r).tier, "标准", "v1 接入方读到了来源的新值");
  record("来源数据更新并重新同步", `CRM ${(await dataset("CRM")).content.profile.rows} 行；v1 接入方仍读到 tier=标准`);

  await fetch(sourceUrl + "/admin/drift");
  assert.equal((await sync("sync-3")).status, "completed");
  const drifted = await dataset("订单系统");
  assert.ok(drifted.content.pendingVersion, "订单金额类型变化没有进入待确认");
  const blocked = await publish("blocked");
  assert.equal(blocked.release, null);
  assert.ok(blocked.check.content.issues.some((i: any) => i.code === "pending_schema"), JSON.stringify(blocked.check.content.issues));
  r = await read(v1Key, company.name, code(1));
  assert.equal(r.status, 200, "结构变化影响了已发布版本");
  record("来源结构变化", "订单金额变为文本：新版本待确认，发布检查被阻止，v1 读取不受影响");

  await api("/api/data/accept", { ...ref(drifted), operationId: "accept-drift" });
  const v2 = (await publish("v2")).release;
  assert.ok(v2, "确认结构变化后 v2 发布检查未通过");
  const diff = await api(`/api/releases/data-diff?fromId=${v1.id}&fromVersion=${v1.version}&toId=${v2.id}&toVersion=${v2.version}`);
  const crmDiff = diff.datasets.find((d: any) => String(d.name).startsWith("CRM"));
  assert.equal(crmDiff.added, 1);
  assert.equal(crmDiff.changed, 1);
  assert.ok(diff.datasets.find((d: any) => String(d.name).startsWith("订单系统")).status !== "unchanged");
  record("确认结构并发布 v2", `CRM 新增 ${crmDiff.added}、变更 ${crmDiff.changed}；订单系统 ${diff.datasets.find((d: any) => String(d.name).startsWith("订单系统")).status}`);

  const upgraded = await api("/api/releases/upgrade", { operationId: "upgrade", connectionRef: ref(connection.connection), releaseRef: ref(v2) });
  assert.equal((await read(v1Key, company.name, code(1))).status, 403, "升级后旧密钥仍可读取");
  r = await read(upgraded.key, company.name, code(1));
  assert.equal(props(r).tier, "重点");
  record("升级到 v2", "旧密钥 403；新密钥读到 tier=重点");

  await api("/api/releases/revoke", { operationId: "revoke", connectionRef: ref(upgraded.connection) });
  assert.equal((await read(upgraded.key, company.name, code(1))).status, 403);
  record("撤销接入", "密钥 403");
  console.log(JSON.stringify({ status: "passed", directory: keep ? directory : undefined, steps }, null, 2));
} catch (error) {
  failed = true;
  console.error(JSON.stringify({ status: "failed", directory, steps, error: (error as Error).stack }, null, 2));
} finally {
  await service.close?.();
  service.server.close();
  sources.close();
  if (!keep && !failed) rmSync(directory, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}

// Check order and pipeline handling follow Helix Foundry apps/api/src/assistant.ts validateBundle
// (Apache-2.0, commit 00d7927); the checks run against ADE mapping definitions over snapshots.
import { randomUUID } from "node:crypto";
import type { Data } from "../agent/contracts.ts";
import type { DatasetContent, Snapshots } from "../data/snapshots.ts";
import { quote } from "../data/executor/engine.ts";
import type { LiveMemory } from "../live/memory.ts";
import { datasetTable, type Pipeline } from "./helix-discovery.ts";

export interface SnapshotCheck {
  kind: "definition" | "type" | "supplement" | "relation" | "pipeline";
  name: string; passed: boolean; severity: "error" | "warning" | "info"; detail: string;
  type?: string; relation?: string; datasetId?: string; metrics?: Record<string, number | string | null>;
}
export interface SnapshotReport {
  valid: boolean; checks: SnapshotCheck[]; validatedAt: string;
  inputVersions: Record<string, string>; previews: Record<string, { snapshotId: string; rows: number }>;
  coverage: { complete: boolean; datasets: Record<string, DatasetContent["coverage"]> };
}
interface Definition { types: Data[]; relations: Data[] }
const LOW_MATCH = 0.8;
const pct = (n: number, d: number) => d ? `${Math.round((n / d) * 1000) / 10}%` : "—";
const text = (alias: string, column: string) => `CAST(${alias}.${quote(column)} AS VARCHAR)`;

/** Executes identity, field, merge and relation checks of a mapping definition over full snapshots. */
export async function validateDefinition(snapshots: Snapshots, live: LiveMemory, definition: Definition, pipelines: Pipeline[] = []): Promise<SnapshotReport> {
  const checks: SnapshotCheck[] = [], inputVersions: Record<string, string> = {}, previews: SnapshotReport["previews"] = {};
  const coverage: SnapshotReport["coverage"] = { complete: true, datasets: {} };
  const fail = (check: Omit<SnapshotCheck, "passed" | "severity">) => checks.push({ ...check, passed: false, severity: "error" });
  const pass = (check: Omit<SnapshotCheck, "passed" | "severity">, warning = false) => checks.push({ ...check, passed: true, severity: warning ? "warning" : "info" });
  const recordCoverage = (id: string, c: DatasetContent) => {
    if (Object.hasOwn(coverage.datasets, id)) return;
    coverage.datasets[id] = c.coverage;
    if (c.coverage?.complete !== true) {
      coverage.complete = false;
      pass({ kind: "definition", datasetId: id, name: `${c.name}：来源覆盖`,
        detail: `来源覆盖不完整：已保存 ${c.coverage?.rows ?? c.profile?.rows ?? 0} / ${c.coverage?.total ?? "未知"} 行；本次仅检查已保存的数据，不能代表全量来源。` }, true);
    }
  };
  const bound = (binding: Data) => {
    const dataset = snapshots.bindingDataset(String(binding.sourceId), String(binding.capability));
    const c = dataset?.content as unknown as DatasetContent | undefined;
    if (!dataset || !c?.activeVersion || c.materialization === "live") { coverage.complete = false; return null; }
    recordCoverage(dataset.id, c);
    inputVersions[dataset.id] = c.activeVersion;
    const { cap } = live.sources.capability(String(binding.sourceId), String(binding.capability));
    return { id: dataset.id, c, table: snapshots.table(dataset.id), idField: cap.idField, columns: new Set((c.profile?.columns ?? []).map(col => col.name)) };
  };
  const one = async (datasetIds: string[], sql: string) => (await snapshots.query(datasetIds, sql, { limit: 1 })).rows[0] as Record<string, unknown>;

  const names = definition.types.map(t => String(t.name));
  if (new Set(names).size !== names.length) fail({ kind: "definition", name: "对象名称唯一", detail: "存在重名对象类型。" });
  const relationKeys = definition.relations.map(r => `${r.from}/${r.name}`);
  if (new Set(relationKeys).size !== relationKeys.length) fail({ kind: "definition", name: "关系名称唯一", detail: "同一对象下存在重名关系。" });

  const sources = new Map<string, NonNullable<ReturnType<typeof bound>>>();
  for (const type of definition.types) {
    const name = String(type.name), b = bound(type);
    if (!b) { checks.push({ kind: "type", type: name, name: `${name}：快照`, passed: true, severity: "info", detail: "该来源没有可用快照或设为实时读取，按在线样本检查。" }); continue; }
    sources.set(name, b);
    const fields = Object.values(type.fields as Record<string, string>);
    const missing = fields.filter(f => !b.columns.has(f));
    if (missing.length) fail({ kind: "type", type: name, datasetId: b.id, name: `${name}：字段存在`, detail: `快照中缺少字段：${missing.join("、")}。` });
    if (!b.columns.has(b.idField)) { fail({ kind: "type", type: name, datasetId: b.id, name: `${name}：身份唯一`, detail: `快照中没有身份字段 ${b.idField}。` }); continue; }
    const r = await one([b.id], `SELECT count(*) AS n, count(${quote(b.idField)}) AS present, count(DISTINCT ${quote(b.idField)}) AS distinct_ids FROM ${b.table}`);
    const n = Number(r.n), present = Number(r.present), distinct = Number(r.distinct_ids);
    const metrics = { rows: n, nulls: n - present, duplicates: present - distinct };
    if (present !== n || distinct !== present) fail({ kind: "type", type: name, datasetId: b.id, name: `${name}：身份唯一`, metrics,
      detail: `${b.idField} 在 ${n} 行中有 ${n - present} 个空值、${present - distinct} 个重复值，不能作为对象身份。` });
    else pass({ kind: "type", type: name, datasetId: b.id, name: `${name}：身份唯一`, metrics, detail: `${n} 行，${b.idField} 唯一且非空。` });

    for (const s of (type.supplements as Data[] | undefined) ?? []) {
      const sb = bound(s), match = s.match as Record<string, string>;
      if (!sb) continue;
      const primary = match.primaryField === "$id" ? b.idField : (type.fields as Record<string, string>)[match.primaryField];
      if (!primary || !b.columns.has(primary) || !sb.columns.has(match.sourceField)) { fail({ kind: "supplement", type: name, datasetId: sb.id, name: `${name}：附来源「${s.name}」`, detail: "匹配字段不在快照中。" }); continue; }
      const r = await one([b.id, sb.id], `SELECT count(*) FILTER (WHERE a.${quote(primary)} IS NOT NULL) AS total,
        count(*) FILTER (WHERE m.k IS NOT NULL) AS matched, max(m.n) AS fanout
        FROM ${b.table} a LEFT JOIN (SELECT ${text("s", match.sourceField)} AS k, count(*) AS n FROM ${sb.table} s GROUP BY 1) m ON ${text("a", primary)} = m.k`);
      const total = Number(r.total), matched = Number(r.matched), fanout = Number(r.fanout ?? 0);
      const metrics = { total, matched, fanout };
      if (fanout > 1) pass({ kind: "supplement", type: name, datasetId: sb.id, name: `${name}：附来源「${s.name}」`, metrics, detail: `附来源同一 ${match.sourceField} 最多对应 ${fanout} 行，属于一对多；属性会保留冲突。匹配 ${pct(matched, total)}。` }, true);
      else pass({ kind: "supplement", type: name, datasetId: sb.id, name: `${name}：附来源「${s.name}」`, metrics, detail: `${total} 个对象中 ${matched} 个（${pct(matched, total)}）在附来源找到。` }, total > 0 && matched / total < LOW_MATCH);
    }
  }

  for (const relation of definition.relations) {
    const from = definition.types.find(t => t.name === relation.from), to = definition.types.find(t => t.name === relation.to);
    const a = sources.get(String(relation.from)), b = sources.get(String(relation.to)), label = `${relation.from} ${relation.name} ${relation.to}`;
    if (!from || !to || !a || !b) continue;
    const column = (type: Data, field: string, src: typeof a) => field === "$id" ? src.idField : (type.fields as Record<string, string>)[field];
    const fromColumn = column(from, String(relation.fromField), a), toColumn = column(to, String(relation.toField), b);
    if (!fromColumn || !toColumn || !a.columns.has(fromColumn) || !b.columns.has(toColumn)) { fail({ kind: "relation", relation: label, name: `关系：${label}`, detail: "关联字段不在快照中。" }); continue; }
    const r = await one([a.id, b.id], `SELECT count(*) FILTER (WHERE x.${quote(fromColumn)} IS NOT NULL) AS total,
      count(*) FILTER (WHERE t.k IS NOT NULL) AS matched, count(DISTINCT ${text("x", fromColumn)}) AS distinct_from
      FROM ${a.table} x LEFT JOIN (SELECT DISTINCT ${text("y", toColumn)} AS k FROM ${b.table} y) t ON ${text("x", fromColumn)} = t.k`);
    const total = Number(r.total), matched = Number(r.matched), cardinality = Number(r.distinct_from) < total ? "多对一" : "一对一";
    const metrics = { total, matched, cardinality };
    if (!matched) fail({ kind: "relation", relation: label, name: `关系：${label}`, metrics, detail: `${total} 条记录的 ${fromColumn} 都没有在目标中找到，关系不成立。` });
    else pass({ kind: "relation", relation: label, name: `关系：${label}`, metrics, detail: `${total} 条中 ${matched} 条（${pct(matched, total)}）能找到目标，${cardinality}。` }, matched / total < LOW_MATCH);
  }

  // Merge pipelines run over the same snapshots; their output is persisted as a derived snapshot for later pinning.
  for (const pipeline of pipelines) {
    const inputs = snapshots.inputs(pipeline.inputs);
    for (const input of inputs) {
      inputVersions[input.datasetId] = input.version;
      recordCoverage(input.datasetId, snapshots.dataset(input.datasetId).content as unknown as DatasetContent);
    }
    const snapshotId = randomUUID();
    try {
      const out = await snapshots.run(inputs.map(({ datasetId: _, ...input }) => input), pipeline.sql, { persist: snapshotId, limit: 20 });
      previews[pipeline.datasetId] = { snapshotId, rows: out.profile.rows };
      for (const check of pipeline.checks) {
        const r = (await snapshots.run([{ table: datasetTable(pipeline.datasetId), version: snapshotId }], check.sql, { limit: 1 })).rows[0] ?? {};
        const ok = Object.values(r).length > 0 && Object.values(r).every(v => v === true || v === 1 || v === "1");
        if (ok) pass({ kind: "pipeline", name: `${pipeline.name}：${check.name}`, metrics: { rows: out.profile.rows }, detail: `合并后 ${out.profile.rows} 行。` });
        else fail({ kind: "pipeline", name: `${pipeline.name}：${check.name}`, metrics: { rows: out.profile.rows }, detail: "合并结果不满足每个对象一行，附来源可能存在一对多匹配。" });
      }
    } catch (error) { fail({ kind: "pipeline", name: pipeline.name, detail: `合并计划执行失败：${(error as Error).message}` }); }
  }
  coverage.complete &&= Object.keys(coverage.datasets).length > 0;
  return { valid: checks.every(c => c.passed), checks, validatedAt: new Date().toISOString(), inputVersions, previews, coverage };
}

export function describeReport(report: SnapshotReport) {
  const failed = report.checks.filter(c => !c.passed), warnings = report.checks.filter(c => c.passed && c.severity === "warning");
  if (failed.length) return `快照检查未通过：${failed.slice(0, 3).map(c => `${c.name}（${c.detail}）`).join("；")}${failed.length > 3 ? ` 等 ${failed.length} 项` : ""}`;
  const scope = report.coverage.complete ? "全量快照检查" : "快照检查（来源覆盖不完整，仅验证可用范围）";
  return `${scope}通过 ${report.checks.length} 项${warnings.length ? `，其中 ${warnings.length} 项需要留意` : ""}；业务含义仍需核对。`;
}

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Data } from "../agent/contracts.ts";
import type { Snapshots, DatasetContent } from "../data/snapshots.ts";
import { quote } from "../data/executor/engine.ts";
import type { Verification } from "./changes.ts";

const rules = JSON.parse(readFileSync(new URL("../../config/ontology/change-rules.json", import.meta.url), "utf8")).relation;
const column = z.object({ datasetId: z.string().min(1).max(200), column: z.string().min(1).max(200) }).strict();
export const relationSubjectSchema = z.object({
  from: column, to: column, acyclic: z.boolean().optional(),
  cardinality: z.enum(["N:1", "1:1"]).optional(), maxDepth: z.number().int().min(1).max(rules.maxDepth ?? 10).optional(),
}).strict();
export type RelationSubject = z.infer<typeof relationSubjectSchema>;
const round = (value: number) => Math.round(value * 10000) / 10000;
const present = (column: string) => `${column} IS NOT NULL AND trim(CAST(${column} AS VARCHAR)) <> ''`;
const family = (type: string) => /^(U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|DECIMAL|DOUBLE|FLOAT|REAL)/.test(type) ? "number"
  : /^(VARCHAR|CHAR|TEXT|STRING)/.test(type) ? "string" : /^(BOOLEAN|DATE|TIMESTAMP|TIME)/.exec(type)?.[0] ?? null;

/** All checks use captured snapshot versions. Type coercion and empty strings cannot manufacture matches. */
export async function verifySnapshotRelation(snapshots: Snapshots, input: RelationSubject): Promise<Omit<Verification, "ruleVersion" | "checkedAt">> {
  const subject = relationSubjectSchema.parse(input);
  const dataset = (id: string, column: string) => {
    const artifact = snapshots.dataset(id), content = artifact.content as unknown as DatasetContent;
    if (!content.activeVersion || content.materialization === "live") throw new Error("该数据集没有可核对的已采用快照");
    const field = content.profile?.columns.find(item => item.name === column);
    if (!field) throw new Error(`字段不存在：${column}`);
    return { id, content, field };
  };
  const from = dataset(subject.from.datasetId, subject.from.column), to = dataset(subject.to.datasetId, subject.to.column);
  const typeCompatible = family(from.field.type) !== null && family(from.field.type) === family(to.field.type);
  const refs = [from, to].map(side => ({ datasetId: side.id, snapshotId: side.content.activeVersion! }));
  const a = quote(snapshots.table(from.id)), b = quote(snapshots.table(to.id));
  const source = `a.${quote(subject.from.column)}`, target = `b.${quote(subject.to.column)}`;
  const match = typeCompatible ? `${source} IN (SELECT ${target} FROM ${b} b WHERE ${present(target)})` : "false";
  const [sourceResult, targetResult] = await Promise.all([
    snapshots.query(refs, `SELECT count(*) AS rows, count(*) FILTER (WHERE ${present(source)}) AS total,
      count(DISTINCT ${source}) FILTER (WHERE ${present(source)}) AS distinct_values,
      count(*) FILTER (WHERE ${present(source)} AND ${match}) AS matched FROM ${a} a`, { limit: 1 }),
    snapshots.query(refs, `SELECT count(*) FILTER (WHERE ${present(target)}) AS filled,
      count(DISTINCT ${target}) FILTER (WHERE ${present(target)}) AS distinct_values FROM ${b} b`, { limit: 1 }),
  ]);
  const s = sourceResult.rows[0], t = targetResult.rows[0];
  const total = Number(s.total), matched = Number(s.matched), sourceRows = Number(s.rows);
  const matchRate = total ? round(matched / total) : 0, targetUnique = Number(t.filled) > 0 && Number(t.filled) === Number(t.distinct_values);
  const cardinalityValid = targetUnique && (subject.cardinality !== "1:1" || total === Number(s.distinct_values));
  const complete = from.content.coverage?.complete === true && to.content.coverage?.complete === true;
  const metrics: Verification["metrics"] = { total, matched, matchRate, targetUnique, typeCompatible, cardinalityValid,
    sourceRows, sourceNonNullRate: sourceRows ? round(total / sourceRows) : 0, complete };
  const notes: string[] = [];
  if (!typeCompatible) notes.push(`关系两端类型不相容（${from.field.type} / ${to.field.type}），不能以字符串转换制造匹配`);
  if (!total) notes.push("起点列没有非空值，无法验证");
  if (!targetUnique) notes.push("目标列为空或不唯一，关联不能唯一定位记录");
  if (subject.cardinality === "1:1" && total !== Number(s.distinct_values)) notes.push("声明为一对一，但多个起点使用同一匹配值");
  let result: Verification["result"] = !typeCompatible || !total || !cardinalityValid || matchRate < rules.reviewMatchRate ? "failed" : matchRate < rules.passMatchRate || !complete ? "review" : "passed";
  if (total && matchRate < rules.reviewMatchRate) notes.push(`匹配率 ${matchRate} 低于最低线 ${rules.reviewMatchRate}`);
  else if (matchRate < rules.passMatchRate) notes.push(`匹配率 ${matchRate} 低于通过线 ${rules.passMatchRate}，需人工判断未匹配记录`);
  if (!complete) notes.push("快照覆盖不完整，检查仅适用于已保存范围，需人工核对");
  if (subject.acyclic && from.id === to.id && typeCompatible && targetUnique) {
    const limit = subject.maxDepth ?? rules.maxDepth ?? 10;
    const child = `a.${quote(subject.to.column)}`;
    const graph = await snapshots.query(refs, `WITH RECURSIVE edges AS (
      SELECT CAST(${child} AS VARCHAR) AS child, CAST(${target} AS VARCHAR) AS parent
      FROM ${a} a JOIN ${b} b ON ${source} = ${target} WHERE ${present(child)} AND ${present(source)}
    ), walk(start, node, path, depth, cycle) AS (
      SELECT child, parent, [child, parent], 1, child = parent FROM edges
      UNION ALL SELECT w.start, e.parent, list_append(w.path, e.parent), w.depth + 1, list_contains(w.path, e.parent)
      FROM walk w JOIN edges e ON w.node = e.child WHERE NOT w.cycle AND w.depth <= ${limit}
    ) SELECT coalesce(bool_or(cycle), false) AS cycle, coalesce(max(depth), 0) AS depth FROM walk`, { limit: 1 });
    const depth = Number(graph.rows[0].depth), cycle = Boolean(graph.rows[0].cycle), within = depth <= limit;
    Object.assign(metrics, { acyclic: !cycle && within, cycleDetected: cycle, maxDepth: depth, withinMaxDepth: within });
    if (cycle) notes.push("声明为无环的层级包含循环引用");
    if (!within) notes.push(`层级深度超过 ${limit} 层，未继续展开；不能确认该层级可采用`);
    if (cycle || !within) result = "failed";
  }
  return { result, metrics, notes, inputs: { snapshots: Object.fromEntries(refs.map(ref => [ref.datasetId, ref.snapshotId])),
    constraints: { acyclic: subject.acyclic ?? false, cardinality: subject.cardinality ?? "N:1", maxDepth: subject.maxDepth ?? rules.maxDepth ?? 10 } } as Data };
}

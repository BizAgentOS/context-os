import type { Executor } from "./executor/jobs.ts";
import { quote, lit, type SnapshotProfile } from "./executor/engine.ts";
export type Watermark = { field: string; value: string; kind: "number" | "time" };
/** Derive the boundary from every row, never from the bounded display profile sample. */
export async function snapshotWatermark(executor: Executor, version: string, profile: SnapshotProfile, field: string | null): Promise<Watermark | null> {
  const column = profile.columns.find(column => column.name === field);
  if (!field || !column || !profile.rows || column.nulls) return null;
  const numeric = /^(?:U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|U?HUGEINT|FLOAT|DOUBLE|DECIMAL)/.test(column.type);
  const expression = numeric ? quote(field) : `TRY_CAST(${quote(field)} AS TIMESTAMP WITH TIME ZONE)`;
  const result = await executor.run({ mode: "read", scope: "workspace", inputs: [{ table: "t", version }],
    sql: `SELECT COUNT(*) FILTER (WHERE ${expression} IS NULL) AS invalid, CAST(MAX(${expression}) AS VARCHAR) AS value FROM t`, limit: 1 });
  const row = result.rows[0];
  return Number(row.invalid) || row.value === null ? null : { field, value: numeric ? String(row.value) : new Date(String(row.value)).toISOString(), kind: numeric ? "number" : "time" };
}

/** An API claiming range support must actually honor it, just like an object filter. */
export async function validateIncrement(executor: Executor, version: string, boundary: Watermark) {
  const type = boundary.kind === "number" ? "DECIMAL(38,10)" : "TIMESTAMP WITH TIME ZONE";
  const expression = `TRY_CAST(${quote(boundary.field)} AS ${type})`;
  const result = await executor.run({ mode: "read", scope: "workspace", inputs: [{ table: "t", version }],
    sql: `SELECT COUNT(*) AS invalid FROM t WHERE ${expression} IS NULL OR ${expression} < CAST(${lit(boundary.value)} AS ${type})`, limit: 1 });
  if (Number(result.rows[0].invalid)) throw new Error("来源未遵循更新时间增量范围，保留上一版数据；请检查增量参数或改为全量同步");
}

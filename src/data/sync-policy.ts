import { z } from "zod";
import type { Artifact, Data, Repository } from "../agent/contracts.ts";
import type { SnapshotProfile } from "./executor/engine.ts";

export const scheduleSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("manual") }).strict(), z.object({ mode: z.literal("hourly") }).strict(),
  z.object({ mode: z.literal("daily"), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default("02:00") }).strict(),
  z.object({ mode: z.literal("weekly"), weekday: z.number().int().min(0).max(6), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default("02:00") }).strict(),
]);
export const qualityThresholdsSchema = z.object({ stopOnEmpty: z.boolean().default(true), rowDropRatio: z.number().min(0).max(1).default(0.5),
  criticalNullIncrease: z.number().min(0).max(1).default(0.3), criticalFields: z.array(z.string().min(1).max(200)).max(100).default([]), checkIdentity: z.boolean().default(true) }).strict();
export const syncSettingsSchema = z.object({ schedule: scheduleSchema.default({ mode: "daily", time: "02:00" }),
  incrementalField: z.string().min(1).max(200).nullable().default(null), qualityThresholds: qualityThresholdsSchema.default({ stopOnEmpty: true, rowDropRatio: 0.5, criticalNullIncrease: 0.3, criticalFields: [], checkIdentity: true }) });
export type SyncSettings = z.infer<typeof syncSettingsSchema>;
export function nextRun(schedule: SyncSettings["schedule"], after: Date): string | null {
  if (schedule.mode === "manual") return null;
  if (schedule.mode === "hourly") return new Date(after.getTime() + 3600000).toISOString();
  const next = new Date(after), [hour, minute] = schedule.time.split(":").map(Number); next.setHours(hour, minute, 0, 0);
  if (schedule.mode === "daily") { if (next <= after) next.setDate(next.getDate() + 1); }
  else { const days = (schedule.weekday - next.getDay() + 7) % 7; next.setDate(next.getDate() + days); if (next <= after) next.setDate(next.getDate() + 7); }
  return next.toISOString();
}
export function policyFor(repo: Repository, source: Artifact) {
  const stored = repo.listArtifacts("sync_policy").find(item => item.content.sourceId === source.id);
  const settings = syncSettingsSchema.parse(stored?.content ?? source.content);
  return { ...settings, sourceId: source.id, sourceVersion: source.version, version: stored?.version ?? 0,
    nextRunAt: settings.schedule.mode === "manual" ? null : stored?.content.nextRunAt as string | undefined ?? nextRun(settings.schedule, new Date(source.createdAt)), artifact: stored };
}
export function qualityBreaks(before: SnapshotProfile | null, after: SnapshotProfile, idField: string | null, settings: SyncSettings): Array<{ code: string; message: string; details: Data }> {
  const reasons: Array<{ code: string; message: string; details: Data }> = [], thresholds = settings.qualityThresholds;
  if (before?.rows && after.rows === 0 && thresholds.stopOnEmpty) reasons.push({ code: "empty_snapshot", message: "来源返回 0 行，保留上一版数据等待确认", details: { before: before.rows, after: 0 } });
  else if (before?.rows && (before.rows - after.rows) / before.rows > thresholds.rowDropRatio) reasons.push({ code: "row_drop", message: `记录数减少 ${Math.round((before.rows - after.rows) / before.rows * 100)}%，超过来源阈值`, details: { before: before.rows, after: after.rows, threshold: thresholds.rowDropRatio } });
  const identity = idField && after.columns.find(column => column.name === idField);
  if (thresholds.checkIdentity && idField && !identity && after.rows) reasons.push({ code: "identity_invalid", message: "身份键字段已缺失，等待核对", details: { field: idField, rows: after.rows } });
  if (thresholds.checkIdentity && identity && (identity.nulls > 0 || identity.distinct < after.rows)) reasons.push({ code: "identity_invalid", message: "身份键存在空值或重复，等待核对", details: { field: idField, nulls: identity.nulls, distinct: identity.distinct, rows: after.rows } });
  for (const field of thresholds.criticalFields) {
    const previous = before?.columns.find(column => column.name === field), current = after.columns.find(column => column.name === field);
    const a = previous && before?.rows ? previous.nulls / before.rows : 0, b = current && after.rows ? current.nulls / after.rows : 1;
    if (b - a > thresholds.criticalNullIncrease) reasons.push({ code: "critical_nulls", message: `关键字段「${field}」空值率明显上升`, details: { field, before: a, after: b, threshold: thresholds.criticalNullIncrease } });
  }
  return reasons;
}

// Adapted from Helix Foundry services/executor/src/limits.ts (Apache-2.0, commit 00d7927).
import type { Execution } from "./engine.ts";

// A waiting reader keeps EXECUTOR_QUERY_TIMEOUT (2 minutes); ingest, persist and materialize
// read or write whole tables and keep EXECUTOR_JOB_TIMEOUT (15 minutes). Seconds, 1 to 86400.
const settings = { query: ["EXECUTOR_QUERY_TIMEOUT", 120], job: ["EXECUTOR_JOB_TIMEOUT", 15 * 60] } as const;
export interface TimeLimit { ms: number; setting: string }

export function timeLimit(job: Partial<Pick<Execution, "mode" | "persist">>): TimeLimit {
  const [setting, fallback] = settings[(job.mode === "query" || job.mode === "read") && !job.persist ? "query" : "job"];
  const value = process.env[setting]?.trim();
  const seconds = value ? Number(value) : fallback;
  if ((value && !/^\d+(\.\d+)?$/.test(value)) || !(seconds >= 1 && seconds <= 86400)) throw new Error(`Invalid ${setting}: ${value} (whole or decimal seconds, from 1 to 86400)`);
  return { ms: seconds * 1000, setting };
}

export function duration(ms: number) {
  const unit = ms % 60000 ? ["second", 1000] as const : ["minute", 60000] as const;
  const n = ms / unit[1];
  return `${n} ${unit[0]}${n === 1 ? "" : "s"}`;
}

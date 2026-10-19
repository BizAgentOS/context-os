import { z } from "zod";
import type { Data } from "../agent/contracts.ts";

/** Shared by execution, discovery and tool descriptions. */
export const readModeSchema = z.enum(["active_snapshot", "live", "release_pinned"]);
export type ReadMode = z.infer<typeof readModeSchema>;
export const workspaceReadModeSchema = z.enum(["active_snapshot", "live"]);
export interface SourceReading {
  id: string;
  name: string;
  capability: string;
  readMode: "snapshot" | "live";
  datasetId: string | null;
  snapshotId: string | null;
  dataAsOf: string | null;
  coverage: Data | null;
  status?: "read" | "unavailable" | "not_read";
}
export interface ReadingReceipt {
  readMode: ReadMode;
  versions: { ontology: { id: string; version: number } | null; mapping: { id: string; version: number }; release?: { id: string; version: number } };
  sources: SourceReading[];
  consistency: string;
  multiSourceTime: string;
}
export function readingConsistency(mode: ReadMode, sources: Pick<SourceReading, "readMode">[]) {
  const snapshots = sources.filter(s => s.readMode === "snapshot").length;
  return snapshots === 0 ? "on_demand_not_atomic" : snapshots < sources.length
    ? mode === "release_pinned" ? "pinned_snapshot_with_on_demand" : "active_snapshot_with_live"
    : mode === "release_pinned" ? "pinned_snapshot" : "active_snapshot";
}
export function readingDescription(mode: ReadMode, sources?: Pick<SourceReading, "readMode">[]) {
  const text = mode === "active_snapshot"
    ? "Default readMode=active_snapshot reads each dataset's adopted snapshot; set readMode=live for an explicit current-source read."
    : mode === "release_pinned"
      ? "readMode=release_pinned reads the snapshot versions fixed by this release."
      : "readMode=live explicitly reads current source records.";
  const mixed = sources?.some(s => s.readMode === "snapshot") && sources.some(s => s.readMode === "live");
  return `${text} ${mixed ? "This view mixes snapshot and live sources. " : ""}Datasets configured as live remain live and are labelled per source. The receipt reports ontology/mapping/release versions, source snapshotId, dataAsOf and coverage. Source times may differ; there is no cross-source atomic business timestamp. Saved evidence is a past reading, not a fresh query.`;
}
export const multipleSourceTimes = "各来源数据截至时间可能不同；快照时间为同步时间，不代表统一业务时点。";

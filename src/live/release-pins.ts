import type { Data } from "../agent/contracts.ts";
import { pinKey, type SnapshotPins } from "./memory.ts";

/** Published definition owns its complete snapshot set; an empty set preserves explicit live bindings. */
export function snapshotPinsForRelease(definition: Data | undefined): SnapshotPins {
  const snapshots = (definition?.snapshots ?? []) as Array<{ sourceId: string; capability: string; snapshotId: string }>;
  return Object.fromEntries(snapshots.map(snapshot => [pinKey(snapshot.sourceId, snapshot.capability), snapshot.snapshotId]));
}

/** The local corrections a release was published with, as `id@version` pins. Empty for releases that predate corrections. */
export function correctionPinsForRelease(definition: Data | undefined): string[] {
  const corrections = (definition?.corrections ?? []) as Array<{ id: string; version: number }>;
  return corrections.map(item => `${item.id}@${item.version}`).sort();
}

import type { Data } from "../agent/contracts.ts";
import { pinKey, type SnapshotPins } from "./memory.ts";

/** Published definition owns its complete snapshot set; an empty set preserves explicit live bindings. */
export function snapshotPinsForRelease(definition: Data | undefined): SnapshotPins {
  const snapshots = (definition?.snapshots ?? []) as Array<{ sourceId: string; capability: string; snapshotId: string }>;
  return Object.fromEntries(snapshots.map(snapshot => [pinKey(snapshot.sourceId, snapshot.capability), snapshot.snapshotId]));
}

// Adapted from Helix Foundry services/executor/src/paths.ts (Apache-2.0, commit 00d7927).
import { resolve } from "node:path";

// DuckDB spills here; the executor owns everything under it.
export const scratchRoot = (root: string) => resolve(root, "scratch");
export const snapshotFile = (root: string, scope: string, version: string) => resolve(root, "datasets", scope, version + ".parquet");
export const incomingDir = (root: string, scope: string) => resolve(root, "incoming", scope);
// A materialize job writes all rows here as JSON lines, for the caller to read once and delete.
export const resultFile = (root: string, scope: string, version: string) => resolve(root, "results", scope, version + ".jsonl");

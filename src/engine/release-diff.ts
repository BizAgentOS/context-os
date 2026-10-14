import { createHash } from "node:crypto";
import type { Json } from "../agent/contracts.ts";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const fingerprint = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

export interface ReleaseDifference {
  path: string;
  kind: "added" | "removed" | "changed";
  before: Json;
  after: Json;
}

/** Compare actual semantic content; keyed lists retain stable object identities. */
export function releaseDiff(before: unknown, after: unknown, path = ""): ReleaseDifference[] {
  if (canonical(before) === canonical(after)) return [];
  const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const keyed = (v: unknown[]): Record<string, unknown> | null => {
    if (!v.every(item => plain(item) && typeof (item.id ?? item.name ?? item.sourceId) === "string")) return null;
    const pairs = v.map(item => {
      const r = item as Record<string, unknown>;
      return [String(r.id ?? (r.from ? `${r.from}/${r.name}` : r.name) ?? r.sourceId), r] as const;
    });
    return new Set(pairs.map(([k]) => k)).size === pairs.length ? Object.fromEntries(pairs) : null;
  };
  if (Array.isArray(before) && Array.isArray(after)) {
    const a = keyed(before), b = keyed(after);
    if (a && b) return releaseDiff(a, b, path);
  }
  if (plain(before) && plain(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(k => releaseDiff(before[k], after[k], `${path}/${k.replaceAll("~", "~0").replaceAll("/", "~1")}`));
  return [{ path: path || "/", kind: before === undefined ? "added" : after === undefined ? "removed" : "changed", before: (before ?? null) as Json, after: (after ?? null) as Json }];
}

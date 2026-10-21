import { retrySourceRead } from "./source-retry.ts";
import { open, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { Capability, SourceConnections } from "../live/sources.ts";
import { jsonData } from "../live/sources.ts";
import { fingerprint } from "../engine/release-diff.ts";
import { incomingDir } from "./executor/paths.ts";

const pageSize = 100;
const reference = (item: Artifact) => ({ id: item.id, version: item.version });
/** Flush each complete page before recording its offset; truncate uncommitted bytes when resuming. */
export async function readSnapshotPages(memory: MemoryStore, sources: SourceConnections, root: string, source: Artifact, cap: Capability, limit: number, baseSnapshot: string | null, incremental?: { field: string; since: string }, knownFields?: string[], excludedFields?: string[]) {
  const directory = incomingDir(root, "workspace"); await mkdir(directory, { recursive: true });
  const signature = fingerprint({ source: reference(source), capability: cap, limit, baseSnapshot, incremental, knownFields, excludedFields });
  const previous = memory.listArtifacts("sync_checkpoint").find(item => item.status === "reading" && item.content.sourceId === source.id && item.content.capability === cap.name);
  let checkpoint = previous?.content.signature === signature ? previous : undefined;
  if (previous && !checkpoint) {
    memory.putArtifact({ ...previous, expectedVersion: previous.version, status: "superseded" });
    if (/^[a-f0-9-]+\.jsonl$/.test(String(previous.content.filename))) await rm(join(directory, String(previous.content.filename)), { force: true });
  }
  if (checkpoint) {
    const filename = String(checkpoint.content.filename);
    if (!/^[a-f0-9-]+\.jsonl$/.test(filename) || !await stat(join(directory, filename)).then(info => info.size >= Number(checkpoint!.content.bytes)).catch(() => false)) {
      memory.putArtifact({ ...checkpoint, expectedVersion: checkpoint.version, status: "unavailable" }); checkpoint = undefined;
    }
  }
  if (!checkpoint) checkpoint = memory.putArtifact({ kind: "sync_checkpoint", title: "分页同步进度", status: "reading", content: jsonData({ signature, sourceId: source.id, sourceVersion: source.version, capability: cap.name,
    filename: randomUUID() + ".jsonl", rows: 0, bytes: 0, total: null, continuation: null, done: false, observedFields: [], baseSnapshot }) });
  const filename = String(checkpoint.content.filename), file = join(directory, filename);
  const handle = await open(file, "a+", 0o600);
  let rows = Number(checkpoint.content.rows), bytes = Number(checkpoint.content.bytes), total = checkpoint.content.total as number | null;
  const observedFields = new Set(checkpoint.content.observedFields as string[] ?? []);
  let continuation = checkpoint.content.continuation as string | null, done = checkpoint.content.done === true;
  await handle.truncate(bytes);
  try {
    while (!done && rows < limit) {
      const count = cap.pagination?.type === "page" ? pageSize : Math.min(pageSize, limit - rows);
      const read = () => sources.readRecordPage(source.id, cap.name, {}, rows, count, source.version, continuation ?? undefined, incremental, { knownFields, excludedFields });
      const page = source.content.protocol === "mcp" ? await retrySourceRead(read) : await read();
      for (const field of page.observedFields ?? []) observedFields.add(field);
      if (observedFields.size > 2000) throw new Error("快照字段元数据超过有界检查范围，请提供精简接口");
      const selected = page.items.slice(0, limit - rows), body = selected.map(row => JSON.stringify(row) + "\n").join("");
      await handle.writeFile(body); await handle.sync();
      bytes += Buffer.byteLength(body); rows += selected.length; total = page.coverage.total;
      continuation = page.continuation; done = !continuation;
      checkpoint = memory.putArtifact({ ...checkpoint, expectedVersion: checkpoint.version, content: { ...checkpoint.content, rows, bytes, total, continuation, done, observedFields: [...observedFields].sort() } });
    }
    return { file, filename, checkpoint, rows, total, observedFields: [...observedFields].sort(), excludedFields: excludedFields ?? [...observedFields].filter(field => !cap.fields.includes(field)).sort(), complete: done && (total === null || rows >= total) };
  } finally { await handle.close(); }
}
export async function finishSnapshotPages(memory: MemoryStore, reading: Awaited<ReturnType<typeof readSnapshotPages>>, status: "completed" | "invalid" = "completed") {
  const checkpoint = memory.getArtifact(reading.checkpoint.id);
  memory.putArtifact({ ...checkpoint, expectedVersion: checkpoint.version, status, content: { ...checkpoint.content, continuation: null } });
  await rm(reading.file, { force: true });
}

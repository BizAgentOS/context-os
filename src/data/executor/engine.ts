// Adapted from Helix Foundry services/executor/src/engine.ts (Apache-2.0, commit 00d7927).
// ADE changes are listed in third_party/helix-foundry/MODIFICATIONS.md.
import { DuckDBInstance, type DuckDBConnection, type Json } from "@duckdb/node-api";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, rename, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { dirname, resolve } from "node:path";
import { resultFile, scratchRoot, snapshotFile } from "./paths.ts";

export const quote = (v: string) => '"' + v.replaceAll('"', '""') + '"';
export const lit = (v: string) => "'" + v.replaceAll("'", "''") + "'";
export const safePart = (s: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(s);

export interface ColumnProfile { name: string; type: string; nulls: number; distinct: number; examples: unknown[]; sensitive: boolean; primaryKey: boolean }
export interface SnapshotProfile { rows: number; duplicateRows: number; columns: ColumnProfile[]; sample: Record<string, unknown>[]; fingerprint: string }
export interface ExecutionInput { table: string; version: string; aliases?: string[]; filters?: { column: string; value: string | number | boolean | null }[] }
export interface Execution {
  mode: "ingest" | "query" | "materialize";
  scope: string; version?: string; file?: string;
  inputs?: ExecutionInput[]; sql?: string; persist?: boolean; offset?: number; limit?: number;
}
export interface Executed { profile: SnapshotProfile; version?: string; rows: Record<string, Json>[] }
export interface Materialized { version: string; count: number }

// Stored samples and examples keep only the start of a long value.
export const SAMPLE_VALUE_LIMIT = 200;
export function compactValue(v: unknown): unknown {
  const text = typeof v === "string" ? v : v && typeof v === "object" ? JSON.stringify(v) : undefined;
  return text !== undefined && text.length > SAMPLE_VALUE_LIMIT ? text.slice(0, SAMPLE_VALUE_LIMIT) + "…" : v;
}
export const compactSample = (rows: Record<string, unknown>[]) => rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, compactValue(v)])));

const units: Record<string, number> = { b: 1, k: 1e3, kb: 1e3, m: 1e6, mb: 1e6, g: 1e9, gb: 1e9, t: 1e12, tb: 1e12, kib: 2 ** 10, mib: 2 ** 20, gib: 2 ** 30, tib: 2 ** 40 };
/** A size as DuckDB settings take it (2GB = 10^9 bytes, 2GiB = 2^30); NaN otherwise. */
export function bytes(size: string) {
  const [, n, unit = "b"] = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)?\s*$/i.exec(size) || [];
  return Number(n) * (units[unit.toLowerCase()] ?? NaN);
}

// The Parquet writer cannot spill a row group, so a group holds about 1/16 of the memory setting.
async function rowGroupSize(c: DuckDBConnection, file: string, size: number, parquet: boolean) {
  let width: number;
  if (parquet) width = Number((await c.runAndReadAll(`SELECT (SELECT sum(total_uncompressed_size) FROM parquet_metadata(${lit(file)})) / greatest(1, (SELECT num_rows FROM parquet_file_metadata(${lit(file)}))) AS width`)).getRowObjectsJson()[0].width);
  else {
    const handle = await open(file, "r");
    try {
      const head = Buffer.alloc(Math.min(size, 1 << 20)), { bytesRead } = await handle.read(head, 0, head.length, 0);
      let lines = 1;
      for (let i = 0; i < bytesRead; i++) if (head[i] === 10) lines++;
      width = bytesRead / lines;
    } finally { await handle.close(); }
  }
  const budget = Math.min(32 << 20, bytes(process.env.DUCKDB_MEMORY || "512MB") / 16);
  return Math.max(2048, Math.min(122_880, Math.floor(budget / Math.max(1, width || 1))));
}

/** Runs one job against immutable Parquet snapshots. The caller passes a scratch directory it always removes. */
export async function execute(job: Execution & { mode: "materialize" }, root: string, scratch?: string): Promise<Materialized>;
export async function execute(job: Execution, root: string, scratch?: string): Promise<Executed>;
export async function execute(job: Execution, root: string, scratch?: string): Promise<Executed | Materialized> {
  if (!safePart(job.scope) || (job.version && !safePart(job.version)) || (job.mode !== "query" && !job.version) || (job.persist && !job.version)) throw new Error("Invalid storage identity");
  const out = job.version ? snapshotFile(root, job.scope, job.version) : resolve(scratchRoot(root), "none.parquet");
  if (job.version) await mkdir(dirname(out), { recursive: true });
  if (!scratch) await mkdir(scratchRoot(root), { recursive: true });
  const temp = scratch || await mkdtemp(resolve(scratchRoot(root), "executor-"));
  let db: DuckDBInstance | undefined, c: DuckDBConnection | undefined, streamed: string | undefined;
  try {
    db = await DuckDBInstance.create(":memory:", { memory_limit: process.env.DUCKDB_MEMORY || "512MB", threads: "2", temp_directory: temp,
      allow_unsigned_extensions: "false", autoinstall_known_extensions: "false", autoload_known_extensions: "false" });
    c = await db.connect();
    const spill = process.env.DUCKDB_SPILL_LIMIT?.trim();
    if (spill) await c.run(`SET max_temp_directory_size = ${lit(spill)}`).catch((e: Error) => { throw new Error(`Invalid DUCKDB_SPILL_LIMIT: ${spill}. ${e.message}`); });
    if (job.mode === "ingest") {
      if (!job.file || !/^[-\w]+\.(csv|json|jsonl|parquet)$/.test(job.file)) throw new Error("Invalid input file");
      const file = resolve(root, "incoming", job.scope, job.file), info = await stat(file);
      const fn = job.file.endsWith(".csv") ? "read_csv_auto" : job.file.endsWith(".parquet") ? "read_parquet" : "read_json_auto";
      if (info.size === 0) await c.run("CREATE TABLE result (__ade_empty VARCHAR)").then(() => c!.run("DELETE FROM result"));
      else {
        // Straight to Parquet, which the profile then reads; JSON columns come from every row.
        streamed = resolve(temp, "ingest.parquet");
        const json = fn === "read_json_auto";
        if (json) await c.run("SET threads = 1");
        let input = file, projection = "*", options = "";
        if (json) {
          // Encode only keys so case-sensitive JSON names cannot collide in DuckDB's columns struct.
          // Stream native JSON text without parsing values in JS (including integers beyond JS precision).
          input = resolve(temp, "typed-input.jsonl");
          const keys = (await c.runAndReadAll(`SELECT json_keys(json_group_structure(json)) AS keys FROM read_json_objects(${lit(file)})`)).getRowObjectsJson()[0].keys as string[];
          const fields = keys.map(key => `${lit("ade_" + Buffer.from(key).toString("hex"))}, json_extract(json, ${lit("/" + key.replaceAll("~", "~0").replaceAll("/", "~1"))})`);
          const records = await c.stream(`SELECT json_object(${fields.join(", ")}) AS encoded FROM read_json_objects(${lit(file)})`);
          await pipeline(async function* () {
            for await (const rows of records.yieldRowObjectJson()) yield rows.map(row => String(row.encoded) + "\n").join("");
          }, createWriteStream(input));
          const schema = (await c.runAndReadAll(`DESCRIBE SELECT * FROM read_json_auto(${lit(input)}, sample_size = -1)`)).getRowObjectsJson();
          // JSON dates, times and UUIDs are strings. Keep their original spelling while retaining numeric and boolean types.
          const columns = schema.map(col => `${lit(String(col.column_name))}: ${lit(String(col.column_type).replace(/^(DATE|TIME|TIMESTAMP(?: WITH TIME ZONE)?|UUID)((?:\[\])*)$/, "VARCHAR$2"))}`);
          options = `, sample_size = -1, columns = {${columns.join(", ")}}`;
          projection = schema.map(col => `${quote(String(col.column_name))} AS ${quote(Buffer.from(String(col.column_name).slice(4), "hex").toString("utf8"))}`).join(", ");
        }
        // The subquery applies DuckDB's usual name deduplication only after original JSON keys are restored.
        await c.run(`COPY (SELECT * FROM (SELECT ${projection} FROM ${fn}(${lit(input)}${options}))) TO ${lit(streamed)} (FORMAT PARQUET, ROW_GROUP_SIZE ${await rowGroupSize(c, input, (await stat(input)).size, fn === "read_parquet")})`);
        if (json) await c.run("SET threads = 2");
        await c.run(`CREATE VIEW result AS SELECT * FROM read_parquet(${lit(streamed)})`);
      }
    } else {
      for (const input of job.inputs || []) {
        if (!safePart(input.table) || !safePart(input.version)) throw new Error("Invalid input");
        await c.run(`CREATE TABLE ${quote(input.table)} AS SELECT * FROM read_parquet(${lit(snapshotFile(root, job.scope, input.version))})`);
        for (const filter of input.filters || []) {
          const value = filter.value === null ? "NULL" : typeof filter.value === "string" ? lit(filter.value) : String(filter.value);
          await c.run(`DELETE FROM ${quote(input.table)} WHERE NOT (${quote(filter.column)} IS NOT DISTINCT FROM ${value})`);
        }
      }
      const aliasCounts = new Map<string, number>();
      for (const input of job.inputs || []) for (const alias of input.aliases || []) aliasCounts.set(alias.toLowerCase(), (aliasCounts.get(alias.toLowerCase()) || 0) + 1);
      const taken = new Set([...(job.inputs || []).map(i => i.table.toLowerCase()), "result"]);
      for (const input of job.inputs || []) for (const alias of input.aliases || []) {
        if (aliasCounts.get(alias.toLowerCase()) !== 1 || taken.has(alias.toLowerCase())) continue;
        await c.run(`CREATE VIEW ${quote(alias)} AS SELECT * FROM ${quote(input.table)}`);
        taken.add(alias.toLowerCase());
      }
      const sql = job.sql?.trim().replace(/;\s*$/, "");
      if (!sql || !/^\s*(select|with)\b/i.test(sql)) throw new Error("Only a single SELECT query is allowed");
      if ((await c.extractStatements(sql)).count !== 1) throw new Error("Only a single SELECT query is allowed");
      await c.run(`SET allowed_paths = [${lit(out)}]`);
      await c.run("SET enable_external_access = false");
      await c.run("SET lock_configuration = true");
      if (job.mode === "materialize") {
        // One pass, no profile; the size cap stops a row-multiplying join long before the time limit.
        const limit = process.env.EXECUTOR_RESULT_LIMIT || "2GB", max = bytes(limit);
        if (!(max >= 0)) throw new Error("Invalid EXECUTOR_RESULT_LIMIT: " + limit);
        const result = await c.stream(`SELECT * FROM (${sql}) AS ade_result`);
        const partial = resolve(temp, "result.jsonl"), file = resultFile(root, job.scope, job.version!);
        let count = 0, size = 0;
        await pipeline(async function* () {
          for await (const rows of result.yieldRowObjectJson()) {
            const lines = rows.map(row => JSON.stringify(row) + "\n").join("");
            size += Buffer.byteLength(lines);
            if (size > max) throw new Error(`Result exceeds EXECUTOR_RESULT_LIMIT (${limit})`);
            count += rows.length;
            yield lines;
          }
        }, createWriteStream(partial));
        await mkdir(dirname(file), { recursive: true });
        await rename(partial, file).catch(e => e.code === "EXDEV" ? copyFile(partial, file) : Promise.reject(e));
        return { version: job.version!, count };
      }
      await c.run(`CREATE TABLE result AS SELECT * FROM (${sql}) AS ade_result`);
    }
    if ((job.mode === "ingest" && !streamed) || job.persist) await c.run(`COPY result TO ${lit(out)} (FORMAT PARQUET)`);
    const rows = Number((await c.runAndReadAll("SELECT count(*) n FROM result")).getRowObjectsJson()[0].n);
    const schema = (await c.runAndReadAll("DESCRIBE result")).getRowObjectsJson().filter(col => !(rows === 0 && col.column_name === "__ade_empty"));
    const sample = (await c.runAndReadAll(`SELECT * FROM result LIMIT ${Math.min(job.limit || 50, 1000)} OFFSET ${Math.max(job.offset || 0, 0)}`)).getRowObjectsJson();
    const stored = compactSample(sample);
    const columns: ColumnProfile[] = [];
    for (const col of schema) {
      const name = String(col.column_name), q = quote(name);
      // Distinct values are counted by hash: DuckDB cannot spill a distinct set of wide values.
      const p = (await c.runAndReadAll(`SELECT (SELECT count(*)-count(${q}) FROM result) AS null_count, (SELECT count(*) FROM (SELECT DISTINCT hash(${q}) FROM result WHERE ${q} IS NOT NULL)) AS distincts`)).getRowObjectsJson()[0];
      columns.push({ name, type: String(col.column_type), nulls: Number(p.null_count), distinct: Number(p.distincts), examples: stored.slice(0, 3).map(r => r[name]),
        sensitive: /email|phone|ssn|password|secret|token|address|birth|credit|邮箱|电话|手机|身份证|密码|地址|生日/i.test(name),
        primaryKey: rows > 0 && Number(p.null_count) === 0 && Number(p.distincts) === rows });
    }
    // Order-independent: the same multiset of rows has the same fingerprint.
    const fp = (await c.runAndReadAll("SELECT bit_xor(hash(result)) h, sum(hash(result)::HUGEINT) hash_sum FROM result")).getRowObjectsJson()[0];
    const duplicateRows = Number((await c.runAndReadAll("SELECT (SELECT count(*) FROM result) - count(*) AS duplicate_rows FROM (SELECT DISTINCT hash(result) FROM result)")).getRowObjectsJson()[0].duplicate_rows);
    const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
    const profile: SnapshotProfile = { rows, duplicateRows, columns, sample: stored, fingerprint: "v2:" + digest([schema, rows, fp]) };
    if (streamed) {
      c.closeSync(); c = undefined;
      await rename(streamed, out).catch(e => e.code === "EXDEV" ? copyFile(streamed!, out) : Promise.reject(e));
    }
    return { profile, version: job.version, rows: sample };
  } finally {
    c?.closeSync(); db?.closeSync();
    if (!scratch) await rm(temp, { recursive: true, force: true });
  }
}

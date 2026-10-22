// Copyright 2026 HelixDB. Licensed under the Apache License, Version 2.0.
// Modified for Context OS, 2026-10-14. Adapted from Helix Foundry discovery.ts at
// 00d7927d7c08e16c58316e006959f052427e7fa1. See third_party/helix-foundry/.
import { createHash } from "node:crypto";
import type { Data } from "../agent/contracts.ts";

export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const irregular: Record<string, string> = { people: "person", children: "child", companies: "company", statuses: "status", analyses: "analysis", series: "series", species: "species", news: "news" };
const singular = (w: string) => irregular[w] ?? (/[^aeiou]ies$/.test(w) ? w.slice(0, -3) + "y" : /(ss|us|is|ics)$/.test(w) ? w : /(x|ch|sh|ss)es$/.test(w) ? w.slice(0, -2) : /s$/.test(w) ? w.slice(0, -1) : w);
const idWords = new Set(["id", "uuid", "guid", "编号", "标识"]);
const keyWords = new Set("id uuid guid key code number no num sku slug handle username 编号 标识 代码 编码".split(" "));
const email = (n: string) => /e-?mail/i.test(n);
const idName = (n: string) => idWords.has(words(n).at(-1) || "") || /(?:编号|标识)$/.test(n);
const keyName = (n: string) => keyWords.has(words(n).at(-1) || "") || /(?:编号|标识|代码|编码)$/.test(n) || email(n);
const sameStem = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)));
const tableName = (name: string) => name.replace(/\.(csv|tsv|json)$/i, "");
const stem = (column: string, table: string) => { const ws = words(column); return singular((ws.length < 2 ? words(tableName(table)) : ws.slice(0, -1)).at(-1) || ""); };
export const entityName = (table: string) => {
  let ws = words(tableName(table));
  if (ws.length > 1 && new Set(["raw", "stg", "dim", "fact", "tbl", "app"]).has(ws[0])) ws = ws.slice(1);
  if (!ws.length) return "记录";
  ws[ws.length - 1] = singular(ws[ws.length - 1]);
  const value = ws.join(" ");
  return value.charAt(0).toUpperCase() + value.slice(1);
};

export interface ColumnProfile { name: string; type: string; distinct: number; nulls: number; unique: boolean; }
export interface DatasetProfile {
  sourceId: string; sourceVersion: number; capability: string; name: string;
  fields: ColumnProfile[]; rows: Data[]; rowCount: number | null; complete: boolean; readAt: string;
  strategy: "on_demand" | "uploaded_snapshot"; idField?: string; originSourceId?: string;
}
export interface BuildIssue {
  code: string; severity: "info" | "warning" | "error"; message: string;
  sourceId?: string; capability?: string; details?: Data;
}
const scalar = (value: unknown) => value === null || ["string", "number", "boolean"].includes(typeof value);
export function profileColumns(fields: string[], rows: Data[]): ColumnProfile[] {
  return fields.map(name => {
    const values = rows.map(row => row[name]);
    const populated = values.filter(value => value !== null && value !== undefined && value !== "");
    const distinct = new Set(populated.map(value => JSON.stringify(value))).size;
    const type = populated.every(value => typeof value === "number" && Number.isInteger(value)) ? "INTEGER"
      : populated.every(value => typeof value === "string") ? "VARCHAR"
      : populated.every(value => typeof value === "number") ? "DOUBLE"
      : populated.every(value => typeof value === "boolean") ? "BOOLEAN" : "MIXED";
    return { name, type: populated.length ? type : "UNKNOWN", distinct, nulls: values.length - populated.length,
      unique: populated.length > 0 && distinct === populated.length && values.every(scalar) };
  });
}
/** Helix's own-key ordering, with Context OS's conservative rejection of unnamed keys. */
export function ownKey(table: string, columns: ColumnProfile[]) {
  const unique = columns.filter(column => column.unique && /^(VARCHAR|INTEGER)$/.test(column.type));
  const nouns = words(tableName(table)).map(singular);
  return (unique.find(column => words(column.name).join("_") === "id" || (idName(column.name) && nouns.includes(stem(column.name, table))))
    ?? unique.find(column => idName(column.name))
    ?? unique.find(column => keyName(column.name) && !email(column.name))
    ?? unique.find(column => email(column.name)))?.name;
}

/** Overlap is an investigation lead, not evidence of a business relationship. */
export function discoverLinks(datasets: DatasetProfile[]): BuildIssue[] {
  const issues: BuildIssue[] = [];
  for (const from of datasets) for (const to of datasets) {
    if (from === to || !to.idField || !to.rows.length) continue;
    const target = to.fields.find(field => field.name === to.idField);
    if (!target?.unique) continue;
    for (const field of from.fields) {
      if (!keyName(field.name) || field.distinct < 2 || (field.name === from.idField && from.sourceId === to.sourceId)) continue;
      if ((field.type === "INTEGER" || target.type === "INTEGER") && !sameStem(stem(field.name, from.name), stem(target.name, to.name))) continue;
      const conventional = words(field.name).join("_") === words(target.name).join("_")
        || (idName(field.name) && sameStem(stem(field.name, from.name), singular(words(tableName(to.name)).at(-1) || "")));
      if (!conventional) continue;
      const values = from.rows.map(row => row[field.name]).filter(value => value !== null && value !== undefined && value !== "");
      const targetValues = new Set(to.rows.map(row => JSON.stringify(row[to.idField!])));
      const distinct = new Set(values.map(value => JSON.stringify(value)));
      const matched = values.filter(value => targetValues.has(JSON.stringify(value))).length;
      const matchedDistinct = [...distinct].filter(value => targetValues.has(value)).length;
      if (!values.length || !(matchedDistinct / distinct.size >= 0.8 || matched / values.length >= 0.9)) continue;
      issues.push({ code: "relationship_candidate", severity: "warning", sourceId: from.originSourceId ?? from.sourceId, capability: from.capability,
        message: `${from.name}.${field.name} 与 ${to.name}.${to.idField} 的样本值重叠；请核对业务含义后定义关系，程序未自动合并。`,
        details: { fromSourceId: from.sourceId, fromCapability: from.capability, fromField: field.name,
          toSourceId: to.sourceId, toCapability: to.capability, toField: to.idField!, matchedRows: matched, inspectedRows: values.length,
          matchedDistinct, distinct: distinct.size, complete: from.complete && to.complete } });
    }
  }
  return issues;
}

import type { Json, Data } from "../agent/contracts.ts";

export type ValueTransform = { op: "none" | "trim" | "lowercase" | "cast" | "parse_date"; valueType?: string; format?: string };
export const objectIdLimit = 16_384;

/** Finite, explicit transforms. Invalid values fail visibly rather than guessing a business value. */
export function transformValue(value: Json, transform?: ValueTransform): Json {
  if (value === null || !transform || transform.op === "none") return value;
  if (transform.op === "trim" || transform.op === "lowercase") {
    if (typeof value !== "string") throw new Error("文本转换需要字符串值");
    return transform.op === "trim" ? value.trim() : value.toLowerCase();
  }
  if (transform.op === "cast") {
    if (transform.valueType === "string" && ["string", "number", "boolean"].includes(typeof value)) return String(value);
    if (["integer", "decimal"].includes(transform.valueType ?? "")) {
      const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
      if (!Number.isFinite(n) || (transform.valueType === "integer" && !Number.isInteger(n))) throw new Error("数值转换失败");
      return n;
    }
    if (transform.valueType === "boolean") {
      if (value === true || value === "true" || value === 1) return true;
      if (value === false || value === "false" || value === 0) return false;
    }
    throw new Error("不支持的类型转换或原始值无效");
  }
  if (typeof value !== "string") throw new Error("日期转换需要字符串值");
  if (transform.format === "ISO8601") {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("日期不符合 ISO8601 格式");
    transformValue(value.slice(0, 10), { op: "parse_date", format: "YYYY-MM-DD" });
    return new Date(value).toISOString();
  }
  const separator = transform.format === "YYYY-MM-DD" ? "-" : transform.format === "YYYY/MM/DD" ? "/" : undefined;
  if (!separator) throw new Error("需要明确支持的日期格式");
  const parts = value.split(separator);
  if (parts.length !== 3 || !/^\d{4}$/.test(parts[0]) || !parts.slice(1).every(p => /^\d{2}$/.test(p))) throw new Error("日期不符合声明格式");
  const [year, month, day] = parts.map(Number), date = new Date(`${parts[0]}-${parts[1]}-${parts[2]}T00:00:00Z`);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error("日期值无效");
  return date.toISOString().slice(0, 10);
}

export function identityValue(row: Data, columns: string[], adapterIdField?: string): string | number {
  const values = columns.map(column => row[column]);
  if (values.some(v => v === null || v === undefined || (typeof v === "string" && !v.trim()) || !["string", "number", "boolean"].includes(typeof v))) throw new Error("对象身份字段为空或无效");
  if (values.length === 1 && typeof values[0] !== "boolean" && (!adapterIdField || adapterIdField === columns[0])) return values[0] as string | number;
  const id = `${values.length === 1 ? "key" : "composite"}:${Buffer.from(JSON.stringify(values)).toString("base64url")}`;
  if (id.length > objectIdLimit) throw new Error("业务身份字段过长，不能生成有界对象编号");
  return id;
}

export function identityFilter(id: string, columns: string[], idType: string, adapterIdField?: string): Data {
  if (columns.length === 1 && idType !== "boolean" && (!adapterIdField || adapterIdField === columns[0])) {
    if (idType === "number" && !Number.isFinite(Number(id))) throw new Error("对象编号类型无效");
    return { [columns[0]]: idType === "number" ? Number(id) : id };
  }
  const prefix = columns.length === 1 ? "key:" : "composite:";
  let values: unknown;
  try { values = JSON.parse(Buffer.from(id.slice(prefix.length), "base64url").toString()); } catch { throw new Error("业务对象编号无效，请使用查询返回的编号"); }
  if (!id.startsWith(prefix) || !Array.isArray(values) || values.length !== columns.length || values.some(v => !["string", "number", "boolean"].includes(typeof v))) throw new Error("业务对象编号无效，请使用查询返回的编号");
  return Object.fromEntries(columns.map((column, index) => [column, (values as Json[])[index]]));
}

export function scopedFilter(scope: Data = {}, filter: Data = {}): Data {
  if (Object.keys(scope).some(column => Object.hasOwn(filter, column) && scope[column] !== filter[column])) throw new Error("查询条件超出实体绑定的行过滤范围");
  return { ...scope, ...filter };
}

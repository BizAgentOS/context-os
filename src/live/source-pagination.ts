import { z } from "zod";
import { createHash } from "node:crypto";

const parameter = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_.$-]{0,99}$/);
export const paginationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("offset") }).strict(),
  z.object({ type: z.literal("page"), pageParam: parameter.default("page"), startPage: z.number().int().min(0).max(1).default(1) }).strict(),
  z.object({ type: z.literal("cursor"), cursorParam: parameter.default("cursor"), nextCursorPath: z.string().min(1).max(200).default("nextCursor") }).strict(),
  z.object({ type: z.literal("link") }).strict(),
]);
export type Pagination = z.infer<typeof paginationSchema>;
export const flattenSchema = z.object({ depth: z.number().int().min(1).max(3).default(3), arrays: z.literal("text").default("text") }).strict();
export const valueAt = (value: unknown, path: string): unknown => path ? path.split(".").reduce<unknown>((item, key) => item && typeof item === "object" && Object.hasOwn(item, key) ? (item as Record<string, unknown>)[key] : undefined, value) : value;
export const pagingScope = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const continuationSchema = z.object({ scope: z.string().length(64), offset: z.number().int().nonnegative(), next: z.union([z.string().max(16000), z.number().int().nonnegative()]) }).strict();
export function continuation(value: z.infer<typeof continuationSchema>): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
export function resume(value: string, scope: string, offset: number) {
  if (value.length > 24000) throw new Error("分页续读标识无效");
  const state = continuationSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  if (state.scope !== scope || state.offset !== offset) throw new Error("分页续读不属于当前来源版本、过滤或位置");
  return state.next;
}
export function nextLink(header: string | null): string | null {
  if (!header) return null;
  const links = header.split(/,(?=\s*<)/).filter(link => /;\s*rel\s*=\s*(?:"[^"]*\bnext\b[^"]*"|next)(?:\s*;|\s*$)/i.test(link));
  if (links.length > 1) throw new Error("来源返回多个下一页地址");
  return links[0]?.match(/^\s*<([^>]+)>/)?.[1] ?? null;
}
/** Explicitly flatten objects only; arrays remain one text value and cannot create ontology structure. */
export function flattenRecord(value: Record<string, unknown>, options: z.infer<typeof flattenSchema>): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  const visit = (item: unknown, path: string, depth: number) => {
    if (item && typeof item === "object" && !Array.isArray(item) && depth < options.depth) {
      for (const [key, child] of Object.entries(item)) visit(child, path ? `${path}.${key}` : key, depth + 1);
    } else {
      if (Object.hasOwn(result, path)) throw new Error("嵌套字段展开后名称冲突");
      result[path] = item && typeof item === "object" ? JSON.stringify(item) : item;
    }
  };
  for (const [key, item] of Object.entries(value)) visit(item, key, 0);
  return result;
}

import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { DomainTool } from "./contracts.ts";
import type { SourceConnections } from "../live/sources.ts";

const label = z.string().trim().min(1).max(200);
const dimensionName = label.refine(
  (v) => v !== "__proto__",
  "不支持保留维度名 __proto__",
);
const day = z
  .string()
  .regex(/^[1-9]\d{3}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(s + "T00:00:00Z");
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "期间必须为有效日历日期");
const dimensions = z.preprocess(
  (value) => {
    // Zod record parsing skips this own key, which would silently widen a query.
    if (value && typeof value === "object" && Object.hasOwn(value, "__proto__"))
      throw new Error("不支持保留维度名 __proto__");
    return value;
  },
  z.record(dimensionName, z.string().min(1).max(500)),
);
const definitionSchema = z
  .object({
    id: label,
    name: label,
    description: z.string().trim().min(1).max(2000),
    revision: label,
    unit: label,
    grain: z.enum(["day", "month"]),
    timeZone: label.refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, "时区无效"),
    dimensions: z
      .array(z.object({ name: dimensionName, label }).strict())
      .max(10),
    aggregation: z
      .object({
        kind: z.enum(["sum", "ratio", "average", "distinct_count", "snapshot"]),
        additiveDimensions: z.array(dimensionName).max(10),
        timeAdditive: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((d, ctx) => {
    const names = d.dimensions.map((x) => x.name),
      additive = d.aggregation.additiveDimensions;
    if (
      new Set(names).size !== names.length ||
      new Set(additive).size !== additive.length ||
      additive.some((x) => !names.includes(x))
    )
      ctx.addIssue({ code: "custom", message: "维度或可加总维度契约无效" });
    if (
      ["ratio", "average", "distinct_count"].includes(d.aggregation.kind) &&
      (additive.length || d.aggregation.timeAdditive)
    )
      ctx.addIssue({
        code: "custom",
        message: "比率、平均与去重指标不可直接加总",
      });
    if (d.aggregation.kind === "snapshot" && d.aggregation.timeAdditive)
      ctx.addIssue({ code: "custom", message: "时点存量不可跨期间加总" });
  });
const base = z
  .object({
    sourceId: label,
    capability: label,
    connectionVersion: z.number().int().positive(),
  })
  .strict();
const scope = z
  .object({
    metricId: label,
    start: day,
    end: day,
    where: dimensions.default({}),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
const querySchema = base
  .extend({
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    start: day,
    end: day,
    where: dimensions.default({}),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
const rowBase = z.object({ dimensions, periodStart: day, periodEnd: day });
const rowSchema = z.discriminatedUnion("status", [
  rowBase
    .extend({ status: z.literal("observed"), value: z.number().finite() })
    .strict(),
  rowBase
    .extend({
      status: z.literal("missing"),
      value: z.null(),
      missingReason: z.string().trim().min(1).max(1000),
    })
    .strict(),
]);
const resultSchema = z
  .object({
    definition: definitionSchema,
    query: scope,
    items: z.array(rowSchema).max(50),
    coverage: z
      .object({
        total: z.number().int().nonnegative().nullable(),
        dataComplete: z.boolean().nullable(),
      })
      .strict(),
  })
  .strict();
type Definition = z.infer<typeof definitionSchema>;
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
const hash = (v: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
function validatePeriod(start: string, end: string, grain: "day" | "month") {
  const duration = Date.parse(end) - Date.parse(start);
  if (
    duration <= 0 ||
    duration > 366 * 86400000 ||
    (grain === "month" && (!start.endsWith("-01") || !end.endsWith("-01")))
  )
    throw new Error("查询期间须左闭右开、最多366天，且与指标粒度对齐");
}
function nextPeriod(start: string, grain: "day" | "month") {
  const date = new Date(start + "T00:00:00Z");
  if (grain === "day") date.setUTCDate(date.getUTCDate() + 1);
  else date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}
function definitionFor(raw: unknown, metricId: string) {
  const d = definitionSchema.parse(raw);
  if (d.id !== metricId) throw new Error("来源返回未获准的指标身份");
  return d;
}
export const metricTools: DomainTool[] = [
  {
    name: "metric_describe",
    description:
      "实际读取获准 BI 指标定义，返回单位、维度、日/月粒度、时区、可加总规则和 definitionHash。sourceId/capability/connectionVersion 从 source_catalog 取得；不推断不存在的业务明细。",
    mutates: false,
    inputSchema: z.toJSONSchema(base),
  },
  {
    name: "metric_query",
    description:
      "按 metric_describe 返回的 definitionHash 查询当前指标观测；显式 start/end 为指标时区的日历日期，左闭右开，月指标按月首对齐。where 仅精确维度过滤。保留口径、空值原因、读取时间和覆盖；非可加总指标不得相加，不把分页当全量。",
    mutates: false,
    inputSchema: z.toJSONSchema(querySchema),
  },
];
export class MetricReader {
  private sources: SourceConnections;
  private calls = 0;
  private assertActive: () => void;
  constructor(sources: SourceConnections, assertActive: () => void = () => {}) {
    this.sources = sources;
    this.assertActive = assertActive;
  }
  private capability(input: z.infer<typeof base>) {
    this.assertActive();
    const c = this.sources.capability(
      input.sourceId,
      input.capability,
      input.connectionVersion,
    );
    if (c.cap.contentKind !== "metrics" || !c.cap.metricId)
      throw new Error("当前能力不是获准的 BI 指标");
    if (++this.calls > 40) throw new Error("本轮指标读取最多40次");
    return c;
  }
  async describe(args: unknown) {
    const input = base.parse(args),
      { cap } = this.capability(input);
    const result = await this.sources.invoke(
      input.sourceId,
      input.capability,
      { operation: "describe", metricId: cap.metricId },
      input.connectionVersion,
    );
    this.assertActive();
    const body = z
      .object({ definition: definitionSchema })
      .strict()
      .parse(result.raw);
    const definition = definitionFor(body.definition, cap.metricId!);
    return {
      kind: "metric_definition",
      definition,
      definitionHash: hash(definition),
      provenance: result.provenance,
    };
  }
  async query(args: unknown) {
    const input = querySchema.parse(args),
      { cap } = this.capability(input);
    // Generic date bounds apply before source I/O; grain is checked against its definition below.
    validatePeriod(input.start, input.end, "day");
    const current = await this.describe({
      sourceId: input.sourceId,
      capability: input.capability,
      connectionVersion: input.connectionVersion,
    });
    if (current.definitionHash !== input.definitionHash)
      throw new Error("指标定义或口径已变化，请重新读取定义后查询");
    validatePeriod(input.start, input.end, current.definition.grain);
    if (
      Object.keys(input.where).some(
        (k) => !current.definition.dimensions.some((d) => d.name === k),
      )
    )
      throw new Error("查询包含未定义的维度");
    const requested = scope.parse({
      metricId: cap.metricId,
      start: input.start,
      end: input.end,
      where: input.where,
      offset: input.offset,
      limit: input.limit,
    });
    const result = await this.sources.invoke(
      input.sourceId,
      input.capability,
      { operation: "query", ...requested },
      input.connectionVersion,
    );
    this.assertActive();
    const body = resultSchema.parse(result.raw),
      definition: Definition = definitionFor(body.definition, cap.metricId!);
    if (hash(definition) !== input.definitionHash)
      throw new Error("指标定义或口径已变化，请重新读取定义后查询");
    validatePeriod(input.start, input.end, definition.grain);
    const names = definition.dimensions.map((d) => d.name);
    if (Object.keys(input.where).some((k) => !names.includes(k)))
      throw new Error("查询包含未定义的维度");
    if (hash(body.query) !== hash(requested))
      throw new Error("来源未遵循指标查询期间、维度或分页契约");
    if (body.items.length > input.limit)
      throw new Error("指标来源未遵循分页上限");
    const keys = new Set<string>();
    const items = body.items.map((row) => {
      if (
        Object.keys(row.dimensions).length !== names.length ||
        names.some((k) => !Object.hasOwn(row.dimensions, k)) ||
        Object.entries(input.where).some(([k, v]) => row.dimensions[k] !== v)
      )
        throw new Error("指标结果维度与定义或过滤不一致");
      if (
        row.periodStart < input.start ||
        row.periodEnd > input.end ||
        row.periodEnd !== nextPeriod(row.periodStart, definition.grain) ||
        (definition.grain === "month" && !row.periodStart.endsWith("-01"))
      )
        throw new Error("指标观测期间与查询范围或粒度不一致");
      const observationId = hash({
        sourceId: input.sourceId,
        capability: input.capability,
        definitionHash: input.definitionHash,
        dimensions: row.dimensions,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
      });
      if (keys.has(observationId))
        throw new Error("同一维度与期间重复返回指标观测");
      keys.add(observationId);
      return { observationId, ...row };
    });
    const { total, dataComplete } = body.coverage;
    if (
      total !== null &&
      ((items.length > 0 && total < input.offset + items.length) ||
        (!items.length && input.offset < total))
    )
      throw new Error("指标总数与分页结果不一致");
    return {
      kind: "metric_observations",
      readId: randomUUID(),
      definition,
      definitionHash: input.definitionHash,
      query: requested,
      items,
      coverage: {
        offset: input.offset,
        shown: items.length,
        total,
        complete:
          total !== null && input.offset === 0 && items.length === total,
        nextOffset:
          items.length &&
          (total === null ? true : input.offset + items.length < total)
            ? input.offset + items.length
            : null,
        dataComplete: items.some((x) => x.status === "missing")
          ? false
          : dataComplete,
      },
      provenance: result.provenance,
    };
  }
}

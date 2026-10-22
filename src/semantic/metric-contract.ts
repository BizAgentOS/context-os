import { z } from "zod";
import { createHash } from "node:crypto";

const label = z.string().trim().min(1).max(200);
const dimensionName = label.refine(value => value !== "__proto__", "不支持保留维度名 __proto__");
export const metricDefinitionSchema = z
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
export const metricHash = (v: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");

export const metricAccessSchema = z.enum(["query", "historical_observations", "definition_only"]);
export const metricReferenceSchema = z.object({
  id: label, entityTypeId: label, name: label, description: z.string().trim().max(4000),
  metricId: label, sourceId: label, capability: label, connectionVersion: z.number().int().positive(),
  dimensions: z.array(z.object({ dimension: dimensionName, propertyId: label }).strict()).max(10),
  definition: metricDefinitionSchema, definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  access: metricAccessSchema,
}).strict().superRefine((item, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (item.metricId !== item.definition.id || metricHash(item.definition) !== item.definitionHash) fail("指标定义身份或口径指纹不一致");
  const dimensions = item.dimensions.map(value => value.dimension);
  if (new Set(dimensions).size !== dimensions.length || new Set(item.dimensions.map(value => value.propertyId)).size !== item.dimensions.length) fail("指标维度和属性对应不能重复");
  if (dimensions.length !== item.definition.dimensions.length || item.definition.dimensions.some(value => !dimensions.includes(value.name))) fail("每个实际指标维度都必须明确对应属性");
});
export type MetricReference = z.infer<typeof metricReferenceSchema>;
export type MetricDefinition = z.infer<typeof metricDefinitionSchema>;

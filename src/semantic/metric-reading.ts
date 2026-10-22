import { z } from "zod";
import type { Data } from "../agent/contracts.ts";
import { MetricReader, metricQuerySchema } from "../agent/metrics.ts";
import type { LiveMemory } from "../live/memory.ts";
import { jsonData } from "../live/sources.ts";
import type { MetricReference } from "./metric-contract.ts";

export const semanticMetricQuerySchema = metricQuerySchema.omit({ sourceId: true, capability: true, connectionVersion: true, definitionHash: true })
  .extend({ metricReferenceId: z.string().trim().min(1).max(200) }).strict();
export const publicMetric = ({ sourceId: _source, capability: _capability, connectionVersion: _connection, ...metric }: MetricReference) => metric;

/** Both QA and v4 read the definition fixed by their view, and accept only declared semantic dimensions. */
export async function readMetricReference(live: LiveMemory, references: MetricReference[], input: unknown, active: () => void, reader = new MetricReader(live.sources, active)) {
  active();
  const args = semanticMetricQuerySchema.parse(input), reference = references.find(item => item.id === args.metricReferenceId);
  if (!reference) throw new Error("指标不在当前视图或授权范围");
  const dimensions = new Map(reference.dimensions.map(item => [item.propertyId, item.dimension]));
  if (Object.keys(args.where).some(id => !dimensions.has(id))) throw new Error("过滤属性不在该指标已授权维度范围");
  const fixed = { metricReference: publicMetric(reference), definition: reference.definition, definitionHash: reference.definitionHash, historicalRecalculation: false,
    query: { metricReferenceId: args.metricReferenceId, start: args.start, end: args.end, where: args.where, offset: args.offset, limit: args.limit } };
  live.sources.capability(reference.sourceId, reference.capability, reference.connectionVersion);
  if (reference.access === "definition_only") return { status: "unavailable", reason: "definition_only", message: "来源仅开放指标定义，未读取或推算数值", result: jsonData({ ...fixed, items: [], coverage: { complete: false, total: null } }) };
  try {
    const actual = await reader.query({ sourceId: reference.sourceId, capability: reference.capability, connectionVersion: reference.connectionVersion, definitionHash: reference.definitionHash,
      start: args.start, end: args.end, where: Object.fromEntries(Object.entries(args.where).map(([id, value]) => [dimensions.get(id)!, value])), offset: args.offset, limit: args.limit });
    active();
    live.sources.capability(reference.sourceId, reference.capability, reference.connectionVersion);
    const result = jsonData({ ...fixed, items: actual.items.map(item => ({ ...item, dimensions: Object.fromEntries(reference.dimensions.map(mapping => [mapping.propertyId, item.dimensions[mapping.dimension]])) })),
      coverage: actual.coverage, sources: [{ name: "指标来源", readMode: "live", readAt: actual.provenance.readAt, dataAsOf: null }],
      versions: { definitionRevision: reference.definition.revision, definitionHash: reference.definitionHash },
      reading: "live_observations_with_fixed_definition", limits: ["固定指标定义和口径；观测为本次实际来源读取，不承诺来源支持旧口径重算"] });
    const partial = !actual.coverage.complete || actual.coverage.dataComplete !== true;
    return { status: partial ? "partial" : "available", ...(partial ? { reason: "incomplete", message: "指标观测含缺失或覆盖未完整确认，请保留来源限制" } : {}), result };
  } catch (error) {
    active();
    live.sources.capability(reference.sourceId, reference.capability, reference.connectionVersion);
    const changed = /定义|口径/.test((error as Error).message);
    return { status: "unavailable", reason: changed ? "metric_definition_changed" : "metric_unavailable", message: changed ? "来源指标定义或口径已变化，当前固定定义不能重算；请重新核对并采用新引用" : "指标来源未成功返回符合固定口径的观测，未推算数值",
      result: { ...jsonData(fixed), items: [], coverage: { complete: false, total: null }, limits: ["没有可用观测，不将缺失当作零"] } as Data };
  }
}

import type { Data } from "../agent/contracts.ts";
import { layeredModelSchema, parseLayeredModel, type LayeredModel } from "./model.ts";
import { metricReferenceSchema } from "./metric-contract.ts";

/** Metric semantics are governed by the foundation, independently of executable object bindings. */
export function projectMetricReferences(input: LayeredModel, foundation: Data): LayeredModel {
  const layered = structuredClone(input), references = metricReferenceSchema.array().parse(foundation.metricReferences ?? []);
  layered.semantic.metricReferences = references;
  const concepts = (foundation.concepts ?? []) as Data[], properties = (foundation.properties ?? []) as Data[];
  for (const reference of references) {
    const entity = concepts.find(item => item.id === reference.entityTypeId);
    if (!entity || entity.deprecated) throw new Error("实体仍有指标引用，请先显式移除或修改指标引用");
    if (!layered.semantic.entityTypes.some(item => item.id === reference.entityTypeId)) layered.semantic.entityTypes.push({
      id: reference.entityTypeId, name: String(entity.name), description: String(entity.description ?? ""),
      aliases: (entity.aliases ?? []) as string[], identityKeys: [], kind: entity.kind === "activity" ? "activity" : "record",
    });
    for (const dimension of reference.dimensions) {
      if (layered.semantic.properties.some(item => item.id === dimension.propertyId && item.entityTypeId === reference.entityTypeId)) continue;
      const property = properties.find(item => item.id === dimension.propertyId && item.entityTypeId === reference.entityTypeId);
      if (!property || property.deprecated) throw new Error("指标维度属性不能在重建中丢失，请先显式处理引用");
      const schema = layeredModelSchema.shape.semantic.shape.properties.element;
      layered.semantic.properties.push(schema.parse(Object.fromEntries(Object.keys(schema.shape).filter(key => property[key] !== undefined).map(key => [key, property[key]]))));
    }
  }
  return parseLayeredModel(layered);
}

import { z } from "zod";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { FoundationService } from "../agent/foundation.ts";
import type { LiveMemory } from "../live/memory.ts";
import { MetricReader } from "../agent/metrics.ts";
import { parseLayeredModel } from "../semantic/model.ts";
import { metricReferenceSchema, type MetricReference } from "../semantic/metric-contract.ts";
import { readStructure } from "./structure-changes.ts";
import { ChangeConflict, type OntologyChanges } from "./changes.ts";
import { fingerprint } from "./release-diff.ts";
import { jsonData } from "../live/sources.ts";
import { publicMetric } from "../semantic/metric-reading.ts";

const name = z.string().trim().min(1).max(200);
const metric = z.object({ id: name, entityTypeId: name, sourceId: name, capability: name, connectionVersion: z.number().int().positive(),
  name: name.optional(), description: z.string().trim().max(4000).optional(), dimensions: metricReferenceSchema.shape.dimensions }).strict();
export const metricReferenceSubject = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), metric }).strict(), z.object({ action: z.literal("update"), metric }).strict(),
  z.object({ action: z.literal("remove"), metric: z.object({ id: name }).strict() }).strict(),
]);
const ref = (value: Artifact) => ({ id: value.id, version: value.version });

/** The definition comes from an authorized BI read; a proposal cannot supply its own formula or revision. */
export function connectMetricReferenceChanges(memory: MemoryStore, foundation: FoundationService, live: LiveMemory, changes: OntologyChanges) {
  changes.registerHandler("metric_reference", { subject: metricReferenceSubject, prepare: async (change, active = () => {}) => {
    active();
    const subject = metricReferenceSubject.parse(change.content.subject), base = foundation.read().adopted;
    if (!base) throw new Error("请先采用指标所属实体的语义定义");
    const baseline = changes.currentBaseline(), layered = readStructure(memory, foundation, live);
    const references = structuredClone(layered.semantic.metricReferences), index = references.findIndex(item => item.id === subject.metric.id), before = references[index] ?? null;
    if (subject.action === "add" && before) throw new Error("指标引用标识已存在，请使用修改操作");
    if (subject.action !== "add" && !before) throw new Error("指标引用不存在，请重新读取本体目录");
    let after: MetricReference | null = null, assertSource = () => {};
    if (subject.action !== "remove") {
      const input = subject.metric;
      if (!layered.semantic.entityTypes.some(item => item.id === input.entityTypeId)) throw new Error("指标所属实体不存在");
      const capability = live.sources.capability(input.sourceId, input.capability, input.connectionVersion).cap;
      if (capability.contentKind !== "metrics") throw new Error("指标引用必须使用获准的 BI 指标能力");
      assertSource = () => { active(); live.sources.capability(input.sourceId, input.capability, input.connectionVersion); };
      const actual = await new MetricReader(live.sources, assertSource).describe({ sourceId: input.sourceId, capability: input.capability, connectionVersion: input.connectionVersion });
      assertSource();
      after = metricReferenceSchema.parse({ ...input, name: input.name ?? actual.definition.name, description: input.description ?? actual.definition.description,
        metricId: actual.definition.id, definition: actual.definition, definitionHash: actual.definitionHash, access: capability.metricAccess ?? "query" });
      if (index >= 0) references[index] = after; else references.push(after);
    } else references.splice(index, 1);
    layered.semantic.metricReferences = references;
    parseLayeredModel(layered);
    const assertCurrent = () => {
      active();
      if (fingerprint(changes.currentBaseline()) !== fingerprint(baseline)) throw new ChangeConflict("stale_baseline", "指标复验期间本体版本已变化，请重新提出修改");
      assertSource();
    };
    assertCurrent();
    return { verification: { result: "review" as const, metrics: { dimensions: after?.dimensions.length ?? 0, definitionRead: !!after, historicalRecalculation: false },
      notes: ["请核对指标口径、所属实体和每个维度对应；定义固定不代表来源支持旧口径重算"], inputs: { baseline, beforeHash: fingerprint(before), afterHash: fingerprint(after),
        reviewedMetric: jsonData({before:before?publicMetric(before):null,after:after?publicMetric(after):null}) } },
      previewImpact: jsonData({ before, after, requiresHumanConfirmation: true, historicalRecalculation: false }), assertCurrent,
      apply: () => {
        assertCurrent();
        const saved = memory.putArtifact({ ...base, expectedVersion: base.version, content: { ...base.content, metricReferences: jsonData(references) as unknown as Data[] } });
        return { foundationRef: ref(saved), metricReferenceId: subject.metric.id, action: subject.action, definitionHash: after?.definitionHash ?? null };
      } };
  } });
}

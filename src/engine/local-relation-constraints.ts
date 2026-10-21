import type { Artifact, Data, Repository } from "../agent/contracts.ts";
import type { LiveMemory } from "../live/memory.ts";
import { SemanticQuery } from "../semantic/query.ts";
import type { LayeredModel } from "../semantic/model.ts";

/** Check the effective graph, including existing identity and local decisions, without saving the hypothetical edge. */
export async function verifyLocalRelationConstraints(memory: Repository, live: LiveMemory, model: Artifact,
  relation: LayeredModel["semantic"]["relationTypes"][number], targetIds: string[], records: Artifact[], assertActive: () => void) {
  const inverseUnique = ["1:1", "1:N"].includes(relation.cardinality);
  if (!relation.acyclic && !inverseUnique) return { metrics: {}, inputs: {} };
  if (!live.snapshots?.read) throw new Error("关系约束复验需要完整固定快照");
  const definition = live.projectModel(model).content, reading = live.capturePreviewReading({ id: model.id, version: model.version }, definition);
  const query = new SemanticQuery(memory, live, { read: (...args) => live.snapshots!.read!(...args), bindingDataset: (...args) => live.snapshots!.bindingDataset?.(...args) });
  const options = { modelRef: { id: model.id, version: model.version }, modelDefinition: definition, ...reading,
    correctionPins: { records }, propertyCorrectionPins: false, assertActive };
  const inputs: Data = { snapshots: reading.pins }, metrics: Record<string, number | boolean> = {};
  if (relation.acyclic) {
    const result = await query.execute({ target: { entityTypeId: relation.from }, fields: [],
      traverse: [{ relationTypeId: relation.id, recursive: true, maxDepth: relation.maxDepth ?? 10 }], page: { limit: 1 } }, options);
    assertActive();
    if (!result.coverage.sourceComplete) throw new Error("层级来源覆盖不完整，不能确认全图无环");
    if (result.traversal?.cycleDetected) throw new Error("局部纠正将使已声明无环的层级产生循环");
    if (result.traversal?.truncated) throw new Error(`局部纠正后的层级深度超过 ${relation.maxDepth ?? 10} 层`);
    Object.assign(metrics, { acyclic: true, withinMaxDepth: true, maxDepthLimit: relation.maxDepth ?? 10 });
  }
  if (inverseUnique) {
    for (const id of targetIds) {
      const result = await query.execute({ target: { entityTypeId: relation.to, id }, fields: [],
        traverse: [{ relationTypeId: relation.id, direction: "in" }], page: { limit: 2 } }, options);
      assertActive();
      if (!result.coverage.sourceComplete) throw new Error("关系来源覆盖不完整，不能确认目标唯一归属");
      if (result.coverage.total === null || result.coverage.total > 1) throw new Error("局部纠正会让同一目标属于多个起点，违反关系基数约束");
    }
    metrics.inverseUnique = true;
  }
  assertActive();
  return { metrics, inputs };
}

import { z } from "zod";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { FoundationService } from "../agent/foundation.ts";
import type { LiveMemory } from "../live/memory.ts";
import type { Snapshots } from "../data/snapshots.ts";
import { ChangeConflict, type OntologyChanges, type Verification } from "./changes.ts";
import { prepareCorrectionMigration } from "../live/correction-migration.ts";
import { prepareIdentityDecisionMigration } from "../live/identity-migration.ts";
import { fingerprint } from "./release-diff.ts";
import { quote } from "../data/executor/engine.ts";
import { jsonData } from "../live/sources.ts";
import { explicitDeprecationSubject, prepareExplicitDeprecation } from "./explicit-deprecation.ts";

const name = z.string().trim().min(1).max(200);
const column = z.object({ datasetId: name, column: name }).strict();
const deprecation = z.object({ relationId: name, from: column, to: column, path: z.tuple([column, column, column, column]) }).strict();
const activity = z.object({ classification: z.literal("activity"), datasetId: name, entityTypeId: name }).strict();
const ref = (a: Artifact) => ({ id: a.id, version: a.version });
const rows = (value: unknown): Data[] => Array.isArray(value) ? structuredClone(value) : [];

export function connectDiscoveryDecisions(memory: MemoryStore, foundation: FoundationService, live: LiveMemory, snapshots: Snapshots, changes: OntologyChanges) {
  const current = () => {
    const base = foundation.read().adopted, model = memory.listArtifacts("live_ontology").find(m => m.status === "adopted");
    if (!base || !model) throw new Error("请先采用实体与来源绑定");
    return { base, model: live.projectModel(model), layered: live.readLayered(model.id, model.version) };
  };
  const captureReading = (ids: string[], model: Artifact) => {
    const baseline = changes.currentBaseline(), connections = structuredClone(model.content.connections as Data);
    const pins = snapshots.inputs(ids).map(i => ({ datasetId: i.datasetId, snapshotId: i.version }));
    const assertCurrent = () => {
      if (fingerprint(changes.currentBaseline()) !== fingerprint(baseline))
        throw new ChangeConflict("verification_changed", "工作版本已变化，请重新复验");
      for (const pin of pins) {
        const dataset = snapshots.dataset(pin.datasetId);
        if (dataset.content.activeVersion !== pin.snapshotId || dataset.content.materialization === "live")
          throw new ChangeConflict("verification_changed", "变更依赖的快照已变化，请重新复验");
      }
      for (const [id, version] of Object.entries(connections)) {
        const source = memory.getArtifact(id);
        if (source.version !== version || source.status !== "ready")
          throw new ChangeConflict("verification_changed", "变更依赖的来源权限或定义已变化，请重新复验");
      }
    };
    assertCurrent();
    return { pins, connections, assertCurrent };
  };
  changes.registerHandler("deprecation", { subject: z.union([deprecation, explicitDeprecationSubject]), prepare: async change => {
    if (Object.hasOwn(change.content.subject as Data, "target")) return prepareExplicitDeprecation(memory, foundation, live, changes, change);
    const subject = deprecation.parse(change.content.subject), { base, model, layered } = current();
    const [firstFrom, firstTo, secondFrom, secondTo] = subject.path;
    if (firstFrom.datasetId !== subject.from.datasetId || firstTo.datasetId !== secondFrom.datasetId || secondTo.datasetId !== subject.to.datasetId || secondTo.column !== subject.to.column)
      throw new Error("弃用依据必须是同一起点与终点的连续两跳路径");
    const binding = (end: z.infer<typeof column>) => layered.bindings.entities.find(b => b.role === "primary" && snapshots.bindingDataset(b.dataset.sourceId, b.dataset.capability)?.id === end.datasetId);
    const relation = (from: z.infer<typeof column>, to: z.infer<typeof column>) => layered.bindings.relations.find(r => r.fromBindingId === binding(from)?.id && r.toBindingId === binding(to)?.id && r.fromColumns.length === 1 && r.toColumns.length === 1 && r.fromColumns[0] === from.column && r.toColumns[0] === to.column);
    const direct = relation(subject.from, subject.to), first = relation(firstFrom, firstTo), second = relation(secondFrom, secondTo);
    if (direct?.relationTypeId !== subject.relationId || !first || !second || first === direct || second === direct)
      throw new Error("直接关系和替代路径必须都已采用；未采用的发现不能作为删除关系的依据");
    const pathRelations = [direct, first, second], relationIds = new Set(pathRelations.map(r => r.relationTypeId));
    const bindingIds = new Set(pathRelations.flatMap(r => [r.fromBindingId, r.toBindingId]));
    const ids = [...new Set([subject.from.datasetId, firstTo.datasetId, subject.to.datasetId])];
    const reading = captureReading(ids, model), { pins } = reading;
    const assertRawPath = () => {
      reading.assertCurrent();
      // Raw joins prove equivalence only while they also define actual object navigation.
      if (pathRelations.some(relation => relation.kind !== "foreign_key"))
        throw new Error("路径包含中间表关系，原始快照不能证明实际查询等价；保留直接关系");
      if (layered.bindings.entities.some(b => bindingIds.has(b.id) && Object.keys(b.rowFilter ?? {}).length))
        throw new Error("路径包含来源范围筛选，原始快照不能证明实际查询等价；保留直接关系");
      if (layered.bindings.identityRules.some(rule => relationIds.has(rule.relationTypeId ?? "") || bindingIds.has(rule.left.bindingId) || bindingIds.has(rule.right.bindingId)))
        throw new Error("路径包含身份治理规则或记录决定，原始快照不能证明实际查询等价；保留直接关系");
      if (memory.listArtifacts("relation_correction").some(record => {
        const target = record.content.target as Data;
        return record.status === "adopted" && target.modelId === model.id && target.modelVersion === model.version &&
          rows(model.content.relations).some(r => relationIds.has(String(r.relationId)) && r.from === target.type && r.name === target.relation);
      })) throw new Error("路径包含已采用的局部纠正，原始快照不能证明实际查询等价；保留直接关系");
    };
    assertRawPath();
    const checks = await Promise.all([[subject.from, subject.to], [firstFrom, firstTo], [secondFrom, secondTo]].map(([from, to]) => changes.checkRelation({ from, to })));
    const table = (id: string) => quote(snapshots.table(id));
    const d = `a.${quote(subject.from.column)}`, via = `b.${quote(secondFrom.column)}`;
    const measured = await snapshots.query(pins, `SELECT count(*) AS total, count(*) FILTER (WHERE ${d} = ${via}) AS matched
      FROM ${table(subject.from.datasetId)} a LEFT JOIN ${table(firstTo.datasetId)} b ON a.${quote(firstFrom.column)} = b.${quote(firstTo.column)}
      WHERE ${d} IS NOT NULL AND trim(CAST(${d} AS VARCHAR)) <> ''`, { limit: 1 });
    assertRawPath();
    const total = Number(measured.rows[0].total), matched = Number(measured.rows[0].matched);
    const passed = total > 0 && matched === total && checks.every(c => c.result === "passed");
    const verification: Omit<Verification, "ruleVersion" | "checkedAt"> = { result: passed ? "passed" : "failed",
      metrics: { total, matched, matchRate: total ? matched / total : 0, targetUnique: checks.every(c => c.metrics.targetUnique === true) },
      notes: [passed ? "全量非空起点均可沿已采用两跳路径到达同一目标；采用将仅弃用直接关系" : "替代路径不完整或结果不一致，不能弃用直接关系"],
      inputs: jsonData({ modelRef: ref(model), foundationRef: ref(base), snapshots: pins, connections: reading.connections, checks: checks.map(c => c.inputs), pathRelationIds: [first.relationTypeId, second.relationTypeId] }) };
    if (!passed) return { verification, apply: () => { throw new Error("弃用复验未通过"); } };
    const virtual: Artifact = { ...base, version: base.version + 1, content: { ...base.content, relations: rows(base.content.relations).filter(r => r.id !== subject.relationId) } };
    layered.semantic.relationTypes = layered.semantic.relationTypes.filter(r => r.id !== subject.relationId);
    layered.bindings.relations = layered.bindings.relations.filter(r => r.relationTypeId !== subject.relationId);
    const definition = await live.prepareDefinitionAgainst({ foundationRef: ref(virtual), baseModelRef: ref(model), purpose: model.content.purpose,
      layered, rationale: String(change.content.evidence) }, virtual);
    const corrections = await prepareCorrectionMigration(memory, live, definition), identities = await prepareIdentityDecisionMigration(memory, live, definition);
    assertRawPath();
    return { verification, apply: () => {
      assertRawPath();
      const adopted = memory.putArtifact({ ...base, expectedVersion: base.version, content: virtual.content });
      const mapped = memory.putArtifact({ kind: "live_ontology", title: model.title, status: "adopted", content: { ...definition, foundationRef: ref(adopted) } });
      corrections(mapped); identities(mapped);
      return { relationId: subject.relationId, foundationRef: ref(adopted), modelRef: ref(mapped) };
    } };
  } });
  changes.registerHandler("data_issue", { subject: activity, prepare: async change => {
    const subject = activity.parse(change.content.subject), { base, model, layered } = current();
    const binding = layered.bindings.entities.find(b => b.entityTypeId === subject.entityTypeId && b.role === "primary");
    if (!binding || snapshots.bindingDataset(binding.dataset.sourceId, binding.dataset.capability)?.id !== subject.datasetId) throw new Error("活动分类目标与当前实体来源不一致");
    const dataset = snapshots.dataset(subject.datasetId), profile = dataset.content.profile as Data;
    const source = live.sources.capability(binding.dataset.sourceId, binding.dataset.capability);
    const entity = layered.semantic.entityTypes.find(e => e.id === subject.entityTypeId)!;
    if (entity.kind === "activity") throw new Error("该实体已确认为活动流");
    const total = Number(profile.rows), timeColumns = rows(profile.columns).filter(c => /^(TIMESTAMP|DATE)/.test(String(c.type)) || /(?:_at|_on|date|time|时间|日期)$/i.test(String(c.name)));
    const reading = captureReading([subject.datasetId], model), { pins } = reading;
    const measured = timeColumns.length ? await snapshots.query(pins, timeColumns.map((c, index) => {
      const column = quote(String(c.name));
      return `SELECT ${index} AS col, count(*) AS total, count(*) FILTER (WHERE try_cast(${column} AS TIMESTAMP) IS NOT NULL) AS valid FROM ${quote(snapshots.table(subject.datasetId))} WHERE ${column} IS NOT NULL AND trim(CAST(${column} AS VARCHAR)) <> ''`;
    }).join(" UNION ALL "), { limit: timeColumns.length }) : { rows: [] };
    const timed = measured.rows.some(row => Number(row.total) > 0 && Number(row.valid) === Number(row.total));
    const verification: Omit<Verification, "ruleVersion" | "checkedAt"> = { result: total > 0 && timed ? "review" : "failed", metrics: { records: total, hasTime: timed },
      notes: ["表规模与时间字段只是分类线索；请明确确认业务含义。采用后保留实体标识、原始数据和对象查询。"],
      inputs: jsonData({ datasetRef: ref(dataset), snapshotId: dataset.content.activeVersion, modelRef: ref(model), sourceRef: ref(source.artifact), connections: reading.connections, profileFingerprint: fingerprint(profile) }) };
    entity.kind = "activity";
    const definition = await live.prepareDefinition({ foundationRef: ref(base), baseModelRef: ref(model), purpose: model.content.purpose, layered, rationale: String(change.content.evidence) });
    const corrections = await prepareCorrectionMigration(memory, live, definition), identities = await prepareIdentityDecisionMigration(memory, live, definition);
    reading.assertCurrent();
    return { verification, apply: () => {
      reading.assertCurrent();
      const mapped = memory.putArtifact({ kind: "live_ontology", title: model.title, status: "adopted", content: definition });
      corrections(mapped); identities(mapped);
      return { entityTypeId: entity.id, classification: "activity", modelRef: ref(mapped) };
    } };
  } });
}

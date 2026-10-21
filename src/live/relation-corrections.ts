import { projectLegacyModel, type LayeredModel } from "../semantic/model.ts";
import { objectIdLimit } from "../semantic/values.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { LiveMemory, SnapshotPins } from "./memory.ts";
import type { ReadMode } from "./reading-contract.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type {
  Artifact,
  Data,
  DomainTool,
  WriteContext,
} from "../agent/contracts.ts";
import { jsonData } from "./sources.ts";
const name = z.string().trim().min(1).max(200);
const version = z.number().int().positive();
export const correctionTarget = z
  .object({
    modelId: name,
    modelVersion: version,
    type: name,
    objectId: z.string().trim().min(1).max(objectIdLimit),
    relation: name,
  })
  .strict();
const proposal = z
  .object({
    operationId: name,
    target: correctionTarget,
    targetIds: z.array(z.string().trim().min(1).max(objectIdLimit)).max(20),
    reason: z.string().trim().min(1).max(2000),
    evidence: z.string().trim().min(1).max(4000),
  })
  .strict();
const action = z.object({ operationId: name, id: name, version }).strict();
export type CorrectionTarget = z.infer<typeof correctionTarget>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
      .join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const relationKey = (t: CorrectionTarget) => hash(t);
/** A published release fixes the corrections it was published with: `id@version` of each adopted record. */
export type PinnedCorrections = ReadonlySet<string>;
export const correctionPin = (record: { id: string; version: number }) => `${record.id}@${record.version}`;
export function activeCorrection(
  repo: Pick<MemoryStore, "listArtifacts" | "getArtifact">,
  target: CorrectionTarget,
  relationId?: string,
  historicalDefinition?: Data,
  pinned?: PinnedCorrections,
) {
  // A pinned set reads the exact stored version, even if that record was superseded since publication.
  const records = pinned
    ? [...pinned].map((pin) => { const [id, version] = pin.split("@"); return repo.getArtifact(id, Number(version)); })
    : repo.listArtifacts("relation_correction");
  return records.find((record) => {
    // Live: only the adopted decision. Pinned: that exact version, which may have been superseded since.
    if (!(pinned ? ["adopted", "superseded"] : ["adopted"]).includes(record.status)) return false;
    const saved = record.content.target as unknown as CorrectionTarget;
    if (
      saved.modelId !== target.modelId ||
      saved.modelVersion !== target.modelVersion ||
      saved.objectId !== target.objectId
    ) return false;
    const snapshot = record.content.snapshot as Data | undefined;
    const definition = (record.content.modelDefinition ?? historicalDefinition) as Data | undefined;
    const relations = definition?.layered
      ? projectLegacyModel(definition.layered as unknown as LayeredModel, { allowTransforms: true }).relations
      : definition?.relations as Data[] | undefined;
    const original = relations?.find((relation) => relation.from === saved.type && relation.name === saved.relation);
    const stableId = (snapshot?.relation as Data | undefined)?.relationId ?? original?.relationId;
    // Once a stable ID exists, a reused/swapped display name cannot select it.
    return stableId ? stableId === relationId : record.content.targetKey === relationKey(target);
  }) ?? null;
}

function correctionModel(live: LiveMemory, target: CorrectionTarget, definitionOverride?: Data, fixedSemantic = false, pins?: SnapshotPins) {
  const stored = live.assertModel(target.modelId, target.modelVersion, fixedSemantic, pins, definitionOverride);
  const layered = (stored.content.layered ?? live.readLayered(target.modelId, target.modelVersion)) as unknown as LayeredModel;
  return { ...stored, content: jsonData({ ...stored.content, ...projectLegacyModel(layered, { allowTransforms: true }), layered }) };
}

export async function captureRelation(
  live: LiveMemory,
  target: CorrectionTarget,
  targetIds: string[],
  assertActive: () => void,
  reading?: { readMode: ReadMode; pins: SnapshotPins; fixedSemantic: boolean; modelDefinition?: Data },
  definitionOverride?: Data,
) {
  const modelDefinition=definitionOverride??reading?.modelDefinition;
  const model = correctionModel(live,target,modelDefinition,reading?.fixedSemantic??false,reading?.pins);
  if (model.status !== "adopted")
    throw new Error("局部纠正需要已采用的执行映射");
  const relation = (model.content.relations as Data[]).find(
    (r) => r.from === target.type && r.name === target.relation,
  );
  if (!relation) throw new Error("关系定义不存在");
  const read = async (type: string, args: Data) => {
    assertActive();
    const result = await live.query(
      {
        modelId: target.modelId,
        modelVersion: target.modelVersion,
        type,
        ...(reading ? { readMode: reading.readMode } : {}),
        limit: 20,
        ...args,
      },
      assertActive,
      false,
      model.content,
      reading?.fixedSemantic ?? false,
      reading?.readMode === "release_pinned" ? reading.pins : undefined,
      reading,
    );
    assertActive();
    if (
      result.evidence?.some((object) =>
        object.matches.some(
          (match) =>
            match.status === "unavailable" ||
            (match.coverage && !match.coverage.complete),
        ),
      )
    )
      throw new Error("依赖来源读取失败或匹配覆盖不完整，不能形成纠正基线");
    return result;
  };
  const origin = await read(target.type, { id: target.objectId, limit: 2 });
  if (origin.items.length !== 1 || !origin.coverage.complete)
    throw new Error("起点不存在、不唯一或覆盖不完整");
  if (String(origin.items[0].$id) !== target.objectId)
    throw new Error("请使用起点对象的规范编号");
  const before = await read(target.type, {
    id: target.objectId,
    relation: target.relation,
  });
  if (!before.coverage.complete)
    throw new Error("原关系覆盖不完整，不能保存局部替换");
  const targets = [];
  for (const id of [...targetIds].sort()) {
    const result = await read(String(relation.to), { id, limit: 2 });
    if (result.items.length !== 1 || !result.coverage.complete)
      throw new Error(`目标 ${id} 不存在、不唯一或覆盖不完整`);
    if (String(result.items[0].$id) !== id)
      throw new Error("请使用目标对象的规范编号，禁止别名重复");
    targets.push(result);
  }
  live.assertModel(target.modelId, target.modelVersion, reading?.fixedSemantic ?? false, reading?.pins, modelDefinition);
  assertActive();
  const evidenceIdentity = (result: typeof origin) =>
    result.evidence
      ?.slice()
      .sort((a, b) => String(a.objectId).localeCompare(String(b.objectId)))
      .map((object) => ({
        objectId: object.objectId,
        properties: Object.fromEntries(
          Object.entries(object.properties).map(([name, p]) => [
            name,
            {
              status: p.status,
              value: p.value,
              blockers: p.blockers,
              evidence: p.evidence.map((e) => ({
                sourceId: e.sourceId,
                recordId: e.recordId,
                field: e.field,
                value: e.value,
                eligible: e.eligible,
              })),
            },
          ]),
        ),
      })) ?? [];
  const facts = {
    origin: origin.items,
    originEvidence: evidenceIdentity(origin),
    beforeEvidence: evidenceIdentity(before),
    targetEvidence: targets.map(evidenceIdentity),
    before: [...before.items].sort((a, b) =>
      String(a.$id).localeCompare(String(b.$id)),
    ),
    targets: targets.map((r) => r.items[0]),
  };
  const snapshot = {
    fingerprint: hash(facts),
    relation,
    origin,
    before,
    targets,
    modelDefinition: model.content,
  };
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 256 * 1024)
    throw new Error("纠正读取依据超过256KB，请先缩小映射字段或目标范围");
  return snapshot;
}
export class RelationCorrections {
  private memory: MemoryStore;
  private live: LiveMemory;
  constructor(memory: MemoryStore, live: LiveMemory) {
    this.memory = memory;
    this.live = live;
  }
  list() {
    return this.memory
      .listArtifacts("relation_correction")
      .slice(0, 40)
      .map((a) => ({
        id: a.id,
        version: a.version,
        title: a.title,
        status: a.status,
        content: { target: a.content.target },
      }));
  }
  read(id: string, v?: number) {
    if (!id || (v !== undefined && (!Number.isSafeInteger(v) || v < 1)))
      throw new Error("需要有效记录 ID 与正整数版本");
    const a = this.memory.getArtifact(id, v);
    if (a.kind !== "relation_correction")
      throw new Error("需要局部关系纠正记录");
    return a;
  }
  private previous(actor: string, op: string, signature: string) {
    const r = this.memory
      .listArtifacts("relation_receipt")
      .find((a) => a.content.actor === actor && a.content.operationId === op);
    if (!r) return null;
    if (r.content.signature !== signature)
      throw new Error("幂等键已绑定不同请求");
    return this.read(String(r.content.id), Number(r.content.version));
  }
  async execute(
    method: "propose" | "check" | "adopt" | "cancel",
    input: unknown,
    context?: WriteContext,
    assertActive: () => void = () => {},
    commit?: (save: () => Artifact) => Artifact,
  ) {
    if (method === "adopt" && context)
      throw new Error("采用需由本地管理员确认具体检查版本");
    const args =
      method === "propose" ? proposal.parse(input) : action.parse(input);
    const actor = context ? `agent:${context.taskId}` : "local-admin";
    const valid = () => {
      assertActive();
      if (context) this.memory.assertWritable(context);
    };
    valid();
    const signature = hash({ method, args });
    const old = this.previous(actor, args.operationId, signature);
    if (old) return old;
    let record: Artifact | null = null,
      target: CorrectionTarget,
      ids: string[],
      base: Data | null,
      semanticRelationId: string | undefined;
    if ("target" in args) {
      if (new Set(args.targetIds).size !== args.targetIds.length)
        throw new Error("目标编号重复");
      target = args.target;
      ids = [...args.targetIds].sort();
      const current=correctionModel(this.live,target);
      semanticRelationId=(current.content.relations as Data[]).find(relation=>relation.from===target.type&&relation.name===target.relation)?.relationId as string|undefined;
      const historical=correctionModel(this.live,target,this.memory.getArtifact(target.modelId,target.modelVersion).content).content;
      const previous = activeCorrection(this.memory, target,semanticRelationId,historical);
      base = previous ? { id: previous.id, version: previous.version } : null;
    } else {
      record = this.read(args.id);
      if (record.version !== args.version)
        throw new Error("候选版本冲突，请重新读取");
      if (record.status === "adopted" && method === "cancel")
        throw new Error("已提交，取消不能回滚已采用纠正");
      if (!["candidate", "checked"].includes(record.status))
        throw new Error("候选已终结");
      target = record.content.target as unknown as CorrectionTarget;
      ids = record.content.targetIds as string[];
      base = record.content.base as Data | null;
      semanticRelationId=((record.content.snapshot as Data|undefined)?.relation as Data|undefined)?.relationId as string|undefined;
    }
    const historicalDefinition=method!=="cancel"?correctionModel(this.live,target,this.memory.getArtifact(target.modelId,target.modelVersion).content).content:undefined;
    if (method === "adopt" && !commit && record?.status !== "checked")
      throw new Error("请先检查候选，再确认该检查版本");
    const snapshot =
      method === "cancel"
        ? null
        : await captureRelation(this.live, target, ids, valid, undefined, record?(record.content.modelDefinition as Data|undefined)??historicalDefinition:undefined);
    if (
      record &&
      snapshot &&
      snapshot.fingerprint !== record.content.fingerprint
    )
      throw new Error("来源事实已变化，原候选不再适用，请保留记录并重新提议");
    semanticRelationId ??= snapshot?.relation.relationId as string|undefined;
    valid();
    const save = () => this.memory.atomic(() => {
      valid();
      const replay = this.previous(actor, args.operationId, signature);
      if (replay) return replay;
      if (record && this.read(record.id).version !== record.version)
        throw new Error("候选版本冲突");
      const prior = activeCorrection(this.memory, target,semanticRelationId,historicalDefinition);
      if (
        method !== "cancel" &&
        canonical(prior ? { id: prior.id, version: prior.version } : null) !==
          canonical(base)
      )
        throw new Error("该关系已有新的纠正决定，请重新提议");
      if (method !== "cancel")
        this.live.assertModel(target.modelId, target.modelVersion);
      const content: Data = record
        ? { ...record.content }
        : jsonData({
            target,
            targetKey: relationKey(target),
            modelDefinition: snapshot!.modelDefinition,
            targetIds: ids,
            base,
            reason: (args as z.infer<typeof proposal>).reason,
            evidence: (args as z.infer<typeof proposal>).evidence,
            evidenceKind: "submitted_rationale",
            responsible: actor,
            condition: "model_and_source_snapshot_unchanged",
            fingerprint: snapshot!.fingerprint,
            snapshot,
            scope: "internal_local_relation",
            operation: args.operationId,
          });
      if (method === "check")
        content.check = jsonData({
          ruleVersion: "local-relation-v1",
          checkedAt: new Date().toISOString(),
          result: "passed",
          checks: [
            "target_existence",
            "complete_original_relation",
            "unchanged_source_snapshot",
            "unchanged_correction_base",
          ],
          notChecked: [
            "business_truth",
            "all_enterprise_records",
            "external_consumer_migration",
          ],
        });
      if (method === "adopt")
        content.decision = jsonData({
          actor,
          at: new Date().toISOString(),
          checkedVersion: record!.version,
        });
      if (method === "adopt" && prior)
        this.memory.putArtifact({
          ...prior,
          expectedVersion: prior.version,
          status: "superseded",
        });
      const saved = this.memory.putArtifact(
        {
          ...(record ? { id: record.id, expectedVersion: record.version } : {}),
          kind: "relation_correction",
          title: `${target.type} ${target.objectId} → ${target.relation}`,
          status: {
            propose: "candidate",
            check: "checked",
            adopt: "adopted",
            cancel: "cancelled",
          }[method],
          content,
        },
        context,
      );
      this.memory.putArtifact({
        kind: "relation_receipt",
        title: "局部关系操作回执",
        status: "saved",
        content: jsonData({
          actor,
          operationId: args.operationId,
          signature,
          id: saved.id,
          version: saved.version,
        }),
      });
      return saved;
    });
    if (commit) return commit(save);
    return method === "adopt" && this.live.onGovernanceAdopt ? this.live.onGovernanceAdopt(record!, save) : save();
  }
}
export const correctionTools: DomainTool[] = [
  {
    name: "relation_correction_read",
    description:
      "按id/version读取一份已保存纠正及原值/依据/检查/决定。历史快照不代表源当前事实。",
    mutates: false,
    inputSchema: z.toJSONSchema(z.object({ id: name, version }).strict()),
  },
  {
    name: "relation_correction_list",
    description: "列出最近40条内部局部关系纠正，保留候选/检查/采用/取消状态。",
    mutates: false,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  ...(["propose", "check", "cancel"] as const).map((method) => ({
    name: `relation_correction_${method}`,
    description: {
      propose:
        "为已采用映射的一个起点关系保存局部目标集合替换候选；最多20目标，空数组表示确认无关联。记录理由/依据为提交者陈述并抓取真实源基线；不自动采用，不写源系统。",
      check:
        "按候选版本重读来源并校验范围/身份/版本；不证明业务真实。返回checked版本供管理员确认采用。",
      cancel: "取消尚未采用的候选；已采用明确拒绝回滚。",
    }[method],
    mutates: true,
    inputSchema: z.toJSONSchema(method === "propose" ? proposal : action),
  })),
];

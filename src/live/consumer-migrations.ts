import { freezeLegacyConsumption } from "./legacy-consumption.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  Artifact,
  Data,
  DomainTool,
  WriteContext,
} from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { LiveMemory } from "./memory.ts";
import { jsonData } from "./sources.ts";
const name = z.string().trim().min(1).max(200);
const ref = z
  .object({ id: name, version: z.number().int().positive() })
  .strict();
const changeRef = ref.extend({ kind: z.literal("mapping_change").optional() });
const previewSchema = z
  .object({
    operationId: name,
    viewRef: ref,
    changeRef,
    dropContextEvidence: z.boolean().default(false),
  })
  .strict();
const actionSchema = ref.extend({ operationId: name });
const impactSchema = z
  .object({
    changeRef,
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(20).default(20),
  })
  .strict();
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => JSON.stringify(k) + ":" + canonical(x))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
const hash = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

export class ConsumerMigrations {
  private memory: MemoryStore;
  private live: LiveMemory;
  constructor(memory: MemoryStore, live: LiveMemory) {
    this.memory = memory;
    this.live = live;
  }
  private change(r: z.infer<typeof ref>) {
    const c = this.memory.getArtifact(r.id);
    if (c.kind !== "mapping_change" || c.version !== r.version)
      throw new Error("变更记录或版本已变化");
    return c;
  }
  private view(r: z.infer<typeof ref>) {
    const v = this.memory.getArtifact(r.id);
    if (v.kind !== "consumer_view" || v.version !== r.version)
      throw new Error("消费视图版本已变化");
    return v;
  }
  private report(v: Artifact, c: Artifact, drop: boolean) {
    const base = c.content.baseRef as { id: string; version: number },
      target = c.content.resultModel as
        { id: string; version: number } | undefined;
    const reasons: string[] = [];
    if (v.status !== "active") reasons.push("仅迁移当前已启用的v3视图");
    if (!same(v.content.modelRef, base))
      reasons.push("消费视图不在此变更的基线");
    if (c.status !== "adopted" || !target)
      reasons.push("变更尚未采用，不能迁移消费者");
    let targetModel: Artifact | undefined;
    try {
      this.live.assertModel(base.id, base.version);
      if (target) {
        targetModel = this.live.assertModel(target.id, target.version);
        if (targetModel.status !== "adopted") reasons.push("目标映射未采用");
      }
    } catch {
      reasons.push("基线或目标映射、当前来源许可不可用");
    }
    const grants = v.content.grants as Data[],
      context = (v.content.contextEvidence as Data[]) ?? [];
    if (context.length && !drop)
      reasons.push("旧文档/BI依据绑定旧模型，需明确移除后迁移");
    if (targetModel)
      try {
        this.live.validateConsumerScope({
          name: v.title,
          purpose: v.content.purpose,
          modelId: targetModel.id,
          grants: grants.map(({ evidence, ...g }) => g),
        });
      } catch {
        reasons.push("现有许可与目标字段或关系端点不兼容；不会自动补授权限");
      }
    const patch = (c.content.draft as Data).patch as Data;
    const affected =
      grants.some(
        (g) =>
          g.type === patch.type &&
          ((g.fields as string[]).includes(String(patch.property)) ||
            (g.relations as string[]).includes(String(patch.relation))),
      ) ||
      (((c.content.impact as Data).dependencies as Data[]) ?? []).some((r) =>
        grants.some(
          (g) =>
            g.type === r.from &&
            (g.relations as string[]).includes(String(r.name)),
        ),
      ) ||
      (((c.content.impact as Data).dependentSupplements as Data[]) ?? []).some(
        (s) =>
          grants.some(
            (g) =>
              g.type === patch.type &&
              (s.properties as string[]).some((p) =>
                (g.fields as string[]).includes(p),
              ),
          ),
      );
    return jsonData({
      contractVersion: "consumer-migration-v1",
      changeRef: { kind: "mapping_change", id: c.id, version: c.version },
      viewRef: { id: v.id, version: v.version },
      baseRef: base,
      targetRef: target ?? null,
      affected,
      compatible: reasons.length === 0,
      reasons,
      grants,
      removedContextEvidence: drop
        ? context.map((x) => ({
            ref: x.evidenceRef,
            kind: x.kind,
            label: x.label,
          }))
        : [],
      requiresDropContextEvidence: context.length > 0,
      dropContextEvidence: drop,
      localCorrections: "remain_on_base_model",
      sourceValues: "on_demand_not_atomic",
      fieldPolicy: "preserve_exact_grants",
      credentialPolicy: "same_key_new_view_version",
      clientPolicy: "discover_catalog_then_pin_viewVersion",
      sampleImpactRef: { kind: "mapping_change", id: c.id, version: c.version },
      notChecked: [
        "all_records",
        "business_truth",
        "live_upstream_availability",
      ],
    });
  }
  impact(input: unknown) {
    const a = impactSchema.parse(input),
      c = this.change(a.changeRef),
      base = c.content.baseRef;
    const views = this.memory
      .listArtifacts("consumer_view")
      .filter((v) => same(v.content.modelRef, base));
    const legacy = this.memory
      .listArtifacts("live_consumer")
      .filter((v) => v.content.modelId === (base as Data).id).length;
    return jsonData({
      changeRef: { kind: "mapping_change", id: c.id, version: c.version },
      status: c.status,
      baseRef: base,
      targetRef: c.content.resultModel ?? null,
      items: views.slice(a.offset, a.offset + a.limit).map((v) => ({
        id: v.id,
        version: v.version,
        title: v.title,
        status: v.status,
        ...this.report(v, c, false),
      })),
      coverage: {
        offset: a.offset,
        shown: Math.min(a.limit, Math.max(0, views.length - a.offset)),
        total: views.length,
        complete: a.offset === 0 && views.length <= a.limit,
      },
      legacy: { count: legacy, policy: "v1_v2_not_migrated" },
    });
  }
  list() {
    return this.memory
      .listArtifacts("consumer_migration")
      .slice(0, 40)
      .map((a) => ({
        id: a.id,
        version: a.version,
        title: a.title,
        status: a.status,
        changeRef: a.content.changeRef,
        viewRef: a.content.viewRef,
        resultRef: a.content.resultRef ?? null,
      }));
  }
  read(input: unknown) {
    const r = ref.parse(input),
      a = this.memory.getArtifact(r.id, r.version);
    if (a.kind !== "consumer_migration") throw new Error("需要迁移记录");
    return a;
  }
  private previous(actor: string, operationId: string, signature: string) {
    const receipt = this.memory
      .listArtifacts("migration_receipt")
      .find(
        (r) =>
          r.content.actor === actor && r.content.operationId === operationId,
      );
    if (!receipt) return null;
    if (receipt.content.signature !== signature)
      throw new Error("幂等键已绑定不同请求");
    return this.read(receipt.content.resultRef);
  }
  execute(
    method: "preview" | "commit",
    input: unknown,
    context?: WriteContext,
  ): Artifact {
    return freezeLegacyConsumption();
  }
}
export const consumerMigrationTools: DomainTool[] = [
  {
    name: "consumer_migration_impact",
    mutates: false,
    description:
      "按同一mapping changeRef分页读取消费视图的影响、许可兼容性和移除旧背景依据要求；不迁移任何视图。",
    inputSchema: z.toJSONSchema(impactSchema),
  },
  {
    name: "consumer_migration_list",
    mutates: false,
    description: "列出最近40条迁移预览/提交记录元数据。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "consumer_migration_read",
    mutates: false,
    description: "读取指定迁移记录版本的完整影响与历史回执。",
    inputSchema: z.toJSONSchema(ref),
  },
];

import { z } from "zod";
import { FoundationService } from "./foundation.ts";
import {
  propertyNames,
  isSupplementProperty,
  type FusionType,
} from "../live/fusion.ts";
import type { CanvasPage, Data, DomainTool } from "./contracts.ts";
import type { MemoryStore } from "./memory.ts";
import type { LiveMemory } from "../live/memory.ts";

const name = z.string().min(1).max(200);
const refSchema = z
  .object({
    spaceId: name,
    kind: z.enum([
      "artifact",
      "type",
      "property",
      "relation",
      "object",
      "foundation_concept",
      "foundation_relation",
    ]),
    id: name,
    version: z.number().int().positive(),
    type: name.optional(),
    member: name.optional(),
    objectId: name.optional(),
  })
  .strict()
  .superRefine((ref, ctx) => {
    const valid =
      ref.kind === "foundation_concept" || ref.kind === "foundation_relation"
        ? !!ref.member && !ref.type && !ref.objectId
        : ref.kind === "artifact"
          ? !ref.type && !ref.member && !ref.objectId
          : !!ref.type &&
            (ref.kind === "property" || ref.kind === "relation"
              ? !!ref.member
              : !ref.member) &&
            (ref.kind === "object"
              ? !!ref.objectId
              : ref.kind === "relation" ||
                ref.kind === "property" ||
                !ref.objectId);
    if (!valid)
      ctx.addIssue({ code: "custom", message: "引用的种类与目标字段不匹配" });
  });
export const workContextSchema = z
  .object({
    view: z.enum([
      "setup.company",
      "setup.sources",
      "ontology.definitions",
      "ontology.objects",
      "consumption",
    ]),
    revision: z.number().int().nonnegative(),
    selection: z.array(refSchema).max(1),
    scope: z
      .object({
        where: z.record(
          name,
          z.union([z.string().max(1000), z.number().finite(), z.boolean()]),
        ),
        offset: z.number().int().nonnegative(),
        limit: z.number().int().min(1).max(100),
      })
      .strict(),
    draftRef: z
      .object({ id: name, revision: z.number().int().nonnegative() })
      .strict(),
  })
  .strict();
export type ObjectRef = z.infer<typeof refSchema>;
export type WorkContext = z.infer<typeof workContextSchema>;
export interface ResolvedWorkContext {
  context: WorkContext;
  target: {
    ref: ObjectRef;
    label: string;
    artifactKind: string;
    status: string;
    definition: Data;
  } | null;
}
export function parseWorkContext(page: CanvasPage, input: unknown) {
  const context = workContextSchema.parse(input);
  if (context.view.split(".")[0] !== page)
    throw new Error("工作上下文与页面不匹配");
  if (Object.keys(context.scope.where).length > 10)
    throw new Error("筛选条件过多");
  return context;
}
export class WorkContexts {
  private memory: MemoryStore;
  private live: LiveMemory;
  constructor(memory: MemoryStore, live: LiveMemory) {
    this.memory = memory;
    this.live = live;
  }
  resolve(context: WorkContext): ResolvedWorkContext {
    const ref = context.selection[0];
    if (!ref) {
      if (Object.keys(context.scope.where).length)
        throw new Error("筛选需要具体对象类型");
      return { context, target: null };
    }
    if (ref.spaceId !== this.memory.workspaceId())
      throw new Error("目标不属于当前企业空间");
    const artifact = this.memory.getArtifact(ref.id, ref.version);
    const allowed = [
      "profile",
      "source",
      "source_policy",
      "ontology",
      "ontology_outline",
      "foundation",
      "verification",
      "source_connection",
      "live_ontology",
      ...(context.view === "consumption" ? ["consumer", "live_consumer"] : []),
    ];
    if (!allowed.includes(artifact.kind))
      throw new Error("当前页面不能引用该内容");
    let label = artifact.title;
    let definition: Data = { title: artifact.title, kind: artifact.kind };
    if (
      ref.kind === "foundation_concept" ||
      ref.kind === "foundation_relation"
    ) {
      if (
        context.view !== "ontology.definitions" ||
        artifact.kind !== "foundation"
      )
        throw new Error("基础定义引用需要基础本体与定义视角");
      if (Object.keys(context.scope.where).length)
        throw new Error("基础定义不能附加实例筛选");
      const service = new FoundationService(this.memory, this.live);
      const { current, adopted } = service.read();
      if (
        ![current, adopted].some(
          (a) => a?.id === ref.id && a.version === ref.version,
        )
      )
        throw new Error("基础定义版本已变化，请保留草稿并重新选择");
      const body = service.project(artifact).content;
      const items = body[
        ref.kind === "foundation_concept" ? "concepts" : "relations"
      ] as Data[];
      const item = items.find((i) => i.id === ref.member);
      if (!item) throw new Error("基础定义目标无效");
      const conflicts = (body.conflicts as Data[]).filter(
        (c) =>
          ((c.retained as Data | undefined)?.id === item.id ||
            (c.proposed as Data | undefined)?.id === item.id) &&
          Boolean((c.retained as Data | undefined)?.from) ===
            (ref.kind === "foundation_relation"),
      );
      const evidenceIds = new Set([
        ...(item.evidenceRefs as string[]),
        ...conflicts.flatMap((c) => [
          ...((c.evidenceRefs ?? []) as string[]),
          ...((c.resolvedBy ?? []) as string[]),
        ]),
      ]);
      definition = {
        ...item,
        conflicts,
        unresolvedConflictCount: (body.conflicts as Data[]).filter(
          (c) => !c.resolvedBy,
        ).length,
        unknowns: body.unknowns,
        evidence: (body.evidence as Data[]).filter((e) =>
          evidenceIds.has(String(e.id)),
        ),
      };
      label = String(item.name);
      if (ref.kind === "foundation_relation") {
        const concepts = body.concepts as Data[];
        const nameFor = (id: unknown) =>
          concepts.find((c) => c.id === id)?.name ?? id;
        label = `${nameFor(item.from)} → ${item.name} → ${nameFor(item.to)}`;
      }
    } else if (ref.kind !== "artifact") {
      if (
        !context.view.startsWith("ontology.") ||
        artifact.kind !== "live_ontology"
      )
        throw new Error("细粒度引用需要在线本体与本体工作区");
      if (this.memory.getArtifact(ref.id).version !== ref.version)
        throw new Error("本体版本已变化，请保留草稿并重新选择");
      const types = artifact.content.types as Data[];
      const type = types.find((t) => t.name === ref.type);
      if (!type) throw new Error("目标类型无效");
      const fusionType = type as unknown as FusionType;
      const fields = type.fields as Data;
      for (const key of Object.keys(context.scope.where))
        if (
          key !== "$id" &&
          (!Object.hasOwn(fields, key) || isSupplementProperty(fusionType, key))
        )
          throw new Error("目标范围包含无效字段");
      if (
        ref.objectId &&
        context.scope.where.$id !== undefined &&
        String(context.scope.where.$id) !== ref.objectId
      )
        throw new Error("对象与筛选范围冲突");
      // Source authorization is checked afresh; a client label never grants access.
      const involved = [type];
      definition = {
        name: type.name,
        description: type.description,
        fields,
        sourceId: type.sourceId,
        capability: type.capability,
        supplements: type.supplements ?? [],
      };
      label = String(type.name);
      if (ref.kind === "property") {
        if (
          ref.member !== "$id" &&
          !propertyNames(fusionType).includes(ref.member!)
        )
          throw new Error("目标属性无效");
        definition = {
          type: type.name,
          property: ref.member!,
          sourceField:
            ref.member === "$id"
              ? this.live.sources.capability(
                  String(type.sourceId),
                  String(type.capability),
                  Number(
                    (artifact.content.connections as Data)[
                      String(type.sourceId)
                    ],
                  ),
                ).cap.idField
              : Object.hasOwn(fields, ref.member!)
                ? fields[ref.member!]
                : null,
          mappings: [
            ...(ref.member === "$id" || Object.hasOwn(fields, ref.member!)
              ? [
                  {
                    sourceId: type.sourceId,
                    capability: type.capability,
                    sourceField:
                      ref.member === "$id" ? "$id" : fields[ref.member!],
                  },
                ]
              : []),
            ...(fusionType.supplements ?? [])
              .filter((s) => Object.hasOwn(s.fields, ref.member!))
              .map((s) => ({
                sourceId: s.sourceId,
                capability: s.capability,
                sourceField: s.fields[ref.member!],
                match: s.match,
                rationale: s.rationale,
              })),
          ],
        };
        label += ` · ${ref.member}`;
      }
      if (ref.kind === "relation") {
        const relation = (artifact.content.relations as Data[]).find(
          (r) => r.from === ref.type && r.name === ref.member,
        );
        if (!relation) throw new Error("目标关系无效");
        definition = relation;
        label = `${relation.from} → ${relation.name} → ${relation.to}`;
        involved.push(types.find((t) => t.name === relation.to)!);
      }
      if (ref.objectId) label += ` · ${ref.objectId}`;
      for (const t of involved.flatMap((t) => [
        t,
        ...((t.supplements || []) as Data[]),
      ]))
        this.live.sources.capability(
          String(t.sourceId),
          String(t.capability),
          Number((artifact.content.connections as Data)[String(t.sourceId)]),
        );
    } else if (Object.keys(context.scope.where).length)
      throw new Error("整份成果引用不能附加对象筛选");
    return {
      context,
      target: {
        ref,
        label,
        artifactKind: artifact.kind,
        status: artifact.status,
        definition,
      },
    };
  }
  async read(context: WorkContext, assertActive: () => void = () => {}) {
    assertActive();
    const resolved = this.resolve(context);
    const ref = resolved.target?.ref;
    if (!ref) return resolved;
    if (
      ref.kind === "object" ||
      ((ref.kind === "relation" || ref.kind === "property") && ref.objectId)
    ) {
      const result = await this.live.query(
        {
          modelId: ref.id,
          modelVersion: ref.version,
          type: ref.type,
          id: ref.objectId,
          ...(ref.kind === "relation" ? { relation: ref.member } : {}),
          ...context.scope,
          ...(ref.kind === "property"
            ? { fields: [...new Set(["$id", ref.member!])] }
            : {}),
        },
        assertActive,
      );
      this.resolve(context);
      return { ...resolved, result };
    }
    return resolved;
  }
  assertCurrent(context: WorkContext) {
    this.resolve(context);
    const ref = context.selection[0];
    if (ref && this.memory.getArtifact(ref.id).version !== ref.version)
      throw new Error("目标版本已变化，不能按旧草稿继续写入");
  }
}
export const contextReadTool: DomainTool = {
  name: "context_read",
  description:
    "读取本条消息固定的目标与范围；定义返回真实定义，对象和实例关系按原范围读取当前源记录，不读取此后的页面选择。",
  mutates: false,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

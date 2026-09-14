import { z } from "zod";
import { KnowledgeReader, knowledgeReadSchema } from "./knowledge.ts";
import { MetricReader, metricQuerySchema } from "./metrics.ts";
import { liveQuerySchema, type LiveMemory } from "../live/memory.ts";
import { jsonData } from "../live/sources.ts";
import type {
  Repository,
  WriteContext,
  DomainTool,
  Data,
} from "./contracts.ts";
const name = z.string().trim().min(1).max(200);
const rationale = z.string().trim().min(1).max(1500);
export const evidenceSchema = z
  .object({
    question: z.string().trim().min(1).max(2000),
    objects: liveQuerySchema.extend({
      modelVersion: z.number().int().positive(),
      where: z.preprocess((value) => {
        if (
          value &&
          typeof value === "object" &&
          Object.hasOwn(value, "__proto__")
        )
          throw new Error("保留筛选字段不可用");
        return value;
      }, liveQuerySchema.shape.where),
      fields: z
        .array(name)
        .min(1)
        .max(20)
        .refine((f) => f.includes("$id"), "共同取证必须保留对象$id"),
      limit: z.number().int().min(1).max(10).default(5),
    }),
    documents: z
      .array(
        knowledgeReadSchema.extend({
          connectionVersion: z.number().int().positive(),
          rationale,
        }),
      )
      .min(1)
      .max(3),
    metrics: z
      .array(
        metricQuerySchema.extend({
          rationale,
          dimensionBindings: z
            .array(z.object({ dimension: name, property: name }).strict())
            .max(5)
            .default([]),
        }),
      )
      .min(1)
      .max(3),
  })
  .strict();
const listSchema = z
  .object({
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();
const readSchema = z
  .object({ id: name, version: z.number().int().positive() })
  .strict();
export const evidenceTools: DomainTool[] = [
  {
    name: "evidence_list",
    mutates: false,
    description:
      "分页发现已保存共同取证的id/version、问题、时间和范围状态。不返回正文；用evidence_read读取指定历史记录，跨页面或新对话无需重新采集。",
    inputSchema: z.toJSONSchema(listSchema),
  },
  {
    name: "evidence_collect",
    mutates: true,
    description:
      "围绕一项业务对象查询，实际重读已选知识片段和指标，保存有界共同取证记录。先从目录取得文档segmentId/revision、从metric_describe取得definitionHash。objects必须显式modelVersion、fields含$id，每页最多10对象。文档rationale只声明关联理由；指标dimensionBindings为空仅作背景，显式维度→对象属性且值相等才连接，不计算指标或推断个体状态。局部失败和覆盖不足保留；采用映射与保存历史取证不同。",
    inputSchema: z.toJSONSchema(evidenceSchema),
  },
  {
    name: "evidence_read",
    mutates: false,
    description:
      "读取保存的共同取证记录与当前依赖状态；它是读取时的有界证据快照，不是最新源值。",
    inputSchema: z.toJSONSchema(readSchema),
  },
];
type ObjectResult = Awaited<ReturnType<LiveMemory["query"]>>;
type MetricResult = Awaited<ReturnType<MetricReader["query"]>>;
function associate(
  result: MetricResult,
  objects: ObjectResult | undefined,
  bindings: { dimension: string; property: string }[],
) {
  if (!bindings.length)
    return {
      status: "context_only",
      reason: "背景指标，未声明对象维度匹配；不能证明个体状态",
      links: [],
    };
  if (!objects)
    return {
      status: "unknown",
      reason: "对象读取失败，无法核对维度",
      links: [],
    };
  if (
    new Set(bindings.map((b) => b.dimension)).size !== bindings.length ||
    bindings.some(
      (b) => !result.definition.dimensions.some((d) => d.name === b.dimension),
    )
  )
    throw new Error("维度绑定必须唯一且来自指标定义");
  return {
    status: "dimension_match",
    reason:
      "仅对已返回对象按声明维度精确匹配，对象期间未核对，不证明语义等价或指标归因",
    objectCoverage: objects.coverage,
    links: result.items.map((observation) => {
      const matched: Array<string | number> = [],
        uncertain: Array<string | number> = [];
      for (let i = 0; i < objects.items.length; i++) {
        const object = objects.items[i];
        let unknown = false,
          mismatch = false;
        for (const binding of bindings) {
          const value = object[binding.property];
          const cell = objects.evidence?.[i]?.properties[binding.property];
          if (
            value === null ||
            value === undefined ||
            (cell && cell.status !== "resolved")
          )
            unknown = true;
          else if (value !== observation.dimensions[binding.dimension])
            mismatch = true;
        }
        if (!mismatch)
          (unknown ? uncertain : matched).push(object.$id as string | number);
      }
      return {
        observationId: observation.observationId,
        objectIds: matched,
        uncertainObjectIds: uncertain,
        status: uncertain.length
          ? "uncertain"
          : matched.length
            ? "matched"
            : "unmatched",
      };
    }),
  };
}
/** Saved evidence is a bounded reading, never an ontology definition or a live replica. */
export class EvidenceService {
  private repo: Repository;
  private live: LiveMemory;
  private collections = 0;
  constructor(repo: Repository, live: LiveMemory) {
    this.repo = repo;
    this.live = live;
  }
  catalog(input: unknown = {}) {
    const { offset, limit } = listSchema.parse(input);
    const all = this.repo.listArtifacts("evidence_bundle");
    return {
      items: all
        .slice(offset, offset + limit)
        .map(({ id, version, title, status, createdAt, content }) => ({
          id,
          version,
          title,
          status,
          createdAt,
          model: content.model,
        })),
      coverage: {
        offset,
        shown: all.slice(offset, offset + limit).length,
        total: all.length,
        nextOffset: offset + limit < all.length ? offset + limit : null,
      },
    };
  }
  list() {
    return this.catalog({ limit: 20 }).items;
  }
  read(input: unknown) {
    const args = readSchema.parse(input),
      artifact = this.repo.getArtifact(args.id, args.version);
    if (artifact.kind !== "evidence_bundle")
      throw new Error("需要共同取证记录");
    const dependencies = (artifact.content.dependencies as Data[]).map((d) => {
      try {
        this.live.sources.capability(
          String(d.sourceId),
          String(d.capability),
          Number(d.connectionVersion),
        );
        return { ...d, available: true };
      } catch {
        return { ...d, available: false };
      }
    });
    let modelCurrent = true;
    const model = artifact.content.model as Data;
    try {
      this.live.assertModel(String(model.id), Number(model.version));
    } catch {
      modelCurrent = false;
    }
    return { artifact, historical: true, modelCurrent, dependencies };
  }
  async collect(
    input: unknown,
    context?: WriteContext,
    operationId?: string,
    assertActive: () => void = () => {},
  ) {
    assertActive();
    if (++this.collections > 4)
      throw new Error("本轮共同取证最多4次，请缩小任务");
    const args = evidenceSchema.parse(input),
      model = this.live.assertModel(
        args.objects.modelId,
        args.objects.modelVersion,
      );
    for (const metric of args.metrics)
      for (const binding of metric.dimensionBindings)
        if (!args.objects.fields.includes(binding.property))
          throw new Error("维度对应的对象属性必须包含在选取字段中");
    const types = model.content.types as Data[];
    const dependencies = [
      ...types
        .flatMap((t) => [t, ...((t.supplements as Data[]) ?? [])])
        .map((t) => ({
          sourceId: String(t.sourceId),
          capability: String(t.capability),
          connectionVersion: Number(
            (model.content.connections as Data)[String(t.sourceId)],
          ),
        })),
      ...args.documents.map((d) => ({
        sourceId: d.sourceId,
        capability: d.capability,
        connectionVersion: d.connectionVersion,
      })),
      ...args.metrics.map((m) => ({
        sourceId: m.sourceId,
        capability: m.capability,
        connectionVersion: m.connectionVersion,
      })),
    ];
    const assertValid = () => {
      assertActive();
      this.live.assertModel(model.id, model.version);
      for (const d of dependencies)
        this.live.sources.capability(
          d.sourceId,
          d.capability,
          d.connectionVersion,
        );
    };
    assertValid();
    for (const d of args.documents)
      if (
        this.live.sources.capability(
          d.sourceId,
          d.capability,
          d.connectionVersion,
        ).cap.contentKind !== "knowledge"
      )
        throw new Error("文档依据需要知识片段能力");
    for (const m of args.metrics)
      if (
        this.live.sources.capability(
          m.sourceId,
          m.capability,
          m.connectionVersion,
        ).cap.contentKind !== "metrics"
      )
        throw new Error("指标依据需要指标能力");
    const capture = async <T>(fn: () => Promise<T>) => {
      assertValid();
      try {
        const result = await fn();
        assertValid();
        return { status: "read" as const, result };
      } catch {
        assertValid();
        return {
          status: "unavailable" as const,
          error: "来源读取失败或结果契约不符；未用替代内容补齐",
        };
      }
    };
    const objects = await capture(() =>
      this.live.query(args.objects, assertValid),
    );
    const reader = new KnowledgeReader(this.live.sources),
      metricReader = new MetricReader(this.live.sources, assertValid);
    const titles = new Map(
      this.live.sources.list().map((s) => [s.id, s.title]),
    );
    const documents = [];
    for (const doc of args.documents) {
      const { rationale, ...query } = doc;
      documents.push({
        request: query,
        sourceTitle: titles.get(query.sourceId) ?? query.sourceId,
        rationale,
        association: "declared_context",
        ...(await capture(() => reader.read(query))),
      });
    }
    const metrics = [];
    for (const metric of args.metrics) {
      const { rationale, dimensionBindings, ...query } = metric;
      const part = await capture(async () => {
        const result = await metricReader.query(query);
        return {
          result,
          association: associate(
            result,
            objects.status === "read" ? objects.result : undefined,
            dimensionBindings,
          ),
        };
      });
      metrics.push({
        request: query,
        sourceTitle: titles.get(query.sourceId) ?? query.sourceId,
        rationale,
        dimensionBindings,
        ...(part.status === "read"
          ? { status: "read" as const, ...part.result }
          : part),
      });
    }
    assertValid();
    const complete =
      objects.status === "read" &&
      objects.result.coverage.complete &&
      !(objects.result.evidence ?? []).some((o) =>
        Object.values(o.properties).some((p) => p.status !== "resolved"),
      ) &&
      documents.every(
        (d) => d.status === "read" && d.result.coverage.complete,
      ) &&
      metrics.every(
        (m) =>
          m.status === "read" &&
          m.result.coverage.complete &&
          m.result.coverage.dataComplete === true &&
          m.result.items.every((i) => i.status === "observed") &&
          (m.association.status === "context_only" ||
            ("links" in m.association &&
              m.association.links.every((l) => l.status === "matched"))),
      );
    const content = jsonData({
      question: args.question,
      model: {
        id: model.id,
        version: model.version,
        status: model.status,
        foundationRef: model.content.foundationRef ?? null,
      },
      request: args,
      dependencies,
      objects,
      documents,
      metrics,
      collectedAt: new Date().toISOString(),
      historical: true,
      scope:
        "本次选取范围，非全企业、非跨源原子快照；文档关联理由与维度语义需业务核对，未自动得出结论",
    });
    if (Buffer.byteLength(JSON.stringify(content)) > 256 * 1024)
      throw new Error("取证记录超过256KB，请减少对象字段或片段长度");
    return this.repo.putArtifact(
      {
        kind: "evidence_bundle",
        title: args.question,
        status: complete ? "collected" : "partial",
        content,
      },
      context,
      operationId,
    );
  }
}

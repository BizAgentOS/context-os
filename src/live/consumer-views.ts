import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { LiveMemory } from "./memory.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type {
  Artifact,
  Data,
  DomainTool,
  WriteContext,
} from "../agent/contracts.ts";
import { jsonData } from "./sources.ts";
const name = z.string().trim().min(1).max(200),
  version = z.number().int().positive();
const ref = z.object({ id: name, version }).strict();
const grant = z
  .object({
    type: name,
    fields: z.array(name).min(1).max(100),
    relations: z.array(name).max(40),
  })
  .strict();
const proposal = z
  .object({
    operationId: name,
    name,
    purpose: z.string().trim().min(1).max(2000),
    modelRef: ref,
    grants: z.array(grant).min(1).max(20),
  })
  .strict();
const query = z
  .object({
    type: name,
    id: name.optional(),
    relation: name.optional(),
    fields: z.array(name).min(1).max(100).optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(20).default(20),
  })
  .strict();
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => JSON.stringify(k) + ":" + canonical(x))
      .join(",")}}`;
  return JSON.stringify(v);
}
export function publicView(a: Artifact) {
  const { keyHash, ...content } = a.content;
  return { ...a, content };
}
class Forbidden extends Error {}
export class ConsumerViews {
  private memory: MemoryStore;
  private live: LiveMemory;
  constructor(memory: MemoryStore, live: LiveMemory) {
    this.memory = memory;
    this.live = live;
  }
  list() {
    return this.memory
      .listArtifacts("consumer_view")
      .slice(0, 40)
      .map(publicView);
  }
  propose(input: unknown, context?: WriteContext) {
    const a = proposal.parse(input),
      actor = context ? `agent:${context.taskId}` : "local-admin";
    if (context) this.memory.assertWritable(context);
    const signature = digest(canonical(a));
    return this.memory.atomic(() => {
      const prior = this.memory
        .listArtifacts("view_receipt")
        .find(
          (r) =>
            r.content.actor === actor &&
            r.content.operationId === a.operationId,
        );
      if (prior) {
        if (prior.content.signature !== signature)
          throw new Error("幂等键已绑定不同请求");
        return publicView(
          this.memory.getArtifact(
            String(prior.content.id),
            Number(prior.content.version),
          ),
        );
      }
      this.live.assertModel(a.modelRef.id, a.modelRef.version);
      const { model } = this.live.validateConsumerScope({
        name: a.name,
        purpose: a.purpose,
        modelId: a.modelRef.id,
        grants: a.grants,
      });
      if (
        a.grants.some(
          (g) =>
            new Set(g.fields).size !== g.fields.length ||
            new Set(g.relations).size !== g.relations.length,
        )
      )
        throw new Error("许可字段或关系重复");
      const view = this.memory.putArtifact(
        {
          kind: "consumer_view",
          title: a.name,
          status: "draft",
          content: jsonData({
            contractVersion: "v3",
            modelRef: a.modelRef,
            semanticRef: model.content.foundationRef ?? null,
            purpose: a.purpose,
            grants: a.grants,
            relationPolicy: "source_mapping_only",
            responsible: actor,
          }),
        },
        context,
      );
      this.memory.putArtifact({
        kind: "view_receipt",
        title: "消费视图提议回执",
        status: "saved",
        content: {
          actor,
          operationId: a.operationId,
          signature,
          id: view.id,
          version: view.version,
        },
      });
      return publicView(view);
    });
  }
  private view(id: string) {
    const a = this.memory.getArtifact(id);
    if (a.kind !== "consumer_view") throw new Error("需要v3消费视图");
    return a;
  }
  private model(a: Artifact) {
    const r = a.content.modelRef as { id: string; version: number };
    const m = this.live.assertModel(r.id, r.version);
    if (m.status !== "adopted") throw new Error("需要已采用映射");
    return m;
  }
  activate(input: unknown) {
    const r = ref.parse(input);
    return this.memory.atomic(() => {
      const a = this.view(r.id);
      if (
        a.status === "active" &&
        a.version === r.version + 1 &&
        a.content.activationBaseVersion === r.version
      )
        return { view: publicView(a), key: null, keyAvailable: false };
      if (a.status !== "draft" || a.version !== r.version)
        throw new Error("消费视图草稿已变化");
      this.model(a);
      const key = "de_view_" + randomBytes(32).toString("base64url");
      const v = this.memory.putArtifact({
        ...a,
        expectedVersion: a.version,
        status: "active",
        content: {
          ...a.content,
          keyHash: digest(key),
          activationBaseVersion: a.version,
        },
      });
      return { view: publicView(v), key, keyAvailable: true };
    });
  }
  revoke(input: unknown) {
    const r = ref.parse(input),
      a = this.view(r.id);
    if (a.status === "revoked" && a.version === r.version + 1)
      return publicView(a);
    if (a.version !== r.version) throw new Error("消费视图版本已变化");
    return publicView(
      this.memory.putArtifact({
        ...a,
        expectedVersion: a.version,
        status: "revoked",
        content: a.content,
      }),
    );
  }
  async handle(
    path: string,
    params: URLSearchParams,
    authorization?: string,
  ): Promise<{ status: number; body: Data }> {
    const key = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    const view = key.startsWith("de_view_")
      ? this.memory
          .listArtifacts("consumer_view")
          .find(
            (a) => a.status === "active" && a.content.keyHash === digest(key),
          )
      : undefined;
    if (!view)
      return { status: 403, body: { error: "凭据无效或消费视图已停用" } };
    let status = 200,
      body: Data;
    const authorized = () => {
      const now = this.view(view.id);
      if (now.version !== view.version || now.status !== "active")
        throw new Forbidden("消费许可已变化或停用");
    };
    try {
      const model = this.model(view),
        grants = view.content.grants as z.infer<typeof grant>[];
      const valid = () => {
        authorized();
        this.model(view);
      };
      valid();
      const common = {
        contractVersion: "v3",
        viewRef: { id: view.id, version: view.version },
        modelRef: view.content.modelRef,
        semanticRef: view.content.semanticRef,
        methodVersion: "fusion-objects-v3.1",
        relationPolicy: "source_mapping_only",
        evidenceAvailability: "not_exposed",
      };
      const keys = [...params.keys()];
      if (new Set(keys).size !== keys.length) throw new z.ZodError([]);
      if (path === "/v3/catalog") {
        if (keys.length) throw new z.ZodError([]);
        body = jsonData({
          ...common,
          types: grants.map((g) => ({ name: g.type })),
          coverage: { shown: grants.length, complete: true },
        });
      } else if (path === "/v3/types") {
        if (keys.length !== 1 || keys[0] !== "type") throw new z.ZodError([]);
        const g = grants.find((g) => g.type === params.get("type"));
        if (!g) throw new Forbidden("类型未授权");
        body = jsonData({
          ...common,
          type: g.type,
          fields: g.fields,
          relations: (model.content.relations as Data[])
            .filter(
              (r) => r.from === g.type && g.relations.includes(String(r.name)),
            )
            .map((r) => ({ name: r.name, to: r.to })),
          limits: { maxObjects: 20 },
          consistency: "on_demand_not_atomic",
        });
      } else if (path === "/v3/objects") {
        if (
          keys.some(
            (k) =>
              !["type", "id", "relation", "fields", "offset", "limit"].includes(
                k,
              ),
          )
        )
          throw new z.ZodError([]);
        const args = query.parse({
          type: params.get("type"),
          ...(params.has("id") ? { id: params.get("id") } : {}),
          ...(params.has("relation")
            ? { relation: params.get("relation") }
            : {}),
          ...(params.has("fields")
            ? { fields: params.get("fields")!.split(",") }
            : {}),
          ...(params.has("offset")
            ? { offset: Number(params.get("offset")) }
            : {}),
          ...(params.has("limit")
            ? { limit: Number(params.get("limit")) }
            : {}),
        });
        const g = grants.find((g) => g.type === args.type);
        if (!g) throw new Forbidden("类型未授权");
        let target = g;
        if (args.relation) {
          if (!args.id) throw new z.ZodError([]);
          if (!g.relations.includes(args.relation))
            throw new Forbidden("关系未授权");
          const r = (model.content.relations as Data[]).find(
            (r) => r.from === g.type && r.name === args.relation,
          )!;
          target = grants.find((g) => g.type === r.to)!;
        }
        const fields = args.fields ?? target.fields;
        if (
          !fields.includes("$id") ||
          fields.some((f) => !target.fields.includes(f))
        )
          throw new Forbidden("字段或对象身份未授权");
        if (new Set(fields).size !== fields.length) throw new z.ZodError([]);
        const result = await this.live.query(
          { ...args, modelId: model.id, modelVersion: model.version, fields },
          valid,
          false,
        );
        valid();
        body = jsonData({
          ...common,
          type: target.type,
          items: result.items.map((row, i) => ({
            objectRef: { type: target.type, id: String(row.$id) },
            properties: Object.fromEntries(
              fields
                .filter((f) => f !== "$id")
                .map((f) => [
                  f,
                  {
                    value: row[f],
                    status:
                      result.evidence?.[i]?.properties[f]?.status ??
                      (row[f] === null ? "missing" : "resolved"),
                  },
                ]),
            ),
          })),
          coverage: result.coverage,
          reads: result.reads.map((r) => ({
            readAt: r.readAt,
            historicalReplay: r.historicalReplay,
          })),
          consistency: "on_demand_not_atomic",
        });
      } else {
        status = 404;
        body = { error: "接口不存在" };
      }
      valid();
    } catch (e) {
      try {
        authorized();
        status =
          e instanceof Forbidden ? 403 : e instanceof z.ZodError ? 400 : 502;
      } catch {
        status = 403;
      }
      body = {
        error:
          status === 403
            ? "消费许可不足、已变化或停用"
            : status === 400
              ? "查询参数无效"
              : "来源或固定映射不可用，请联系管理员",
      };
    }
    this.memory.putArtifact({
      kind: "live_access",
      title: view.title,
      status: String(status),
      content: {
        consumerId: view.id,
        path,
        status,
        readAt: new Date().toISOString(),
        contractVersion: "v3",
      },
    });
    return { status, body };
  }
}
export const consumerViewTools: DomainTool[] = [
  {
    name: "consumer_view_propose",
    description:
      "为指定已采用modelRef保存v3许可消费视图草稿，明确用途、类型、主/附来源融合字段与关系。字段须含$id，关系两端及关联属性须授权。operationId稳定重试；真实启用及密钥仅管理员界面处理。v3只读取源映射关系，不自动发布内部局部纠正。",
    mutates: true,
    inputSchema: z.toJSONSchema(proposal),
  },
  {
    name: "consumer_view_list",
    description: "读取最近40个v3消费视图与授权状态，不返回凭据。",
    mutates: false,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

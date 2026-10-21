import { objectIdLimit } from "../semantic/values.ts";
import { freezeLegacyConsumption } from "./legacy-consumption.ts";
import { snapshotPinsForRelease, correctionPinsForRelease, identityDecisionPinsForRelease, propertyCorrectionPinsForRelease } from "./release-pins.ts";
import type { SnapshotPins } from "./memory.ts";
import type { ReadingReceipt } from "./reading-contract.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { LiveMemory } from "./memory.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type {
  Artifact,
  Data,
  DomainTool,
  WriteContext,
} from "../agent/contracts.ts";
import { fileURLToPath } from "node:url";
import {
  contextScope,
  contextReading,
  contextOptions,
  type ContextScope,
} from "./consumer-context.ts";
import { consumerConnection } from "./consumer-contract.ts";
import { jsonData } from "./sources.ts";
const name = z.string().trim().min(1).max(200),
  version = z.number().int().positive();
const ref = z.object({ id: name, version }).strict();
export const consumerGrant = z
  .object({
    type: name,
    fields: z.array(name).min(1).max(100),
    relations: z.array(name).max(40),
    evidence: z
      .object({
        fields: z.array(name).max(20),
        relations: z.array(name).max(40),
      })
      .strict()
      .optional(),
  })
  .strict();
const proposal = z
  .object({
    operationId: name,
    name,
    purpose: z.string().trim().min(1).max(2000),
    modelRef: ref,
    grants: z.array(consumerGrant).min(1).max(20),
    contextEvidence: z.array(contextScope).max(6).optional(),
  })
  .strict();
const query = z
  .object({
    type: name,
    id: z.string().trim().min(1).max(objectIdLimit).optional(),
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
class ViewVersionChanged extends Error {}
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
  propose(_input: unknown, _context?: WriteContext, _options: { fixedSemantic?: boolean; snapshotPins?: SnapshotPins; releaseRef?: { id: string; version: number } } = {}): Artifact {
    return freezeLegacyConsumption();
  }
  /** Published v4 composition owns semantics and pins; compatibility options cannot override either. */
  createForRelease(input: unknown, releaseRef: { id: string; version: number }, _options: { fixedSemantic?: boolean; snapshotPins?: SnapshotPins } = {}) {
    const release = this.memory.getArtifact(releaseRef.id, releaseRef.version);
    if (release.kind !== "data_release" || release.status !== "published") throw new Error("需要已发布版本");
    const args = proposal.parse(input);
    const modelRef = release.content.modelRef as { id: string; version: number } | null;
    if (!modelRef || modelRef.id !== args.modelRef.id || modelRef.version !== args.modelRef.version) throw new Error("业务映射必须属于指定发布版本");
    const definition = (release.content.definition as Data | undefined)?.model;
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw new Error("发布版本缺少固定业务映射");
    const modelDefinition = jsonData({ ...definition, foundationRef: release.content.foundationRef });
    const draft = this.proposeInternal(input, undefined, { fixedSemantic: true, snapshotPins: snapshotPinsForRelease(release.content.definition as Data), correctionPins: correctionPinsForRelease(release.content.definition as Data), identityDecisionPins: identityDecisionPinsForRelease(release.content.definition as Data), propertyCorrectionPins: propertyCorrectionPinsForRelease(release.content.definition as Data), releaseRef, modelDefinition });
    return this.activateInternal({ id: draft.id, version: draft.version }).view;
  }
  private proposeInternal(input: unknown, context?: WriteContext, options: { fixedSemantic?: boolean; snapshotPins?: SnapshotPins; correctionPins?: string[]; identityDecisionPins?: string[]; propertyCorrectionPins?: string[]; releaseRef?: { id: string; version: number }; modelDefinition?: Data } = {}) {
    const a = proposal.parse(input),
      actor = context ? `agent:${context.taskId}` : "local-admin";
    if (context) this.memory.assertWritable(context);
    const signature = digest(canonical({ ...a, ...(options.releaseRef ? { releaseRef: options.releaseRef } : {}) }));
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
      this.live.assertModel(a.modelRef.id, a.modelRef.version, options.fixedSemantic, options.snapshotPins, options.modelDefinition);
      const { model } = this.live.validateConsumerScope({
        name: a.name,
        purpose: a.purpose,
        modelId: a.modelRef.id,
        grants: a.grants.map(({ evidence, ...g }) => g),
      }, options.fixedSemantic, options.snapshotPins, options.modelDefinition);
      if (
        a.grants.some(
          (g) =>
            new Set(g.fields).size !== g.fields.length ||
            new Set(g.relations).size !== g.relations.length,
        )
      )
        throw new Error("许可字段或关系重复");
      for (const g of a.grants) {
        if (
          g.evidence &&
          (g.evidence.fields.some(
            (f) => f === "$id" || !g.fields.includes(f),
          ) ||
            g.evidence.relations.some((r) => !g.relations.includes(r)) ||
            new Set(g.evidence.fields).size !== g.evidence.fields.length ||
            new Set(g.evidence.relations).size !== g.evidence.relations.length)
        )
          throw new Error("证据范围必须属于已许可字段或关系且不得重复");
      }
      const contextEvidence = (a.contextEvidence ?? []).map((scope) => {
        const preview = contextReading(
          this.memory,
          this.live,
          a.modelRef,
          scope,
          "validation",
        );
        return {
          ...scope,
          evidenceRef: randomUUID(),
          label:
            scope.kind === "document"
              ? String(preview.title)
              : String((preview.definition as Data).name),
        };
      });
      if (
        new Set(
          contextEvidence.map((c) =>
            canonical({ bundleRef: c.bundleRef, kind: c.kind, index: c.index }),
          ),
        ).size !== contextEvidence.length
      )
        throw new Error("背景证据重复");
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
            contextEvidence,
            relationPolicy: "source_mapping_only",
            responsible: actor,
            ...(options.fixedSemantic ? { fixedSemantic: true } : {}),
            ...(options.snapshotPins !== undefined ? { snapshotPins: options.snapshotPins } : {}),
            ...(options.correctionPins !== undefined ? { correctionPins: options.correctionPins } : {}),
            ...(options.identityDecisionPins !== undefined ? { identityDecisionPins: options.identityDecisionPins } : {}),
            ...(options.propertyCorrectionPins !== undefined ? { propertyCorrectionPins: options.propertyCorrectionPins } : {}),
            ...(options.releaseRef ? { releaseRef: options.releaseRef } : {}),
            ...(options.modelDefinition ? { modelDefinition: options.modelDefinition } : {}),
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
  evidenceOptions(input: unknown) {
    return jsonData(contextOptions(this.memory, this.live, ref.parse(input)));
  }
  connection(input: unknown, origin: string) {
    const r = ref.parse(input),
      v = this.view(r.id);
    if (v.version !== r.version || v.status === "revoked")
      throw new Error("视图已变化或停用");
    this.model(v);
    return jsonData(
      consumerConnection(
        v.content.grants as Data[],
        origin,
        fileURLToPath(
          new URL("../../scripts/dataengine-mcp.ts", import.meta.url),
        ),
        process.execPath,
        this.contextCatalog(v),
        v.version,
        Boolean(v.content.requiresViewVersion),
      ),
    );
  }
  private contextCatalog(v: Artifact) {
    for(const scope of (v.content.contextEvidence as Data[])??[]) contextReading(this.memory,this.live,v.content.modelRef as {id:string;version:number},scope as unknown as ContextScope,v.id);
    return ((v.content.contextEvidence as Data[]) ?? []).map((c) => ({
      ref: c.evidenceRef,
      kind: c.kind,
      label: c.label,
    }));
  }
  private view(id: string) {
    const a = this.memory.getArtifact(id);
    if (a.kind !== "consumer_view") throw new Error("需要v3消费视图");
    return a;
  }
  private model(a: Artifact) {
    const r = a.content.modelRef as { id: string; version: number };
    const m = this.live.assertModel(r.id, r.version, a.content.fixedSemantic === true, a.content.snapshotPins as SnapshotPins | undefined, this.definition(a));
    if (m.status !== "adopted") throw new Error("需要已采用映射");
    return m;
  }
  private definition(view: Artifact): Data {
    if (view.content.modelDefinition) return view.content.modelDefinition as Data;
    const modelRef = view.content.modelRef as { id: string; version: number };
    // Pre-release views retain their original vocabulary even when current semantic names change.
    return this.memory.getArtifact(modelRef.id, modelRef.version).content;
  }
  activate(_input: unknown): { view: Artifact; key: string | null; keyAvailable: boolean } {
    return freezeLegacyConsumption();
  }
  private activateInternal(input: unknown) {
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
      for (const scope of (a.content.contextEvidence as Data[]) ?? [])
        contextReading(
          this.memory,
          this.live,
          a.content.modelRef as { id: string; version: number },
          scope as unknown as ContextScope,
          a.id,
        );
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
    this.memory.deleteConsumerEvidence(a.id);
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
    origin = "http://localhost",
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
    return this.readView(view, path, params, origin);
  }
  /** Internal composition only: the owner must authenticate and pin its linked view. */
  assertLinkedReadable(viewRef: { id: string; version: number }) {
    const view = this.view(viewRef.id);
    if (view.status !== "active" || view.version !== viewRef.version) throw new Error("业务数据许可已停用或变化");
    this.model(view);
    return view;
  }

  /** Internal composition only: the owner must authenticate and pin its linked view. */
  async readLinkedView(viewRef: { id: string; version: number }, path: string, params: URLSearchParams, authorize: () => void) {
    const view = this.view(viewRef.id);
    if (view.status !== "active") return { status: 403, body: { error: "业务数据许可已停用" } as Data };
    if (view.version !== viewRef.version) return { status: 409, body: { error: "业务数据许可已变化，请重新发布数据集" } as Data };
    return this.readView(view, path, params, "http://localhost", authorize);
  }
  private publicReading(view: Artifact, receipt: ReadingReceipt) {
    return { ...receipt, versions: { ...receipt.versions, ...(view.content.releaseRef ? { release: view.content.releaseRef } : {}) },
      sources: receipt.sources.map((source, index) => ({ id: digest(view.id + ":" + source.id + ":" + source.capability).slice(0, 24),
        name: `来源 ${index + 1}`, readMode: source.readMode, snapshotId: source.snapshotId, dataAsOf: source.dataAsOf, coverage: source.coverage, ...(source.status ? { status: source.status } : {}) })) };
  }
  private async readView(view: Artifact, path: string, params: URLSearchParams, origin: string, authorizeOwner = () => {}): Promise<{ status: number; body: Data }> {
    let status = 200,
      body: Data;
    const authorized = () => {
      authorizeOwner();
      const now = this.view(view.id);
      if (now.status !== "active") throw new Forbidden("消费许可已变化或停用");
      if(now.version!==view.version)throw new ViewVersionChanged("视图版本已变化");
    };
    try {
      params=new URLSearchParams(params);
      if(params.getAll('viewVersion').length>1)throw new z.ZodError([]);
      const pinned=params.has('viewVersion')?z.coerce.number().int().positive().safe().parse(params.get('viewVersion')):undefined;
      params.delete('viewVersion');
      if((pinned!==undefined&&pinned!==view.version)||(view.content.requiresViewVersion&&pinned===undefined&&['/v3/types','/v3/objects','/v3/evidence'].includes(path)))throw new ViewVersionChanged('需要当前视图版本');
      const model = this.model(view),
        grants = view.content.grants as z.infer<typeof consumerGrant>[];
      const valid = () => {
        authorized();
        this.model(view);
      };
      valid();
      const common = {
        contractVersion: "v3",
        viewVersionRequired:Boolean(view.content.requiresViewVersion),
        viewRef: { id: view.id, version: view.version },
        modelRef: view.content.modelRef,
        semanticRef: view.content.semanticRef,
        methodVersion: "fusion-objects-v3.1",
        relationPolicy: "source_mapping_only",
        evidenceAvailability:
          (view.content.contextEvidence as Data[])?.length ||
          grants.some(
            (g) => g.evidence?.fields.length || g.evidence?.relations.length,
          )
            ? "scoped_reading"
            : "not_exposed",
      };
      const keys = [...params.keys()];
      if (new Set(keys).size !== keys.length) throw new z.ZodError([]);
      if (path === "/v3/catalog") {
        if (keys.length) throw new z.ZodError([]);
        body = jsonData({
          ...common,
          contextEvidence: this.contextCatalog(view),
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
          evidence: g.evidence ?? { fields: [], relations: [] },
          relations: (model.content.relations as Data[])
            .filter(
              (r) => r.from === g.type && g.relations.includes(String(r.name)),
            )
            .map((r) => ({ name: r.name, to: r.to })),
          limits: { maxObjects: 20 },
          ...this.publicReading(view, this.live.describeReading(model.id, g.type, view.content.snapshotPins as SnapshotPins | undefined, "live", g.fields, this.definition(view))),
        });
      } else if (path === "/v3/connection") {
        if (keys.length) throw new z.ZodError([]);
        body = jsonData({
          ...common,
          ...consumerConnection(
            grants,
            origin,
            fileURLToPath(
              new URL("../../scripts/dataengine-mcp.ts", import.meta.url),
            ),
            process.execPath,
            this.contextCatalog(view),
            view.version,
            Boolean(view.content.requiresViewVersion),
          ),
        });
      } else if (path === "/v3/evidence") {
        if (keys.length !== 1 || keys[0] !== "ref") throw new z.ZodError([]);
        const evidenceRef = name.parse(params.get("ref"));
        const context = ((view.content.contextEvidence as Data[]) ?? []).find(
          (c) => c.evidenceRef === evidenceRef,
        );
        if (context) {
          const evidence = contextReading(
            this.memory,
            this.live,
            view.content.modelRef as { id: string; version: number },
            context as unknown as ContextScope,
            view.id,
          );
          valid();
          body = jsonData({
            ...common,
            evidenceRef,
            reading: "saved_reading_not_current",
            retention: "explicit_saved_bundle",
            evidence,
          });
        } else {
          const c = this.memory.readConsumerEvidence(evidenceRef);
          if (
            !c ||
            c.viewId !== view.id ||
            c.viewVersion !== view.version ||
            Date.parse(String(c.expiresAt)) <= Date.now()
          )
            throw new Forbidden("证据不可用");
          const g = grants.find((g) => g.type === c.type);
          if (
            !g ||
            !(c.kind === "property"
              ? g.evidence?.fields.includes(String(c.field))
              : g.evidence?.relations.includes(String(c.relation)))
          )
            throw new Forbidden("证据未许可");
          body = jsonData({
            ...common,
            evidenceRef,
            reading: "saved_reading_not_current",
            expiresAt: c.expiresAt,
            evidence: c.evidence,
          });
        }
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
          { ...args, modelId: model.id, modelVersion: model.version, fields, readMode: view.content.snapshotPins !== undefined ? "release_pinned" : "live" },
          valid,
          // A release applies exactly the corrections it was published with; a view without a pinned set (pre-release) applies none.
          view.content.correctionPins !== undefined ? new Set(view.content.correctionPins as string[]) : false,
          this.definition(view),
          view.content.fixedSemantic === true,
          view.content.snapshotPins as SnapshotPins | undefined,
          undefined,
          view.content.identityDecisionPins !== undefined ? new Set(view.content.identityDecisionPins as string[]) : false,
          undefined,
          view.content.propertyCorrectionPins !== undefined ? new Set(view.content.propertyCorrectionPins as string[]) : false,
        );
        valid();
        const pendingEvidence: Array<{
          id: string;
          viewId: string;
          expiresAt: number;
          body: Data;
        }> = [];
        const persist = (scope: Data, evidence: Data) => {
          const id = randomUUID(),
            expiresAt = Date.now() + 86400000;
          pendingEvidence.push({
            id,
            viewId: view.id,
            expiresAt,
            body: jsonData({
              viewId: view.id,
              viewVersion: view.version,
              ...scope,
              expiresAt: new Date(expiresAt).toISOString(),
              evidence,
            }),
          });
          return id;
        };
        const targetDefinition = (model.content.types as Data[]).find(
          (t) => t.name === target.type,
        )!;
        const matches = (i: number, f: string) =>
          (result.evidence?.[i]?.matches ?? [])
            .filter((m) =>
              ((targetDefinition.supplements as Data[]) ?? []).some(
                (s) =>
                  s.name === m.binding && Object.hasOwn(s.fields as Data, f),
              ),
            )
            .map((m) => ({
              originRef: digest(
                view.id + ":" + m.sourceId + ":" + m.capability,
              ).slice(0, 24),
              status: m.status,
              reason: m.reason,
              attemptedAt: m.attemptedAt,
              readAt: m.readAt ?? null,
              coverage: m.coverage ?? null,
            }));
        const reads = result.reads.map((r) => ({
          readAt: r.readAt,
          historicalReplay: r.historicalReplay,
        }));
        let relationEvidenceRef: string | undefined;
        if (args.relation && g.evidence?.relations.includes(args.relation)) {
          const r = (model.content.relations as Data[]).find(
            (r) => r.from === g.type && r.name === args.relation,
          )!;
          relationEvidenceRef = persist(
            { type: g.type, kind: "relation", relation: args.relation },
            {
              kind: "relation",
              from: result.relationOrigin!,
              relation: args.relation,
              toType: target.type,
              targetIds: result.items.map((row) => String(row.$id)),
              rule: {
                kind: "exact_match",
                fromField: r.fromField,
                toField: r.toField,
              },
              coverage: result.coverage,
              reads,
              explanation:
                "按固定源映射的关联字段精确匹配；仅证明本次有界读取的关系，不含内部局部纠正。",
            },
          );
        }
        body = jsonData({
          ...common,
          ...(relationEvidenceRef ? { relationEvidenceRef } : {}),
          type: target.type,
          items: result.items.map((row, i) => ({
            objectRef: { type: target.type, id: String(row.$id) },
            properties: Object.fromEntries(
              fields
                .filter((f) => f !== "$id")
                .map((f) => [
                  f,
                  {
                    ...(target.evidence?.fields.includes(f)
                      ? {
                          evidenceRef: persist(
                            { type: target.type, kind: "property", field: f },
                            {
                              kind: "property",
                              objectRef: {
                                type: target.type,
                                id: String(row.$id),
                              },
                              field: f,
                              value: row[f],
                              status:
                                result.evidence?.[i]?.properties[f]?.status ??
                                (row[f] === null ? "missing" : "resolved"),
                              observations: result.evidence?.[i]?.properties[
                                f
                              ]?.evidence.map((e) => ({
                                originRef: digest(
                                  view.id +
                                    ":" +
                                    e.sourceId +
                                    ":" +
                                    e.capability,
                                ).slice(0, 24),
                                value: e.value,
                                eligible: e.eligible,
                                readAt: e.readAt,
                                historicalReplay: e.historicalReplay,
                              })) ?? [
                                {
                                  value: row[f],
                                  eligible: true,
                                  ...reads[reads.length - 1],
                                },
                              ],
                              objectCoverage: result.coverage,
                              matches: matches(i, f),
                              reads,
                              explanation:
                                "只保留获准属性的读取值与可用性；冲突不择一，不确定或缺失不等于零。",
                            },
                          ),
                        }
                      : {}),
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
          ...this.publicReading(view, { readMode: result.readMode, versions: result.versions, sources: result.sources, consistency: result.consistency, multiSourceTime: result.multiSourceTime }),
        });
        valid();
        this.memory.saveConsumerEvidence(pendingEvidence);
      } else {
        status = 404;
        body = { error: "接口不存在" };
      }
      valid();
    } catch (e) {
      try {
        authorized();
        status =
          e instanceof ViewVersionChanged ? 409 : e instanceof Forbidden ? 403 : e instanceof z.ZodError ? 400 : 502;
      } catch (error) {
        status = error instanceof ViewVersionChanged?409:403;
      }
      body = {
        ...(status===409?{code:"view_version_changed",hint:"重新读取 /v3/catalog 并携带当前 viewRef.version 作为 viewVersion，再开始查询。"}:{}),
        error:
          status === 409?"视图已迁移或缺少版本，请重新发现当前许可":status === 403
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

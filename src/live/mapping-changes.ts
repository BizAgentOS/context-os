import { createHash } from "node:crypto";
import { z } from "zod";
import { assertSnapshotImpact, modelSchema, type LiveMemory } from "./memory.ts";
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
const patchSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("property"),
      type: name,
      property: name,
      supplement: name.optional(),
      sourceField: name,
    })
    .strict(),
  z
    .object({
      kind: z.literal("relation"),
      type: name,
      relation: name,
      fromField: name,
      toField: name,
    })
    .strict(),
]);
const proposeSchema = z
  .object({
    operationId: name,
    baseRef: ref,
    patch: patchSchema,
    reason: z.string().trim().min(1).max(2000),
    evidence: z.string().trim().min(1).max(4000),
    relatedCorrections: z.array(ref).max(20).default([]),
  })
  .strict();
const actionSchema = z
  .object({ operationId: name, id: name, version })
  .strict();
type Draft = z.infer<typeof proposeSchema>;
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
// Only known receipt metadata loses its volatile timestamps; business fields stay intact.
const sorted = <T>(values: T[]) =>
  [...values].sort((a, b) => canonical(a).localeCompare(canonical(b)));
function pageFacts(page: Awaited<ReturnType<LiveMemory["query"]>>) {
  return {
    items: sorted(page.items),
    coverage: page.coverage,
    reads: sorted(page.reads.map(({ readAt, ...receipt }) => receipt)),
    evidence: sorted(
      (page.evidence ?? []).map((object) => ({
        objectId: object.objectId,
        properties: Object.fromEntries(
          Object.entries(object.properties).map(([key, p]) => [
            key,
            {
              ...p,
              evidence: sorted(
                p.evidence.map(({ readAt, ...receipt }) => receipt),
              ),
            },
          ]),
        ),
        matches: sorted(
          object.matches.map(({ readAt, attemptedAt, ...match }) => match),
        ),
      })),
    ),
  };
}
function present(a: Artifact): Artifact & { changeRef: Data } {
  const changeRef = { kind: "mapping_change", id: a.id, version: a.version };
  return {
    ...a,
    changeRef,
    content: {
      ...a.content,
      impact: { ...(a.content.impact as Data), changeRef },
    },
  };
}
export class MappingChanges {
  private memory: MemoryStore;
  private live: LiveMemory;
  constructor(memory: MemoryStore, live: LiveMemory) {
    this.memory = memory;
    this.live = live;
  }
  list() {
    return this.memory
      .listArtifacts("mapping_change")
      .slice(0, 40)
      .map((a) => ({
        id: a.id,
        version: a.version,
        title: a.title,
        status: a.status,
        baseRef: a.content.baseRef,
        changeRef: { kind: "mapping_change", id: a.id, version: a.version },
      }));
  }
  read(id: string, v?: number) {
    if (!id || (v !== undefined && (!Number.isSafeInteger(v) || v < 1)))
      throw new Error("需要有效记录与版本");
    const a = this.memory.getArtifact(id, v);
    if (a.kind !== "mapping_change") throw new Error("需要映射修订记录");
    return present(a);
  }
  private base(baseRef: { id: string; version: number }) {
    const a = this.live.assertModel(baseRef.id, baseRef.version);
    const current = this.memory
      .listArtifacts("live_ontology")
      .find((m) => m.status === "adopted");
    if (
      a.status !== "adopted" ||
      current?.id !== a.id ||
      current.version !== a.version
    )
      throw new Error("执行映射基线已变化，请重新读取");
    return a;
  }
  issues(baseRef: { id: string; version: number }) {
    ref.parse(baseRef);
    this.base(baseRef);
    const rows = this.memory
      .listArtifacts("relation_correction")
      .filter((a) => {
        const t = a.content.target as Data;
        return t.modelId === baseRef.id && t.modelVersion === baseRef.version;
      });
    const groups = new Map<
      string,
      {
        type: string;
        relation: string;
        count: number;
        references: { id: string; version: number; status: string }[];
      }
    >();
    for (const a of rows) {
      const t = a.content.target as Data,
        key = JSON.stringify([t.type, t.relation]);
      const group = groups.get(key) || {
        type: String(t.type),
        relation: String(t.relation),
        count: 0,
        references: [],
      };
      group.count++;
      if (group.references.length < 20)
        group.references.push({
          id: a.id,
          version: a.version,
          status: a.status,
        });
      groups.set(key, group);
    }
    return {
      baseRef,
      groups: [...groups.values()].slice(0, 40),
      totalGroups: groups.size,
      scope: "saved_local_corrections_only",
      notChecked: ["unreported_source_issues", "business_truth"],
    };
  }
  private definition(base: Artifact, patch: Draft["patch"]) {
    const d = modelSchema.parse(
      Object.fromEntries(
        Object.entries(base.content).filter(([k]) =>
          Object.hasOwn(modelSchema.shape, k),
        ),
      ),
    );
    d.baseModelRef = { id: base.id, version: base.version };
    const type = d.types.find((t) => t.name === patch.type);
    if (!type) throw new Error("修订类型不存在");
    let before: unknown, after: unknown, path: string[];
    if (patch.kind === "property") {
      const binding = patch.supplement
        ? type.supplements?.find((s) => s.name === patch.supplement)
        : type;
      if (!binding || !Object.hasOwn(binding.fields, patch.property))
        throw new Error("属性绑定不存在；本票只修订已有绑定");
      before = binding.fields[patch.property];
      after = patch.sourceField;
      Object.defineProperty(binding.fields, patch.property, {
        value: patch.sourceField,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      path = [patch.type, patch.supplement || "primary", patch.property];
    } else {
      const r = d.relations.find(
        (r) => r.from === patch.type && r.name === patch.relation,
      );
      if (!r) throw new Error("关系规则不存在");
      before = { fromField: r.fromField, toField: r.toField };
      after = { fromField: patch.fromField, toField: patch.toField };
      r.fromField = patch.fromField;
      r.toField = patch.toField;
      path = [patch.type, patch.relation];
    }
    if (canonical(before) === canonical(after)) throw new Error("规则没有变化");
    return { definition: d, diff: { kind: patch.kind, path, before, after } };
  }
  private async capture(draft: Draft, valid: () => void) {
    const base = this.base(draft.baseRef),
      { definition, diff } = this.definition(base, draft.patch);
    if (
      new Set(draft.relatedCorrections.map((r) => r.id)).size !==
      draft.relatedCorrections.length
    )
      throw new Error("关联纠正引用重复");
    for (const r of draft.relatedCorrections) {
      const a = this.memory.getArtifact(r.id);
      const t = a.content.target as Data;
      if (
        a.kind !== "relation_correction" ||
        a.version !== r.version ||
        t.modelId !== base.id ||
        t.modelVersion !== base.version
      )
        throw new Error("关联纠正依据版本或范围已变化");
    }
    const prepared = await this.live.prepareDefinition(definition, valid);
    const query = {
      modelId: base.id,
      modelVersion: base.version,
      type: draft.patch.type,
    };
    const enumeration = await this.live.query(
      { ...query, fields: ["$id"], limit: 5 },
      valid,
      false,
    );
    if (!enumeration.items.length) throw new Error("没有实际起点可验证修订");
    const ids = enumeration.items.map((i) => String(i.$id)).sort();
    if (new Set(ids).size !== ids.length) throw new Error("样本身份不唯一");
    const changedType = (prepared.types as Data[]).find(
      (t) => t.name === draft.patch.type,
    )!;
    const patch = draft.patch;
    const dependentSupplements =
      patch.kind === "property" && !patch.supplement
        ? ((changedType.supplements ?? []) as Data[]).filter(
            (s) => (s.match as Data).primaryField === patch.property,
          )
        : [];
    const affectedFields =
      patch.kind === "property"
        ? [
            ...new Set([
              patch.property,
              ...dependentSupplements.flatMap((s) =>
                Object.keys(s.fields as Data),
              ),
            ]),
          ]
        : [];
    const samples = [];
    const available = (r: Awaited<ReturnType<LiveMemory["query"]>>) => {
      if (
        r.evidence?.some((e) =>
          e.matches.some((m) => m.status === "unavailable"),
        )
      )
        throw new Error("来源读取失败，不能形成影响报告");
      return r;
    };
    for (const id of [...ids].sort()) {
      valid();
      const origin = await this.live.query(
        { ...query, id, fields: ["$id"], limit: 2 },
        valid,
        false,
      );
      if (
        origin.items.length !== 1 ||
        !origin.coverage.complete ||
        String(origin.items[0].$id) !== id
      )
        throw new Error("样本身份不存在、不唯一或覆盖不完整");
      const selection =
        draft.patch.kind === "property"
          ? { fields: ["$id", ...affectedFields], limit: 2 }
          : { relation: draft.patch.relation, limit: 20 };
      const before = available(
        await this.live.query({ ...query, id, ...selection }, valid, false),
      );
      const after = available(
        await this.live.query(
          { ...query, id, ...selection },
          valid,
          false,
          prepared,
        ),
      );
      samples.push({
        id,
        before,
        after,
        changed: canonical(pageFacts(before)) !== canonical(pageFacts(after)),
      });
    }
    const fullCheck = await this.live.snapshotImpact(base.content, definition);
    valid();
    this.base(draft.baseRef);
    const issues = this.issues(draft.baseRef);
    const dependencies =
      patch.kind === "property" && !patch.supplement
        ? (base.content.relations as Data[]).filter(
            (r) =>
              (r.from === draft.patch.type && r.fromField === patch.property) ||
              (r.to === draft.patch.type && r.toField === patch.property),
          )
        : [];
    const impact = {
      dependencies,
      dependentSupplements: dependentSupplements.map((s) => ({
        name: s.name,
        properties: Object.keys(s.fields as Data),
        comparison: "included_in_samples",
      })),
      contractVersion: "mapping-impact-v1",
      scope: {
        type: draft.patch.type,
        sampleIds: ids,
        enumerationCoverage: enumeration.coverage,
        selection: "first_page_not_statistical",
        notChecked: [
          "all_enterprise_records",
          "business_truth",
          "atomic_source_snapshot",
        ],
      },
      samples,
      snapshotCheck: fullCheck,
      summary: {
        sampleCount: samples.length,
        changedSamples: samples.filter((s) => s.changed).length,
      },
      localCorrections: {
        ...issues,
        policy: "remain_on_base_model_not_migrated",
      },
      consumption: {
        status: "not_evaluated",
        policy: "existing_consumers_remain_on_base_model",
        integration: "T016-03",
      },
    };
    const snapshot = jsonData({ diff, impact });
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 256 * 1024)
      throw new Error("映射影响读取依据超过256KB，请缩小字段或关系目标范围");
    return {
      definition: prepared,
      ...snapshot,
      fingerprint: hash({
        diff,
        impact: {
          ...impact,
          samples: samples.map((s) => ({
            ...s,
            before: pageFacts(s.before),
            after: pageFacts(s.after),
          })),
        },
      }),
    };
  }
  private previous(actor: string, operationId: string, signature: string) {
    const r = this.memory
      .listArtifacts("mapping_receipt")
      .find(
        (a) =>
          a.content.actor === actor && a.content.operationId === operationId,
      );
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
  ) {
    if (method === "adopt" && context)
      throw new Error("采用需由管理员确认具体检查版本");
    const args =
        method === "propose"
          ? proposeSchema.parse(input)
          : actionSchema.parse(input),
      actor = context ? `agent:${context.taskId}` : "local-admin";
    const valid = () => {
      assertActive();
      if (context) this.memory.assertWritable(context);
    };
    valid();
    const signature = hash({ method, args }),
      old = this.previous(actor, args.operationId, signature);
    if (old) return old;
    const record = "baseRef" in args ? null : this.read(args.id);
    if (record) {
      if (record.version !== (args as z.infer<typeof actionSchema>).version)
        throw new Error("修订版本冲突");
      if (record.status === "adopted" && method === "cancel")
        throw new Error("已提交，取消不能回滚");
      if (!["candidate", "checked"].includes(record.status))
        throw new Error("修订已终结");
    }
    if (method === "adopt" && record?.status !== "checked")
      throw new Error("请先检查并确认具体版本");
    const draft = ("baseRef" in args ? args : record!.content.draft) as Draft;
    const captured =
      method === "cancel" ? null : await this.capture(draft, valid);
    if (
      record &&
      captured &&
      captured.fingerprint !== record.content.fingerprint
    )
      throw new Error("来源或治理依据已变化，请重新提出修订");
    return this.memory.atomic(() => {
      valid();
      const replay = this.previous(actor, args.operationId, signature);
      if (replay) return replay;
      if (record && this.read(record.id).version !== record.version)
        throw new Error("修订版本冲突");
      if (method !== "cancel") this.base(draft.baseRef);
      const content: Data = record
        ? { ...record.content }
        : jsonData({
            ...captured,
            draft,
            baseRef: draft.baseRef,
            responsible: actor,
            evidenceKind: "submitted_rationale",
          });
      delete (content.impact as Data).changeRef;
      if (method === "check") assertSnapshotImpact((content.impact as Data).snapshotCheck as Data | undefined);
      if (method === "check")
        content.check = {
          ruleVersion: "mapping-change-v1",
          result: "passed",
          at: new Date().toISOString(),
          notChecked: [
            "business_truth",
            "all_enterprise_records",
            "consumer_migration",
          ],
        };
      if (method === "adopt") {
        const result = this.memory.putArtifact({
          kind: "live_ontology",
          title: String(captured!.definition.purpose),
          status: "adopted",
          content: {
            ...captured!.definition,
            changeRef: {
              kind: "mapping_change",
              id: record!.id,
              version: record!.version + 1,
            },
          },
        });
        content.resultModel = { id: result.id, version: result.version };
        content.decision = {
          actor,
          at: new Date().toISOString(),
          checkedVersion: record!.version,
        };
      }
      const saved = this.memory.putArtifact(
        {
          ...(record ? { id: record.id, expectedVersion: record.version } : {}),
          kind: "mapping_change",
          title: `${draft.patch.type} · ${draft.patch.kind === "property" ? draft.patch.property : draft.patch.relation}映射修订`,
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
        kind: "mapping_receipt",
        title: "映射修订回执",
        status: "saved",
        content: {
          actor,
          operationId: args.operationId,
          signature,
          id: saved.id,
          version: saved.version,
        },
      });
      return present(saved);
    });
  }
}
export const mappingChangeTools: DomainTool[] = [
  {
    name: "mapping_change_list",
    description: "列出最近40份映射修订元数据；正文和影响按需read。",
    mutates: false,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "mapping_change_read",
    description:
      "按id/version读取共同changeRef、规则差异、实例前后依据、覆盖、检查和决定。",
    mutates: false,
    inputSchema: z.toJSONSchema(ref),
  },
  {
    name: "mapping_change_issues",
    description:
      "按当前baseRef汇总已保存局部纠正的同类问题；不代表全部企业问题。",
    mutates: false,
    inputSchema: z.toJSONSchema(z.object({ baseRef: ref }).strict()),
  },
  ...(["propose", "check", "cancel"] as const).map((method) => ({
    name: `mapping_change_${method}`,
    description: {
      propose:
        "对最新已采用映射修订一个已有属性绑定或关系字段规则，保存共同变更引用、最多5起点/每关系20目标的前后实例影响。property的supplement省略表示主来源，填写表示附来源名。理由与依据为提交者陈述。可引用最多20条局部纠正；不自动采用。",
      check:
        "重读来源与治理依据检查具体修订版本；通过不代表业务真实，管理员在页面确认采用。",
      cancel: "取消尚未采用的修订；已提交不能冒充回滚。",
    }[method],
    mutates: true,
    inputSchema: z.toJSONSchema(
      method === "propose" ? proposeSchema : actionSchema,
    ),
  })),
];

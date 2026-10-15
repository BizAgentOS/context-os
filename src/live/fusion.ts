import { z } from "zod";
import type { SourceConnections } from "./sources.ts";
import type { Json } from "../agent/contracts.ts";

const name = z.string().trim().min(1).max(200);
export const supplementSchema = z
  .object({
    name,
    sourceId: name,
    capability: name,
    match: z
      .object({
        primaryField: name.describe(
          "主来源 fields 的业务属性名（键），不是原始源列名；或 $id。例如 fields={业务编号:ticket} 时填写业务编号",
        ),
        sourceField: name.describe("附来源获准精确过滤的原始字段，如 ticket"),
      })
      .strict(),
    fields: z.preprocess(
      (value) => {
        if (
          value &&
          typeof value === "object" &&
          Object.hasOwn(value, "__proto__")
        )
          throw new Error("保留属性名不可用");
        return value;
      },
      z.record(
        name.refine(
          (v) => v !== "__proto__" && v !== "$id",
          "保留属性名不可用",
        ),
        name,
      ),
    ),
    rationale: z.string().trim().min(1).max(2000),
  })
  .strict();
export type Supplement = z.infer<typeof supplementSchema>;
export interface FusionType {
  sourceId: string;
  capability: string;
  fields: Record<string, string>;
  supplements?: Supplement[];
}
type Page = Awaited<ReturnType<SourceConnections["readRecords"]>>;
type Receipt = Page["provenance"];
export interface ValueEvidence extends Receipt {
  sourceTitle: string;
  recordId: string | number;
  field: string;
  value: Json;
  eligible: boolean;
}
export interface Match {
  binding: string;
  sourceId: string;
  capability: string;
  status:
    | "unique"
    | "missing"
    | "ambiguous"
    | "unknown"
    | "unavailable"
    | "missing_key";
  reason: string;
  attemptedAt: string;
  readAt?: string;
  coverage?: Page["coverage"];
}
export interface PropertyEvidence {
  status: "resolved" | "missing" | "conflict" | "uncertain";
  value: Json;
  evidence: ValueEvidence[];
  blockers: string[];
}
export interface ObjectEvidence {
  objectId: string | number;
  properties: Record<string, PropertyEvidence>;
  matches: Match[];
}
export const propertyNames = (type: FusionType) => [
  ...new Set([
    ...Object.keys(type.fields),
    ...(type.supplements ?? []).flatMap((s) => Object.keys(s.fields)),
  ]),
];
export const isSupplementProperty = (type: FusionType, field: string) =>
  (type.supplements ?? []).some((s) => Object.hasOwn(s.fields, field));

export function validateSupplements(
  type: FusionType,
  sources: SourceConnections,
  connections: Record<string, number>,
) {
  const supplements = type.supplements ?? [];
  if (new Set(supplements.map((s) => s.name)).size !== supplements.length)
    throw new Error("附来源名称重复");
  if (propertyNames(type).length > 100)
    throw new Error("每种类型最多100个融合属性");
  for (const s of supplements) {
    if (s.sourceId === type.sourceId && s.capability === type.capability)
      throw new Error("附来源不能重复主来源能力");
    const { cap, artifact } = sources.capability(s.sourceId, s.capability);
    if (cap.contentKind !== "records")
      throw new Error("附来源只能绑定业务记录，知识与指标不是同实体明细");
    if (
      !Object.keys(s.fields).length ||
      Object.values(s.fields).some((f) => !cap.fields.includes(f))
    )
      throw new Error("附来源字段映射无效");
    if (
      s.match.primaryField !== "$id" &&
      !Object.hasOwn(type.fields, s.match.primaryField)
    )
      throw new Error("匹配起点必须是主来源属性或$id");
    if (
      !cap.fields.includes(s.match.sourceField) ||
      !Object.hasOwn(cap.filters, s.match.sourceField)
    )
      throw new Error("附来源匹配键必须支持获准精确过滤");
    connections[s.sourceId] = artifact.version;
  }
}

/** Per-call bounded joins. Only complete unique matches contribute resolved values. */
export async function fuseRows(
  type: FusionType,
  primary: Page,
  fields: string[],
  sources: Pick<SourceConnections, "capability" | "readRecords" | "list">,
  connections: Record<string, number>,
  assertValid: () => void,
) {
  const primaryCap = sources.capability(
    type.sourceId,
    type.capability,
    connections[type.sourceId],
  ).cap;
  const titles = new Map(sources.list().map((s) => [s.id, s.title]));
  const requested = new Set(fields);
  const supplements = (type.supplements ?? []).filter((s) =>
    Object.keys(s.fields).some((f) => requested.has(f)),
  );
  const objects: ObjectEvidence[] = primary.items.map((row) => ({
    objectId: row[primaryCap.idField] as string | number,
    properties: Object.create(null),
    matches: [],
  }));
  const reads: Receipt[] = [primary.provenance];
  for (let i = 0; i < primary.items.length; i++) {
    const row = primary.items[i];
    for (const field of fields) {
      const sourceField =
        field === "$id"
          ? primaryCap.idField
          : Object.hasOwn(type.fields, field)
            ? type.fields[field]
            : undefined;
      objects[i].properties[field] = {
        status: "missing",
        value: null,
        evidence: sourceField
          ? [
              {
                ...primary.provenance,
                sourceTitle: titles.get(type.sourceId)!,
                recordId: objects[i].objectId,
                field: sourceField,
                value: row[sourceField],
                eligible: true,
              },
            ]
          : [],
        blockers: [],
      };
    }
  }
  const jobs = objects.flatMap((object, index) =>
    supplements.map((s) => ({ object, index, s })),
  );
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const position = cursor++,
        { object, index, s } = jobs[position];
      assertValid();
      const match: Match = {
        binding: s.name,
        sourceId: s.sourceId,
        capability: s.capability,
        status: "unknown",
        reason: "",
        attemptedAt: new Date().toISOString(),
      };
      object.matches.push(match);
      const cap = sources.capability(
        s.sourceId,
        s.capability,
        connections[s.sourceId],
      ).cap;
      const key =
        primary.items[index][
          s.match.primaryField === "$id"
            ? primaryCap.idField
            : type.fields[s.match.primaryField]
        ];
      let page: Page | undefined;
      if (position >= 40) {
        match.reason = "本次附来源读取预算40次已用尽，请缩小主来源分页";
      } else if (key === null || (typeof key === "string" && !key.trim())) {
        match.status = "missing_key";
        match.reason = "主来源没有可用的匹配键";
      } else if (
        (s.match.sourceField === cap.idField && typeof key !== cap.idType) ||
        !["string", "number", "boolean"].includes(typeof key)
      ) {
        match.reason = "匹配键类型不一致；未做字符串/数字转换";
      } else {
        try {
          page = await sources.readRecords(
            s.sourceId,
            s.capability,
            { [s.match.sourceField]: key },
            0,
            2,
            connections[s.sourceId],
          );
          assertValid();
          // A source's advertised total can prove multiplicity even when its page is short.
          match.status =
            page.items.length > 1 ||
            (page.coverage.total !== null && page.coverage.total > 1)
              ? "ambiguous"
              : !page.coverage.complete
                ? "unknown"
                : page.items.length === 1
                  ? "unique"
                  : "missing";
          match.reason =
            match.status === "unique"
              ? "完整查询唯一匹配"
              : match.status === "missing"
                ? "完整查询无匹配"
                : match.status === "ambiguous"
                  ? "业务键对应多条记录，未选择任何一条"
                  : "查询覆盖不完整，不能确定零或唯一匹配";
          match.coverage = page.coverage;
          match.readAt = page.provenance.readAt;
          reads.push(page.provenance);
        } catch {
          // Invalidated authorization/run/model is fatal; an upstream outage remains a local gap.
          assertValid();
          match.status = "unavailable";
          match.reason = "来源读取失败或未遵循获准字段/过滤契约";
        }
      }
      for (const [property, sourceField] of Object.entries(s.fields)) {
        if (!requested.has(property)) continue;
        const cell = object.properties[property];
        for (const row of page?.items ?? [])
          cell.evidence.push({
            ...page!.provenance,
            sourceTitle: titles.get(s.sourceId)!,
            recordId: row[cap.idField] as string | number,
            field: sourceField,
            value: row[sourceField],
            eligible: match.status === "unique",
          });
        if (!["unique", "missing"].includes(match.status))
          cell.blockers.push(s.name);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, jobs.length) }, () => worker()),
  );
  assertValid();
  for (const object of objects) {
    object.matches.sort(
      (a, b) =>
        supplements.findIndex((s) => s.name === a.binding) -
        supplements.findIndex((s) => s.name === b.binding),
    );
    for (const cell of Object.values(object.properties)) {
      cell.evidence.sort((a, b) =>
        a.sourceId === type.sourceId && a.capability === type.capability
          ? -1
          : b.sourceId === type.sourceId && b.capability === type.capability
            ? 1
            : a.sourceId.localeCompare(b.sourceId) ||
              a.capability.localeCompare(b.capability),
      );
      const values = cell.evidence
        .filter((e) => e.eligible && e.value !== null)
        .map((e) => e.value);
      const distinct = [
        ...new Map(values.map((v) => [JSON.stringify(v), v])).values(),
      ];
      cell.status =
        distinct.length > 1
          ? "conflict"
          : cell.blockers.length
            ? "uncertain"
            : distinct.length === 1
              ? "resolved"
              : "missing";
      cell.value = cell.status === "resolved" ? distinct[0] : null;
    }
  }
  return {
    items: objects.map((o) =>
      Object.fromEntries(fields.map((f) => [f, o.properties[f].value])),
    ),
    evidence: objects,
    reads,
  };
}

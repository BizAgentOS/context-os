import { createHash } from "node:crypto";
import { z } from "zod";
import type { MemoryStore } from "../agent/memory.ts";
import type { LiveMemory } from "./memory.ts";
import type { Data } from "../agent/contracts.ts";
import { jsonData } from "./sources.ts";
const ref = z
  .object({
    id: z.string().min(1).max(200),
    version: z.number().int().positive(),
  })
  .strict();
export const contextScope = z
  .object({
    bundleRef: ref,
    kind: z.enum(["document", "metric"]),
    index: z.number().int().min(0).max(2),
  })
  .strict();
export type ContextScope = z.infer<typeof contextScope>;
const pick = (value: Data, keys: string[]) =>
  Object.fromEntries(
    keys.filter((k) => Object.hasOwn(value, k)).map((k) => [k, value[k]]),
  );

/** Only an explicitly selected, immutable document/metric reading is projected. */
export function contextReading(
  memory: MemoryStore,
  live: LiveMemory,
  modelRef: { id: string; version: number },
  scope: ContextScope,
  namespace: string,
) {
  const bundle = memory.getArtifact(
      scope.bundleRef.id,
      scope.bundleRef.version,
    ),
    c = bundle.content,
    m = c.model as Data;
  if (
    bundle.kind !== "evidence_bundle" ||
    m.id !== modelRef.id ||
    m.version !== modelRef.version
  )
    throw new Error("证据必须属于当前固定映射");
  const part = (
    c[scope.kind === "document" ? "documents" : "metrics"] as Data[]
  )[scope.index];
  if (!part || part.status !== "read") throw new Error("该证据未成功读取");
  const request = part.request as Data;
  live.sources.capability(
    String(request.sourceId),
    String(request.capability),
    Number(request.connectionVersion),
  );
  const r = part.result as Data;
  const opaque = (id: unknown) =>
    createHash("sha256")
      .update(namespace + ":" + String(request.sourceId) + ":" + String(id))
      .digest("hex")
      .slice(0, 32);
  const common = {
    kind: scope.kind,
    collectedAt: c.collectedAt,
    sourceVersion: request.connectionVersion,
    association: "explicit_context_only",
    explanation: "管理员明确授权的历史背景读取；不自动证明对象状态或指标归因。",
  };
  if (scope.kind === "document")
    return jsonData({
      ...common,
      title: r.title,
      text: r.text,
      location: {
        segmentRef: opaque(r.segmentId),
        revision: r.revision,
        start: r.start,
        end: r.end,
      },
      coverage: r.coverage,
      readAt: r.readAt,
    });
  return jsonData({
    ...common,
    definition: pick(r.definition as Data, [
      "name",
      "description",
      "revision",
      "unit",
      "grain",
      "timeZone",
      "dimensions",
      "aggregation",
    ]),
    definitionHash: r.definitionHash,
    query: pick(r.query as Data, ["start", "end", "where", "offset", "limit"]),
    items: (r.items as Data[]).map(({ observationId, ...row }) => ({
      ...row,
      observationRef: opaque(observationId),
    })),
    coverage: r.coverage,
    readAt: (r.provenance as Data).readAt,
  });
}

export function contextOptions(
  memory: MemoryStore,
  live: LiveMemory,
  modelRef: { id: string; version: number },
) {
  live.assertModel(modelRef.id, modelRef.version);
  const items = [];
  for (const bundle of memory.listArtifacts("evidence_bundle").slice(0, 20)) {
    const m = bundle.content.model as Data;
    if (m.id !== modelRef.id || m.version !== modelRef.version) continue;
    for (const kind of ["document", "metric"] as const)
      for (let index = 0; index < 3; index++) {
        const scope = {
          bundleRef: { id: bundle.id, version: bundle.version },
          kind,
          index,
        };
        try {
          const preview = contextReading(
            memory,
            live,
            modelRef,
            scope,
            "admin-preview",
          );
          items.push({ scope, preview });
        } catch {
          /* unavailable readings are not offered for new authorization */
        }
      }
  }
  return {
    items,
    scope:
      "最近20份共同取证中，当前固定映射且来源仍可用的文档/指标读取；逐份授权全部显示内容。",
  };
}

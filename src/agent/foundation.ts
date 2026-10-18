import type { LiveMemory } from "../live/memory.ts";
import { knowledgeTools } from "./knowledge.ts";
import { foundationWebTool } from "./foundation-web.ts";
import {
  FoundationDocuments,
  foundationDocumentTool,
  foundationEvidenceInput,
  verifyFoundationEvidence,
  isUnknownEnterprise,
  type FoundationEvidence,
} from "./foundation-evidence.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { MemoryStore } from "./memory.ts";
import type { Artifact, Data, DomainTool, WriteContext } from "./contracts.ts";
import { helixProjection } from "../engine/helix-projection.ts";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const text = z.string().trim().min(1).max(1500);
const refs = z.array(id).min(1).max(20);
const concept = z
  .object({ id, name: text, description: text, evidenceRefs: refs })
  .strict();
const relation = concept.extend({ from: id, to: id }).strict();
const issue = z
  .object({
    id,
    description: text,
    evidenceRefs: refs.optional(),
    resolvedBy: refs.optional(),
  })
  .strict();
const proposal = z
  .object({
    baseVersion: z.number().int().nonnegative(),
    identityCorrection: z
      .object({ previousName: text, evidenceRefs: refs })
      .strict()
      .optional(),
    enterprise: z
      .object({ name: z.string().trim().min(2).max(200), evidenceRefs: z.array(id).max(20) })
      .strict(),
    concepts: z.array(concept).max(30),
    relations: z.array(relation).max(60),
    evidence: z.array(foundationEvidenceInput).max(40),
    unknowns: z.array(issue).max(30),
    conflicts: z.array(issue).max(30),
  })
  .strict();
type Evidence = FoundationEvidence;
type Concept = z.infer<typeof concept> & {
  mappingStatus: "unbound";
  origin: "interpretation";
};
type Relation = Concept & z.infer<typeof relation>;
type Issue = z.infer<typeof issue> & {
  retained?: Concept | Relation;
  proposed?: Concept | Relation;
};
interface FoundationContent {
  enterprise: z.infer<typeof proposal>["enterprise"];
  concepts: Concept[];
  relations: Relation[];
  evidence: Evidence[];
  unknowns: Issue[];
  conflicts: Issue[];
  documentVersions?: Record<string, number>;
  adoptedVersion: number | null;
  profileRef: { id: string; version: number } | null;
  operation: { hash: string };
}
const content = (artifact: Artifact) =>
  artifact.content as unknown as FoundationContent;
const asData = (value: unknown): Data => JSON.parse(JSON.stringify(value));

function unique(items: { id: string }[], label: string) {
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new Error(`${label}标识重复`);
}
function merge<T extends { id: string }>(previous: T[], updates: T[]): T[] {
  const entries = new Map(previous.map((item) => [item.id, item]));
  for (const item of updates) entries.set(item.id, item);
  return [...entries.values()];
}

// Program (Helix) provenance survives wording and evidence updates.
const PROGRAM_FIELDS = ["origin", "programSource", "programEvidenceId"] as const;
function keepProgram<T extends { id: string }>(previous: T[], updates: T[]): T[] {
  return updates.map((item) => {
    const prior = previous.find((entry) => entry.id === item.id) as Record<string, unknown> | undefined;
    if (prior?.origin !== "program") return item;
    return { ...item, ...Object.fromEntries(PROGRAM_FIELDS.filter((key) => key in prior).map((key) => [key, prior[key]])) };
  });
}

/** Concepts and relations come from the data program; documents and the assistant refine existing ones. */
function assertStructureLocked(previous: FoundationContent | null, concepts: { id: string }[], relations: { id: string; from: string; to: string }[]) {
  const message = "概念和关系由数据程序根据结构化数据构建；文档与助手只能补充已有概念和关系的名称、说明、依据、未知项与冲突。请先接入结构化数据。";
  if (concepts.some((item) => !previous?.concepts.some((entry) => entry.id === item.id))) throw new Error(message);
  for (const item of relations) {
    const prior = previous?.relations.find((entry) => entry.id === item.id);
    if (!prior) throw new Error(message);
    if (prior.from !== item.from || prior.to !== item.to) throw new Error("关系端点由数据程序的匹配结果决定，不能改写；可补充名称、说明和依据。");
  }
}

export const foundationTools: DomainTool[] = [
  foundationDocumentTool,
  foundationWebTool,
  ...knowledgeTools,
  {
    name: "foundation_read",
    description:
      "读取企业基础本体的当前版本和已采用版本。概念绑定状态由执行映射实时投影；仅获准绑定可通过 live_query 按 conceptId 查询实例。",
    mutates: false,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "foundation_propose",
    description:
      "加载 company-foundation-ontology Skill 后，按基础版本保存有真实对话或文档依据的候选。概念和关系由数据程序构建：只能沿已有 id 补充名称、说明和依据，不能新增概念或关系、不能改关系端点；未知项和冲突可以新增。证据 id 不可改写。检查只保证结构与引文可定位。",
    mutates: true,
    inputSchema: z.toJSONSchema(proposal),
  },
];

/** Shared semantic service; the UI and agent consume the same versioned artifact. */
export class FoundationService {
  private memory: MemoryStore;
  private live?: LiveMemory;
  constructor(memory: MemoryStore, live?: LiveMemory) {
    this.memory = memory;
    this.live = live;
  }

  read() {
    const current = this.memory.listArtifacts("foundation")[0] ?? null;
    const adopted =
      current?.status === "adopted"
        ? current
        : current && content(current).adoptedVersion
          ? this.memory.getArtifact(
              current.id,
              content(current).adoptedVersion!,
            )
          : null;
    return { current, adopted };
  }

  project(artifact: Artifact): Artifact {
    const result = structuredClone(artifact);
    for (const entry of content(result).evidence) {
      delete entry.webSnapshot;
      delete entry.knowledgeSnapshot;
      delete entry.apiSnapshot;
    }
    const bindings =
      this.live?.bindings({ id: artifact.id, version: artifact.version }) ?? [];
    const projected = result.content.concepts as Data[];
    for (const concept of projected) {
      const matches = bindings.filter((b) => b.conceptId === concept.id);
      concept.bindings = asData(matches) as unknown as Data[];
      concept.mappingStatus = matches.some((b) => b.status === "adopted")
        ? "bound"
        : "unbound";
    }
    for (const relation of result.content.relations as Data[]) {
      const matches = bindings.filter((b) =>
        b.relations.some((r) => r.relationId === relation.id),
      );
      relation.mappingStatus = matches.some((b) => b.status === "adopted")
        ? "bound"
        : "unbound";
      relation.bindings = matches.map((b) => ({
        modelId: b.modelId,
        modelVersion: b.modelVersion,
        status: b.status,
        reason: b.reason,
        relationId: String(relation.id),
        mappings: b.relations.filter((r) => r.relationId === relation.id),
      }));
    }
    // Program discovery evidence (merged sources, link match counts, review notes) for each built concept.
    const helix = helixProjection(this.memory, artifact);
    if (helix) {
      const { concepts: byConcept, ...summary } = helix;
      for (const concept of projected) concept.helix = byConcept[String(concept.id)] ?? null;
      result.content.helix = asData(summary);
    }
    result.content.consumerReadiness = {
      objectsQueryable: bindings.some((b) => b.status === "adopted"),
      reason:
        "仅已采用且依赖有效的执行子集可供消费；候选只供预览，未映射概念仍可治理",
    };
    return result;
  }

  view() {
    const { current, adopted } = this.read();
    return {
      current: current ? this.project(current) : null,
      adopted: adopted ? this.project(adopted) : null,
    };
  }

  propose(
    args: unknown,
    context: WriteContext,
    operationId: string,
    skillDigest: string,
    documents?: FoundationDocuments,
    options: { lockStructure?: boolean } = {},
  ): Artifact {
    this.memory.assertWritable(context);
    if (!skillDigest)
      throw new Error("请先加载 company-foundation-ontology Skill");
    const input = proposal.parse(args);
    const hash = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const receipt = this.memory.artifactOperation(context, operationId);
    if (receipt) {
      if (
        receipt.kind !== "foundation" ||
        content(receipt).operation.hash !== hash
      )
        throw new Error("同一操作标识不能提交不同内容");
      return receipt;
    }
    const { current, adopted } = this.read();
    if (input.baseVersion !== (current?.version ?? 0))
      throw new Error("基础本体版本已变化，请 foundation_read 后再修改");
    const previous = current ? content(current) : null;
    // Model-driven callers (documents, the assistant) may only refine program-built structure.
    if (options.lockStructure) assertStructureLocked(previous, input.concepts, input.relations);
    for (const key of [
      "concepts",
      "relations",
      "evidence",
      "unknowns",
      "conflicts",
    ] as const)
      unique(input[key], key);
    const evidence = verifyFoundationEvidence(
      this.memory,
      input.evidence,
      previous?.evidence ?? [],
      context,
      documents,
    );
    for (const item of input.evidence) {
      const saved = evidence.find((e) => e.id === item.id)!;
      if (
        saved.kind === "web" &&
        saved.identity?.name !== input.enterprise.name
      )
        throw new Error(
          "网页研究主体与当前企业不一致，请先消歧，不合并不同企业",
        );
    }
    const checkRefs = (references: string[]) => {
      if (references.some((ref) => !evidence.some((entry) => entry.id === ref)))
        throw new Error("依据引用不存在；没有依据的内容请保留为未知");
    };
    checkRefs(input.enterprise.evidenceRefs);
    // Program discovery may begin without an enterprise profile. Retaining that
    // explicitly unknown identity must not block an unrelated concept repair.
    const previousUnknown = isUnknownEnterprise(previous?.enterprise);
    const retainsUnknown = previousUnknown && input.enterprise.name === previous?.enterprise.name && input.enterprise.evidenceRefs.length === 0;
    if (
      !retainsUnknown &&
      !input.enterprise.evidenceRefs.some((ref) =>
        evidence
          .find((entry) => entry.id === ref)!
          .quote.includes(input.enterprise.name),
      )
    )
      throw new Error("企业名称必须出现在引用的用户原话或文档片段中");
    if (previous && !previousUnknown && previous.enterprise.name !== input.enterprise.name) {
      const correction = input.identityCorrection;
      const latestUser = this.memory
        .messages(context.taskId)
        .filter((message) => message.role === "user")
        .at(-1);
      if (!correction || correction.previousName !== previous.enterprise.name)
        throw new Error(
          "企业名称变化需要明确的同主体名称纠正及原话依据；不能将不同企业合并",
        );
      checkRefs(correction.evidenceRefs);
      if (
        !correction.evidenceRefs.some((ref) => {
          const entry = evidence.find((e) => e.id === ref)!;
          return (
            entry.messageId === latestUser?.id &&
            entry.quote.includes(input.enterprise.name) &&
            !previous.evidence.some((e) => e.id === ref)
          );
        })
      )
        throw new Error("名称纠正需要本轮新增且包含新名称的用户原话依据");
    }
    const concepts = merge(
      previous?.concepts ?? [],
      keepProgram(previous?.concepts ?? [], input.concepts.map((item) => ({
        ...item,
        mappingStatus: "unbound" as const,
        origin: "interpretation" as const,
      }))),
    );
    const relations = merge(
      previous?.relations ?? [],
      keepProgram(previous?.relations ?? [], input.relations.map((item) => ({
        ...item,
        mappingStatus: "unbound" as const,
        origin: "interpretation" as const,
      }))),
    );
    unique([...concepts, ...relations], "概念与关系的稳定引用");
    if (!concepts.length)
      throw new Error("基础本体至少需要一个有依据的业务概念");
    if (new Set(concepts.map((item) => item.name)).size !== concepts.length)
      throw new Error("概念名称重复，请沿用已有概念标识");
    for (const item of [...concepts, ...relations])
      checkRefs(item.evidenceRefs);
    for (const item of relations)
      if (
        !concepts.some((c) => c.id === item.from) ||
        !concepts.some((c) => c.id === item.to)
      )
        throw new Error("关系端点必须引用已有概念标识");
    const mergeIssues = (
      prior: Issue[],
      updates: Issue[],
      allowDocument = false,
    ) => {
      const latestUser = this.memory
        .messages(context.taskId)
        .filter((message) => message.role === "user")
        .at(-1);
      for (const item of updates) {
        const existing = prior.find((entry) => entry.id === item.id);
        if (existing && existing.description !== item.description)
          throw new Error(
            "已有未决项的说明不可改写，请保留原问题并引用补充依据",
          );
        if (
          item.resolvedBy &&
          JSON.stringify(item.resolvedBy) !==
            JSON.stringify(existing?.resolvedBy)
        ) {
          if (
            !item.resolvedBy.some((ref) => {
              const entry = evidence.find((e) => e.id === ref);
              return (
                (entry?.messageId === latestUser?.id ||
                  (allowDocument &&
                    (entry?.kind === "document" ||
                      entry?.kind === "web" ||
                      entry?.kind === "knowledge" || entry?.kind === "api") &&
                    input.evidence.some((e) => e.id === ref))) &&
                !previous?.evidence.some((e) => e.id === ref)
              );
            })
          )
            throw new Error(
              "解决未决项需要本轮新增的用户原话依据（未知项也可使用已读取的新文档依据）",
            );
        }
      }
      return merge(
        prior,
        updates.map((item) => {
          const existing = prior.find((entry) => entry.id === item.id);
          return {
            ...existing,
            ...item,
            ...(existing?.resolvedBy && !item.resolvedBy
              ? { resolvedBy: existing.resolvedBy }
              : {}),
          };
        }),
      );
    };
    const unknowns = mergeIssues(
      previous?.unknowns ?? [],
      input.unknowns,
      true,
    );
    const conflicts = mergeIssues(previous?.conflicts ?? [], input.conflicts);
    const latestUserId = this.memory
      .messages(context.taskId)
      .filter((m) => m.role === "user")
      .at(-1)?.id;
    const freshUser = (ref: string) =>
      evidence.some(
        (e) =>
          e.id === ref &&
          e.kind === "user-statement" &&
          e.messageId === latestUserId &&
          !previous?.evidence.some((old) => old.id === ref),
      );
    const meaning = (item: Concept | Relation) =>
      JSON.stringify({
        name: item.name,
        description: item.description,
        ...("from" in item ? { from: item.from, to: item.to } : {}),
      });
    // A meaning only the program has stated (its placeholder, backed by its own data profile)
    // is filled in by documents, not contested; confirmed meanings still become conflicts.
    const programEvidence = new Set(
      (previous?.concepts ?? []).map((item) => (item as { programEvidenceId?: string }).programEvidenceId).filter(Boolean),
    );
    const programOnly = (item: Concept | Relation) =>
      (item as { origin?: string }).origin === "program" && item.evidenceRefs.every((ref) => programEvidence.has(ref));
    for (const after of [...concepts, ...relations]) {
      const before = [
        ...(previous?.concepts ?? []),
        ...(previous?.relations ?? []),
      ].find((item) => item.id === after.id);
      if (
        !before ||
        programOnly(before) ||
        meaning(before) === meaning(after) ||
        after.evidenceRefs.some(freshUser) ||
        !after.evidenceRefs.some((ref) =>
          evidence.some(
            (e) =>
              e.id === ref &&
              (e.kind === "document" ||
                e.kind === "web" ||
                e.kind === "knowledge" || e.kind === "api"),
          ),
        )
      )
        continue;
      const conflictId = `doc-${after.id.slice(0, 60)}-${createHash("sha256")
        .update(
          JSON.stringify({ baseVersion: current?.version, before, after }),
        )
        .digest("hex")
        .slice(0, 12)}`;
      if (!conflicts.some((item) => item.id === conflictId))
        conflicts.push({
          id: conflictId,
          description: `资料对「${before.name}」给出不同含义，需要核对。`,
          evidenceRefs: [
            ...new Set([...before.evidenceRefs, ...after.evidenceRefs]),
          ],
          retained: before,
          proposed: after,
        });
    }
    for (const item of [...unknowns, ...conflicts]) {
      if (item.resolvedBy) checkRefs(item.resolvedBy);
      if (item.evidenceRefs) checkRefs(item.evidenceRefs);
    }
    if (
      concepts.length > 60 ||
      relations.length > 120 ||
      evidence.length > 200 ||
      unknowns.length + conflicts.length > 100
    )
      throw new Error("基础定义超出当前范围，请缩小业务范围");
    const profile = this.memory.listArtifacts("profile")[0];
    const profileName = (
      profile?.content.statements as Data[] | undefined
    )?.find((item) => item.key === "company.name" && item.userEdited);
    if (profileName && profileName.text !== input.enterprise.name)
      throw new Error(
        "企业名称与人工确认的企业信息不一致，请先核对，已有信息未修改",
      );
    const baselineName = adopted
      ? content(adopted).enterprise.name
      : previous?.enterprise.name;
    const adoptedItems = adopted
      ? [...content(adopted).concepts, ...content(adopted).relations]
      : [];
    const changes = adopted
      ? [...concepts, ...relations].flatMap((item) => {
          const before =
            adoptedItems.find((entry) => entry.id === item.id) ?? null;
          return JSON.stringify(before) === JSON.stringify(item)
            ? []
            : [{ id: item.id, before, after: item }];
        })
      : [];
    return this.memory.putArtifact(
      {
        ...(current
          ? { id: current.id, expectedVersion: current.version }
          : {}),
        kind: "foundation",
        title: `${input.enterprise.name} · 基础本体`,
        status: "candidate",
        content: asData({
          ...input,
          concepts,
          relations,
          evidence,
          unknowns,
          conflicts,
          adoptedVersion: adopted?.version ?? null,
          profileRef: profile
            ? { id: profile.id, version: profile.version }
            : null,
          documentVersions: evidence
            .filter((e) => e.kind === "document")
            .reduce<Record<string, number>>(
              (versions, e) => {
                versions[e.sourceId!] = Math.max(
                  versions[e.sourceId!] ?? 0,
                  e.sourceVersion!,
                );
                return versions;
              },
              { ...previous?.documentVersions },
            ),
          method: { name: "company-foundation-ontology", digest: skillDigest },
          operation: { hash },
          enterpriseChange:
            baselineName && baselineName !== input.enterprise.name
              ? {
                  before: baselineName,
                  after: input.enterprise.name,
                  evidenceRefs: input.enterprise.evidenceRefs,
                }
              : null,
          changes,
          checks: {
            valid: true,
            version: 1,
            description: "已核对结构、关系端点与引文；业务含义仍需人工核对",
          },
          consumerReadiness: {
            objectsQueryable: false,
            reason: "尚未绑定并验证业务来源",
          },
        }),
      },
      context,
      operationId,
    );
  }

  evidence(id: string, version: number, evidenceId: string) {
    const artifact = this.memory.getArtifact(id, version);
    if (artifact.kind !== "foundation") throw new Error("需要基础本体引用");
    const evidence = content(artifact).evidence.find(
      (item) => item.id === evidenceId,
    );
    if (!evidence) throw new Error("依据不存在");
    return new FoundationDocuments(this.memory).locate(evidence);
  }

  candidate(id: string, version: number) {
    const current = this.read().current;
    if (
      !current ||
      current.id !== id ||
      current.version !== version ||
      current.status !== "candidate"
    )
      throw new Error("基础候选版本已变化，请重新查看");
    return current;
  }

  adopt(id: string, version: number, options: { automatic?: boolean } = {}): Artifact {
    const { current, adopted } = this.read();
    if (
      current?.id === id &&
      current.status === "adopted" &&
      current.content.adoptedFrom === version
    )
      return current;
    const candidate = this.candidate(id, version);
    const draft = content(candidate);
    const profile = this.memory.listArtifacts("profile")[0];
    if (
      (profile?.version ?? null) !== (draft.profileRef?.version ?? null) ||
      (profile?.id ?? null) !== (draft.profileRef?.id ?? null)
    )
      throw new Error("企业信息已变化，请重新生成并核对基础候选");
    for (const [sourceId, version] of Object.entries(
      candidate.content.documentVersions ?? {},
    )) {
      const source = this.memory.getArtifact(sourceId);
      // Deleted inputs keep already adopted historical citations, but never justify new reads.
      const retainedHistory = options.automatic && source.status === "removed" &&
        (adopted?.content.documentVersions as Data | undefined)?.[sourceId] === version;
      if (source.version !== version && !retainedHistory)
        throw new Error("候选引用的资料已更新，请重新读取并检查后再采用");
    }
    const activeRefs = new Set([
      ...draft.enterprise.evidenceRefs,
      ...[...draft.concepts, ...draft.relations].flatMap(
        (item) => item.evidenceRefs,
      ),
      ...[...draft.unknowns, ...draft.conflicts].flatMap(
        (item) => item.resolvedBy ?? item.evidenceRefs ?? [],
      ),
    ]);
    for (const e of draft.evidence.filter(
      (e) => (e.kind === "knowledge" || e.kind === "api") && activeRefs.has(e.id),
    )) {
      const source = this.memory.getArtifact(e.sourceId!);
      if (source.status !== "ready" || source.version !== e.connectionVersion)
        throw new Error("候选引用的知识来源已停用或契约变化，请重新核对");
    }
    if (!options.automatic && draft.conflicts.some((item) => !item.resolvedBy))
      throw new Error("请先解决候选中的冲突，再采用基础定义");
    const retained = new Map<string, Concept | Relation>();
    if (options.automatic) for (const conflict of draft.conflicts) {
      if (!conflict.resolvedBy && conflict.retained && !retained.has(conflict.retained.id))
        retained.set(conflict.retained.id, conflict.retained);
    }
    return this.memory.putArtifact({
      id,
      expectedVersion: version,
      kind: "foundation",
      title: candidate.title,
      status: "adopted",
      content: {
        ...candidate.content,
        concepts: draft.concepts.map(item => retained.get(item.id) ?? item),
        relations: draft.relations.map(item => retained.get(item.id) ?? item),
        adoptedFrom: version,
        adoptedAt: new Date().toISOString(),
        ...(options.automatic ? { automatic: true } : {}),
      },
    });
  }
}

import { createHash } from "node:crypto";
import { z } from "zod";
import type { MemoryStore } from "./memory.ts";
import type { Artifact, Data, DomainTool, WriteContext } from "./contracts.ts";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const text = z.string().trim().min(1).max(1500);
const refs = z.array(id).min(1).max(20);
const concept = z
  .object({ id, name: text, description: text, evidenceRefs: refs })
  .strict();
const relation = concept.extend({ from: id, to: id }).strict();
const issue = z
  .object({ id, description: text, resolvedBy: refs.optional() })
  .strict();
const proposal = z
  .object({
    baseVersion: z.number().int().nonnegative(),
    identityCorrection: z
      .object({ previousName: text, evidenceRefs: refs })
      .strict()
      .optional(),
    enterprise: z
      .object({ name: z.string().trim().min(2).max(200), evidenceRefs: refs })
      .strict(),
    concepts: z.array(concept).max(30),
    relations: z.array(relation).max(60),
    evidence: z
      .array(
        z
          .object({ id, messageId: z.string().min(1).max(200), quote: text })
          .strict(),
      )
      .max(40),
    unknowns: z.array(issue).max(30),
    conflicts: z.array(issue).max(30),
  })
  .strict();
type Evidence = {
  id: string;
  messageId: string;
  quote: string;
  kind: string;
  capturedAt: string;
  validTime: string;
};
type Concept = z.infer<typeof concept> & {
  mappingStatus: "unbound";
  origin: "interpretation";
};
type Relation = Concept & z.infer<typeof relation>;
type Issue = z.infer<typeof issue>;
interface FoundationContent {
  enterprise: z.infer<typeof proposal>["enterprise"];
  concepts: Concept[];
  relations: Relation[];
  evidence: Evidence[];
  unknowns: Issue[];
  conflicts: Issue[];
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

export const foundationTools: DomainTool[] = [
  {
    name: "foundation_read",
    description:
      "读取企业基础本体的当前版本和已采用版本。概念未绑定来源，不能查询实例。",
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
      "加载 company-foundation-ontology Skill 后，按基础版本保存有真实对话依据的候选。概念/关系/未决项按稳定 id 增量合并；证据 id 不可改写。检查只保证结构与引文可定位。",
    mutates: true,
    inputSchema: z.toJSONSchema(proposal),
  },
];

/** Shared semantic service; the UI and agent consume the same versioned artifact. */
export class FoundationService {
  private memory: MemoryStore;
  constructor(memory: MemoryStore) {
    this.memory = memory;
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

  propose(
    args: unknown,
    context: WriteContext,
    operationId: string,
    skillDigest: string,
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
    for (const key of [
      "concepts",
      "relations",
      "evidence",
      "unknowns",
      "conflicts",
    ] as const)
      unique(input[key], key);
    const evidence = [...(previous?.evidence ?? [])];
    for (const item of input.evidence) {
      const existing = evidence.find((entry) => entry.id === item.id);
      if (existing) {
        if (
          existing.messageId !== item.messageId ||
          existing.quote !== item.quote
        )
          throw new Error("已有证据不可改写，请使用新的证据标识");
        continue;
      }
      const message = this.memory.getMessage(item.messageId);
      if (
        !message ||
        message.role !== "user" ||
        message.taskId !== context.taskId ||
        !message.content.includes(item.quote)
      )
        throw new Error("证据必须引用当前任务的真实用户原话");
      evidence.push({
        ...item,
        kind: "user-statement",
        capturedAt: message.createdAt,
        validTime: "unknown",
      });
    }
    const checkRefs = (references: string[]) => {
      if (references.some((ref) => !evidence.some((entry) => entry.id === ref)))
        throw new Error("依据引用不存在；没有依据的内容请保留为未知");
    };
    checkRefs(input.enterprise.evidenceRefs);
    if (
      !input.enterprise.evidenceRefs.some((ref) =>
        evidence
          .find((entry) => entry.id === ref)!
          .quote.includes(input.enterprise.name),
      )
    )
      throw new Error("企业名称必须出现在引用的用户原话中");
    if (previous && previous.enterprise.name !== input.enterprise.name) {
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
      input.concepts.map((item) => ({
        ...item,
        mappingStatus: "unbound" as const,
        origin: "interpretation" as const,
      })),
    );
    const relations = merge(
      previous?.relations ?? [],
      input.relations.map((item) => ({
        ...item,
        mappingStatus: "unbound" as const,
        origin: "interpretation" as const,
      })),
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
    const mergeIssues = (prior: Issue[], updates: Issue[]) => {
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
                entry?.messageId === latestUser?.id &&
                !previous?.evidence.some((e) => e.id === ref)
              );
            })
          )
            throw new Error("解决未决项需要本轮新增的用户原话依据");
        }
      }
      return merge(
        prior,
        updates.map((item) => {
          const existing = prior.find((entry) => entry.id === item.id);
          return existing?.resolvedBy && !item.resolvedBy
            ? { ...item, resolvedBy: existing.resolvedBy }
            : item;
        }),
      );
    };
    const unknowns = mergeIssues(previous?.unknowns ?? [], input.unknowns);
    const conflicts = mergeIssues(previous?.conflicts ?? [], input.conflicts);
    for (const item of [...unknowns, ...conflicts])
      if (item.resolvedBy) checkRefs(item.resolvedBy);
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
            description: "已核对结构、关系端点和用户原话；业务含义仍需人工核对",
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

  adopt(id: string, version: number): Artifact {
    const { current } = this.read();
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
    if (draft.conflicts.some((item) => !item.resolvedBy))
      throw new Error("请先解决候选中的冲突，再采用基础定义");
    return this.memory.putArtifact({
      id,
      expectedVersion: version,
      kind: "foundation",
      title: candidate.title,
      status: "adopted",
      content: {
        ...candidate.content,
        adoptedFrom: version,
        adoptedAt: new Date().toISOString(),
      },
    });
  }
}

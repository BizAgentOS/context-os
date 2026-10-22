import { createHash } from "node:crypto";
import {tablePage,tableRowCount} from "../data/table-rows.ts";
import type {
  Artifact,
  Data,
  DomainTool,
  Json,
  Repository,
  WriteContext,
} from "./contracts.ts";
import { ObjectView } from "./domain-objects.ts";
import type {
  TypeDefinition,
  RelationDefinition,
  FunctionDefinition,
} from "./domain-objects.ts";

const json = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const str = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} 不能为空`);
  return value;
};
const obj = (value: unknown): Data => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("需要对象参数");
  return value as Data;
};
const arr = (value: unknown): Data[] => {
  if (!Array.isArray(value)) throw new Error("需要列表参数");
  return value.map(obj);
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const schema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string" };
const evidenceSchema = schema(
  {
    sourceId: string,
    version: { type: "integer", minimum: 1 },
    row: { type: "integer", minimum: 1 },
    hash: string,
  },
  ["sourceId", "version"],
);
const typeSchema = schema(
  {
    name: string,
    description: string,
    sourceId: string,
    idField: string,
    fields: { type: "object", additionalProperties: { type: "string" } },
  },
  ["name", "description", "sourceId", "idField", "fields"],
);
const relationSchema = schema(
  {
    name: string,
    from: string,
    to: string,
    fromField: string,
    toField: string,
  },
  ["name", "from", "to", "fromField", "toField"],
);
const functionSchema = schema(
  {
    name: string,
    implementation: { type: "string", enum: ["recovery_evidence"] },
    type: string,
    relation: string,
    field: string,
    evidence: { type: "array", items: evidenceSchema },
  },
  ["name", "implementation", "type", "relation", "field", "evidence"],
);
const outlineEvidenceSchema = {
  type: "array",
  minItems: 1,
  maxItems: 30,
  items: evidenceSchema,
};
const objectOperationsSchema = {
  type: "array",
  minItems: 1,
  maxItems: 12,
  items: schema(
    {
      op: {
        type: "string",
        enum: [
          "describe",
          "query",
          "get",
          "related",
          "evidence",
          "aggregate",
          "call",
        ],
      },
      as: string,
      type: string,
      id: string,
      input: { anyOf: [{ type: "string" }, { type: "object" }] },
      where: { type: "object" },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      relation: string,
      field: string,
      method: string,
    },
    ["op"],
  ),
};
export const domainTools: DomainTool[] = [
  {
    name: "workspace_overview",
    description: "查看企业理解、来源、本体和成果目录；详细信息按引用读取。",
    inputSchema: schema({}),
    mutates: false,
  },
  {
    name: "memory_read",
    description:
      "按 id 和可选历史版本读取成果。来源分页返回 rows 或文本片段，不默认加载全文。",
    inputSchema: schema(
      {
        id: string,
        version: { type: "integer" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      ["id"],
    ),
    mutates: false,
  },
  {
    name: "profile_update",
    description:
      "增量保存企业理解。source 必须有来源证据；suggestion 是待查证建议；user 必须提供当前任务真实用户消息的 messageId、quote，text 与 quote 完全一致。核验通过的用户原话可更正同一陈述；来源或建议不能覆盖人工编辑，冲突单独保留。",
    inputSchema: schema(
      {
        statements: {
          type: "array",
          maxItems: 30,
          items: schema(
            {
              key: string,
              text: string,
              origin: {
                type: "string",
                enum: ["source", "suggestion", "user"],
              },
              messageId: string,
              quote: string,
              evidence: { type: "array", items: evidenceSchema },
            },
            ["key", "text", "origin"],
          ),
        },
      },
      ["statements"],
    ),
    mutates: true,
  },
  {
    name: "ontology_outline",
    description:
      "根据已保存的文档或表格，保存少量有证据的概念定义和关系初稿。每个概念及关系都需引用真实来源；关系端点必须为本稿概念。初稿不创建实例、不采用模型，也不开放 API。后续接入适合的记录后再用 ontology_propose 提出映射。修改初稿需传准确 id/version。",
    inputSchema: schema(
      {
        id: string,
        version: { type: "integer", minimum: 1 },
        title: { type: "string", maxLength: 160 },
        purpose: { type: "string", maxLength: 1200 },
        concepts: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: schema(
            {
              name: { type: "string", maxLength: 80 },
              description: { type: "string", maxLength: 1200 },
              evidence: outlineEvidenceSchema,
            },
            ["name", "description", "evidence"],
          ),
        },
        relations: {
          type: "array",
          maxItems: 30,
          items: schema(
            {
              name: { type: "string", maxLength: 80 },
              from: string,
              to: string,
              description: { type: "string", maxLength: 1200 },
              evidence: outlineEvidenceSchema,
            },
            ["name", "from", "to", "description", "evidence"],
          ),
        },
      },
      ["title", "purpose", "concepts", "relations"],
    ),
    mutates: true,
  },
  {
    name: "ontology_propose",
    description:
      "围绕当前任务提出有来源依据的本体候选。types.fields 把业务属性映射到 CSV 列，idField 是来源身份列，关系字段用业务属性名或 $id。只允许已注册 recovery_evidence 回访证据方法，不能以办结判断恢复。候选必须预览并由用户采用后才正式生效。",
    inputSchema: schema(
      {
        id: string,
        version: { type: "integer" },
        title: string,
        purpose: string,
        types: { type: "array", minItems: 1, maxItems: 12, items: typeSchema },
        relations: { type: "array", maxItems: 30, items: relationSchema },
        functions: { type: "array", maxItems: 12, items: functionSchema },
        evidence: { type: "array", minItems: 1, items: evidenceSchema },
      },
      ["title", "purpose", "types", "relations", "functions", "evidence"],
    ),
    mutates: true,
  },
  {
    name: "ontology_preview",
    description:
      "检查一个准确版本的候选映射、身份和方法，保存实例预览和缺失关联。valid=true 仅代表程序检查通过，仍需用户采用。",
    inputSchema: schema({ id: string, version: { type: "integer" } }, [
      "id",
      "version",
    ]),
    mutates: true,
  },
  {
    name: "object_execute",
    description:
      '在本体对象环境组合 1–12 个受限方法；as 保存句柄，后续 input="$句柄" 跨调用复用。集合也可用返回的 {snapshot,collectionId} 引用，不可自造或改写成员及范围；实体可用 {snapshot,type,id}。describe 发现类型/方法；query(type,where,offset,limit) 精确匹配业务字段；get(type,id)；related(input,relation)；evidence(input)；aggregate(input,field?) 计数/分组；call(input,method) 调用已实现方法。分页集合可以继续查证和调用，coverage 说明 total/offset/shown/complete；部分页 aggregate 仅统计当前页，partial=true，不能称为总体；派生关系的全量未知时 total=null。正式调查固定当前任务的本体与来源版本，candidateId+candidateVersion 只能显式预览。输出带快照和来源证据。',
    inputSchema: schema(
      {
        candidateId: string,
        candidateVersion: { type: "integer" },
        operations: objectOperationsSchema,
      },
      ["operations"],
    ),
    mutates: false,
  },
  {
    name: "ontology_verify",
    description:
      "用一个具体业务问题执行真实对象查证，并把问题、步骤、结果、覆盖范围和来源版本保存到本体页。operations 与 object_execute 相同；候选需传 candidateId/candidateVersion，正式查证沿用本任务固定快照。结果始终待用户核对，不接收模型编造的答案或通过结论；部分页仍只代表当前页，办结不等于恢复。执行失败不保存验证结果。",
    inputSchema: schema(
      {
        question: { type: "string", maxLength: 1200 },
        candidateId: string,
        candidateVersion: { type: "integer", minimum: 1 },
        operations: objectOperationsSchema,
      },
      ["question", "operations"],
    ),
    mutates: true,
  },
  {
    name: "report_save",
    description:
      "保存当前对象调查的简易报告。snapshot 必须来自实际 object_execute。每项区分 fact/interpretation/unknown，事实和解释必须引用同一快照内真实来源证据；不会自动成为企业事实。候选模型生成的报告明确标记 preview。",
    inputSchema: schema(
      {
        title: string,
        question: string,
        snapshot: string,
        findings: {
          type: "array",
          minItems: 1,
          maxItems: 30,
          items: schema(
            {
              kind: {
                type: "string",
                enum: ["fact", "interpretation", "unknown"],
              },
              text: string,
              evidence: { type: "array", items: evidenceSchema },
            },
            ["kind", "text", "evidence"],
          ),
        },
        limitations: { type: "array", items: string },
      },
      ["title", "question", "snapshot", "findings"],
    ),
    mutates: true,
  },
];

export class Workspace {
  private repo: Repository;
  private context?: WriteContext;
  private objectView?: ObjectView;
  private previewViews = new Map<string, ObjectView>();
  constructor(repo: Repository, context?: WriteContext) {
    this.repo = repo;
    this.context = context;
  }
  overview(): Json {
    const summarize = (a: Artifact) => ({
      id: a.id,
      version: a.version,
      title: a.title,
      status: a.status,
      kind: a.kind,
    });
    return json({
      profile: this.repo.listArtifacts("profile")[0] ?? null,
      sources: this.repo.listArtifacts("source",{content:"compact"}).map((a) => ({
        ...summarize(a),
        columns: a.content.columns,
        total: a.content.format === "csv" ? tableRowCount(a) : undefined,
      })),
      models: this.repo.listArtifacts("ontology").map(summarize),
      outlines: this.repo.listArtifacts("ontology_outline").map(summarize),
      industryReferences: this.repo.listArtifacts("industry_reference").slice(0, 1).map((a) => ({
        ...summarize(a), enterpriseName: a.content.enterpriseName, purpose: "naming_reference",
        instructions: "用 memory_read 按引用读取所选行业术语；只辅助已有概念的名称和说明，不作为企业事实或结构创建依据。",
      })),
      verifications: this.repo.listArtifacts("verification").map((a) => ({
        ...summarize(a),
        hasNewerSources: Object.entries(
          (a.content.sourceVersions ?? {}) as Data,
        ).some(
          ([id, version]) => this.repo.getArtifact(id).version !== version,
        ),
      })),
      reports: this.repo.listArtifacts("report").map((a) => ({
        ...summarize(a),
        hasNewerSources: Object.entries(
          (a.content.sourceVersions ?? {}) as Data,
        ).some(
          ([id, version]) => this.repo.getArtifact(id).version !== version,
        ),
      })),
    });
  }
  upload(name: string, content: string): Artifact {
    if (typeof content !== "string" || Buffer.byteLength(content) > 5_000_000)
      throw new Error("文件需为 UTF-8 文本且不超过 5 MB");
    if (!/\.(csv|md|txt)$/i.test(name) || /[\\/]/.test(name))
      throw new Error("仅支持 CSV、Markdown 和 TXT 文件名");
    const format = name.toLowerCase().endsWith(".csv") ? "csv" : "text";
    const prior = this.repo
      .listArtifacts("source",{content:"compact"})
      .find((a) => a.title === name && a.content.origin !== "feishu");
    let parsed: { columns: string[]; rows: Data[] } = { columns: [], rows: [] };
    let parseError: string | undefined;
    try {
      if (format === "csv") parsed = parseCsv(content);
      else if (!content.trim())
        throw new Error("资料正文为空，请提供有内容的 Markdown/TXT 文件");
      else if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(content))
        throw new Error("资料包含无效文本或编码字符，请使用有效 UTF-8 文本");
    } catch (error) {
      parseError = (error as Error).message;
    }
    return this.repo.putArtifact({
      ...(prior ? { id: prior.id, expectedVersion: prior.version } : {}),
      kind: "source",
      title: name,
      status: parseError ? "failed" : "ready",
      content: {
        format,
        raw: content,
        hash: digest(content),
        ...parsed,
        ...(parseError ? { parseError } : {}),
      },
    });
  }
  editProfile(key: string, text: string): Artifact {
    return this.updateProfile(
      [
        {
          key: str(key, "陈述标识"),
          text: str(text, "陈述内容"),
          origin: "user",
          userEdited: true,
        },
      ],
      undefined,
      true,
    );
  }
  clearOptionalProfile(key: string): void {
    if (!["company.business", "business", "company.location", "company.website", "company.goal"].includes(key))
      throw new Error("该企业字段不能清空");
    const prior = this.repo.listArtifacts("profile")[0];
    if (!prior) return;
    const statements = (prior.content.statements ?? []) as Data[];
    if (!statements.some(item => item.key === key)) return;
    const conflicts = structuredClone((prior.content.conflicts ?? []) as Data[]);
    for (const conflict of conflicts) if (conflict.key === key && !conflict.resolved)
      conflict.resolved = { origin: "user", at: new Date().toISOString(), value: "", removed: true };
    this.repo.putArtifact({ ...prior, expectedVersion: prior.version,
      content: { ...prior.content, statements: statements.filter(item => item.key !== key), conflicts } });
  }
  adopt(id: string, version: number): Artifact {
    const model = this.repo.getArtifact(id);
    if (model.kind !== "ontology" || model.version !== version)
      throw new Error("候选版本已变化，请重新检查");
    if (
      model.status !== "candidate" ||
      !(model.content.validation as Data)?.valid ||
      !model.content.preview
    )
      throw new Error("候选需要通过检查并保存实际预览");
    const active = this.activeModel();
    const base = model.content.baseModel as Data | null;
    if (
      (active?.id ?? null) !== (base?.id ?? null) ||
      (active?.version ?? null) !== (base?.version ?? null)
    )
      throw new Error("当前采用的基础模型已变化，需要重新提出候选");
    for (const [sourceId, sourceVersion] of Object.entries(
      model.content.sourceVersions as Data,
    ))
      if (this.repo.getArtifact(sourceId).version !== sourceVersion)
        throw new Error("来源版本已变化，需要重新提出并检查候选");
    const prepared = new ObjectView(this.repo, {
      ...model,
      version: model.version + 1,
      status: "adopted",
    });
    return this.repo.putArtifact({
      id: model.id,
      expectedVersion: model.version,
      kind: "ontology",
      title: model.title,
      status: "adopted",
      content: {
        ...model.content,
        preview: prepared.preview(),
        adoptedFrom: { id: model.id, version: model.version },
      },
    });
  }
  execute(
    name: string,
    args: Record<string, unknown>,
    operationId?: string,
  ): Json {
    if (name === "workspace_overview") return this.overview();
    if (name === "memory_read") return json(this.read(args));
    if (name === "profile_update")
      return json(this.updateProfile(arr(args.statements), operationId));
    if (name === "ontology_outline")
      return json(this.outline(args, operationId));
    if (name === "ontology_propose")
      return json(this.propose(args, operationId));
    if (name === "ontology_preview")
      return json(this.preview(args, operationId));
    if (name === "object_execute")
      return this.view(args).execute(arr(args.operations));
    if (name === "ontology_verify") return json(this.verify(args, operationId));
    if (name === "report_save") return json(this.saveReport(args, operationId));
    throw new Error(`未知领域工具：${name}`);
  }
  private outline(
    args: Record<string, unknown>,
    operationId?: string,
  ): Artifact {
    const bounded = (value: unknown, label: string, limit: number) => {
      const text = str(value, label).trim();
      if (text.length > limit) throw new Error(`${label}不能超过 ${limit} 字`);
      return text;
    };
    const evidenceFor = (value: unknown) => {
      const refs = this.validateEvidence(value, true);
      if (refs.length > 30) throw new Error("每项概念或关系最多引用 30 项证据");
      for (const ref of refs) {
        const source = this.repo.getArtifact(
          String(ref.sourceId),
          Number(ref.version),
        );
        if (source.status === "failed")
          throw new Error("解析失败的来源不能作为概念依据，请先修正资料内容");
        const hasContent =
          source.content.format === "csv"
            ? Array.isArray(source.content.rows) &&
              source.content.rows.length > 0
            : source.content.format === "text" &&
              typeof source.content.raw === "string" &&
              !!source.content.raw.trim();
        if (source.status !== "ready" || !hasContent)
          throw new Error(
            "概念依据需要有实际正文或业务记录的资料，请先补充内容",
          );
      }
      return refs;
    };
    const inputConcepts = arr(args.concepts);
    if (!inputConcepts.length || inputConcepts.length > 12)
      throw new Error("概念初稿需要 1–12 个业务概念");
    const concepts = inputConcepts.map((concept) => ({
      name: bounded(concept.name, "概念名称", 80),
      description: bounded(concept.description, "概念含义", 1200),
      evidence: evidenceFor(concept.evidence),
    }));
    const names = new Set(concepts.map((concept) => concept.name));
    if (names.size !== concepts.length) throw new Error("概念名称必须唯一");
    const inputRelations = arr(args.relations ?? []);
    if (inputRelations.length > 30) throw new Error("概念关系不能超过 30 项");
    const relations = inputRelations.map((relation) => {
      const from = bounded(relation.from, "起点概念", 80);
      const to = bounded(relation.to, "终点概念", 80);
      if (!names.has(from) || !names.has(to))
        throw new Error("关系必须连接本稿中真实存在的概念");
      return {
        name: bounded(relation.name, "关系名称", 80),
        from,
        to,
        description: bounded(relation.description, "关系含义", 1200),
        evidence: evidenceFor(relation.evidence),
      };
    });
    if (
      new Set(relations.map((relation) => `${relation.from}:${relation.name}`))
        .size !== relations.length
    )
      throw new Error("同一概念的关系名称不能重复");
    const evidence = [
      ...new Map(
        [...concepts, ...relations]
          .flatMap((item) => item.evidence)
          .map((ref) => [JSON.stringify(ref), ref]),
      ).values(),
    ];
    const sourceVersions: Record<string, number> = {};
    for (const ref of evidence) {
      const id = String(ref.sourceId);
      if (
        sourceVersions[id] !== undefined &&
        sourceVersions[id] !== ref.version
      )
        throw new Error("同一概念初稿不能混用来源版本");
      sourceVersions[id] = Number(ref.version);
    }
    if ((args.id === undefined) !== (args.version === undefined))
      throw new Error("修改概念初稿需要准确的 id 和 version");
    const prior =
      args.id === undefined
        ? undefined
        : this.repo.getArtifact(
            str(args.id, "概念初稿 id"),
            Number(args.version),
          );
    if (prior && prior.kind !== "ontology_outline")
      throw new Error("只能修订概念初稿，不能覆盖其他企业记忆");
    return this.repo.putArtifact(
      {
        ...(prior
          ? { id: prior.id, expectedVersion: Number(args.version) }
          : {}),
        kind: "ontology_outline",
        title: bounded(args.title, "概念初稿名称", 160),
        status: "draft",
        content: json({
          purpose: bounded(args.purpose, "建模问题", 1200),
          concepts,
          relations,
          sourceVersions,
          evidence,
        }) as Data,
      },
      this.context,
      operationId,
    );
  }
  private verify(
    args: Record<string, unknown>,
    operationId?: string,
  ): Artifact {
    const question = str(args.question, "验证问题").trim();
    if (question.length > 1200) throw new Error("验证问题不能超过 1200 字");
    if (
      (args.candidateId === undefined) !==
      (args.candidateVersion === undefined)
    )
      throw new Error("预览验证需要准确的候选 id 和 version");
    const operations = arr(args.operations);
    const view = this.view(args);
    const result = view.execute(operations);
    const refs: Data[] = [];
    const collectEvidence = (value: Json): void => {
      if (Array.isArray(value)) {
        value.forEach(collectEvidence);
      } else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          if (key === "evidence" && Array.isArray(child))
            refs.push(...this.validateEvidence(child));
          else collectEvidence(child);
        }
      }
    };
    collectEvidence(result);
    // An empty result has no record rows; keep the actual investigated source scope.
    if (!refs.length)
      refs.push(
        ...this.validateEvidence(
          Object.entries(view.sourceVersions).map(([sourceId, version]) => ({
            sourceId,
            version,
          })),
        ),
      );
    for (const ref of refs)
      if (view.sourceVersions[String(ref.sourceId)] !== ref.version)
        throw new Error("验证证据不属于当前对象快照");
    const evidence = [
      ...new Map(refs.map((ref) => [JSON.stringify(ref), ref])).values(),
    ];
    return this.repo.putArtifact(
      {
        kind: "verification",
        title: question,
        status: "unreviewed",
        content: json({
          question,
          runNumber:
            1 +
            Math.max(
              0,
              ...this.repo
                .listArtifacts("verification")
                .filter(
                  (item) =>
                    String(item.content.question)
                      .trim()
                      .replace(/\s+/g, " ") === question.replace(/\s+/g, " "),
                )
                .map((item) => Number(item.content.runNumber) || 0),
            ),
          modelId: view.model.id,
          modelVersion: view.model.version,
          modelStatus: view.model.status,
          sourceVersions: view.sourceVersions,
          snapshot: view.snapshot,
          operations,
          result,
          evidence,
          generatedAt: new Date().toISOString(),
        }) as Data,
      },
      this.context,
      operationId,
    );
  }
  private saveReport(
    args: Record<string, unknown>,
    operationId?: string,
  ): Artifact {
    const snapshot = str(args.snapshot, "对象快照");
    const view = [this.objectView, ...this.previewViews.values()].find(
      (v) => v?.snapshot === snapshot,
    );
    if (!view) throw new Error("报告需要本次工作区已实际读取的对象快照");
    const input = arr(args.findings);
    if (!input.length || input.length > 30)
      throw new Error("报告需要 1–30 项结论");
    const findings = input.map((f) => {
      if (!["fact", "interpretation", "unknown"].includes(String(f.kind)))
        throw new Error("报告结论需区分事实、解释或未知");
      const evidence = this.validateEvidence(f.evidence, f.kind !== "unknown");
      for (const ref of evidence)
        if (view.sourceVersions[String(ref.sourceId)] !== ref.version)
          throw new Error("报告证据不属于此调查快照或来源范围");
      return { kind: f.kind, text: str(f.text, "报告内容"), evidence };
    });
    if (!findings.some((f) => f.evidence.length))
      throw new Error("报告至少需要一项实际来源证据");
    const limitations =
      args.limitations === undefined
        ? []
        : (args.limitations as unknown[]).map((value) =>
            str(value, "报告限制"),
          );
    return this.repo.putArtifact(
      {
        kind: "report",
        title: str(args.title, "报告标题"),
        status: view.model.status === "candidate" ? "preview" : "draft",
        content: json({
          question: str(args.question, "报告问题"),
          snapshot,
          model: {
            id: view.model.id,
            version: view.model.version,
            status: view.model.status,
          },
          sourceVersions: view.sourceVersions,
          findings,
          limitations,
          evidence: findings.flatMap((f) => f.evidence),
          generatedAt: new Date().toISOString(),
        }) as Data,
      },
      this.context,
      operationId,
    );
  }
  private activeModel(): Artifact | undefined {
    return this.repo
      .listArtifacts("ontology")
      .find((a) => a.status === "adopted");
  }
  private view(args: Record<string, unknown>): ObjectView {
    if (args.candidateId !== undefined) {
      const model = this.repo.getArtifact(
        str(args.candidateId, "候选 id"),
        Number(args.candidateVersion),
      );
      if (
        model.kind !== "ontology" ||
        model.status !== "candidate" ||
        !(model.content.validation as Data)?.valid ||
        !model.content.preview
      )
        throw new Error("预览对象需要已检查的候选版本");
      const key = `${model.id}:${model.version}`;
      if (!this.previewViews.has(key))
        this.previewViews.set(key, new ObjectView(this.repo, model));
      return this.previewViews.get(key)!;
    }
    if (!this.objectView) {
      const investigation = this.context
        ? this.repo.getInvestigation?.(this.context.taskId)
        : undefined;
      if (investigation) {
        const model = this.repo.getArtifact(
          investigation.modelId,
          investigation.modelVersion,
        );
        if (model.kind !== "ontology" || model.status !== "adopted")
          throw new Error("任务绑定的本体版本不可用");
        this.objectView = new ObjectView(
          this.repo,
          model,
          investigation.sourceVersions,
        );
      } else {
        const model = this.activeModel();
        if (!model) throw new Error("尚无已采用本体，可先提出候选并预览");
        const versions = {
          ...(model.content.sourceVersions as Record<string, number>),
        };
        for (const type of model.content.types as unknown as TypeDefinition[])
          versions[type.sourceId] = this.repo.getArtifact(
            type.sourceId,
          ).version;
        const view = new ObjectView(this.repo, model, versions);
        if (this.context)
          this.repo.bindInvestigation?.(this.context, {
            modelId: model.id,
            modelVersion: model.version,
            sourceVersions: view.sourceVersions,
          });
        this.objectView = view;
      }
    }
    return this.objectView;
  }
  private propose(
    args: Record<string, unknown>,
    operationId?: string,
  ): Artifact {
    const types = arr(args.types).map((t) => ({
      name: str(t.name, "类型名称"),
      description: str(t.description, "类型含义"),
      sourceId: str(t.sourceId, "来源 id"),
      idField: str(t.idField, "身份字段"),
      fields: Object.fromEntries(
        Object.entries(obj(t.fields)).map(([name, column]) => [
          name,
          str(column, "映射列"),
        ]),
      ),
    }));
    if (
      !types.length ||
      types.length > 12 ||
      new Set(types.map((t) => t.name)).size !== types.length
    )
      throw new Error("需要 1–12 个名称唯一的业务类型");
    const relations = arr(args.relations ?? []).map((r) =>
      Object.fromEntries(
        ["name", "from", "to", "fromField", "toField"].map((key) => [
          key,
          str(r[key], key),
        ]),
      ),
    ) as unknown as RelationDefinition[];
    if (
      relations.length > 30 ||
      new Set(relations.map((r) => `${r.from}:${r.name}`)).size !==
        relations.length
    )
      throw new Error("关系名称重复或超过上限");
    const functions = arr(args.functions ?? []).map((f) => {
      if (
        f.implementation !== "recovery_evidence" ||
        Object.keys(f).some(
          (k) =>
            ![
              "name",
              "implementation",
              "type",
              "relation",
              "field",
              "evidence",
            ].includes(k),
        )
      )
        throw new Error(
          "业务方法必须使用已注册实现及固定参数，不能自定义恢复条件",
        );
      return {
        name: str(f.name, "方法名称"),
        implementation: "recovery_evidence",
        type: str(f.type, "方法类型"),
        relation: str(f.relation, "回访关系"),
        field: str(f.field, "反馈字段"),
        evidence: this.validateEvidence(f.evidence, true),
      };
    }) as FunctionDefinition[];
    if (
      functions.length > 12 ||
      new Set(functions.map((f) => `${f.type}:${f.name}`)).size !==
        functions.length
    )
      throw new Error("方法名称重复或超过上限");
    const evidence = this.validateEvidence(args.evidence, true);
    const sourceVersions: Record<string, number> = {};
    for (const type of types) {
      const source = this.repo.getArtifact(type.sourceId);
      if (source.kind !== "source") throw new Error("映射必须引用真实来源");
      sourceVersions[source.id] = source.version;
    }
    for (const ref of [...evidence, ...functions.flatMap((f) => f.evidence)]) {
      if (
        sourceVersions[String(ref.sourceId)] !== undefined &&
        sourceVersions[String(ref.sourceId)] !== ref.version
      )
        throw new Error("同一本体来源不能混用不同版本");
      sourceVersions[String(ref.sourceId)] = Number(ref.version);
    }
    const prior = args.id
      ? this.repo.getArtifact(String(args.id), Number(args.version))
      : undefined;
    if (prior && (prior.kind !== "ontology" || prior.status === "adopted"))
      throw new Error("已采用模型请提出新的候选修订");
    const active = this.activeModel();
    return this.repo.putArtifact(
      {
        ...(prior
          ? { id: prior.id, expectedVersion: Number(args.version) }
          : {}),
        kind: "ontology",
        title: str(args.title, "本体名称"),
        status: "candidate",
        content: json({
          purpose: str(args.purpose, "建模目标"),
          types,
          relations,
          functions,
          evidence,
          sourceVersions,
          baseModel: active ? { id: active.id, version: active.version } : null,
        }) as Data,
      },
      this.context,
      operationId,
    );
  }
  private preview(
    args: Record<string, unknown>,
    operationId?: string,
  ): Artifact {
    // Read the exact input version; Repository handles operation replay before its version check.
    const model = this.repo.getArtifact(
      str(args.id, "候选 id"),
      Number(args.version),
    );
    if (model.kind !== "ontology" || model.status !== "candidate")
      throw new Error("需要候选的准确版本");
    let preview: Data | null = null;
    const errors: string[] = [];
    try {
      preview = new ObjectView(this.repo, {
        ...model,
        version: model.version + 1,
      }).preview();
    } catch (error) {
      errors.push((error as Error).message);
    }
    return this.repo.putArtifact(
      {
        id: model.id,
        expectedVersion: model.version,
        kind: "ontology",
        title: model.title,
        status: "candidate",
        content: {
          ...model.content,
          validation: {
            valid: !errors.length,
            errors,
            checkedAt: new Date().toISOString(),
          },
          preview,
        },
      },
      this.context,
      operationId,
    );
  }
  private read(args: Record<string, unknown>): unknown {
    let artifact = this.repo.getArtifact(
      str(args.id, "成果 id"),
      args.version === undefined ? undefined : Number(args.version),
      {evidence:"compact"},
    );
    if (artifact.kind === "change_evidence_receipt") return artifact;
    if (artifact.kind === "foundation" || artifact.kind === "engine_candidate") artifact = this.repo.getArtifact(artifact.id, artifact.version);
    if (artifact.kind !== "source") return artifact;
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
    const { raw, rows, ...rest } = artifact.content;
    if (rest.format === "csv" && artifact.status !== "failed")
      return {
        ...artifact,
        content: {
          ...rest,
          rows: tablePage(artifact,this.repo,offset,limit).rows,
          offset,
          total: tableRowCount(artifact),
          truncated: offset + limit < tableRowCount(artifact),
        },
      };
    const lines = String(raw).split("\n");
    return {
      ...artifact,
      content: {
        ...rest,
        raw: lines
          .slice(offset, offset + limit)
          .join("\n")
          .slice(0, 12000),
        offset,
        total: lines.length,
        truncated:
          offset + limit < lines.length ||
          lines.slice(offset, offset + limit).join("\n").length > 12000,
      },
    };
  }
  private validateEvidence(value: unknown, required = false): Data[] {
    const refs = value === undefined ? [] : arr(value);
    if (required && !refs.length) throw new Error("需要真实来源证据");
    return refs.map((ref) => {
      const source = this.repo.getArtifact(
        str(ref.sourceId, "来源 id"),
        Number(ref.version),
      );
      if (
        source.kind !== "source" ||
        !Number.isInteger(ref.version) ||
        Number(ref.version) < 1
      )
        throw new Error("来源证据版本无效");
      if (
        ref.row !== undefined &&
        (!Number.isInteger(ref.row) ||
          Number(ref.row) < 1 ||
          Number(ref.row) > tableRowCount(source))
      )
        throw new Error("来源证据行号不存在");
      return {
        sourceId: source.id,
        version: source.version,
        ...(ref.row === undefined ? {} : { row: ref.row }),
        hash: source.content.hash,
      };
    });
  }
  private updateProfile(
    updates: Data[],
    operationId?: string,
    trusted = false,
  ): Artifact {
    if (!updates.length || updates.length > 30)
      throw new Error("一次保存 1–30 条陈述");
    const prior = this.repo.listArtifacts("profile")[0];
    const statements = structuredClone(
      (prior?.content.statements ?? []) as Data[],
    );
    const conflicts = structuredClone(
      (prior?.content.conflicts ?? []) as Data[],
    );
    for (const update of updates) {
      const key = str(update.key, "陈述标识");
      const text = str(update.text, "陈述内容");
      if (
        !trusted &&
        !["source", "suggestion", "user"].includes(String(update.origin))
      )
        throw new Error("需要明确陈述来源");
      let userEvidence: Data | undefined;
      if (!trusted && update.origin === "user") {
        const message = this.repo.getMessage?.(
          str(update.messageId, "用户消息 id"),
        );
        const quote = str(update.quote, "用户原话引用");
        if (
          !this.context ||
          !message ||
          message.role !== "user" ||
          message.taskId !== this.context.taskId
        )
          throw new Error("需要当前任务的真实用户消息");
        if (text !== quote || !message.content.includes(quote))
          throw new Error("用户陈述必须完整匹配引用的原话，推论请保存为建议");
        userEvidence = { messageId: message.id, quote };
      }
      const evidence = this.validateEvidence(
        update.evidence,
        update.origin === "source",
      );
      const existing = statements.find((s) => s.key === key);
      const next: Data = {
        key,
        text,
        origin: trusted ? "user" : update.origin,
        evidence,
        userEdited: trusted || update.origin === "user",
        ...(userEvidence ? { userEvidence } : {}),
      };
      if (existing?.userEdited && !trusted && !userEvidence) {
        if (existing.text !== text)
          conflicts.push({
            key,
            retained: existing.text,
            proposed: text,
            evidence,
          });
        continue;
      }
      if (existing) Object.assign(existing, next);
      else statements.push(next);
      if (trusted)
        for (const conflict of conflicts)
          if (conflict.key === key && !conflict.resolved)
            conflict.resolved = {
              origin: "user",
              at: new Date().toISOString(),
              value: text,
            };
    }
    return this.repo.putArtifact(
      {
        ...(prior ? { id: prior.id, expectedVersion: prior.version } : {}),
        kind: "profile",
        title: "企业理解",
        status: "draft",
        content: { statements, conflicts },
      },
      trusted ? undefined : this.context,
      operationId,
    );
  }
}

function parseCsv(raw: string): { columns: string[]; rows: Data[] } {
  const table: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const text = raw.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((v) => v !== "")) table.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (quoted) throw new Error("CSV 引号未闭合");
  if (field || row.length) {
    row.push(field);
    table.push(row);
  }
  const columns = table.shift() ?? [];
  if (
    !columns.length ||
    columns.some((c) => !c.trim()) ||
    new Set(columns).size !== columns.length
  )
    throw new Error("CSV 需要唯一、非空列名");
  const rows = table.map((cells) => {
    if (cells.length !== columns.length) throw new Error("CSV 行列数不一致");
    return Object.fromEntries(
      columns.map((name, index) => [name, cells[index]]),
    );
  });
  return { columns, rows };
}

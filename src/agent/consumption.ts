import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type {
  Artifact,
  Data,
  DomainTool,
  Repository,
  WriteContext,
} from "./contracts.ts";
import { ObjectView, type ModelDefinition } from "./domain-objects.ts";
import { SourcePolicyService } from "./source-policy.ts";

interface Grant {
  type: string;
  fields: string[];
  relations: string[];
}
interface ConsumerDefinition {
  name: string;
  purpose: string;
  modelId: string;
  modelVersion: number;
  sourceVersions: Record<string, number>;
  grants: Grant[];
  credentialVersion?: number;
}
export interface ConsumerDataUpdate {
  consumerId: string;
  consumerVersion: number;
  modelId: string;
  modelVersion: number;
  currentSourceVersions: Record<string, number>;
  nextSourceVersions: Record<string, number>;
  changedSources: {
    sourceId: string;
    title: string;
    fromVersion: number;
    toVersion: number;
  }[];
  valid: boolean;
  errors: string[];
  preview?: Data;
}
export interface AccessLog {
  id: number;
  at: string;
  consumerId: string | null;
  consumerName: string | null;
  operation: "read" | "unsupported";
  resource: { type?: string; relation?: string };
  result: "allowed" | "denied";
  status: number;
  reason: string;
  model: { id: string; version: number } | null;
  sourceVersions: Record<string, number>;
}
interface ConsumerRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization?: string;
}
interface ConsumerResponse {
  status: number;
  body: Data;
}
class AccessError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const plain = (value: unknown): Data =>
  JSON.parse(JSON.stringify(value)) as Data;
const text = (value: unknown, label: string, max = 240): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label}需要非空文本，最多 ${max} 字符`);
  return value.trim();
};
const versionNumber = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new Error("需要明确的有效版本");
  return Number(value);
};
const list = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error(`${label}需要明确清单`);
  const result = value.map((item) => text(item, label));
  if (new Set(result).size !== result.length)
    throw new Error(`${label}不能重复`);
  return result;
};
const hash = (key: string) => createHash("sha256").update(key).digest("hex");

export const consumptionTools: DomainTool[] = [
  {
    name: "consumer_propose",
    description:
      "按已采用的本体提出只读消费授权草稿。新建时省略 id 和 expectedVersion，由系统生成；仅修改已经存在的 draft 时原样复制其 id 与真实 expectedVersion，不要自行编造标识。只保存待用户确认的名称、用途和明确范围，不签发凭据、不启用或撤销。编号 $id 也需要显式授权；关系要求起始对象编号、目标类型和两端连接字段都获授权。",
    mutates: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        purpose: { type: "string" },
        modelId: {
          type: "string",
          description:
            "已采用本体的完整 id，从企业记忆原样复制，不自行生成或修改。",
        },
        modelVersion: {
          type: "integer",
          minimum: 1,
          description:
            "与 modelId 配对的已采用本体确切 version；不是授权草稿的版本。",
        },
        id: {
          type: "string",
          description:
            "仅修改已有 draft 授权草稿时填写其真实 id；新建必须省略，由系统生成。不要填写本体 id 或自行编造。",
        },
        expectedVersion: {
          type: "integer",
          minimum: 1,
          description:
            "仅修改时与 id 一起填写该授权草稿当前真实 version；新建必须省略。",
        },
        grants: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { type: "string" },
              fields: { type: "array", minItems: 1, items: { type: "string" } },
              relations: { type: "array", items: { type: "string" } },
            },
            required: ["type", "fields", "relations"],
          },
        },
      },
      required: ["name", "purpose", "modelId", "modelVersion", "grants"],
    },
  },
];

/** The credential store is deliberately separate from model-visible enterprise memory. */
export class ConsumptionService {
  private db: DatabaseSync;
  private memory: Repository;
  private sourcePolicies: SourcePolicyService;
  private closed = false;

  constructor(directory: string, memory: Repository) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = join(directory, "consumption.sqlite");
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS credentials (key_hash TEXT PRIMARY KEY, consumer_id TEXT NOT NULL, consumer_version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS access_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, consumer_id TEXT, body TEXT NOT NULL);`);
    this.memory = memory;
    this.sourcePolicies = new SourcePolicyService(memory);
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
  list(): Artifact[] {
    return this.memory.listArtifacts("consumer");
  }
  logs(consumerId?: string, limit = 30): AccessLog[] {
    const bound = Math.min(100, Math.max(1, Math.trunc(limit) || 30));
    const rows = consumerId
      ? this.db
          .prepare(
            "SELECT id,body FROM access_logs WHERE consumer_id=? ORDER BY id DESC LIMIT ?",
          )
          .all(consumerId, bound)
      : this.db
          .prepare("SELECT id,body FROM access_logs ORDER BY id DESC LIMIT ?")
          .all(bound);
    return rows.map(
      (row) =>
        ({ ...JSON.parse(String(row.body)), id: Number(row.id) }) as AccessLog,
    );
  }

  private adoptedModel(id: unknown, version: unknown): Artifact {
    const model = this.memory.getArtifact(
      text(id, "本体标识"),
      versionNumber(version),
    );
    if (model.kind !== "ontology" || model.status !== "adopted")
      throw new Error("授权必须绑定已采用的本体版本");
    return model;
  }
  private assertNonSensitive(
    definition: ModelDefinition,
    typeName: string,
    fields: string[],
  ): void {
    const type = definition.types.find(
      (candidate) => candidate.name === typeName,
    );
    if (!type) throw new Error("本体对象类型不存在");
    const sensitiveFields = this.sourcePolicies.read(type.sourceId)?.content
      .sensitiveFields as string[] | undefined;
    for (const field of fields) {
      const column = field === "$id" ? type.idField : type.fields[field];
      if (sensitiveFields?.includes(column))
        throw new AccessError(
          403,
          "sensitive_field",
          `${typeName}.${field} 对应敏感来源列，不能对外读取`,
        );
    }
  }
  private grants(value: unknown, definition: ModelDefinition): Grant[] {
    if (!Array.isArray(value) || !value.length || value.length > 50)
      throw new Error("需要明确的可读类型与字段清单");
    const grants = value.map((item: unknown): Grant => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new Error("授权条目需要对象");
      const entry = item as Record<string, unknown>;
      const type = text(entry.type, "类型");
      const fields = list(entry.fields, "字段");
      const relations = list(entry.relations, "关系");
      const target = definition.types.find(
        (candidate) => candidate.name === type,
      );
      if (!target) throw new Error(`本体没有类型 ${type}`);
      if (!fields.length) throw new Error(`类型 ${type} 至少需要一个明确字段`);
      for (const field of fields)
        if (field !== "$id" && !Object.hasOwn(target.fields, field))
          throw new Error(`类型 ${type} 没有字段 ${field}`);
      this.assertNonSensitive(definition, type, fields);
      return { type, fields, relations };
    });
    if (new Set(grants.map((grant) => grant.type)).size !== grants.length)
      throw new Error("授权类型不能重复");
    for (const grant of grants)
      for (const name of grant.relations) {
        const relation = definition.relations.find(
          (candidate) =>
            candidate.from === grant.type && candidate.name === name,
        );
        if (!relation) throw new Error(`类型 ${grant.type} 没有关系 ${name}`);
        if (!grant.fields.includes("$id"))
          throw new Error(
            `关系 ${name} 需要明确授权起始对象编号 ${grant.type}.$id；请先与用户确认，不自动扩大范围`,
          );
        const target = grants.find(
          (candidate) => candidate.type === relation.to,
        );
        if (!target)
          throw new Error(`关系 ${name} 需要明确授权目标类型 ${relation.to}`);
        if (
          !grant.fields.includes(relation.fromField) ||
          !target.fields.includes(relation.toField)
        )
          throw new Error(
            `关系 ${name} 需要授权连接字段 ${grant.type}.${relation.fromField} 与 ${relation.to}.${relation.toField}`,
          );
      }
    return grants;
  }
  propose(
    args: Record<string, unknown>,
    context?: WriteContext,
    operationId?: string,
  ): Artifact {
    let model: Artifact;
    try {
      model = this.adoptedModel(args.modelId, args.modelVersion);
    } catch {
      const choices = this.memory
        .listArtifacts("ontology")
        .filter((artifact) => artifact.status === "adopted")
        .map(({ id, version, title }) => ({ id, version, title }));
      throw new Error(
        choices.length
          ? `本体标识或版本不可用。请原样复制已采用本体的完整引用，不要猜测或修改：${JSON.stringify(choices)}`
          : "本体标识或版本不可用。目前没有已采用本体，请先在本体页确认采用，再提出消费授权。",
      );
    }
    const definition = model.content as unknown as ModelDefinition;
    const grants = this.grants(args.grants, definition);
    const name = text(args.name, "调用方名称", 100);
    const purpose = text(args.purpose, "用途", 1000);
    const id = args.id === undefined ? undefined : text(args.id, "调用方标识");
    if (id) {
      let previous: Artifact;
      try {
        previous = this.memory.getArtifact(id);
      } catch {
        throw new Error(
          "该授权草稿不存在。新建时省略 id 和 expectedVersion，由系统生成；修改前先读取真实授权草稿。",
        );
      }
      if (previous.kind !== "consumer" || previous.status !== "draft")
        throw new Error("只能修改未启用的授权草稿；已启用范围需重新登记并确认");
      if (args.expectedVersion === undefined)
        throw new Error(
          "修改授权草稿需要同时填写真实 id 与当前 expectedVersion，请先读取草稿。",
        );
    } else if (args.expectedVersion !== undefined) {
      throw new Error(
        "新建时省略 id 和 expectedVersion，由系统生成；修改时两者必须配对。",
      );
    }
    return this.memory.putArtifact(
      {
        id,
        expectedVersion:
          args.expectedVersion === undefined
            ? undefined
            : versionNumber(args.expectedVersion),
        kind: "consumer",
        title: name,
        status: "draft",
        content: plain({
          name,
          purpose,
          modelId: model.id,
          modelVersion: model.version,
          sourceVersions: definition.sourceVersions,
          grants,
        }),
      },
      context,
      operationId,
    );
  }
  private current(id: string, version: number): Artifact {
    const consumer = this.memory.getArtifact(id);
    if (consumer.kind !== "consumer") throw new Error("调用方不存在");
    if (consumer.version !== versionNumber(version))
      throw new Error("授权版本已变化，请重新查看后确认");
    return consumer;
  }
  private matchesCredential(
    consumer: Artifact,
    credentialVersion: number,
  ): boolean {
    const definition = consumer.content as unknown as ConsumerDefinition;
    const anchor = definition.credentialVersion ?? consumer.version;
    if (anchor !== credentialVersion || !Number.isSafeInteger(anchor))
      return false;
    if (anchor === consumer.version) return true;
    if (anchor < 1 || anchor >= consumer.version) return false;
    // A data publication may carry the original credential forward, but its
    // adopted model and explicit grants must still match the activation.
    try {
      const original = this.memory.getArtifact(consumer.id, anchor);
      return (
        original.kind === "consumer" &&
        original.status === "active" &&
        original.content.modelId === definition.modelId &&
        original.content.modelVersion === definition.modelVersion &&
        JSON.stringify(original.content.grants) ===
          JSON.stringify(definition.grants)
      );
    } catch {
      return false;
    }
  }
  previewDataUpdate(id: string, version: number): ConsumerDataUpdate {
    const consumer = this.current(id, version);
    if (consumer.status !== "active")
      throw new Error("只有已启用调用方可以更新数据");
    const definition = consumer.content as unknown as ConsumerDefinition;
    const result: ConsumerDataUpdate = {
      consumerId: consumer.id,
      consumerVersion: consumer.version,
      modelId: definition.modelId,
      modelVersion: definition.modelVersion,
      currentSourceVersions: { ...definition.sourceVersions },
      nextSourceVersions: { ...definition.sourceVersions },
      changedSources: [],
      valid: false,
      errors: [],
    };
    try {
      const model = this.adoptedModel(
        definition.modelId,
        definition.modelVersion,
      );
      const modelDefinition = model.content as unknown as ModelDefinition;
      // Advance records only. Documents defining business meaning remain part
      // of the reviewed ontology version and are never silently substituted.
      for (const sourceId of new Set(
        modelDefinition.types.map((type) => type.sourceId),
      )) {
        const source = this.memory.getArtifact(sourceId);
        if (source.kind !== "source") throw new Error("本体对应的来源不可读取");
        const fromVersion = versionNumber(definition.sourceVersions[sourceId]);
        result.nextSourceVersions[sourceId] = source.version;
        if (source.version !== fromVersion)
          result.changedSources.push({
            sourceId,
            title: source.title,
            fromVersion,
            toVersion: source.version,
          });
      }
      this.grants(definition.grants, modelDefinition);
      const view = new ObjectView(
        this.memory,
        model,
        result.nextSourceVersions,
      );
      // ObjectView checks CSV schemas and unique nonempty identities. Also
      // reject malformed rows rather than publishing absent mapped values.
      for (const type of modelDefinition.types) {
        const source = this.memory.getArtifact(
          type.sourceId,
          result.nextSourceVersions[type.sourceId],
        );
        const columns = [type.idField, ...Object.values(type.fields)];
        for (const [index, row] of (source.content.rows as Data[]).entries()) {
          if (
            !row ||
            typeof row !== "object" ||
            Array.isArray(row) ||
            columns.some(
              (column) =>
                !Object.hasOwn(row, column) || row[column] === undefined,
            )
          )
            throw new Error(
              `类型 ${type.name} 的来源第 ${index + 1} 条记录缺少映射字段`,
            );
        }
      }
      result.preview = view.preview();
      result.valid = true;
    } catch (error) {
      result.errors.push(
        error instanceof Error ? error.message : "数据更新检查失败",
      );
    }
    return result;
  }
  publishDataUpdate(
    id: string,
    version: number,
    sourceVersions: unknown,
  ): Artifact {
    const consumer = this.current(id, version);
    const preview = this.previewDataUpdate(id, version);
    if (
      !sourceVersions ||
      typeof sourceVersions !== "object" ||
      Array.isArray(sourceVersions)
    )
      throw new Error("发布数据需要已预览的明确来源版本");
    const supplied = sourceVersions as Record<string, unknown>;
    if (
      Object.keys(supplied).length !==
        Object.keys(preview.nextSourceVersions).length ||
      Object.entries(preview.nextSourceVersions).some(
        ([sourceId, sourceVersion]) => supplied[sourceId] !== sourceVersion,
      )
    )
      throw new Error("来源版本已变化，请重新预览后发布");
    if (!preview.valid)
      throw new Error(`数据更新未通过检查：${preview.errors.join("；")}`);
    if (!preview.changedSources.length)
      throw new Error("当前已经使用最新数据，无需发布");
    const definition = consumer.content as unknown as ConsumerDefinition;
    const credentialVersion = definition.credentialVersion ?? consumer.version;
    const credential = this.db
      .prepare("SELECT consumer_version FROM credentials WHERE consumer_id=?")
      .get(consumer.id);
    if (
      !credential ||
      !this.matchesCredential(consumer, Number(credential.consumer_version))
    )
      throw new Error("调用方凭据不可用，不能发布数据");
    // One memory write is atomic; failure leaves both the previous records and
    // the original API key usable. Publication does not touch the key store.
    return this.memory.putArtifact({
      id,
      expectedVersion: version,
      kind: "consumer",
      title: consumer.title,
      status: "active",
      content: {
        ...consumer.content,
        credentialVersion,
        sourceVersions: preview.nextSourceVersions,
        dataPublishedAt: new Date().toISOString(),
      },
    });
  }
  activate(
    id: string,
    version: number,
  ): { consumer: Artifact; apiKey: string } {
    const draft = this.current(id, version);
    if (draft.status !== "draft") throw new Error("只有授权草稿可以启用");
    const definition = draft.content as unknown as ConsumerDefinition;
    const model = this.adoptedModel(
      definition.modelId,
      definition.modelVersion,
    );
    this.grants(definition.grants, model.content as unknown as ModelDefinition);
    // Loading the fixed version validates that every source dependency is available.
    new ObjectView(this.memory, model, definition.sourceVersions);
    const apiKey = `de_consumer_${randomBytes(32).toString("base64url")}`;
    const keyHash = hash(apiKey);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // A previous interrupted activation can leave an unpublished digest. Retrying a draft replaces it.
      this.db
        .prepare("DELETE FROM credentials WHERE consumer_id=?")
        .run(draft.id);
      this.db
        .prepare("INSERT INTO credentials VALUES (?,?,?)")
        .run(keyHash, draft.id, draft.version + 1);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* SQLite may already have rolled back the failed commit. */
      }
      throw error;
    }
    try {
      // The committed digest remains unusable until the reviewed memory version becomes active.
      const consumer = this.memory.putArtifact({
        id: draft.id,
        expectedVersion: draft.version,
        kind: "consumer",
        title: draft.title,
        status: "active",
        content: { ...draft.content, activatedAt: new Date().toISOString() },
      });
      return { consumer, apiKey };
    } catch (error) {
      try {
        this.db
          .prepare("DELETE FROM credentials WHERE key_hash=?")
          .run(keyHash);
      } catch {
        /* The draft still denies this digest; the next activation removes any orphan. */
      }
      throw error;
    }
  }
  revoke(id: string, version: number): Artifact {
    const consumer = this.current(id, version);
    if (consumer.status !== "active")
      throw new Error("只有已启用调用方可以撤销");
    // Auth checks this latest artifact on every call; no process-local permission cache exists.
    return this.memory.putArtifact({
      id,
      expectedVersion: version,
      kind: "consumer",
      title: consumer.title,
      status: "revoked",
      content: { ...consumer.content, revokedAt: new Date().toISOString() },
    });
  }

  handle(request: ConsumerRequest): ConsumerResponse {
    let consumer: Artifact | null = null;
    let definition: ConsumerDefinition | null = null;
    const resource: AccessLog["resource"] = {};
    let response: ConsumerResponse;
    let reason = "ok";
    try {
      const match = /^Bearer (de_consumer_[A-Za-z0-9_-]{43})$/.exec(
        request.authorization ?? "",
      );
      const credential = match
        ? this.db
            .prepare(
              "SELECT consumer_id,consumer_version FROM credentials WHERE key_hash=?",
            )
            .get(hash(match[1]))
        : undefined;
      if (credential) {
        try {
          consumer = this.memory.getArtifact(String(credential.consumer_id));
        } catch {
          /* Missing memory fails closed. */
        }
      }
      if (
        !consumer ||
        consumer.kind !== "consumer" ||
        consumer.status !== "active" ||
        !this.matchesCredential(consumer, Number(credential?.consumer_version))
      )
        throw new AccessError(
          401,
          "invalid_credential",
          "调用凭据无效或已停用",
        );
      definition = consumer.content as unknown as ConsumerDefinition;
      if (request.method !== "GET")
        throw new AccessError(405, "method_not_allowed", "仅支持只读查询");
      if (request.path !== "/v1/objects" && request.path !== "/v1/schema")
        throw new AccessError(404, "unsupported_resource", "消费接口不存在");
      const allowed = new Set(
        request.path === "/v1/schema"
          ? ["dataVersion"]
          : [
              "type",
              "id",
              "fields",
              "relation",
              "offset",
              "limit",
              "dataVersion",
            ],
      );
      for (const key of request.query.keys())
        if (!allowed.has(key) || request.query.getAll(key).length !== 1)
          throw new AccessError(
            403,
            "unsupported_parameter",
            "请求包含未开放的查询参数",
          );
      const dataVersion = request.query.get("dataVersion");
      if (
        dataVersion !== null &&
        (!/^[1-9]\d*$/.test(dataVersion) ||
          !Number.isSafeInteger(Number(dataVersion)))
      )
        throw new AccessError(400, "invalid_data_version", "数据版本无效");
      if (dataVersion !== null && Number(dataVersion) !== consumer.version)
        throw new AccessError(
          409,
          "data_version_changed",
          "数据已发布新版本，请重新读取结构后再查询",
        );
      if (request.path === "/v1/schema") {
        const model = this.adoptedModel(
          definition.modelId,
          definition.modelVersion,
        );
        const modelDefinition = model.content as unknown as ModelDefinition;
        try {
          this.grants(definition.grants, modelDefinition);
        } catch {
          throw new AccessError(
            403,
            "scope_unavailable",
            "当前授权范围受使用限制，请联系管理员调整",
          );
        }
        response = {
          status: 200,
          body: plain({
            name: definition.name,
            purpose: definition.purpose,
            model: { id: model.id, version: model.version },
            dataVersion: consumer.version,
            types: definition.grants.map((grant) => {
              const type = modelDefinition.types.find(
                (candidate) => candidate.name === grant.type,
              )!;
              return {
                name: type.name,
                description: type.description,
                fields: grant.fields.map((name) => ({ name })),
                relations: grant.relations.map((name) => {
                  const relation = modelDefinition.relations.find(
                    (candidate) =>
                      candidate.from === grant.type && candidate.name === name,
                  )!;
                  return { name, to: relation.to };
                }),
              };
            }),
          }),
        };
      } else {
        const type = request.query.get("type") ?? "";
        const grant = definition.grants.find(
          (candidate) => candidate.type === type,
        );
        if (!grant)
          throw new AccessError(403, "type_denied", "没有此对象类型的读取权限");
        resource.type = grant.type;
        const id = request.query.get("id");
        if (id !== null && !grant.fields.includes("$id"))
          throw new AccessError(403, "identity_denied", "对象编号未获授权");
        const model = this.adoptedModel(
          definition.modelId,
          definition.modelVersion,
        );
        const modelDefinition = model.content as unknown as ModelDefinition;
        if (id !== null)
          this.assertNonSensitive(modelDefinition, type, ["$id"]);
        const relationName = request.query.get("relation");
        let outputGrant = grant;
        if (relationName !== null) {
          if (!id || !grant.relations.includes(relationName))
            throw new AccessError(
              403,
              "relation_denied",
              "关系未获授权或缺少起始对象编号",
            );
          const relation = modelDefinition.relations.find(
            (candidate) =>
              candidate.from === type && candidate.name === relationName,
          );
          const target = definition.grants.find(
            (candidate) => candidate.type === relation?.to,
          );
          if (
            !relation ||
            !target ||
            !grant.fields.includes(relation.fromField) ||
            !target.fields.includes(relation.toField)
          )
            throw new AccessError(
              403,
              "relation_denied",
              "关系的目标或连接字段未获授权",
            );
          resource.relation = relation.name;
          this.assertNonSensitive(modelDefinition, relation.from, [
            relation.fromField,
          ]);
          this.assertNonSensitive(modelDefinition, relation.to, [
            relation.toField,
          ]);
          outputGrant = target;
        }
        const fields = request.query.has("fields")
          ? request.query.get("fields")!.split(",")
          : outputGrant.fields;
        if (
          !fields.length ||
          fields.some((field) => !outputGrant.fields.includes(field)) ||
          new Set(fields).size !== fields.length
        )
          throw new AccessError(403, "field_denied", "请求字段未获授权");
        // Source classification is current even when the consumer's data version is fixed.
        this.assertNonSensitive(modelDefinition, outputGrant.type, fields);
        const integer = (name: string, fallback: number, max: number) => {
          const value = request.query.get(name);
          if (value === null) return fallback;
          if (
            !/^\d+$/.test(value) ||
            !Number.isSafeInteger(Number(value)) ||
            Number(value) > max ||
            (name === "limit" && Number(value) < 1)
          )
            throw new AccessError(400, "invalid_page", "分页参数无效");
          return Number(value);
        };
        const offset = integer("offset", 0, Number.MAX_SAFE_INTEGER);
        const limit = integer("limit", 20, 100);
        const view = new ObjectView(
          this.memory,
          model,
          definition.sourceVersions,
        );
        const output = view.execute(
          relationName === null
            ? [
                {
                  op: "query",
                  type,
                  ...(id === null ? {} : { where: { $id: id } }),
                  offset,
                  limit,
                  as: "objects",
                },
              ]
            : [
                {
                  op: "query",
                  type,
                  where: { $id: id },
                  limit: 1,
                  as: "origin",
                },
                {
                  op: "related",
                  input: "$origin",
                  relation: relationName,
                  as: "objects",
                },
              ],
        );
        const collection = (output.results as Data).objects as Data;
        const pageItems =
          relationName === null
            ? (collection.items as Data[])
            : (collection.items as Data[]).slice(offset, offset + limit);
        const items = pageItems.map((entity) => ({
          type: entity.type,
          ...(fields.includes("$id") ? { id: entity.id } : {}),
          fields: Object.fromEntries(
            fields
              .filter((field) => field !== "$id")
              .map((field) => [field, (entity.fields as Data)[field]]),
          ),
        }));
        const usedTypes = new Set([type, outputGrant.type]);
        const sourceVersions = Object.fromEntries(
          view.definition.types
            .filter((candidate) => usedTypes.has(candidate.name))
            .map((candidate) => [
              candidate.sourceId,
              view.sourceVersions[candidate.sourceId],
            ]),
        );
        const hasMore = offset + items.length < Number(collection.total);
        response = {
          status: 200,
          body: plain({
            items,
            page: {
              offset,
              limit,
              hasMore,
              nextOffset: hasMore ? offset + items.length : null,
            },
            model: { id: model.id, version: model.version },
            dataVersion: consumer.version,
            sourceVersions,
          }),
        };
      }
    } catch (error) {
      const known =
        error instanceof AccessError
          ? error
          : new AccessError(
              409,
              "memory_unavailable",
              "授权对应的企业记忆暂不可读取",
            );
      reason = known.code;
      response = {
        status: known.status,
        body: { error: known.message, code: known.code },
      };
    }
    const log = {
      at: new Date().toISOString(),
      consumerId: consumer?.id ?? null,
      consumerName: consumer?.title ?? null,
      operation: request.method === "GET" ? "read" : "unsupported",
      resource,
      result: response.status === 200 ? "allowed" : "denied",
      status: response.status,
      reason,
      model: definition
        ? { id: definition.modelId, version: definition.modelVersion }
        : null,
      sourceVersions: definition?.sourceVersions ?? {},
    };
    // Only server-selected metadata is logged. Credentials, request bodies, arbitrary query values and returned rows never enter the audit trail.
    this.db
      .prepare("INSERT INTO access_logs(consumer_id,body) VALUES (?,?)")
      .run(log.consumerId, JSON.stringify(log));
    return response;
  }
}

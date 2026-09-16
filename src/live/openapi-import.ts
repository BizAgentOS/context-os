import { createHash, randomUUID } from "node:crypto";
import { parseDocument } from "yaml";
import { z } from "zod";
import {
  SourceConnections,
  type Capability,
  type Connection,
} from "./sources.ts";
import { fetchSource, sourceUrl } from "./source-http.ts";

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as ObjectValue) : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const string = (v: unknown) => (typeof v === "string" ? v : "");
const short = (v: unknown, max = 200) => string(v).slice(0, max);
const label = z.string().trim().min(1).max(200);
const selectionSchema = z
  .object({
    id: z.string().min(1).max(500),
    itemsPath: z.string().max(200),
    totalPath: z.string().max(200).optional(),
    fields: z.array(label).min(1).max(100),
    idField: label,
    idType: z.enum(["string", "number"]),
    limitParam: label,
    offsetParam: label,
  })
  .strict();
const authSchema = z
  .object({
    type: z.enum(["none", "bearer", "apiKey", "basic"]),
    headerName: z.string().max(100).optional(),
    secret: z.string().max(4000).optional(),
  })
  .strict();
type AuthOption = {
  type: "none" | "bearer" | "apiKey" | "basic";
  headerName?: string;
};
export type ImportOperation = {
  id: string;
  method: string;
  path: string;
  name: string;
  summary: string;
  supported: boolean;
  reason?: string;
  auth: AuthOption[];
  defaults?: Omit<z.infer<typeof selectionSchema>, "id">;
  pagination?: { limitDeclared: boolean; offsetDeclared: boolean };
  fieldTypes: Record<string, string>;
  filters: Record<string, string>;
};
type Catalog = {
  draftId: string;
  title: string;
  version: string;
  format: string;
  baseUrl: string;
  authOptions: AuthOption[];
  operations: ImportOperation[];
};
type Draft = { catalog: Catalog; digest: string; expires: number };
type Receipt = {
  config: Connection;
  expires: number;
  saving?: ReturnType<SourceConnections["connect"]>;
};
const TTL = 30 * 60 * 1000;

/** No external references are fetched, and cyclic references never expand indefinitely. */
function resolver(document: ObjectValue) {
  const resolvedRefs = new Map<string, ObjectValue>();
  let expansions = 0;
  const spend = (cost = 1) => {
    expansions += cost;
    if (expansions > 50000) throw new Error("引用展开超过预算，请简化文档");
  };
  function resolve(
    value: unknown,
    seen = new Set<string>(),
    depth = 0,
  ): ObjectValue {
    if (++expansions > 50000) throw new Error("引用展开超过预算，请简化文档");
    if (depth > 20) throw new Error("引用层级过深");
    let result = object(value);
    if (result.$ref) {
      const ref = string(result.$ref);
      if (!ref.startsWith("#/"))
        throw new Error("暂不支持外部 $ref，请导入已合并的文档");
      if (seen.has(ref)) throw new Error("不支持循环引用的记录结构");
      const cached = resolvedRefs.get(ref);
      if (cached) return cached;
      const next = new Set(seen).add(ref);
      let target: unknown = document;
      for (const encoded of ref.slice(2).split("/")) {
        const key = decodeURIComponent(encoded)
          .replaceAll("~1", "/")
          .replaceAll("~0", "~");
        const parent = object(target);
        if (!Object.hasOwn(parent, key)) throw new Error("文档引用不存在");
        target = parent[key];
      }
      result = resolve(target, next, depth + 1);
      resolvedRefs.set(ref, result);
      return result;
    }
    if (result.oneOf || result.anyOf)
      throw new Error("暂不支持多种可选返回结构");
    if (result.allOf) {
      const properties: ObjectValue = { ...object(result.properties) };
      for (const part of array(result.allOf)) {
        const resolved = resolve(part, new Set(seen), depth + 1);
        for (const [key, property] of Object.entries(
          object(resolved.properties),
        )) {
          spend();
          if (Object.hasOwn(properties, key) && properties[key] !== property) {
            const left = JSON.stringify(properties[key]),
              right = JSON.stringify(property);
            spend(Math.ceil((left.length + right.length) / 32));
            if (left !== right) throw new Error("组合结构中字段定义不一致");
          }
          properties[key] = property;
        }
      }
      result = { ...result, allOf: undefined, type: "object", properties };
    }
    return result;
  }
  return resolve;
}

function parseText(text: string): ObjectValue {
  if (Buffer.byteLength(text) > 2_000_000) throw new Error("文档最多 2 MB");
  try {
    const parsed = parseDocument(text, {
      uniqueKeys: true,
      prettyErrors: false,
      logLevel: "silent",
    });
    if (parsed.errors.length) throw new Error("invalid");
    const document: unknown = parsed.toJS({ maxAliasCount: 20 });
    let nodes = 0;
    const walk = (value: unknown, depth: number, parents: Set<unknown>) => {
      if (++nodes > 50000 || depth > 40 || parents.has(value))
        throw new Error("too complex");
      if (value && typeof value === "object") {
        const next = new Set(parents).add(value);
        for (const child of Object.values(value)) walk(child, depth + 1, next);
      }
    };
    walk(document, 0, new Set());
    if (Buffer.byteLength(JSON.stringify(document)) > 2_000_000)
      throw new Error("expanded size");
    return object(document);
  } catch {
    throw new Error(
      "无法解析文档：请提供有效的 JSON/YAML，检查重复字段、引用或文档大小",
    );
  }
}

function serverUrl(document: ObjectValue, documentUrl?: string) {
  if (document.swagger === "2.0") {
    if (!document.host)
      return documentUrl
        ? new URL(short(document.basePath, 500) || "/", documentUrl).href
        : "";
    return `${array(document.schemes)[0] === "http" ? "http" : "https"}://${string(document.host)}${string(document.basePath)}`;
  }
  const server = object(array(document.servers)[0]);
  let url = string(server.url);
  url = url.replace(/\{([^}]+)\}/g, (_all, key: string) =>
    string(object(object(server.variables)[key]).default),
  );
  if (!url) return documentUrl ? new URL("/", documentUrl).href : "";
  try {
    return new URL(url, documentUrl).href;
  } catch {
    return "";
  }
}

function authOptions(
  document: ObjectValue,
  operation: ObjectValue,
  resolve: ReturnType<typeof resolver>,
): AuthOption[] {
  const security = operation.security ?? document.security;
  if (security === undefined || (Array.isArray(security) && !security.length))
    return [{ type: "none" }];
  if (!Array.isArray(security)) throw new Error("认证声明需要 security 数组");
  const schemes =
    document.swagger === "2.0"
      ? object(document.securityDefinitions)
      : object(object(document.components).securitySchemes);
  const options: AuthOption[] = [];
  for (const choice of security) {
    const keys = Object.keys(object(choice));
    if (!keys.length) {
      options.push({ type: "none" });
      continue;
    }
    if (keys.length !== 1) continue;
    const scheme = resolve(schemes[keys[0]]);
    if (
      scheme.type === "apiKey" &&
      scheme.in === "header" &&
      /^[A-Za-z0-9-]{1,100}$/.test(string(scheme.name))
    )
      options.push({ type: "apiKey", headerName: string(scheme.name) });
    if (
      scheme.type === "basic" ||
      (scheme.type === "http" &&
        string(scheme.scheme).toLowerCase() === "basic")
    )
      options.push({ type: "basic" });
    if (
      scheme.type === "http" &&
      string(scheme.scheme).toLowerCase() === "bearer"
    )
      options.push({ type: "bearer" });
  }
  return options;
}

function describe(
  document: ObjectValue,
  documentUrl?: string,
): Omit<Catalog, "draftId"> {
  const format =
    document.swagger === "2.0"
      ? "Swagger 2.0"
      : /^3\.[01]\.\d+$/.test(string(document.openapi))
        ? `OpenAPI ${document.openapi}`
        : "";
  if (!format)
    throw new Error(
      "请导入 Swagger 2.0 或 OpenAPI 3.0/3.1 文档，不能使用 Swagger UI 网页地址",
    );
  const resolve = resolver(document),
    operations: ImportOperation[] = [];
  const baseUrl = serverUrl(document, documentUrl);
  const names = new Set<string>();
  for (const [path, value] of Object.entries(object(document.paths))) {
    if (!path.startsWith("/")) continue;
    const pathItem = object(value);
    for (const method of [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "head",
      "options",
      "trace",
    ]) {
      if (!Object.hasOwn(pathItem, method)) continue;
      if (operations.length >= 200)
        throw new Error("单次文档最多 200 个接口，请拆分后导入");
      const op = object(pathItem[method]);
      const baseName = (short(op.operationId, 120) || `${method}_${path}`)
        .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, "_")
        .slice(0, 120);
      let name = baseName,
        suffix = 2;
      while (names.has(name)) name = `${baseName}_${suffix++}`;
      names.add(name);
      const entry: ImportOperation = {
        id: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        name,
        summary: short(op.summary || op.operationId || path),
        supported: false,
        auth: [],
        fieldTypes: {},
        filters: {},
      };
      operations.push(entry);
      try {
        if (method !== "get")
          throw new Error("仅导入只读 GET；写入和删除接口不接入");
        if (!/^\/(?!\/)[^?#\\{}]{0,450}$/.test(path))
          throw new Error("暂不支持含路径参数的接口");
        if (pathItem.$ref) throw new Error("请将路径引用合并到 paths 后导入");
        if (op.requestBody) throw new Error("暂不支持带请求体的 GET");
        if (op.servers || pathItem.servers || op.schemes)
          throw new Error("接口覆盖了服务地址，请单独导入此服务的文档");
        entry.auth = authOptions(document, op, resolve);
        if (!entry.auth.length)
          throw new Error(
            "暂不支持此认证方式（OAuth、Cookie、查询密钥或组合认证）",
          );
        const params = [
          ...array(pathItem.parameters),
          ...array(op.parameters),
        ].map((p) => resolve(p));
        const query = params.filter((p) => p.in === "query");
        const limitParam = query.find((p) =>
          /^(limit|_limit|\$top|pageSize|page_size|size)$/.test(string(p.name)),
        )?.name;
        const offsetParam = query.find((p) =>
          /^(offset|_offset|\$skip|skip)$/.test(string(p.name)),
        )?.name;
        if (
          !offsetParam &&
          query.some((p) =>
            /^(page|pageNum|pageNumber|page_no|pageIndex|cursor|pageToken|nextToken)$/i.test(
              string(p.name),
            ),
          )
        )
          throw new Error(
            "页码或游标分页暂不支持，请提供 limit/offset 列表接口",
          );
        entry.pagination = {
          limitDeclared: Boolean(limitParam),
          offsetDeclared: Boolean(offsetParam),
        };
        if (
          params.some(
            (p) =>
              p.required &&
              ![String(limitParam), String(offsetParam)].includes(
                string(p.name),
              ),
          )
        )
          throw new Error("含额外必填参数，请先提供无需业务参数的列表接口");
        const responses = object(op.responses);
        const response = resolve(
          responses["200"] ??
            responses[
              Object.keys(responses).find((k) => /^2\d\d$/.test(k)) ?? ""
            ],
        );
        const content = object(response.content);
        const mediaKey = Object.keys(content).find(
          (k) =>
            k === "application/json" || /^application\/[^;]+\+json$/.test(k),
        );
        const schema =
          document.swagger === "2.0"
            ? response.schema
            : object(content[mediaKey ?? ""]).schema;
        const lists: { path: string; schema: ObjectValue }[] = [];
        const totals: string[] = [];
        const visit = (value: unknown, path: string, depth: number) => {
          const current = resolve(value);
          if (current.type === "array") {
            lists.push({ path, schema: resolve(current.items) });
            return;
          }
          if (depth >= 4) return;
          for (const [key, child] of Object.entries(
            object(current.properties),
          )) {
            if (key.includes(".")) continue;
            const next = path ? `${path}.${key}` : key;
            if (
              /^(total|totalCount|total_count)$/.test(key) &&
              ["integer", "number"].includes(string(resolve(child).type))
            )
              totals.push(next);
            else visit(child, next, depth + 1);
          }
        };
        visit(schema, "", 0);
        if (lists.length !== 1)
          throw new Error(
            "返回值需要唯一的记录数组；对象详情或多个数组暂不支持",
          );
        const list = lists[0];
        for (const [field, definition] of Object.entries(
          object(list.schema.properties),
        )) {
          const property = resolve(definition);
          const type = Array.isArray(property.type)
            ? property.type.filter((t) => t !== "null")[0]
            : property.type;
          if (["string", "number", "integer", "boolean"].includes(string(type)))
            entry.fieldTypes[field] =
              type === "integer" ? "number" : String(type);
        }
        const fields = Object.keys(entry.fieldTypes);
        if (!fields.length || fields.length > 100)
          throw new Error("记录需包含 1–100 个标量字段");
        const identities = fields.filter((f) =>
          ["string", "number"].includes(entry.fieldTypes[f]),
        );
        const idField =
          identities.find((f) => /^id$/i.test(f)) ??
          identities.find((f) => /(_id|Id|ID)$/.test(f)) ??
          identities[0];
        if (!idField) throw new Error("缺少字符串或数字身份字段");
        for (const parameter of query) {
          const field = string(parameter.name);
          if (
            fields.includes(field) &&
            ![limitParam, offsetParam].includes(field)
          )
            entry.filters[field] = field;
        }
        entry.defaults = {
          fields,
          idField,
          idType: entry.fieldTypes[idField] as "string" | "number",
          itemsPath: list.path,
          ...(totals.length === 1 ? { totalPath: totals[0] } : {}),
          limitParam: String(limitParam || "limit"),
          offsetParam: String(offsetParam || "offset"),
        };
        entry.supported = true;
      } catch (error) {
        entry.reason =
          error instanceof Error
            ? error.message.slice(0, 180)
            : "无法识别此接口结构";
      }
    }
  }
  if (!operations.length) throw new Error("文档 paths 中没有接口");
  return {
    title: short(object(document.info).title) || "API 来源",
    version: short(object(document.info).version, 100),
    format,
    baseUrl,
    operations,
    authOptions: [
      ...new Map(
        operations
          .filter((o) => o.supported)
          .flatMap((o) => o.auth)
          .map((a) => [JSON.stringify(a), a]),
      ).values(),
    ],
  };
}

/** Admin-only, transient discovery/test state. Only commit persists the tested connection. */
export class OpenApiImports {
  private sources: SourceConnections;
  private drafts = new Map<string, Draft>();
  private receipts = new Map<string, Receipt>();
  private timer: ReturnType<typeof setInterval>;
  constructor(sources: SourceConnections) {
    this.sources = sources;
    this.timer = setInterval(() => this.expire(), 60000).unref();
  }
  close() {
    clearInterval(this.timer);
    this.drafts.clear();
    this.receipts.clear();
  }
  private expire() {
    for (const [id, item] of this.drafts)
      if (item.expires <= Date.now()) this.drafts.delete(id);
    for (const [id, item] of this.receipts)
      if (item.expires <= Date.now()) this.receipts.delete(id);
  }
  async parse(input: unknown): Promise<Catalog> {
    const request = z
      .object({
        url: z.string().max(2000).optional(),
        text: z.string().max(2_000_000).optional(),
      })
      .strict()
      .parse(input);
    if (Boolean(request.url) === Boolean(request.text))
      throw new Error("请选择文档 URL 或 JSON/YAML 内容");
    this.expire();
    if (this.drafts.size >= 20)
      throw new Error("导入草稿过多，请等待旧草稿过期后重试");
    let text = request.text ?? "";
    if (request.url) {
      const url = sourceUrl(request.url);
      try {
        const response = await fetchSource(url, {
          headers: {
            Accept: "application/json, application/yaml, text/yaml, text/plain",
          },
        });
        if (!response.ok) throw new Error("failed");
        text = await response.text();
      } catch {
        throw new Error(
          "文档读取失败，请检查地址；受保护的文档可下载后上传或粘贴",
        );
      }
    }
    const document = parseText(text);
    const catalog = {
      draftId: randomUUID(),
      ...describe(document, request.url),
    };
    this.drafts.set(catalog.draftId, {
      catalog,
      digest: createHash("sha256")
        .update(JSON.stringify(document))
        .digest("hex"),
      expires: Date.now() + TTL,
    });
    return structuredClone(catalog);
  }
  async preview(input: unknown) {
    const request = z
      .object({
        draftId: z.string().uuid(),
        name: label,
        baseUrl: z.string().url().max(2000),
        auth: authSchema,
        operations: z.array(selectionSchema).min(1).max(30),
      })
      .strict()
      .parse(input);
    this.expire();
    const draft = this.drafts.get(request.draftId);
    if (!draft) throw new Error("导入草稿已过期，请重新解析");
    if (this.receipts.size >= 20)
      throw new Error("测试记录过多，请等待旧记录过期后重试");
    if (
      new Set(request.operations.map((o) => o.id)).size !==
      request.operations.length
    )
      throw new Error("请勿重复选择接口");
    const baseUrl = sourceUrl(request.baseUrl);
    const capabilities = request.operations.map((selected) => {
      const op = draft.catalog.operations.find((o) => o.id === selected.id);
      if (!op?.supported || !op.defaults) throw new Error("选择的接口不能导入");
      if (
        !op.auth.some(
          (a) =>
            a.type === "none" ||
            (a.type === request.auth.type &&
              (a.type !== "apiKey" ||
                a.headerName?.toLowerCase() ===
                  request.auth.headerName?.toLowerCase())),
        )
      )
        throw new Error(
          "认证方式与所选接口不一致，请分别导入使用不同认证的接口",
        );
      if (
        selected.fields.some((f) => !Object.hasOwn(op.fieldTypes, f)) ||
        !selected.fields.includes(selected.idField) ||
        selected.idType !== op.fieldTypes[selected.idField]
      )
        throw new Error("身份字段或返回字段与文档不一致");
      if (
        selected.itemsPath !== op.defaults.itemsPath ||
        selected.totalPath !== op.defaults.totalPath ||
        (op.pagination?.limitDeclared &&
          selected.limitParam !== op.defaults.limitParam) ||
        (op.pagination?.offsetDeclared &&
          selected.offsetParam !== op.defaults.offsetParam)
      )
        throw new Error("返回路径或分页参数与文档不一致，请修正文档后重试");
      if (
        ![selected.limitParam, selected.offsetParam].every((p) =>
          /^[A-Za-z_$][A-Za-z0-9_.$-]{0,99}$/.test(p),
        )
      )
        throw new Error(
          "分页参数名只支持字母、数字、下划线、点、连字符和 $，且不能以数字开头",
        );
      const { id: _id, ...mapping } = selected;
      const path = baseUrl.pathname.replace(/\/$/, "") + op.path;
      const cap: Capability = {
        ...mapping,
        name: op.name,
        path,
        contentKind: "records",
        filters: Object.fromEntries(
          Object.entries(op.filters).filter(([field]) =>
            selected.fields.includes(field),
          ),
        ),
      };
      return cap;
    });
    const { secret, ...auth } = request.auth;
    const config: Connection = {
      name: request.name,
      protocol: "http",
      url: baseUrl.origin,
      auth,
      ...(secret ? { token: secret } : {}),
      capabilities,
      importInfo: {
        title: draft.catalog.title,
        version: draft.catalog.version,
        format: draft.catalog.format,
        digest: draft.digest,
        operationIds: request.operations.map((o) => o.id),
      },
    };
    const results = [];
    for (const cap of capabilities) {
      const sample = await this.sources.preview(config, cap.name);
      if (!sample.items.length)
        throw new Error(
          `接口 ${cap.name} 未返回记录，暂时无法验证身份和字段；补充数据后重试`,
        );
      results.push({
        name: cap.name,
        path: cap.path,
        fields: cap.fields,
        sample,
      });
    }
    const receiptId = randomUUID();
    this.receipts.set(receiptId, { config, expires: Date.now() + TTL });
    return {
      receiptId,
      expiresAt: new Date(Date.now() + TTL).toISOString(),
      results,
    };
  }
  async commit(input: unknown) {
    const { receiptId } = z
      .object({ receiptId: z.string().uuid() })
      .strict()
      .parse(input);
    this.expire();
    const receipt = this.receipts.get(receiptId);
    if (!receipt) throw new Error("测试记录已过期，请重新测试后保存");
    if (!receipt.saving) {
      receipt.saving = this.sources
        .connect(receipt.config)
        .then((saved) => {
          delete receipt.config.token;
          return saved;
        })
        .catch((error) => {
          receipt.saving = undefined;
          throw error;
        });
    }
    return receipt.saving;
  }
}

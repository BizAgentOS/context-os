import { fetchSource, sourceUrl, redactSource } from "./source-http.ts";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Artifact, Data, Repository } from "../agent/contracts.ts";

const name = z.string().trim().min(1).max(200);
const capabilitySchema = z
  .object({
    name,
    contentKind: z.enum(["records", "knowledge", "metrics"]).default("records"),
    path: z.string().max(500).optional(),
    metricId: name.optional(),
    fields: z.array(name).max(100).default([]),
    idField: name.default("id"),
    idType: z.enum(["string", "number"]).default("string"),
    itemsPath: z.string().max(200).default("items"),
    totalPath: z.string().max(200).optional(),
    filters: z.record(name, name).default({}),
    limitParam: name.default("limit"),
    offsetParam: name.default("offset"),
  })
  .strict();
const connectionSchema = z
  .object({
    name,
    protocol: z.enum(["http", "mcp"]),
    url: z.string().url(),
    token: z.string().max(4000).optional(),
    auth: z
      .object({
        type: z.enum(["none", "bearer", "apiKey", "basic"]),
        headerName: z
          .string()
          .regex(/^[A-Za-z0-9-]+$/)
          .max(100)
          .optional(),
      })
      .strict()
      .optional(),
    importInfo: z
      .object({
        format: z.string().max(40),
        title: name,
        version: z.string().max(100),
        digest: z.string().length(64),
        operationIds: z.array(z.string().min(1).max(500)).max(30),
      })
      .strict()
      .optional(),
    capabilities: z.array(capabilitySchema).min(1).max(30),
  })
  .strict();
export type Capability = z.infer<typeof capabilitySchema>;
export type Connection = z.infer<typeof connectionSchema> & {
  toolSchemas?: Record<string, string>;
  /** Host-created adapter; never accepted from connection JSON or a tool input. */
  localSource?: { id: string; version: number };
};
export const jsonData = (value: unknown): Data =>
  JSON.parse(JSON.stringify(value));
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const at = (value: unknown, path: string): unknown =>
  path
    ? path
        .split(".")
        .reduce<unknown>(
          (v, key) =>
            v && typeof v === "object" && Object.hasOwn(v, key)
              ? (v as Record<string, unknown>)[key]
              : undefined,
          value,
        )
    : value;

export class SourceConnections {
  onSaved?: (source: Artifact) => void;
  private repo: Repository;
  private file: string;
  private secrets: Record<string, string>;
  constructor(directory: string, repo: Repository) {
    this.repo = repo;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, "source-credentials.json");
    try {
      this.secrets = JSON.parse(readFileSync(this.file, "utf8"));
      chmodSync(this.file, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.secrets = {};
    }
  }
  list() {
    return this.repo.listArtifacts("source_connection");
  }
  private persist() {
    const tmp = this.file + "." + randomUUID();
    writeFileSync(tmp, JSON.stringify(this.secrets), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
  private async mcp<T>(
    config: Connection,
    token: string | undefined,
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    const client = new Client({
      name: "dataengine-source",
      version: "0.2.1",
    });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        redirect: "error",
      },
      fetch: (input, init) => fetchSource(input, init),
    });
    try {
      await client.connect(transport);
      return await fn(client);
    } finally {
      await client.close();
    }
  }
  private validate(input: unknown) {
    const config = connectionSchema.parse(input);
    sourceUrl(config.url);
    if (config.token && /[\r\n]/.test(config.token))
      throw new Error("认证值不能包含换行");
    if (config.auth) {
      if (config.protocol !== "http")
        throw new Error("认证类型配置仅用于 HTTP");
      if (config.auth.type !== "none" && !config.token)
        throw new Error("请填写认证凭据");
      if (
        config.auth.type === "apiKey" &&
        (!config.auth.headerName ||
          /^(host|cookie|authorization|proxy-.*|content-.*|connection|transfer-encoding|accept|origin|referer|sec-.*)$/i.test(
            config.auth.headerName,
          ))
      )
        throw new Error("请使用独立的 API Key 请求头名称");
      if (config.auth.type === "none" && config.token)
        throw new Error("无认证连接不能携带凭据");
    }
    if (
      new Set(config.capabilities.map((c) => c.name)).size !==
      config.capabilities.length
    )
      throw new Error("能力名称重复");
    for (const c of config.capabilities) {
      if (
        c.contentKind === "metrics" &&
        (!c.metricId ||
          c.fields.length ||
          Object.keys(c.filters).length ||
          c.totalPath)
      )
        throw new Error(
          "指标能力需要明确 metricId，使用固定指标合同，不配置记录字段/过滤/总数路径",
        );
      if (c.contentKind !== "metrics" && c.metricId)
        throw new Error("metricId 仅用于指标能力");
      if (
        c.contentKind === "knowledge" &&
        (c.idType !== "string" ||
          !c.totalPath ||
          !c.filters[c.idField] ||
          ["documentId", "title", "revision", "text"].includes(c.idField) ||
          !["documentId", "title", "revision", "text"].every((f) =>
            c.fields.includes(f),
          ))
      )
        throw new Error(
          "知识能力需要字符串片段身份、身份过滤、总数及 documentId/title/revision/text 字段",
        );
      if (
        (c.contentKind !== "metrics" && !c.fields.includes(c.idField)) ||
        new Set(c.fields).size !== c.fields.length ||
        Object.keys(c.filters).some((f) => !c.fields.includes(f))
      )
        throw new Error("字段、身份或过滤配置无效");
      if (
        c.limitParam === c.offsetParam ||
        Object.values(c.filters).some((p) =>
          [c.limitParam, c.offsetParam].includes(p),
        )
      )
        throw new Error("分页与过滤参数不能冲突");
      if (config.protocol === "http") {
        if (
          !c.path?.startsWith("/") ||
          c.path.startsWith("//") ||
          c.path.includes("?") ||
          c.path.includes("#") ||
          c.path.includes("\\")
        )
          throw new Error("HTTP 能力需要同一源上的绝对 GET 路径");
      }
    }
    return config;
  }
  private async http(
    config: Connection,
    cap: Capability,
    args: Record<string, unknown>,
    token?: string,
  ) {
    const url = new URL(cap.path!, config.url);
    if (url.origin !== new URL(config.url).origin)
      throw new Error("来源路径必须在同一服务内");
    for (const [key, value] of Object.entries(args))
      url.searchParams.set(
        key,
        typeof value === "object" ? JSON.stringify(value) : String(value),
      );
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token && config.auth?.type !== "none") {
      if (config.auth?.type === "apiKey")
        headers[config.auth.headerName!] = token;
      else
        headers.Authorization = `${config.auth?.type === "basic" ? "Basic" : "Bearer"} ${token}`;
    }
    try {
      const response = await fetchSource(url, { headers });
      if (!response.ok) throw new Error("请求失败");
      return redactSource(await response.json(), token);
    } catch {
      throw new Error(
        "来源读取失败：请检查连接、授权或接口契约；未返回替代数据",
      );
    }
  }
  /** Validate a bounded sample without creating any source or storing its credentials. */
  async preview(input: unknown, capability: string) {
    const config = this.validate(input);
    if (config.protocol !== "http") throw new Error("仅支持 HTTP 样本测试");
    const cap = config.capabilities.find((c) => c.name === capability);
    if (!cap || cap.contentKind !== "records")
      throw new Error("请选择记录接口");
    const raw = await this.http(
      config,
      cap,
      { [cap.limitParam]: 3, [cap.offsetParam]: 0 },
      config.token,
    );
    return {
      ...this.records(raw, cap, {}, 0, 3),
      readAt: new Date().toISOString(),
    };
  }
  async connect(input: unknown) {
    const config = this.validate(input);
    let toolSchemas: Record<string, string> | undefined;
    if (config.protocol === "mcp") {
      try {
        toolSchemas = await this.mcp(config, config.token, async (client) => {
          const result = await client.listTools();
          if (result.nextCursor) throw new Error("请使用不超过一页的能力目录");
          return Object.fromEntries(
            config.capabilities.map((c) => {
              const t = result.tools.find((t) => t.name === c.name);
              if (!t) throw new Error("批准的工具不存在");
              return [c.name, hash(t.inputSchema)];
            }),
          );
        });
      } catch {
        throw new Error("MCP 能力发现失败，请检查地址、授权和工具名称");
      }
    }
    const { token, ...safe } = config;
    const artifact = this.repo.putArtifact({
      kind: "source_connection",
      title: config.name,
      status: "ready",
      content: jsonData({ ...safe, ...(toolSchemas ? { toolSchemas } : {}) }),
    });
    if (token) {
      this.secrets[artifact.id] = token;
      this.persist();
    }
    this.onSaved?.(artifact);
    return artifact;
  }
  disable(id: string, version: number) {
    const a = this.repo.getArtifact(id);
    if (a.kind !== "source_connection") throw new Error("来源不存在");
    const result = this.repo.putArtifact({
      ...a,
      expectedVersion: version,
      status: "disabled",
    });
    delete this.secrets[id];
    this.persist();
    return result;
  }
  /** Bind an uploaded CSV to the same record contract used by HTTP and MCP. */
  connectUpload(sourceId: string, sourceVersion: number, idField: string): Artifact {
    const source = this.repo.getArtifact(sourceId);
    if (source.kind !== "source" || source.status !== "ready" || source.content.format !== "csv" || source.version !== sourceVersion)
      throw new Error("CSV 来源已更新或不可用，请重新读取");
    const fields = source.content.columns as string[], rows = source.content.rows as Data[];
    if (!Array.isArray(fields) || !Array.isArray(rows) || !fields.includes(idField)) throw new Error("CSV 身份字段不存在");
    const cap = capabilitySchema.parse({name: "records", fields, idField, idType: "string", totalPath: "total",
      limitParam: "__ade_limit", offsetParam: "__ade_offset", filters: Object.fromEntries(fields.map((field, index) => [field, `__ade_filter_${index}`]))});
    const ids = new Set<string>();
    for (const row of rows) {
      const value = row[idField];
      if (typeof value !== "string" || !value.trim() || ids.has(value)) throw new Error("CSV 对象身份为空或重复，不能建立执行来源");
      ids.add(value);
    }
    const prior = this.list().find(item => (item.content.localSource as Data | undefined)?.id === sourceId);
    if (prior?.status === "disabled") throw new Error("CSV 执行来源已停用，请明确恢复来源后重试");
    if (prior && (prior.content.localSource as Data).version === sourceVersion && hash((prior.content.capabilities as Data[])[0]) === hash(cap)) return prior;
    return this.repo.putArtifact({ ...(prior ? {id: prior.id, expectedVersion: prior.version} : {}), kind: "source_connection", title: source.title, status: "ready",
      content: jsonData({name: source.title, protocol: "http", url: "http://localhost/", adapter: "uploaded_csv", localSource: {id: sourceId, version: sourceVersion}, capabilities: [cap]}) });
  }
  capability(id: string, capability: string, version?: number) {
    const a = this.repo.getArtifact(id);
    if (a.kind !== "source_connection" || a.status !== "ready")
      throw new Error("来源已停用或不存在");
    if (version !== undefined && a.version !== version)
      throw new Error("来源契约版本已变化，需要重新检查本体");
    const config = a.content as unknown as Connection;
    if (config.localSource) {
      const source = this.repo.getArtifact(config.localSource.id);
      if (source.kind !== "source" || source.status !== "ready" || source.version !== config.localSource.version)
        throw new Error("CSV 来源版本已更新或已移除，需要重新构建并检查映射");
    }
    const savedCap = config.capabilities.find((c) => c.name === capability);
    const cap = savedCap ? capabilitySchema.parse(savedCap) : undefined;
    if (!cap) throw new Error("来源能力不存在");
    return { artifact: a, config, cap };
  }
  /** Internal bounded transport shared by typed record, document and metric adapters. */
  async invoke(
    id: string,
    capability: string,
    args: Record<string, unknown>,
    version?: number,
  ) {
    const { artifact, config, cap } = this.capability(id, capability, version);
    let raw: unknown;
    try {
      if (config.localSource) {
        const source = this.repo.getArtifact(config.localSource.id, config.localSource.version);
        const offset = Number(args[cap.offsetParam] ?? 0), limit = Number(args[cap.limitParam] ?? 20);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new Error("CSV 读取范围无效");
        const filters = Object.entries(cap.filters).filter(([, parameter]) => Object.hasOwn(args, parameter));
        const rows = (source.content.rows as Data[]).filter(row => filters.every(([field, parameter]) => row[field] === args[parameter]));
        raw = {items: rows.slice(offset, offset + limit), total: rows.length};
      } else if (config.protocol === "http") {
        raw = await this.http(config, cap, args, this.secrets[id]);
      } else
        raw = await this.mcp(config, this.secrets[id], async (client) => {
          const tools = await client.listTools();
          const tool = tools.tools.find((t) => t.name === cap.name);
          if (
            !tool ||
            hash(tool.inputSchema) !== config.toolSchemas?.[cap.name]
          )
            throw new Error("MCP 契约发生变化");
          const result = await client.callTool({
            name: cap.name,
            arguments: args,
          });
          if (result.isError) throw new Error("MCP 工具失败");
          if (result.structuredContent) return result.structuredContent;
          const contents = result.content as { type: string; text?: string }[];
          const text = contents?.find((c) => c.type === "text")?.text;
          if (!text) throw new Error("MCP 未返回 JSON");
          return JSON.parse(text);
        });
    } catch {
      throw new Error(
        "来源读取失败：请检查连接、授权或接口契约；未返回替代数据",
      );
    }
    // Check again after I/O, so revocation during a query takes effect.
    this.capability(id, capability, artifact.version);
    raw = redactSource(raw, this.secrets[id]);
    return {
      raw,
      provenance: {
        sourceId: id,
        connectionVersion: artifact.version,
        capability,
        readAt: new Date().toISOString(),
        historicalReplay: false,
      },
    };
  }
  /** The record contract at a pinned connection version, for reads served from a locked snapshot. Only revocation is checked. */
  pinnedCapability(id: string, capability: string, version: number) {
    if (this.repo.getArtifact(id).status === "disabled") throw new Error("来源已停用或不存在");
    const a = this.repo.getArtifact(id, version);
    if (a.kind !== "source_connection") throw new Error("来源已停用或不存在");
    const config = a.content as unknown as Connection;
    const savedCap = config.capabilities.find((c) => c.name === capability);
    if (!savedCap) throw new Error("来源能力不存在");
    return { artifact: a, config, cap: capabilitySchema.parse(savedCap) };
  }
  async readRecords(
    id: string,
    capability: string,
    where: Data = {},
    offset = 0,
    limit = 20,
    version?: number,
  ) {
    if (this.capability(id, capability, version).cap.contentKind === "metrics")
      throw new Error("BI 指标请使用 metric_describe / metric_query");
    if (
      this.capability(id, capability, version).cap.contentKind === "knowledge"
    )
      throw new Error(
        "知识文档请使用 knowledge_query / knowledge_read 分段读取",
      );
    return this.read(id, capability, where, offset, limit, version);
  }
  async read(
    id: string,
    capability: string,
    where: Data = {},
    offset = 0,
    limit = 20,
    version?: number,
  ) {
    const { artifact, cap } = this.capability(id, capability, version);
    if (cap.contentKind === "metrics")
      throw new Error("BI 指标不能作为记录读取，请使用 metric_query");
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("分页范围无效");
    where = { ...where };
    if (Object.hasOwn(where, cap.idField) && cap.idType === "number") {
      const value = where[cap.idField];
      if (
        (typeof value !== "number" &&
          (typeof value !== "string" || !value.trim())) ||
        !Number.isFinite(Number(value))
      )
        throw new Error("对象编号需要数字");
      where[cap.idField] = Number(value);
    }
    const args: Record<string, string | number | boolean> = {
      [cap.limitParam]: limit,
      [cap.offsetParam]: offset,
    };
    for (const [field, value] of Object.entries(where)) {
      if (
        !Object.hasOwn(cap.filters, field) ||
        !["string", "number", "boolean"].includes(typeof value)
      )
        throw new Error("来源不支持此过滤条件");
      args[cap.filters[field]] = value as string | number | boolean;
    }
    const { raw } = await this.invoke(id, capability, args, artifact.version);
    return {
      ...this.records(raw, cap, where, offset, limit),
      provenance: {
        sourceId: id,
        connectionVersion: artifact.version,
        capability,
        readAt: new Date().toISOString(),
        historicalReplay: false,
      },
    };
  }
  private records(
    raw: unknown,
    cap: Capability,
    where: Data,
    offset: number,
    limit: number,
  ) {
    const rows = at(raw, cap.itemsPath);
    if (!Array.isArray(rows) || rows.length > limit)
      throw new Error("来源未遵循记录数组或分页契约");
    const ids = new Set<string>();
    const items: Data[] = rows.map((row) => {
      if (
        !row ||
        typeof row !== "object" ||
        cap.fields.some((f) => !Object.hasOwn(row, f))
      )
        throw new Error("来源字段变化，需要修订映射");
      if (
        cap.fields.some(
          (f) =>
            row[f] !== null &&
            !["string", "number", "boolean"].includes(typeof row[f]),
        )
      )
        throw new Error("本轮仅支持标量字段");
      const identity = row[cap.idField];
      if (
        typeof identity !== cap.idType ||
        !String(identity).trim() ||
        ids.has(String(identity))
      )
        throw new Error("来源对象身份为空或重复");
      ids.add(String(identity));
      if (Object.entries(where).some(([k, v]) => row[k] !== v))
        throw new Error("来源未遵循过滤契约");
      if (
        cap.contentKind === "knowledge" &&
        ([cap.idField, "documentId", "title", "revision"].some(
          (f) =>
            typeof row[f] !== "string" || !row[f].trim() || row[f].length > 500,
        ) ||
          typeof row.text !== "string" ||
          !row.text.trim() ||
          row.text.length > 16000 ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(row.text))
      )
        throw new Error("知识片段字段无效或正文超过16000字符，请在来源分段");
      return Object.fromEntries(cap.fields.map((f) => [f, row[f]]));
    });
    const total = cap.totalPath ? at(raw, cap.totalPath) : undefined;
    if (
      total !== undefined &&
      (!Number.isSafeInteger(total) ||
        Number(total) < 0 ||
        (items.length > 0 && Number(total) < offset + items.length))
    )
      throw new Error("来源总数契约无效");
    return {
      items,
      coverage: {
        offset,
        shown: items.length,
        total: typeof total === "number" ? total : null,
        complete:
          typeof total === "number" && offset === 0 && items.length === total,
      },
    };
  }
}

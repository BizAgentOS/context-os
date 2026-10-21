import { scheduleSchema, qualityThresholdsSchema } from "../data/sync-policy.ts";
import { oauthSchema, SourceAuthorization } from "./source-auth.ts";
import { paginationSchema, flattenSchema, valueAt, continuation, resume, pagingScope, nextLink, flattenRecord } from "./source-pagination.ts";
import {tableRows,tableRowsSync} from "../data/table-rows.ts";
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
import { DatabaseConnections } from "../connectors/database.ts";
import type { DatabaseScanner } from "../connectors/database-scanner.ts";

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
    pagination: paginationSchema.optional(),
    flatten: flattenSchema.optional(),
    incrementalParam: name.optional(),
  })
  .strict();
const connectionSchema = z
  .object({
    name,
    protocol: z.enum(["http", "mcp"]),
    url: z.string().url(),
    token: z.string().max(4000).optional(),
    pagination: paginationSchema.optional(),
    flatten: flattenSchema.optional(),
    allowInsecureHttp: z.boolean().optional(),
    schedule: scheduleSchema.optional(),
    incrementalField: name.nullable().optional(),
    qualityThresholds: qualityThresholdsSchema.optional(),
    auth: z
      .object({
        type: z.enum(["none", "bearer", "apiKey", "basic", "oauth2"]),
        oauth2: oauthSchema.optional(),
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
export type Connection = Omit<z.infer<typeof connectionSchema>, "protocol"> & {
  protocol: "http" | "mcp" | "postgres" | "mysql";
  adapter?: "uploaded_csv" | "database";
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
  readonly databases: DatabaseConnections;
  onSaved?: (source: Artifact) => void;
  private repo: Repository;
  private file: string;
  private secrets: Record<string, string>;
  private authorization: SourceAuthorization;
  constructor(directory: string, repo: Repository, databaseScanner?: DatabaseScanner) {
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
    this.authorization = new SourceAuthorization(directory);
    this.databases = new DatabaseConnections(directory, repo, source => this.onSaved?.(source), databaseScanner);
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
      version: "0.2.3",
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
  private async mcpTools(client: Client) {
    const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined); tools.push(...page.tools);
      if (tools.length > 10000 || cursors.size >= 100 || page.nextCursor && cursors.has(page.nextCursor)) throw new Error("MCP 能力目录分页无效或超过读取预算");
      cursor = page.nextCursor; if (cursor) cursors.add(cursor);
    } while (cursor);
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error("MCP 目录存在重复工具名称");
    return { tools };
  }
  private validate(input: unknown) {
    const config = connectionSchema.parse(input);
    for (const cap of config.capabilities) { cap.pagination ??= config.pagination; cap.flatten ??= config.flatten; }
    sourceUrl(config.url, config.allowInsecureHttp);
    if (config.token && /[\r\n]/.test(config.token))
      throw new Error("认证值不能包含换行");
    if (config.auth) {
      if (config.protocol !== "http")
        throw new Error("认证类型配置仅用于 HTTP");
      if (config.auth.type === "oauth2") {
        if (!config.auth.oauth2 || !(config.auth.oauth2.clientSecret || config.auth.oauth2.refreshToken) || config.token) throw new Error("OAuth 需要客户端凭据或刷新令牌，不使用静态 Token");
        sourceUrl(config.auth.oauth2.tokenUrl, config.allowInsecureHttp);
      } else if (config.auth.oauth2) throw new Error("OAuth 配置与认证方式不一致");
      if (!["none", "oauth2"].includes(config.auth.type) && !config.token)
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
      const pageParameter = c.pagination?.type === "page" ? c.pagination.pageParam : c.pagination?.type === "cursor" ? c.pagination.cursorParam : c.offsetParam;
      if (c.limitParam === pageParameter || Object.values(c.filters).some(parameter => [c.limitParam, pageParameter].includes(parameter))) throw new Error("分页与过滤参数不能冲突");
      if (c.pagination && c.pagination.type !== "offset" && config.protocol !== "http") throw new Error("页码、游标和 Link 分页仅用于 HTTP 来源");
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
  private async httpPage(
    config: Connection,
    cap: Capability,
    args: Record<string, unknown>,
    token?: string,
    pageUrl?: string,
    authorizationId?: string,
  ) {
    const original = new URL(cap.path!, config.url), url = pageUrl ? new URL(pageUrl, original) : original;
    if (url.pathname !== original.pathname || url.username || url.password || url.hash) throw new Error("下一页地址超出已批准接口");
    if (url.origin !== new URL(config.url).origin)
      throw new Error("来源路径必须在同一服务内");
    for (const [key, value] of Object.entries(args))
      url.searchParams.set(
        key,
        typeof value === "object" ? JSON.stringify(value) : String(value),
      );
    const oauth = config.auth?.type === "oauth2" ? config.auth.oauth2 : undefined;
    if (oauth) token = await this.authorization.token(oauth, config.allowInsecureHttp, authorizationId);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token && config.auth?.type !== "none") {
      if (config.auth?.type === "apiKey")
        headers[config.auth.headerName!] = token;
      else
        headers.Authorization = `${config.auth?.type === "basic" ? "Basic" : "Bearer"} ${token}`;
    }
    try {
      let response = await fetchSource(url, { headers });
      if (response.status === 401 && oauth) {
        await response.body?.cancel();
        token = await this.authorization.token(oauth, config.allowInsecureHttp, authorizationId, true);
        headers.Authorization = `Bearer ${token}`; response = await fetchSource(url, { headers });
      }
      if (!response.ok) throw new Error("请求失败");
      const link = nextLink(response.headers.get("link"));
      // A continuation is public and may be persisted by synchronization. Never carry
      // source credentials out through response metadata, even when URL encoded.
      if (link) {
        const decoded = decodeURIComponent(link.replaceAll("+", "%20"));
        if (this.authorization.redact(redactSource(link, token), oauth, authorizationId) !== link ||
            this.authorization.redact(redactSource(decoded, token), oauth, authorizationId) !== decoded) throw new Error("分页地址包含凭据");
      }
      return { raw: this.authorization.redact(redactSource(await response.json(), token), oauth, authorizationId), nextLink: link };
    } catch {
      throw new Error(
        "来源读取失败：请检查连接、授权或接口契约；未返回替代数据",
      );
    }
  }
  private async http(config: Connection, cap: Capability, args: Record<string, unknown>, token?: string) {
    return (await this.httpPage(config, cap, args, token)).raw;
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
      { [cap.limitParam]: 3, ...(!cap.pagination || cap.pagination.type === "offset" ? { [cap.offsetParam]: 0 } : cap.pagination.type === "page" ? { [cap.pagination.pageParam]: cap.pagination.startPage } : {}) },
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
          const result = await this.mcpTools(client);
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
    if (safe.auth?.oauth2) safe.auth = { ...safe.auth, oauth2: SourceAuthorization.public(safe.auth.oauth2) };
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
    if (config.auth?.oauth2) this.authorization.register(artifact.id, config.auth.oauth2);
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
    this.databases.forget(id);
    this.authorization.forget(id);
    return result;
  }
  /** Bind an uploaded CSV to the same record contract used by HTTP and MCP. */
  connectUpload(sourceId: string, sourceVersion: number, idField: string): Artifact {
    const source = this.repo.getArtifact(sourceId);
    if (source.kind !== "source" || source.status !== "ready" || source.content.format !== "csv" || source.version !== sourceVersion)
      throw new Error("CSV 来源已更新或不可用，请重新读取");
    const fields = source.content.columns as string[], rows = tableRowsSync(source,this.repo);
    if (!Array.isArray(fields) || !fields.includes(idField)) throw new Error("CSV 身份字段不存在");
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
    pageUrl?: string,
  ) {
    const { artifact, config, cap } = this.capability(id, capability, version);
    let raw: unknown, link: string | null = null;
    try {
      if (config.localSource) {
        const source = this.repo.getArtifact(config.localSource.id, config.localSource.version);
        const offset = Number(args[cap.offsetParam] ?? 0), limit = Number(args[cap.limitParam] ?? 20);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new Error("CSV 读取范围无效");
        const filters = Object.entries(cap.filters).filter(([, parameter]) => Object.hasOwn(args, parameter));
        const items:Data[]=[];let total=0;
        for await(const row of tableRows(source,this.repo)){if(!filters.every(([field, parameter]) => row[field] === args[parameter]))continue;if(total>=offset&&items.length<limit)items.push(row);total++;}
        raw = {items,total};
      } else if (config.adapter === "database") {
        const where = Object.fromEntries(Object.entries(cap.filters).filter(([, parameter]) => Object.hasOwn(args, parameter)).map(([field, parameter]) => [field, args[parameter]]));
        raw = await this.databases.read(id, capability, jsonData(where), Number(args[cap.offsetParam] ?? 0), Number(args[cap.limitParam] ?? 20), artifact.version);
      } else if (config.protocol === "http") {
        const page = await this.httpPage(config, cap, args, this.secrets[id], pageUrl, id);
        raw = page.raw; link = page.nextLink;
      } else
        raw = await this.mcp(config, this.secrets[id], async (client) => {
          const tools = await this.mcpTools(client);
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
      raw, nextLink: link,
      provenance: {
        sourceId: id,
        connectionVersion: artifact.version,
        capability,
        readAt: new Date().toISOString(),
        historicalReplay: false,
      },
    };
  }
  acceptSnapshotSchema(id: string, capability: string, version: number, columns: { name: string; type: string }[]) {
    const { artifact, cap, config } = this.capability(id, capability, version);
    const fields = columns.map(column => column.name);
    if (!fields.includes(cap.idField) || fields.length > 100) throw new Error("身份字段已移除或字段超过范围，请先修订来源合同");
    const identity = columns.find(column => column.name === cap.idField)!;
    const idType = /^(?:U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|U?HUGEINT|FLOAT|DOUBLE|DECIMAL)/.test(identity.type) ? "number" : "string";
    const next = capabilitySchema.parse({ ...cap, fields, idType, filters: Object.fromEntries(Object.entries(cap.filters).filter(([field]) => fields.includes(field))) });
    if (hash(next) === hash(cap)) return artifact;
    return this.repo.putArtifact({ ...artifact, expectedVersion: artifact.version, content: jsonData({ ...config, capabilities: config.capabilities.map(item => item.name === capability ? next : item) }) });
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
  /** Sequential page boundary shared by full snapshots and resumable synchronization. */
  async readRecordPage(id: string, capability: string, where: Data = {}, offset = 0, limit = 20, version?: number, cursor?: string, incremental?: { field: string; since: string }, snapshot?: { knownFields?: string[]; excludedFields?: string[] }) {
    const { artifact, cap, config } = this.capability(id, capability, version), strategy = cap.pagination;
    if (incremental && (!cap.incrementalParam || !cap.fields.includes(incremental.field))) throw new Error("来源未声明该字段的增量读取合同");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("分页范围无效");
    if (!strategy || strategy.type === "offset") {
      const scope = pagingScope([id, artifact.version, capability, where, incremental]);
      if (cursor) resume(cursor, scope, offset);
      const result = await this.readOffset(id, capability, where, offset, limit, version, incremental, snapshot);
      const nextOffset = offset + result.items.length;
      const hasMore = result.coverage.total === null ? result.items.length === limit : nextOffset < result.coverage.total;
      return { ...result, continuation: hasMore ? continuation({ scope, offset: nextOffset, next: nextOffset }) : null };
    }
    if (config.protocol !== "http") throw new Error("该分页策略仅适用于 HTTP 记录来源");
    where = { ...where };
    if (cap.idType === "number" && Object.hasOwn(where, cap.idField)) {
      if (typeof where[cap.idField] !== "number" && (typeof where[cap.idField] !== "string" || !String(where[cap.idField]).trim()) || !Number.isFinite(Number(where[cap.idField]))) throw new Error("对象编号需要数字");
      where[cap.idField] = Number(where[cap.idField]);
    }
    const scope = pagingScope([id, artifact.version, capability, where, strategy.type === "page" ? limit : null, incremental]);
    const next = cursor ? resume(cursor, scope, offset) : strategy.type === "page" ? strategy.startPage : null;
    if (offset && !cursor) throw new Error("非偏移分页必须从已保存的下一页继续");
    const args: Record<string, unknown> = { [cap.limitParam]: limit, ...(incremental ? { [cap.incrementalParam!]: incremental.since } : {}) };
    if (strategy.type === "page") args[strategy.pageParam] = next;
    if (strategy.type === "cursor" && next !== null) args[strategy.cursorParam] = next;
    for (const [field, value] of Object.entries(where)) {
      if (!Object.hasOwn(cap.filters, field) || !["string", "number", "boolean"].includes(typeof value)) throw new Error("来源不支持此过滤条件");
      args[cap.filters[field]] = cap.idType === "number" && field === cap.idField ? Number(value) : value;
    }
    const result = await this.invoke(id, capability, args, artifact.version, strategy.type === "link" && next !== null ? String(next) : undefined);
    const parsed = this.records(result.raw, cap, where, offset, limit, snapshot), nextOffset = offset + parsed.items.length;
    let nextValue: string | number | null = null;
    if (strategy.type === "cursor") {
      const candidate = valueAt(result.raw, strategy.nextCursorPath);
      if (candidate !== null && candidate !== undefined && candidate !== "") {
        if (!["string", "number"].includes(typeof candidate)) throw new Error("下一页游标无效");
        nextValue = String(candidate);
      }
    } else if (strategy.type === "link") nextValue = result.nextLink;
    else if (parsed.coverage.total === null ? parsed.items.length === limit : nextOffset < parsed.coverage.total) nextValue = Number(next) + 1;
    if (nextValue === null && parsed.coverage.total !== null && nextOffset < parsed.coverage.total) throw new Error("来源分页提前结束，未覆盖其报告总数");
    if (nextValue !== null && (!parsed.items.length || String(nextValue) === String(next))) throw new Error("来源分页没有前进，停止同步");
    return { ...parsed, coverage: { ...parsed.coverage, complete: offset === 0 && nextValue === null, total: parsed.coverage.total ?? (nextValue === null ? nextOffset : null) },
      provenance: result.provenance, continuation: nextValue === null ? null : continuation({ scope, offset: nextOffset, next: nextValue }) };
  }
  async read(id: string, capability: string, where: Data = {}, offset = 0, limit = 20, version?: number) {
    const { cap } = this.capability(id, capability, version);
    if (!cap.pagination || cap.pagination.type === "offset") return this.readOffset(id, capability, where, offset, limit, version);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("分页范围无效");
    let position = 0, cursor: string | undefined;
    const items: Data[] = []; let last: Awaited<ReturnType<SourceConnections["readRecordPage"]>> | undefined;
    do {
      last = await this.readRecordPage(id, capability, where, position, Math.min(100, offset + limit), version, cursor);
      items.push(...last.items.slice(Math.max(0, offset - position), Math.max(0, offset + limit - position)));
      position += last.items.length; cursor = last.continuation ?? undefined;
    } while (cursor && position < offset + limit);
    return { items, coverage: { offset, shown: items.length, total: last.coverage.total, complete: offset === 0 && !cursor && items.length === position }, provenance: last.provenance };
  }
  private async readOffset(
    id: string,
    capability: string,
    where: Data = {},
    offset = 0,
    limit = 20,
    version?: number,
    incremental?: { field: string; since: string },
    snapshot?: { knownFields?: string[]; excludedFields?: string[] },
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
      ...(incremental ? { [cap.incrementalParam!]: incremental.since } : {}),
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
      ...this.records(raw, cap, where, offset, limit, snapshot),
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
    snapshot?: { knownFields?: string[]; excludedFields?: string[] },
  ) {
    const rows = at(raw, cap.itemsPath);
    if (!Array.isArray(rows) || rows.length > limit)
      throw new Error("来源未遵循记录数组或分页契约");
    const ids = new Set<string>(), observedFields = new Set<string>();
    const items: Data[] = rows.map((original) => {
      const row = original && typeof original === "object" && cap.flatten ? flattenRecord(original, cap.flatten) : original;
      if (
        !row ||
        typeof row !== "object" ||
        !snapshot && cap.fields.some((f) => !Object.hasOwn(row, f))
      )
        throw new Error("来源字段变化，需要修订映射");
      const observed = snapshot ? Object.keys(row) : [];
      if (snapshot && (observed.length > 2000 || observed.some(field => field.length > 200))) throw new Error("快照字段元数据超过有界检查范围，请提供精简接口");
      for (const field of observed) observedFields.add(field);
      if (observedFields.size > 2000) throw new Error("快照字段元数据超过有界检查范围，请提供精简接口");
      const fields = snapshot ? observed.filter(field => cap.fields.includes(field) || snapshot.knownFields && !snapshot.knownFields.includes(field) && !snapshot.excludedFields?.includes(field)) : cap.fields;
      if (fields.length > 100) throw new Error("已选择的字段或新结构超过100列范围");
      if (
        fields.some(
          (f) =>
            row[f] !== null &&
            !["string", "number", "boolean"].includes(typeof row[f]),
        )
      )
        throw new Error("本轮仅支持标量字段");
      const identity = row[cap.idField];
      if (
        !snapshot && (typeof identity !== cap.idType ||
        !String(identity).trim() ||
        ids.has(String(identity)))
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
      return Object.fromEntries(fields.map((f) => [f, row[f]]));
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
      ...(snapshot ? { observedFields: [...observedFields].sort() } : {}),
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

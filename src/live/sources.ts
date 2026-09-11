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
import type { Data, Repository } from "../agent/contracts.ts";

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
    capabilities: z.array(capabilitySchema).min(1).max(30),
  })
  .strict();
export type Capability = z.infer<typeof capabilitySchema>;
export type Connection = z.infer<typeof connectionSchema> & {
  toolSchemas?: Record<string, string>;
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
  private validateUrl(value: string) {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("源地址需为不含凭据、查询和片段的 HTTP(S) 地址");
    if (
      url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw new Error("远端来源必须使用 HTTPS");
    return url;
  }
  private async fetchBounded(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const response = await fetch(input, {
      ...init,
      redirect: "error",
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(12000)])
        : AbortSignal.timeout(12000),
    });
    if (!response.body) return response;
    let size = 0;
    const bounded = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.length;
          if (size > 2_000_000) throw new Error("来源响应超过 2 MB");
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(bounded, {
      status: response.status,
      headers: response.headers,
    });
  }

  private async mcp<T>(
    config: Connection,
    token: string | undefined,
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    const client = new Client({
      name: "dataengine-source",
      version: "0.1.0-dev",
    });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        redirect: "error",
      },
      fetch: (input, init) => this.fetchBounded(input, init),
    });
    try {
      await client.connect(transport);
      return await fn(client);
    } finally {
      await client.close();
    }
  }
  async connect(input: unknown) {
    const config = connectionSchema.parse(input);
    this.validateUrl(config.url);
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
  capability(id: string, capability: string, version?: number) {
    const a = this.repo.getArtifact(id);
    if (a.kind !== "source_connection" || a.status !== "ready")
      throw new Error("来源已停用或不存在");
    if (version !== undefined && a.version !== version)
      throw new Error("来源契约版本已变化，需要重新检查本体");
    const config = a.content as unknown as Connection;
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
      if (config.protocol === "http") {
        const url = new URL(cap.path!, config.url);
        for (const [k, v] of Object.entries(args))
          url.searchParams.set(
            k,
            typeof v === "object" ? JSON.stringify(v) : String(v),
          );
        const response = await this.fetchBounded(url, {
          headers: this.secrets[id]
            ? { Authorization: `Bearer ${this.secrets[id]}` }
            : {},
        });
        if (!response.ok) throw new Error("来源请求失败");
        raw = await response.json();
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
    if (this.secrets[id])
      raw = JSON.parse(
        JSON.stringify(raw).replaceAll(this.secrets[id], "[redacted]"),
      );
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
      provenance: {
        sourceId: id,
        connectionVersion: artifact.version,
        capability,
        readAt: new Date().toISOString(),
        historicalReplay: false,
      },
    };
  }
}

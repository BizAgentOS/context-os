import {
  createMcpManager,
  parseMcpCapabilityId,
  type McpManager,
  type McpCapabilityDescriptor,
  type McpServerConfig,
} from "@kodax-ai/kodax/mcp";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createHash, randomInt } from "node:crypto";

const connectionSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/).optional(),
    url: z.string().trim().url().max(2048),
    type: z.enum(["http", "sse"]).default("http"),
    headers: z
      .record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string().max(4000))
      .default({}),
  })
  .strict();
interface Connection {
  name: string;
  config: McpServerConfig;
  capabilities: McpCapabilityDescriptor[];
  allowed: string[];
  revision: number;
}
export class AgentMcp {
  private connections: Connection[] = [];
  private refreshing = new Set<string>();
  private connecting = new Map<string, string>();
  private closed = false;
  private managers = new Map<string, McpManager>();
  private directory: string;
  constructor(directory: string) {
    this.directory = join(directory, "capabilities");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.connections = JSON.parse(
        readFileSync(join(this.directory, "mcp.json"), "utf8"),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  private save() {
    const target = join(this.directory, "mcp.json");
    writeFileSync(`${target}.tmp`, JSON.stringify(this.connections), {
      mode: 0o600,
    });
    chmodSync(`${target}.tmp`, 0o600);
    renameSync(`${target}.tmp`, target);
  }
  private manager(c: Connection) {
    let manager = this.managers.get(c.name);
    if (!manager) {
      manager = createMcpManager(
        { [c.name]: c.config },
        { cacheDir: join(this.directory, "mcp-cache", c.name) },
      );
      this.managers.set(c.name, manager);
    }
    return manager;
  }
  list() {
    return this.connections.map((c) => ({
      name: c.name,
      url: c.config.url,
      transport: c.config.type,
      revision: c.revision,
      capabilities: c.capabilities.map((d) => ({
        ...d,
        allowed: c.allowed.includes(d.id),
      })),
    }));
  }
  async connect(input: unknown) {
    if (this.closed) throw new Error("连接服务已停止，请重新打开页面");
    const value = connectionSchema.parse(input);
    const url = new URL(value.url);
    if (url.username || url.password || url.search || url.hash)
      throw new Error("凭据请填写到请求头，连接地址不要携带参数");
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      )
    )
      throw new Error("远程 MCP 需要 HTTPS，本机允许 HTTP");
    // The URL-only path reuses one connection; legacy explicitly named profiles
    // may still connect the same endpoint with different account credentials.
    if (!value.name && this.connections.some((c) => c.config.url === url.href))
      throw new Error("该地址已经连接，请在已有连接中管理可用范围");
    const name = value.name ?? `mcp-${url.hostname.replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 42)}-${createHash("sha256").update(url.href).digest("hex").slice(0, 8)}`;
    if (this.connections.some((c) => c.name === name))
      throw new Error("连接名称已存在");
    if (this.connecting.has(name) || (!value.name && [...this.connecting.values()].includes(url.href)))
      throw new Error("此 MCP 正在连接，请等待当前连接完成");
    this.connecting.set(name, url.href);
    const c: Connection = {
      name,
      config: {
        type: value.type,
        url: url.href,
        headers: value.headers,
        connect: "lazy",
        startupTimeoutMs: 15_000,
        requestTimeoutMs: 15_000,
      },
      capabilities: [],
      allowed: [],
      // A fresh generation prevents stale settings from granting a reconnected name.
      revision: randomInt(1, 2 ** 48 - 1),
    };
    const manager = this.manager(c);
    try {
      // getCatalog may return cached capabilities after a failed refresh.
      // Explicit onboarding must complete a live discovery before saving.
      await manager.startServer(c.name);
      c.capabilities = [
        ...(await manager.getCatalog(c.name))
          .descriptors,
      ];
      if (this.closed) throw new Error("连接服务已停止");
      this.connections.push(c);
      this.save();
      return this.list();
    } catch {
      this.connections = this.connections.filter(connection => connection !== c);
      this.managers.delete(c.name);
      await manager.dispose();
      throw new Error("未能发现 MCP 能力。请核对服务地址；若需要访问令牌，请展开身份验证。网页登录服务请使用已适配的服务入口。");
    } finally {
      this.connecting.delete(name);
    }
  }
  grant(name: string, ids: string[], expectedRevision?: number) {
    const c = this.connections.find((c) => c.name === name);
    if (!c || ids.some((id) => !c.capabilities.some((d) => d.id === id)))
      throw new Error("未知的连接或能力");
    if (ids.length && this.refreshing.has(name))
      throw new Error("能力目录正在刷新，请等待后重新选择");
    if (
      ids.length &&
      expectedRevision !== undefined &&
      c.revision !== expectedRevision
    )
      throw new Error("能力目录或授权已改变，请重新打开能力设置");
    c.allowed = [...new Set(ids)];
    c.revision++;
    this.save();
    return this.list();
  }
  search(query = "") {
    return this.list()
      .flatMap((c) => c.capabilities)
      .filter((d) =>
        JSON.stringify(d).toLowerCase().includes(query.toLowerCase()),
      );
  }
  snapshot(query = "", options?: { server?: string; kind?: string }) {
    const items = this.search(query).filter(
      (d) =>
        (!options?.server || d.serverId === options.server) &&
        (!options?.kind || d.kind === options.kind),
    );
    return {
      items,
      complete: true,
      freshness: "cached" as const,
      revision: createHash("sha256")
        .update(JSON.stringify(items))
        .digest("hex"),
    };
  }
  describe(id: string) {
    const d = this.list()
      .flatMap((c) => c.capabilities)
      .find((d) => d.id === id);
    if (!d) throw new Error("MCP 能力不存在，请先在能力设置连接服务");
    return d;
  }
  async refresh(name: string) {
    const c = this.connections.find((c) => c.name === name);
    if (!c) throw new Error("连接不存在");
    if (this.refreshing.has(name)) throw new Error("能力目录正在刷新");
    this.refreshing.add(name);
    // Invalidate immediately, including results already in flight.
    try {
      this.grant(name, []);
      const manager = this.manager(c);
      await manager.startServer(name);
      c.capabilities = [
        ...(await manager.getCatalog(name))
          .descriptors,
      ];
      c.allowed = [];
      c.revision++;
      this.save();
    } catch {
      throw new Error("重新发现失败，请检查 MCP 服务；旧授权已撤销");
    } finally {
      this.refreshing.delete(name);
    }
    return this.list();
  }
  async disconnect(name: string) {
    const c = this.connections.find((c) => c.name === name);
    if (!c) throw new Error("连接不存在");
    this.grant(name, []);
    this.connections = this.connections.filter((c) => c.name !== name);
    this.save();
    const manager = this.managers.get(name);
    this.managers.delete(name);
    await manager?.dispose();
    return this.list();
  }
  async call(id: string, args: Record<string, unknown> = {}) {
    const parsed = parseMcpCapabilityId(id);
    const c = this.connections.find((c) => c.name === parsed.serverId);
    if (!c || !c.allowed.includes(id))
      throw new Error("此 MCP 能力尚未授权，请在能力设置中选择具体能力");
    const revision = c.revision,
      manager = this.manager(c);
    let result: unknown;
    try {
      result =
        parsed.kind === "tool"
          ? await manager.execute(id, args)
          : parsed.kind === "resource"
            ? await manager.read(id)
            : await manager.provider().getPrompt(id, args);
    } catch {
      throw new Error("MCP 调用失败，请检查参数和服务状态");
    }
    if (c.revision !== revision || !c.allowed.includes(id))
      throw new Error("调用期间授权已改变，结果不再交付");
    if (JSON.stringify(result).length > 80_000)
      throw new Error("MCP 返回内容过大，请缩小查询范围");
    return result;
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.managers.values()].map((m) => m.dispose()));
    this.managers.clear();
  }
}

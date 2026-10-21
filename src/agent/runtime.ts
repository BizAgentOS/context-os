import {
  createKodaXRuntime,
  type KodaXRuntime,
  type RuntimeRunHandle,
  type RuntimeKodaXOptions,
  type RuntimePermissionRequest,
} from "@kodax-ai/kodax/runtime";
import { registerEndpointProvider } from "./custom-provider.ts";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Data, DomainTool, Json } from "./contracts.ts";

import type { AgentCapabilities } from "../capabilities/service.ts";

export interface RunRequest {
  nativeTools?: string[];
  capabilities?: AgentCapabilities;
  sessionId?: string;
  ephemeral?: boolean;
  title: string;
  input: string;
  system: string;
  tools: DomainTool[];
  onTool: (name: string, args: Record<string, unknown>, operationId?: string) => Promise<Json>;
  onSession: (id: string) => void;
  onEvent: (kind: string, data: Data) => void;
  authorizeTool?: (name: string, args: Record<string, unknown>) => void;
}
export interface RunOutcome {
  text: string;
  status?: "completed" | "stopped" | "timed_out" | "failed";
  error?: string;
  sessionId: string;
  runId: string;
  usage?: Json;
}
export interface AgentDriver {
  run(request: RunRequest): Promise<RunOutcome>;
  fork?(scope: string): AgentDriver;
  stop(): Promise<void>;
  close(): Promise<void>;
}
export const providers = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  zhipu: "ZHIPU_API_KEY",
  "zhipu-coding": "ZHIPU_CODING_API_KEY",
  "zai-coding": "ZAI_CODING_API_KEY",
  custom: "DATAENGINE_CUSTOM_API_KEY",
} as const;
export type Provider = keyof typeof providers;
export interface ModelSettings {
  provider: Provider;
  model: string;
  baseUrl?: string;
  protocol?: "openai" | "anthropic";
}

export function modelKeyEnvironment(settings: ModelSettings): string {
  if (settings.provider !== "custom") return providers[settings.provider];
  const identity = createHash("sha256")
    .update(`${settings.protocol}\n${settings.baseUrl}`)
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
  return `DATAENGINE_CUSTOM_${identity}_API_KEY`;
}

export function customEndpoint(body: Record<string, unknown>): {
  baseUrl: string;
  protocol: "openai" | "anthropic";
} {
  if (body.protocol !== "openai" && body.protocol !== "anthropic")
    throw new Error("请选择 OpenAI 或 Anthropic 兼容协议");
  if (typeof body.baseUrl !== "string" || body.baseUrl.length > 2048)
    throw new Error("请填写 API Base URL");
  let url: URL;
  try {
    url = new URL(body.baseUrl.trim());
  } catch {
    throw new Error("API URL 格式不正确");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  )
    throw new Error(
      "API URL 仅支持 HTTP/HTTPS，不能包含账户、密钥、查询参数或片段",
    );
  const baseUrl = url.href.replace(/\/+$/, "");
  if (/\/(chat\/completions|messages|responses)$/.test(baseUrl))
    throw new Error(
      "请填写 API 根地址，不要包含 chat/completions、messages 或 responses",
    );
  return { baseUrl, protocol: body.protocol };
}

export class KodaXDriver implements AgentDriver {
  private runtime?: KodaXRuntime;
  private customRegistrations = new Map<string, () => void>();
  private handle?: RuntimeRunHandle;
  private stopping = false;
  private directory: string;
  settings: ModelSettings;

  constructor(directory: string, settings: ModelSettings) {
    this.directory = resolve(directory);
    this.settings = settings;
    mkdirSync(join(this.directory, "workspace"), {
      recursive: true,
      mode: 0o700,
    });
  }

  fork(scope: string): AgentDriver {
    return new KodaXDriver(join(this.directory, "pools", scope), this.settings);
  }

  async initialize() {
    this.runtime ??= await createKodaXRuntime({
      mode: "embedded",
      isolation: "inline",
      homeDir: join(this.directory, "sdk-home"),
      sessionsDir: join(this.directory, "sessions"),
      profile: "dataengine",
      defaultProvider:
        this.settings.provider === "custom" ? "openai" : this.settings.provider,
      defaultModel: this.settings.model,
      permissionTimeoutMs: 10_000,
      userInputTimeoutMs: 10_000,
    });
    return this.runtime;
  }

  async run(request: RunRequest): Promise<RunOutcome> {
    this.stopping = false;
    const runtime = await this.initialize();
    let provider: string = this.settings.provider;
    if (this.settings.provider === "custom") {
      const endpoint = customEndpoint(
        this.settings as unknown as Record<string, unknown>,
      );
      const apiKeyEnv = modelKeyEnvironment(this.settings);
      provider = `dataengine-endpoint-${createHash("sha256")
        .update(this.directory + apiKeyEnv)
        .digest("hex")
        .slice(0, 20)}`;
      const customConfig = {
        name: provider,
        ...endpoint,
        apiKeyEnv,
        model: this.settings.model,
        reasoning: "none" as const,
        userAgentMode: "compat" as const,
      };
      this.customRegistrations.get(provider)?.();
      this.customRegistrations.set(
        provider,
        registerEndpointProvider(customConfig),
      );
    }
    const workspace = join(this.directory, "workspace");
    const session = request.sessionId
      ? await runtime.sessions.load(request.sessionId)
      : await runtime.sessions.create({
          title: request.title,
          projectPath: workspace,
          gitRoot: workspace,
          surface: "dataengine",
        });
    request.onSession(session.id);
    let usedTool = false;
    let textAfterTool = "";
    let operationSequence = 0;
    const toolBoundary = () => { usedTool = true; textAfterTool = ""; };
    const allowed = new Set([
      ...request.tools.map((t) => t.name),
      ...(request.nativeTools ?? []),
    ]);
    const authorize = (name: string, args: Record<string, unknown> = {}) => {
      if (this.stopping || !allowed.has(name)) throw new Error("当前运行不允许这个操作");
      request.authorizeTool?.(name, args);
    };
    const external = request.capabilities?.mcp;
    const assertExternal = () => {
      if (this.stopping || !external) throw new Error("外部能力不可用");
      return external;
    };
    const externalResult = async (
      id: string,
      args: Record<string, unknown> = {},
      permission = "mcp_call",
    ) => {
      authorize(permission, args);
      toolBoundary();
      const operationId = `operation-${++operationSequence}`;
      request.onEvent("operation.started", { id: operationId, name: id });
      try {
        const result = await assertExternal().call(id, args);
        if (this.stopping) throw new Error("已停止本次调用");
        request.onEvent("operation.completed", { id: operationId, name: id });
        return { kind: "tool" as const, content: JSON.stringify(result) };
      } catch (error) {
        request.onEvent("operation.failed", { id: operationId, name: id });
        throw error;
      }
    };
    const extension: NonNullable<RuntimeKodaXOptions["extensionRuntime"]> = {
      listRunTools: () =>
        request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          capabilityId: t.name,
          sideEffect: t.mutates ? "mutates-state" : "readonly",
          planModeAllowed: !t.mutates,
        })),
      searchCapabilities: async (provider, query, options) => {
        if (provider !== "mcp" || !external || !allowed.has("mcp_search")) return [];
        authorize("mcp_search", { query }); return external.snapshot(query, options).items.slice(0, options?.limit ?? 20);
      },
      searchCapabilitySnapshot: async (provider, query, options) => {
        if (provider !== "mcp" || !external || !allowed.has("mcp_search")) return { items: [], complete: true, freshness: "unknown" };
        authorize("mcp_search", { query }); return external.snapshot(query, options);
      },
      describeCapability: async (_provider, id) => {
        if (id.startsWith("mcp:")) { authorize("mcp_describe", { id }); return assertExternal().describe(id); }
        authorize(id); return request.tools.find(t => t.name === id);
      },
      readCapability: async (_provider, id) => {
        authorize("mcp_read_resource", { id });
        const result = await externalResult(id, {}, "mcp_read_resource");
        return { ...result, kind: "resource" };
      },
      getCapabilityPrompt: async (_provider, id, args) =>
        externalResult(id, args, "mcp_get_prompt"),
      getCapabilityPromptContext: async () => undefined,
      executeCapability: async (provider, id, args) => {
        if (provider === "mcp" && id.startsWith("mcp:"))
          return externalResult(id, args);
        if (provider !== "mcp" || !allowed.has(id) || this.stopping)
          throw new Error("当前运行不允许这个操作");
        authorize(id, args);
        toolBoundary();
        const operationId = `operation-${++operationSequence}`;
        request.onEvent("operation.started", { id: operationId, name: id });
        try {
          const result = await request.onTool(id, args, operationId);
          request.onEvent("operation.completed", { id: operationId, name: id });
          return {
            kind: "tool",
            content: JSON.stringify(result),
            structuredContent: result,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "操作失败";
          request.onEvent("operation.failed", { id: operationId, name: id, error: message });
          return {
            kind: "tool",
            content: JSON.stringify({ error: message }),
            structuredContent: { error: message },
          };
        }
      },
    };
    const subscription = runtime.events.subscribe(
      { sessionId: session.id },
      (event) => {
        const payload = event.payload as Record<string, unknown>;
        if (event.type === "tool.started") toolBoundary();
        if (event.type === "tool.started" || event.type === "tool.finished") {
          const detail = (payload.tool ?? payload.result) as
            { name?: string; id?: string } | undefined;
          if (detail?.name && request.nativeTools?.includes(detail.name))
            request.onEvent(
              event.type === "tool.started"
                ? "capability.started"
                : "capability.finished",
              { name: detail.name, ...(detail.id ? { id: detail.id } : {}) },
            );
        }
        if (event.type === "permission.requested") {
          const permission = event.payload as RuntimePermissionRequest;
          let authorized = false;
          try { authorize(permission.toolName); authorized = true; } catch { /* A revoked run must not gain a native capability. */ }
          void runtime.permissions
            .respond(
              permission.id,
              authorized
                ? { type: "allow_once" }
                : { type: "reject", reason: "仅允许当前企业工作区的操作" },
            )
            .catch(() => {});
        }
        if (
          event.type === "assistant.delta" &&
          typeof payload.text === "string"
        ) {
          textAfterTool += payload.text;
          request.onEvent("assistant.delta", { text: payload.text });
        }
        if (event.type === "run.progress" && payload.kind === "iteration_start")
          request.onEvent("run.progress", { iteration: Number(payload.iter) });
      },
    );
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      request.onEvent("run.timed_out", { reason: "运行超过240秒" });
      void this.stop().catch(() => {});
    }, 240_000);
    try {
      this.handle = await runtime.runs.start({
        sessionId: session.id,
        input: { type: "text", text: request.input },
        permissionBroker: "runtime",
        options: {
          provider,
          model: this.settings.model,
          agentMode: "sa",
          maxIter: 24,
          maxOutputTokens: 6500,
          thinking: false,
          lsp: false,
          extensionRuntime: extension,
          context: {
            gitRoot: workspace,
            executionCwd: workspace,
            systemPromptOverride: request.system,
            agentProfile: {
              surface: "dataengine",
              id: "enterprise-memory",
              name: "DataEngine 企业记忆助手",
              instructions: request.system,
            },
            toolVisibilityPolicy: (tool) => allowed.has(tool.name),
            assertReadablePath: () => {
              throw new Error("请通过企业来源对象读取资料");
            },
          },
        },
      });
      if (this.stopping) await runtime.runs.abort(this.handle.runId);
      request.onEvent("run.started", {
        runId: this.handle.runId,
        sessionId: session.id,
      });
      const result = await this.handle.result;
      const failed =
        result.phase === "failed" || result.terminal?.kind === "failed";
      return {
        sessionId: session.id,
        runId: this.handle.runId,
        status: timedOut ? "timed_out" : failed ? "failed" : this.stopping || ["cancelled", "interrupted"].includes(result.phase) ? "stopped" : "completed",
        // lastText may refer to narration before the final tool call (for example at maxIter).
        // Only text produced after that call can be the user-facing answer.
        text: usedTool ? textAfterTool : result.result?.lastText ?? "",
        ...(failed
          ? {
              error:
                result.failureDetail?.safeMessage ??
                "模型运行失败，请检查模型设置或稍后继续。",
            }
          : {}),
        ...(result.result?.usage
          ? { usage: JSON.parse(JSON.stringify(result.result.usage)) as Json }
          : {}),
      };
    } finally {
      clearTimeout(timeout);
      subscription.close();
      this.handle = undefined;
      if (request.ephemeral) await runtime.sessions.delete(session.id);
    }
  }

  async stop() {
    this.stopping = true;
    if (this.handle && this.runtime)
      await this.runtime.runs.abort(this.handle.runId);
  }
  async close() {
    await this.stop();
    try {
      await this.runtime?.close();
    } finally {
      for (const unregister of this.customRegistrations.values()) unregister();
      this.customRegistrations.clear();
    }
  }
}

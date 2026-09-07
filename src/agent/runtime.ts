import {
  createKodaXRuntime,
  type KodaXRuntime,
  type RuntimeRunHandle,
  type RuntimeKodaXOptions,
  type RuntimePermissionRequest,
} from "@kodax-ai/kodax/runtime";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Data, DomainTool, Json } from "./contracts.ts";

export interface RunRequest {
  sessionId?: string;
  title: string;
  input: string;
  system: string;
  tools: DomainTool[];
  onTool: (name: string, args: Record<string, unknown>) => Promise<Json>;
  onSession: (id: string) => void;
  onEvent: (kind: string, data: Data) => void;
}
export interface RunOutcome {
  text: string;
  error?: string;
  sessionId: string;
  runId: string;
  usage?: Json;
}
export interface AgentDriver {
  run(request: RunRequest): Promise<RunOutcome>;
  stop(): Promise<void>;
  close(): Promise<void>;
}
export const providers = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
} as const;
export type Provider = keyof typeof providers;
export interface ModelSettings {
  provider: Provider;
  model: string;
}

export class KodaXDriver implements AgentDriver {
  private runtime?: KodaXRuntime;
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

  async initialize() {
    this.runtime ??= await createKodaXRuntime({
      mode: "embedded",
      isolation: "inline",
      homeDir: join(this.directory, "sdk-home"),
      sessionsDir: join(this.directory, "sessions"),
      profile: "dataengine",
      defaultProvider: this.settings.provider,
      defaultModel: this.settings.model,
      permissionTimeoutMs: 10_000,
      userInputTimeoutMs: 10_000,
    });
    return this.runtime;
  }

  async run(request: RunRequest): Promise<RunOutcome> {
    this.stopping = false;
    const runtime = await this.initialize();
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
    const allowed = new Set(request.tools.map((t) => t.name));
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
      searchCapabilities: async () => [],
      describeCapability: async (_provider, id) =>
        request.tools.find((t) => t.name === id),
      readCapability: async () => {
        throw new Error("请使用当前工作区工具");
      },
      getCapabilityPrompt: async () => null,
      getCapabilityPromptContext: async () => undefined,
      executeCapability: async (provider, id, args) => {
        if (provider !== "mcp" || !allowed.has(id) || this.stopping)
          throw new Error("当前运行不允许这个操作");
        request.onEvent("operation.started", { name: id });
        try {
          const result = await request.onTool(id, args);
          request.onEvent("operation.completed", { name: id });
          return {
            kind: "tool",
            content: JSON.stringify(result),
            structuredContent: result,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "操作失败";
          request.onEvent("operation.failed", { name: id, error: message });
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
        if (event.type === "permission.requested") {
          const permission = event.payload as RuntimePermissionRequest;
          void runtime.permissions
            .respond(
              permission.id,
              allowed.has(permission.toolName)
                ? { type: "allow_once" }
                : { type: "reject", reason: "仅允许当前企业工作区的操作" },
            )
            .catch(() => {});
        }
        if (
          event.type === "assistant.delta" &&
          typeof payload.text === "string"
        )
          request.onEvent("assistant.delta", { text: payload.text });
        if (event.type === "run.progress" && payload.kind === "iteration_start")
          request.onEvent("run.progress", { iteration: Number(payload.iter) });
      },
    );
    const timeout = setTimeout(() => {
      void this.stop();
    }, 240_000);
    try {
      this.handle = await runtime.runs.start({
        sessionId: session.id,
        input: { type: "text", text: request.input },
        permissionBroker: "runtime",
        options: {
          provider: this.settings.provider,
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
        text: result.result?.lastText ?? "",
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
    }
  }

  async stop() {
    this.stopping = true;
    if (this.handle && this.runtime)
      await this.runtime.runs.abort(this.handle.runId);
  }
  async close() {
    await this.stop();
    await this.runtime?.close();
  }
}

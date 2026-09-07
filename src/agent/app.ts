import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, basename } from "node:path";
import { MemoryStore } from "./memory.ts";
import { Workspace, domainTools } from "./workspace.ts";
import { ObjectView } from "./domain-objects.ts";
import {
  KodaXDriver,
  providers,
  type AgentDriver,
  type ModelSettings,
  type Provider,
} from "./runtime.ts";
import type {
  Artifact,
  Data,
  DomainTool,
  Json,
  Task,
  WriteContext,
} from "./contracts.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const system = readFileSync(join(ROOT, "config/agent/system.md"), "utf8");
const string = (value: unknown, label: string, max = 12000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label} 不能为空且不能超过 ${max} 字`);
  return value.trim();
};
const serializable = (value: unknown): Json =>
  JSON.parse(JSON.stringify(value)) as Json;
const objectSchema = (
  properties: Record<string, unknown>,
  required: string[],
) => ({ type: "object", properties, required, additionalProperties: false });
const controlTools: DomainTool[] = [
  {
    name: "task_checkpoint",
    description: "保存当前任务的工作摘要与下一步；成果引用由真实保存自动记录。",
    mutates: true,
    inputSchema: objectSchema({ nextStep: { type: "string" } }, ["nextStep"]),
  },
  {
    name: "task_ask",
    description:
      "保存具体待补充问题并等待用户；本体采用问题带 candidateId/version。成功后只收尾，不再调用其他工具。",
    mutates: true,
    inputSchema: objectSchema(
      {
        question: { type: "string" },
        reason: { type: "string" },
        candidateId: { type: "string" },
        version: { type: "integer" },
      },
      ["question", "reason"],
    ),
  },
  {
    name: "task_complete",
    description:
      "交付完成时引用已经保存的本任务成果，保存完成状态。成功后只收尾，不再调用工具。",
    mutates: true,
    inputSchema: objectSchema(
      {
        artifactIds: { type: "array", items: { type: "string" } },
        summary: { type: "string" },
      },
      ["artifactIds", "summary"],
    ),
  },
];

export class AgentApplication {
  readonly memory: MemoryStore;
  readonly driver: AgentDriver;
  private actualDriver?: KodaXDriver;
  private active?: { context: WriteContext; promise: Promise<void> };
  private modelTest = false;
  private streaming = "";
  private settings: ModelSettings;
  private injected: boolean;

  constructor(directory: string, driver?: AgentDriver) {
    this.memory = new MemoryStore(directory);
    const saved = this.memory.getSettings();
    const provider = (
      typeof saved.provider === "string" && saved.provider in providers
        ? saved.provider
        : "deepseek"
    ) as Provider;
    this.settings = {
      provider,
      model:
        typeof saved.model === "string" ? saved.model : "deepseek-v4-flash",
    };
    this.injected = !!driver;
    this.actualDriver = driver
      ? undefined
      : new KodaXDriver(join(directory, "runtime"), this.settings);
    this.driver = driver ?? this.actualDriver!;
  }

  model() {
    return {
      ...this.settings,
      configured:
        this.injected || !!process.env[providers[this.settings.provider]],
      sdkVersion: "0.7.96-beta.2",
    };
  }
  state(taskId?: string) {
    const tasks = this.memory.listTasks();
    const task = taskId ? this.memory.getTask(taskId) : (tasks[0] ?? null);
    return {
      model: this.model(),
      task,
      tasks,
      artifacts: this.memory.listArtifacts(),
      messages: task ? this.memory.messages(task.id) : [],
      events: task ? this.memory.events(task.id) : [],
      busy: !!this.active || this.modelTest,
      streaming: task?.id === this.active?.context.taskId ? this.streaming : "",
    };
  }

  async idle() {
    await this.active?.promise;
  }

  private async stopActive(reason = "已暂停，已保存成果保留。") {
    if (!this.active) return;
    const active = this.active;
    this.memory.pauseTask(active.context.taskId, reason);
    await this.driver.stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        active.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("运行尚未结束，请稍后继续")),
            10_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async stop(taskId: string) {
    if (this.active?.context.taskId === taskId) await this.stopActive();
    else this.memory.pauseTask(taskId);
    return { task: this.memory.getTask(taskId) };
  }

  async message(
    body: Record<string, unknown>,
  ): Promise<{ task: Task; artifact?: Artifact }> {
    if (this.modelTest) throw new Error("正在测试模型连接，请稍后发送");
    const text = string(body.text, "消息");
    const messageId =
      typeof body.messageId === "string"
        ? string(body.messageId, "消息标识", 150)
        : randomUUID();
    const previous = this.memory.getMessage(messageId);
    if (previous) {
      if (
        previous.content !== text ||
        previous.role !== "user" ||
        (body.taskId !== undefined && body.taskId !== previous.taskId)
      )
        throw new Error("消息标识已使用");
      return { task: this.memory.getTask(previous.taskId) };
    }
    const focusVersion =
      body.focusVersion === undefined ? undefined : Number(body.focusVersion);
    if (
      focusVersion !== undefined &&
      (!Number.isInteger(focusVersion) || focusVersion < 1)
    )
      throw new Error("无效的来源版本");
    const focus =
      typeof body.focusId === "string"
        ? this.memory.getArtifact(body.focusId, focusVersion)
        : undefined;
    await this.stopActive("已收到新的输入，按更新后的任务继续。");
    const task =
      typeof body.taskId === "string"
        ? this.memory.getTask(body.taskId)
        : this.memory.createTask(text.slice(0, 160));
    const adoptsCandidate =
      task.pending?.candidateId &&
      /^(?:采用这版|确认采用|采用当前候选|采用这个候选|我确认采用这版)[。！!]?$/u.test(
        text,
      );
    if (
      adoptsCandidate &&
      focus &&
      (focus.id !== task.pending!.candidateId ||
        focus.version !== task.pending!.version)
    ) {
      const reason = "当前引用与待决定的候选版本不同，请打开具体候选后再决定";
      this.memory.restoreWaiting(task.id, task.pending!, reason);
      throw new Error(reason);
    }
    const message = this.memory.addMessage(task.id, "user", text, messageId);
    if (text === "使用最新资料继续") {
      this.memory.clearInvestigation(
        task.id,
        "用户明确要求使用最新资料与本体继续。",
      );
    }
    if (adoptsCandidate && task.pending) {
      return this.decision({
        taskId: task.id,
        candidateId: task.pending.candidateId,
        version: task.pending.version,
        decision: "adopt",
      });
    }
    if (!this.model().configured) {
      this.memory.pauseTask(task.id, "请先配置模型，消息和资料已保存。");
      return { task: this.memory.getTask(task.id) };
    }
    this.launch(
      task.id,
      `当前用户消息（id=${message.id}）：${text}${task.pending ? `\n此前待用户决定：${JSON.stringify(task.pending)}` : ""}`,
      focus,
    );
    return { task: this.memory.getTask(task.id) };
  }

  private launch(taskId: string, input: string, focus?: Artifact) {
    const context = this.memory.beginExecution(taskId);
    this.streaming = "";
    // Publish the active slot before the SDK can invoke tools or another request arrives.
    const promise = Promise.resolve().then(() =>
      this.run(context, input, focus),
    );
    this.active = { context, promise };
    void promise
      .finally(() => {
        if (this.active?.context.executionId === context.executionId)
          this.active = undefined;
      })
      .catch(() => {});
  }

  private async run(context: WriteContext, input: string, focused?: Artifact) {
    const task = this.memory.getTask(context.taskId);
    const workspace = new Workspace(this.memory, context);
    let closingTimer: ReturnType<typeof setTimeout> | undefined;
    let failure: string | undefined;
    let lastWrite: { signature: string; operationId: string } | undefined;
    let writeSequence = 0;
    const startClosing = () => {
      closingTimer ??= setTimeout(() => {
        void this.driver.stop();
      }, 15_000);
    };
    try {
      const outcome = await this.driver.run({
        sessionId: task.sessionId ?? undefined,
        title: task.goal,
        system,
        tools: [...domainTools, ...controlTools],
        input: JSON.stringify({
          task: {
            goal: task.goal,
            nextStep: task.nextStep,
            artifactRefs: task.artifactRefs,
            investigation: task.investigation ?? null,
          },
          enterprise: workspace.overview(),
          focus: focused
            ? {
                id: focused.id,
                version: focused.version,
                title: focused.title,
                kind: focused.kind,
              }
            : null,
          recentMessages: this.memory.messages(task.id).slice(-8),
          input,
        }),
        onSession: (id) => {
          this.memory.session(task.id, id);
        },
        onEvent: (kind, data) => {
          if (kind === "assistant.delta") {
            this.streaming += String(data.text);
            return;
          }
          this.memory.event(task.id, kind, data);
        },
        onTool: async (name, args) => {
          try {
            this.memory.assertWritable(context);
          } catch (error) {
            void this.driver.stop();
            throw error;
          }
          if (name === "task_checkpoint")
            return serializable(
              this.memory.checkpoint(
                context,
                string(args.nextStep, "下一步", 3000),
              ),
            );
          if (name === "task_ask") {
            const pending: Data = {
              question: string(args.question, "问题", 3000),
              reason: string(args.reason, "原因", 3000),
            };
            if (args.candidateId) {
              const candidate = this.memory.getArtifact(
                string(args.candidateId, "候选"),
                Number(args.version),
              );
              if (
                candidate.kind !== "ontology" ||
                candidate.status !== "candidate"
              )
                throw new Error("需要有效本体候选");
              pending.candidateId = candidate.id;
              pending.version = candidate.version;
            }
            const result = this.memory.ask(context, pending);
            startClosing();
            return serializable(result);
          }
          if (name === "task_complete") {
            if (
              !Array.isArray(args.artifactIds) ||
              !args.artifactIds.every((id) => typeof id === "string")
            )
              throw new Error("需要成果引用列表");
            const result = this.memory.complete(
              context,
              args.artifactIds,
              string(args.summary, "交付说明", 3000),
            );
            startClosing();
            return serializable(result);
          }
          const signature = createHash("sha256")
            .update(name + JSON.stringify(args))
            .digest("hex");
          const mutates = domainTools.find(
            (tool) => tool.name === name,
          )?.mutates;
          const operationId = mutates
            ? lastWrite?.signature === signature
              ? lastWrite.operationId
              : `write-${++writeSequence}`
            : undefined;
          const result = await workspace.execute(name, args, operationId);
          if (mutates && operationId) lastWrite = { signature, operationId };
          return result;
        },
      });
      failure = outcome.error
        ? this.safeError(new Error(outcome.error))
        : undefined;
      if (outcome.text.trim())
        this.memory.addMessage(task.id, "assistant", outcome.text);
      else if (this.memory.getTask(task.id).pending)
        this.memory.addMessage(
          task.id,
          "assistant",
          String(this.memory.getTask(task.id).pending?.question),
        );
      this.memory.event(task.id, "run.result", {
        runId: outcome.runId,
        sessionId: outcome.sessionId,
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        ...(failure ? { error: failure } : {}),
      });
    } catch (error) {
      failure = this.safeError(error);
      this.memory.addMessage(
        task.id,
        "assistant",
        `本次执行未完成：${failure}。已保存的资料和成果仍然可以查看。`,
      );
    } finally {
      if (closingTimer) clearTimeout(closingTimer);
      this.memory.endExecution(context, failure);
      this.streaming = "";
    }
  }

  safeError(error: unknown): string {
    let text = error instanceof Error ? error.message : "操作失败";
    for (const env of Object.values(providers)) {
      const key = process.env[env];
      if (key) text = text.split(key).join("[凭据已隐藏]");
    }
    return text.slice(0, 600);
  }

  async upload(body: Record<string, unknown>) {
    if (this.modelTest) throw new Error("正在测试连接，请稍后上传");
    await this.stopActive("资料已变化，将使用更新后的来源继续。");
    const workspace = new Workspace(this.memory);
    const artifact = workspace.upload(
      string(body.name, "文件名", 180),
      typeof body.content === "string" ? body.content : "",
    );
    const task =
      typeof body.taskId === "string"
        ? this.memory.getTask(body.taskId)
        : this.memory.createTask("读取资料，形成企业理解并说明下一步");
    this.memory.clearInvestigation(
      task.id,
      "当前任务接入了新资料，下一次调查使用最新依据。",
    );
    this.memory.attachArtifact(task.id, artifact);
    const text = `已上传资料：${artifact.title}（版本 ${artifact.version}）。请检查内容，更新企业理解并说明与当前目标相关的缺口。`;
    this.memory.addMessage(task.id, "user", text);
    if (this.model().configured) this.launch(task.id, text, artifact);
    return { artifact, task: this.memory.getTask(task.id) };
  }

  async sample(body: Record<string, unknown>) {
    if (this.modelTest) throw new Error("正在测试连接，请稍后接入示例");
    await this.stopActive();
    const directory = join(ROOT, "data/samples/chengchuan-heating");
    const manifest = JSON.parse(
      readFileSync(join(directory, "manifest.json"), "utf8"),
    ) as { files: { path: string }[] };
    const workspace = new Workspace(this.memory);
    const task =
      typeof body.taskId === "string"
        ? this.memory.getTask(body.taskId)
        : this.memory.createTask("建立澄川热力企业理解，并准备投诉处理复盘");
    this.memory.clearInvestigation(
      task.id,
      "当前任务接入了示例资料，下一次调查使用最新依据。",
    );
    const artifacts = manifest.files.map((file) =>
      workspace.upload(
        basename(file.path),
        readFileSync(join(directory, file.path), "utf8"),
      ),
    );
    for (const artifact of artifacts)
      this.memory.attachArtifact(task.id, artifact);
    const text =
      "已接入虚构澄川热力的原始示例资料。请先阅读企业说明和相关业务规则，保存企业理解，再提出一个适合验证的投诉复盘任务。";
    this.memory.addMessage(task.id, "user", text);
    if (this.model().configured) this.launch(task.id, text);
    return { artifacts, task: this.memory.getTask(task.id) };
  }

  async decision(
    body: Record<string, unknown>,
  ): Promise<{ task: Task; artifact?: Artifact }> {
    if (this.modelTest) throw new Error("正在测试连接，请稍后处理候选");
    const taskId = string(body.taskId, "任务");
    const task = this.memory.getTask(taskId);
    const candidateId = string(body.candidateId, "候选");
    const version = Number(body.version);
    if (
      task.pending?.candidateId !== candidateId ||
      task.pending?.version !== version
    )
      throw new Error("该决定不对应当前等待的候选版本");
    await this.stopActive("正在处理用户的本体决定。");
    if (body.decision === "reject")
      return this.message({
        taskId,
        text: "我暂不采用这份本体候选。请保留草稿，说明可以怎样修改。",
      });
    if (body.decision !== "adopt") throw new Error("无效的决定");
    this.memory.event(taskId, "decision.received", {
      candidateId,
      version,
      decision: "adopt",
    });
    try {
      const artifact = new Workspace(this.memory).adopt(candidateId, version);
      this.memory.attachArtifact(taskId, artifact);
      this.memory.clearInvestigation(taskId, "当前任务已采用新的本体版本。");
      return {
        ...(await this.message({
          taskId,
          text: `我已采用刚才展示的本体候选，应用确认当前模型为 ${artifact.id} 版本 ${artifact.version}。请按原任务继续。`,
        })),
        artifact,
      };
    } catch (error) {
      this.memory.restoreWaiting(taskId, task.pending!, this.safeError(error));
      this.memory.event(taskId, "decision.failed", {
        candidateId,
        version,
        error: this.safeError(error),
      });
      throw error;
    }
  }

  async editProfile(body: Record<string, unknown>) {
    if (this.modelTest) throw new Error("正在测试连接，请稍后编辑");
    const id = string(body.id, "企业理解标识");
    const expectedVersion = Number(body.expectedVersion);
    await this.stopActive("用户已纠正企业理解。");
    const current = this.memory.getArtifact(id);
    if (current.kind !== "profile" || current.version !== expectedVersion)
      throw new Error("企业理解版本已变化，请重新打开后再编辑");
    const artifact = new Workspace(this.memory).editProfile(
      string(body.key, "陈述标识", 200),
      string(body.text, "陈述内容", 5000),
    );
    return { artifact };
  }

  async configure(body: Record<string, unknown>) {
    if (this.active || this.modelTest)
      throw new Error("请先停止当前运行再修改模型设置");
    if (typeof body.provider !== "string" || !(body.provider in providers))
      throw new Error("不支持的模型服务");
    const provider = body.provider as Provider;
    const model = string(body.model, "模型名称", 120);
    if (body.apiKey !== undefined && typeof body.apiKey !== "string")
      throw new Error("API Key 应为文本");
    if (typeof body.apiKey === "string" && body.apiKey.trim())
      process.env[providers[provider]] = body.apiKey.trim();
    this.settings = { provider, model };
    this.memory.saveSettings({ ...this.settings });
    if (this.actualDriver) this.actualDriver.settings = this.settings;
    return { model: this.model() };
  }

  objectDetails(query: URLSearchParams) {
    const artifact = this.memory.getArtifact(
      string(query.get("artifactId"), "成果"),
      Number(query.get("version")),
    );
    let model: Artifact;
    let versions: Record<string, number>;
    if (artifact.kind === "report") {
      const ref = artifact.content.model as Data;
      model = this.memory.getArtifact(String(ref.id), Number(ref.version));
      versions = artifact.content.sourceVersions as Record<string, number>;
    } else {
      if (
        artifact.kind !== "ontology" ||
        !artifact.content.preview ||
        !(artifact.content.validation as Data)?.valid
      )
        throw new Error("需要已检查的本体或已保存的调查报告");
      model = artifact;
      versions = artifact.content.sourceVersions as Record<string, number>;
    }
    const view = new ObjectView(this.memory, model, versions);
    if (
      artifact.kind === "report" &&
      view.snapshot !== artifact.content.snapshot
    )
      throw new Error("报告的对象快照不匹配");
    const type = query.get("type");
    const id = query.get("id");
    const relation = query.get("relation");
    const operations: Data[] = [];
    if (type)
      operations.push(
        id
          ? { op: "get", type, id, as: "target" }
          : {
              op: "query",
              type,
              offset: Number(query.get("offset") ?? 0),
              limit: Math.min(100, Number(query.get("limit") ?? 20)),
              as: "target",
            },
      );
    if (relation) {
      if (!type || !id) throw new Error("展开关系需要具体对象");
      operations.push({
        op: "related",
        input: "$target",
        relation,
        as: "related",
      });
    }
    const results = operations.length
      ? (view.execute(operations).results as Data)
      : {};
    return {
      snapshot: view.snapshot,
      model: { id: model.id, version: model.version, status: model.status },
      sourceVersions: view.sourceVersions,
      types: view.definition.types.map((t) => ({
        ...t,
        relations: view.definition.relations.filter((r) => r.from === t.name),
        methods: view.definition.functions.filter((f) => f.type === t.name),
      })),
      result: results.target ?? null,
      ...(results.related ? { related: results.related } : {}),
    };
  }

  async refresh(body: Record<string, unknown>) {
    return this.message({
      taskId: string(body.taskId, "任务"),
      text: "使用最新资料继续",
      messageId: body.messageId ?? randomUUID(),
    });
  }

  async testConnection() {
    if (this.active || this.modelTest) throw new Error("请等待当前运行结束");
    if (!this.model().configured) throw new Error("请先配置 API Key");
    this.modelTest = true;
    try {
      const result = await this.driver.run({
        title: "模型连接检查",
        system: "请用中文简短回答。",
        input: "只回复：连接成功。",
        tools: [],
        onTool: async () => {
          throw new Error("连接检查没有工具");
        },
        onSession: () => {},
        onEvent: () => {},
      });
      if (result.error || !result.text.trim())
        throw new Error(result.error ?? "模型没有返回内容");
      return { ok: true, message: result.text };
    } finally {
      this.modelTest = false;
    }
  }

  async close() {
    await this.stopActive();
    await this.driver.close();
    this.memory.close();
  }
}

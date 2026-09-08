import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, basename } from "node:path";
import { MemoryStore } from "./memory.ts";
import { Workspace, domainTools } from "./workspace.ts";
import { ObjectView } from "./domain-objects.ts";
import { ConsumptionService, consumptionTools } from "./consumption.ts";
import {
  KodaXDriver,
  providers,
  type AgentDriver,
  type ModelSettings,
  type Provider,
} from "./runtime.ts";
import type {
  Artifact,
  CanvasPage,
  CanvasProgress,
  Data,
  DomainTool,
  Json,
  Repository,
  Task,
  WriteContext,
} from "./contracts.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const system = readFileSync(join(ROOT, "config/agent/system.md"), "utf8");
const canvasSystem = readFileSync(join(ROOT, "config/agent/canvas.md"), "utf8");
const canvasPages: CanvasPage[] = [
  "company",
  "sources",
  "ontology",
  "consumption",
];
const canvasPrompts: Record<CanvasPage, string> = {
  company: "你的企业叫什么？",
  sources: "上传第一份企业资料。",
  ontology: "从哪些业务对象开始？",
  consumption: "哪些应用需要使用这些企业记忆？",
};
const pageCompleteTool: DomainTool = {
  name: "page_complete",
  description:
    "完成当前页。必须先保存有依据的企业名称与业务，或实际检查有记录的 CSV；本体页必须用户已采用。成功后只简短收尾，不再调用工具。",
  mutates: true,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
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
        consumerId: { type: "string" },
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
  readonly consumption: ConsumptionService;
  readonly driver: AgentDriver;
  private actualDriver?: KodaXDriver;
  private active?: { context: WriteContext; promise: Promise<void> };
  private modelTest = false;
  private streaming = "";
  private settings: ModelSettings;
  private injected: boolean;

  constructor(directory: string, driver?: AgentDriver) {
    this.memory = new MemoryStore(directory);
    this.consumption = new ConsumptionService(directory, this.memory);
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

  private canvasProgress(): CanvasProgress {
    const saved = this.memory.getCanvas();
    if (saved) {
      const adopted = this.memory
        .listArtifacts("ontology")
        .some((a) => a.status === "adopted");
      if (adopted && !saved.reached.includes("consumption")) {
        saved.reached = [...new Set([...saved.reached, ...canvasPages])];
        for (const id of ["company", "sources", "ontology"] as CanvasPage[])
          if (!saved.completed.includes(id)) saved.completed.push(id);
        this.memory.saveCanvas(saved);
      }
      return saved;
    }
    // Existing spaces keep their saved memory; the new canvas does not reset them.
    const completed: CanvasPage[] = [];
    const hasModel = this.memory.listArtifacts("ontology").length > 0;
    if (this.companyReady() || hasModel) completed.push("company");
    if ((completed.length && this.sourcesReady()) || hasModel)
      completed.push("sources");
    if (
      this.memory.listArtifacts("ontology").some((a) => a.status === "adopted")
    )
      completed.push("ontology");
    const currentPage = canvasPages[Math.min(completed.length, 2)];
    const progress: CanvasProgress = {
      currentPage,
      completed,
      reached: canvasPages.slice(
        0,
        completed.includes("ontology")
          ? 4
          : canvasPages.indexOf(currentPage) + 1,
      ),
      taskIds: {},
    };
    this.memory.saveCanvas(progress);
    return progress;
  }

  private companyReady(): boolean {
    const profile = this.memory.listArtifacts("profile")[0];
    const statements = (profile?.content.statements ?? []) as Data[];
    const has = (keys: string[]) =>
      statements.some(
        (statement) =>
          keys.includes(String(statement.key)) &&
          ["user", "source"].includes(String(statement.origin)) &&
          typeof statement.text === "string" &&
          statement.text.trim().length > 1 &&
          !/^(未知|待定|未提供|不知道|无|公司|企业)$/.test(
            statement.text.trim(),
          ),
      );
    return (
      has([
        "company.name",
        "company_name",
        "enterprise.name",
        "name",
        "企业名称",
        "公司名称",
      ]) &&
      has([
        "company.business",
        "company_business",
        "enterprise.business",
        "business",
        "主营业务",
        "业务",
        "业务范围",
      ])
    );
  }

  private sourcesReady(): boolean {
    return this.memory
      .listArtifacts("source")
      .some(
        (source) =>
          source.status === "ready" &&
          source.content.format === "csv" &&
          Array.isArray(source.content.rows) &&
          source.content.rows.length > 0,
      );
  }

  private canvasPage(value?: unknown): CanvasPage {
    const progress = this.canvasProgress();
    const page = value ?? progress.currentPage;
    if (!canvasPages.includes(page as CanvasPage)) throw new Error("无效页面");
    if (!progress.reached.includes(page as CanvasPage))
      throw new Error("请先完成前一页");
    return page as CanvasPage;
  }

  private canvasTask(page: CanvasPage): Task {
    const progress = this.canvasProgress();
    let taskId = progress.taskIds[page];
    if (!taskId) {
      taskId = this.memory.createTask(
        {
          company: "建立企业信息",
          sources: "接入企业资料",
          ontology: "建立本体与对象",
          consumption: "管理企业记忆消费",
        }[page],
      ).id;
      progress.taskIds[page] = taskId;
      this.memory.saveCanvas(progress);
    }
    return this.memory.getTask(taskId);
  }

  canvasState(value?: unknown) {
    const page = this.canvasPage(value);
    const progress = this.canvasProgress();
    const task = progress.taskIds[page]
      ? this.memory.getTask(progress.taskIds[page]!)
      : null;
    const pending = task?.pending;
    const profile = this.memory.listArtifacts("profile")[0] ?? null;
    const sources = this.memory.listArtifacts("source");
    const ontologies = this.memory.listArtifacts("ontology");
    const consumers = this.consumption.list();
    const prompt =
      page === "company" && this.companyReady()
        ? "有哪些企业信息需要调整？"
        : page === "sources" && sources.length
          ? "还需要接入哪些资料？"
          : page === "ontology" && ontologies.length
            ? "想查看或调整哪些对象？"
            : page === "consumption" && consumers.length
              ? "哪些访问范围需要调整？"
              : canvasPrompts[page];
    return {
      currentPage: progress.currentPage,
      page,
      pages: canvasPages.map((id) => ({
        id,
        ready: progress.completed.includes(id),
        available: progress.reached.includes(id),
      })),
      model: this.model(),
      busy: !!this.active || this.modelTest,
      streaming: task?.id === this.active?.context.taskId ? this.streaming : "",
      messages: task
        ? this.memory
            .messages(task.id)
            .map(({ id, role, content }) => ({ id, role, content }))
        : [],
      prompt: String(
        pending?.question ??
          (!this.model().configured
            ? "先配置模型，就可以开始创建企业记忆。"
            : prompt),
      ),
      profile,
      sources,
      ontologies,
      consumers,
      accessLogs: page === "consumption" ? this.consumption.logs() : [],
      pending: pending
        ? {
            question: pending.question,
            ...(pending.consumerId
              ? { consumerId: pending.consumerId, version: pending.version }
              : {}),
            ...(pending.candidateId
              ? { candidateId: pending.candidateId, version: pending.version }
              : {}),
          }
        : null,
    };
  }

  async canvasNavigate(body: Record<string, unknown>) {
    const page = this.canvasPage(body.page);
    await this.stopActive("已切换页面，保存的内容保留。");
    const progress = this.canvasProgress();
    progress.currentPage = page;
    this.memory.saveCanvas(progress);
    return this.canvasState(page);
  }

  async canvasStop(body: Record<string, unknown>) {
    const page = this.canvasPage(body.page);
    const taskId = this.canvasProgress().taskIds[page];
    if (taskId) await this.stop(taskId);
    return this.canvasState(page);
  }

  async canvasMessage(
    body: Record<string, unknown>,
  ): Promise<ReturnType<AgentApplication["canvasState"]>> {
    if (this.modelTest) throw new Error("正在测试连接，请稍后发送");
    const page = this.canvasPage(body.page);
    if (page !== this.canvasProgress().currentPage)
      throw new Error("页面已变化，请回到当前页面后继续");
    const text = string(body.text, "消息", 6000);
    const messageId =
      body.messageId === undefined
        ? randomUUID()
        : string(body.messageId, "消息标识", 150);
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
    if (
      focus &&
      ![
        "profile",
        "source",
        "ontology",
        ...(page === "consumption" ? ["consumer"] : []),
      ].includes(focus.kind)
    )
      throw new Error("当前页面不支持此内容");
    const task = this.canvasTask(page);
    if (this.memory.hasMessageReceipt(messageId, task.id, "user", text))
      return this.canvasState();
    const previous = this.memory.getMessage(messageId);
    if (previous) {
      if (
        previous.taskId !== task.id ||
        previous.content !== text ||
        previous.role !== "user"
      )
        throw new Error("消息标识已使用");
      return this.canvasState();
    }
    if (
      task.pending?.candidateId &&
      /^(?:采用这版|确认采用|采用当前候选|采用这个候选|我确认采用这版)[。！!]?$/u.test(
        text,
      )
    ) {
      if (
        focus &&
        (focus.id !== task.pending.candidateId ||
          focus.version !== task.pending.version)
      )
        throw new Error(
          "当前引用与待决定的候选版本不同，请打开具体候选后再决定",
        );
      await this.stopActive("正在保存你的决定。");
      this.memory.addMessage(task.id, "user", text, messageId);
      return this.canvasDecision({
        page,
        candidateId: task.pending.candidateId,
        version: task.pending.version,
        decision: "adopt",
      });
    }
    await this.stopActive("已收到新的输入。");
    const message = this.memory.addMessage(task.id, "user", text, messageId);
    this.memory.trimMessages(task.id);
    if (!this.model().configured)
      this.memory.pauseTask(task.id, "请先配置模型，内容已保存。");
    else
      this.launch(
        task.id,
        `请处理本页最新的用户消息 ${message.id}。`,
        focus,
        page,
      );
    return this.canvasState(page);
  }

  async canvasUpload(body: Record<string, unknown>) {
    if (this.modelTest) throw new Error("正在测试连接，请稍后上传");
    const page = this.canvasPage(body.page);
    if (page === "consumption") throw new Error("请在数据页接入资料。");
    if (page !== this.canvasProgress().currentPage)
      throw new Error("页面已变化，请回到当前页面后继续");
    await this.stopActive("正在接入资料。");
    const artifact = new Workspace(this.memory).upload(
      string(body.name, "文件名", 180),
      typeof body.content === "string" ? body.content : "",
    );
    const task = this.canvasTask(page);
    this.memory.clearInvestigation(task.id, "已接入新资料。");
    this.memory.attachArtifact(task.id, artifact);
    this.memory.addMessage(
      task.id,
      "user",
      `我上传了 ${artifact.title}，请查看资料并继续当前页。`,
    );
    this.memory.trimMessages(task.id);
    if (this.model().configured)
      this.launch(
        task.id,
        "请检查最新上传的资料并继续当前页。",
        artifact,
        page,
      );
    return this.canvasState(page);
  }

  async canvasDecision(
    body: Record<string, unknown>,
  ): Promise<ReturnType<AgentApplication["canvasState"]>> {
    if (this.modelTest) throw new Error("正在测试连接，请稍后处理");
    const page = this.canvasPage(body.page);
    if (page !== "ontology" || this.canvasProgress().currentPage !== page)
      throw new Error("请在本体页面处理候选");
    const task = this.canvasTask(page);
    const candidateId = string(body.candidateId, "候选");
    const version = Number(body.version);
    if (
      task.pending?.candidateId !== candidateId ||
      task.pending.version !== version
    )
      throw new Error("该决定不对应当前等待的候选版本");
    if (!["adopt", "reject"].includes(String(body.decision)))
      throw new Error("无效的决定");
    await this.stopActive("正在保存你的决定。");
    if (body.decision === "reject")
      return this.canvasMessage({
        page,
        text: "暂不采用这版，请问我最需要调整的地方。",
      });
    try {
      const artifact = new Workspace(this.memory).adopt(candidateId, version);
      this.memory.attachArtifact(task.id, artifact);
      this.memory.clearInvestigation(task.id, "已采用本体。");
      const progress = this.canvasProgress();
      if (!progress.completed.includes("ontology"))
        progress.completed.push("ontology");
      this.memory.saveCanvas(progress);
      this.memory.addMessage(task.id, "user", "采用这版本体。");
      this.memory.addMessage(
        task.id,
        "assistant",
        "已采用。现在可以查看企业的对象和关系。",
      );
      this.memory.dismissPending(task.id);
      this.memory.trimMessages(task.id);
      return this.canvasState(page);
    } catch (error) {
      this.memory.restoreWaiting(task.id, task.pending!, this.safeError(error));
      throw error;
    }
  }

  async activateConsumer(body: Record<string, unknown>) {
    if (this.canvasProgress().currentPage !== "consumption")
      throw new Error("请在数据消费页启用访问");
    const id = string(body.id, "调用方");
    const version = Number(body.version);
    const task = this.canvasTask("consumption");
    if (task.pending?.consumerId !== id || task.pending.version !== version)
      throw new Error("该授权不对应当前待确认版本，请查看最新范围");
    await this.stopActive("正在保存你的授权。");
    const result = this.consumption.activate(id, version);
    this.memory.attachArtifact(task.id, result.consumer);
    this.memory.dismissPending(task.id);
    this.memory.addMessage(
      task.id,
      "assistant",
      "已启用这组访问范围。接入凭据在单独的窗口中交付。",
    );
    this.memory.trimMessages(task.id);
    const progress = this.canvasProgress();
    if (!progress.completed.includes("consumption"))
      progress.completed.push("consumption");
    this.memory.saveCanvas(progress);
    return {
      ...this.canvasState("consumption"),
      credential: {
        consumerId: result.consumer.id,
        apiKey: result.apiKey,
        endpoint: "/v1/objects",
      },
    };
  }

  async revokeConsumer(body: Record<string, unknown>) {
    if (this.canvasProgress().currentPage !== "consumption")
      throw new Error("请在数据消费页停用访问");
    const id = string(body.id, "调用方");
    const version = Number(body.version);
    const consumer = this.consumption.revoke(id, version);
    // Access is revoked before contacting the model. A stalled provider must
    // never delay an owner's decision to stop data access.
    void this.stopActive("访问已停用，正在结束当前对话。").catch(() => {});
    const task = this.canvasTask("consumption");
    this.memory.attachArtifact(task.id, consumer);
    if (task.pending?.consumerId === id) this.memory.dismissPending(task.id);
    this.memory.addMessage(
      task.id,
      "assistant",
      "该调用方已停用，下一次 API 请求会被拒绝。",
    );
    this.memory.trimMessages(task.id);
    return this.canvasState("consumption");
  }

  private canvasWorkspace(context: WriteContext, page: CanvasPage): Workspace {
    const kinds =
      page === "consumption"
        ? ["profile", "ontology", "consumer"]
        : page === "ontology"
          ? ["profile", "source", "ontology"]
          : ["profile", "source"];
    const repository: Repository = {
      listArtifacts: (kind) =>
        this.memory.listArtifacts(kind).filter((a) => kinds.includes(a.kind)),
      getArtifact: (id, version) => {
        const artifact = this.memory.getArtifact(id, version);
        if (!kinds.includes(artifact.kind))
          throw new Error("当前页面不支持此内容");
        return artifact;
      },
      putArtifact: (input, writeContext, operationId) => {
        if (!kinds.includes(input.kind))
          throw new Error("当前页面不支持保存此内容");
        return this.memory.putArtifact(input, writeContext, operationId);
      },
      getMessage: (id) => this.memory.getMessage(id),
      getInvestigation: (id) => this.memory.getInvestigation(id),
      bindInvestigation: (writeContext, scope) =>
        this.memory.bindInvestigation(writeContext, scope),
    };
    return new Workspace(repository, context);
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

  private launch(
    taskId: string,
    input: string,
    focus?: Artifact,
    page?: CanvasPage,
  ) {
    const context = this.memory.beginExecution(taskId);
    this.streaming = "";
    // Publish the active slot before the SDK can invoke tools or another request arrives.
    const promise = Promise.resolve().then(() =>
      this.run(context, input, focus, page),
    );
    this.active = { context, promise };
    void promise
      .finally(() => {
        if (this.active?.context.executionId === context.executionId)
          this.active = undefined;
      })
      .catch(() => {});
  }

  private async run(
    context: WriteContext,
    input: string,
    focused?: Artifact,
    page?: CanvasPage,
  ) {
    const task = this.memory.getTask(context.taskId);
    const workspace = page
      ? this.canvasWorkspace(context, page)
      : new Workspace(this.memory, context);
    const tools = page
      ? [
          ...domainTools.filter((tool) =>
            [
              "workspace_overview",
              "memory_read",
              ...(page !== "consumption" ? ["profile_update"] : []),
              ...(page === "ontology"
                ? ["ontology_propose", "ontology_preview", "object_execute"]
                : []),
            ].includes(tool.name),
          ),
          ...controlTools.filter((tool) => tool.name === "task_ask"),
          ...(page === "consumption" ? consumptionTools : [pageCompleteTool]),
        ]
      : [...domainTools, ...controlTools];
    let pageCompleted = false;
    const inspectedSources = new Map<string, number>();
    let closingTimer: ReturnType<typeof setTimeout> | undefined;
    let failure: string | undefined;
    let lastWrite: { signature: string; operationId: string } | undefined;
    let writeSequence = 0;
    const startClosing = () => {
      closingTimer ??= setTimeout(() => {
        void this.driver.stop().catch(() => {});
      }, 15_000);
    };
    try {
      const outcome = await this.driver.run({
        sessionId: page ? undefined : (task.sessionId ?? undefined),
        title: task.goal,
        system: page ? canvasSystem : system,
        tools,
        input: JSON.stringify({
          ...(page
            ? { page }
            : {
                task: {
                  goal: task.goal,
                  nextStep: task.nextStep,
                  artifactRefs: task.artifactRefs,
                  investigation: task.investigation ?? null,
                },
              }),
          enterprise: workspace.overview(),
          ...(page === "consumption"
            ? {
                consumption: {
                  consumers: this.consumption.list(),
                  recentAccess: this.consumption.logs(undefined, 10),
                },
              }
            : {}),
          focus: focused
            ? {
                id: focused.id,
                version: focused.version,
                title: focused.title,
                kind: focused.kind,
              }
            : null,
          recentMessages: page
            ? this.memory.trimMessages(task.id)
            : this.memory.messages(task.id).slice(-8),
          input,
        }),
        onSession: (id) => {
          if (!page) this.memory.session(task.id, id);
        },
        onEvent: (kind, data) => {
          if (kind === "assistant.delta") {
            if (
              page &&
              this.memory.getTask(task.id).revision !== context.taskRevision
            )
              return;
            this.streaming += String(data.text);
            return;
          }
          this.memory.event(task.id, kind, data);
        },
        onTool: async (name, args) => {
          try {
            this.memory.assertWritable(context);
          } catch (error) {
            void this.driver.stop().catch(() => {});
            throw error;
          }
          if (page && !tools.some((tool) => tool.name === name))
            throw new Error("当前页面没有这项能力");
          if (page && name === "page_complete") {
            let artifacts: Artifact[];
            if (page === "company") {
              if (!this.companyReady())
                throw new Error("请先保存有依据的企业名称与业务");
              artifacts = this.memory.listArtifacts("profile").slice(0, 1);
            } else if (page === "sources") {
              artifacts = this.memory
                .listArtifacts("source")
                .filter(
                  (a) =>
                    a.status === "ready" &&
                    a.content.format === "csv" &&
                    Array.isArray(a.content.rows) &&
                    a.content.rows.length > 0 &&
                    inspectedSources.get(a.id) === a.version,
                );
              if (!artifacts.length)
                throw new Error("请先读取并检查一份有记录的 CSV 业务资料");
            } else {
              artifacts = this.memory
                .listArtifacts("ontology")
                .filter((a) => a.status === "adopted");
              if (!artifacts.length)
                throw new Error("请先让用户采用已检查的本体候选");
            }
            for (const artifact of artifacts)
              this.memory.attachArtifact(task.id, artifact);
            this.memory.complete(
              context,
              artifacts.map((a) => a.id),
              "当前页面已建立。",
            );
            pageCompleted = true;
            startClosing();
            return {
              saved: true,
              message: "当前页面已完成，回复简短收尾后由产品进入下一页。",
            };
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
              if (page && page !== "ontology")
                throw new Error("请在本体页面处理候选");
              const candidate = this.memory.getArtifact(
                string(args.candidateId, "候选"),
                Number(args.version),
              );
              if (
                candidate.kind !== "ontology" ||
                candidate.status !== "candidate"
              )
                throw new Error("需要有效本体候选");
              if (
                page &&
                (this.memory.getArtifact(candidate.id).version !==
                  candidate.version ||
                  !(candidate.content.validation as Data)?.valid ||
                  !candidate.content.preview)
              )
                throw new Error("请先检查并展示最新候选版本");
              pending.candidateId = candidate.id;
              pending.version = candidate.version;
            }
            if (args.consumerId) {
              if (page !== "consumption" || args.candidateId)
                throw new Error("请在数据消费页确认访问范围");
              const consumer = this.memory.getArtifact(
                string(args.consumerId, "调用方"),
                Number(args.version),
              );
              if (
                consumer.kind !== "consumer" ||
                consumer.status !== "draft" ||
                this.memory.getArtifact(consumer.id).version !==
                  consumer.version
              )
                throw new Error("请先展示最新的访问范围草稿");
              pending.consumerId = consumer.id;
              pending.version = consumer.version;
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
          const mutates = [...domainTools, ...consumptionTools].find(
            (tool) => tool.name === name,
          )?.mutates;
          const operationId = mutates
            ? lastWrite?.signature === signature
              ? lastWrite.operationId
              : `write-${++writeSequence}`
            : undefined;
          const result =
            name === "consumer_propose" && page === "consumption"
              ? serializable(
                  this.consumption.propose(args, context, operationId),
                )
              : await workspace.execute(name, args, operationId);
          if (page && name === "memory_read" && typeof args.id === "string") {
            const artifact = result as unknown as Artifact;
            if (
              artifact.kind === "source" &&
              Array.isArray(artifact.content.rows) &&
              artifact.content.rows.length > 0
            )
              inspectedSources.set(artifact.id, artifact.version);
          }
          if (mutates && operationId) lastWrite = { signature, operationId };
          return result;
        },
      });
      failure = outcome.error
        ? this.safeError(new Error(outcome.error))
        : undefined;
      const interrupted =
        page && this.memory.getTask(task.id).revision !== context.taskRevision;
      if (page && failure && !interrupted) {
        this.memory.addMessage(
          task.id,
          "assistant",
          `本次执行未完成：${failure}。已保存的内容仍然保留。`,
        );
      } else if (!interrupted && outcome.text.trim())
        this.memory.addMessage(
          task.id,
          "assistant",
          page ? outcome.text.slice(0, 6000) : outcome.text,
        );
      else if (!interrupted && this.memory.getTask(task.id).pending)
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
      if (
        !page ||
        this.memory.getTask(task.id).revision === context.taskRevision
      )
        this.memory.addMessage(
          task.id,
          "assistant",
          `本次执行未完成：${failure}。已保存的资料和成果仍然可以查看。`,
        );
    } finally {
      if (closingTimer) clearTimeout(closingTimer);
      this.memory.endExecution(context, failure);
      if (page) {
        this.memory.trimMessages(task.id);
        const current = this.memory.getTask(task.id);
        if (
          pageCompleted &&
          !failure &&
          current.status === "completed" &&
          current.revision === context.taskRevision
        ) {
          const progress = this.canvasProgress();
          if (!progress.completed.includes(page)) progress.completed.push(page);
          const next = canvasPages[canvasPages.indexOf(page) + 1];
          if (next && !progress.reached.includes(next)) {
            progress.reached.push(next);
            if (progress.currentPage === page) progress.currentPage = next;
          }
          this.memory.saveCanvas(progress);
        }
      }
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
    this.consumption.close();
    this.memory.close();
  }
}

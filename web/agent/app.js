const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const kindNames = {
  profile: "企业理解",
  source: "数据来源",
  ontology: "本体与对象",
  report: "调查报告",
  change: "记忆更新",
};
const statusNames = {
  running: "进行中",
  waiting: "待补充",
  paused: "已暂停",
  completed: "已完成",
  draft: "草稿",
  candidate: "待决定",
  adopted: "已采用",
  active: "已采用",
  saved: "已保存",
  ready: "可使用",
  parsed: "已解析",
  rejected: "未采用",
  error: "处理失败",
  failed: "处理失败",
  superseded: "历史版本",
  preview: "预览",
  confirmed: "已确认",
  proposed: "建议",
};
const libraryDescriptions = {
  profile: "逐步积累对企业的理解。每条陈述保留来源，你可以直接纠正。",
  source: "已接入的企业资料。查看原文、表格和版本，找到每项结论的依据。",
  ontology: "围绕业务问题建立概念、关系和规则。查看候选与预览，再决定采用。",
  report: "用企业记忆回答实际问题。报告保留来源和定义的版本，随时可以回查。",
  change: "查看已形成新版本的企业理解、来源和定义，打开当前内容与上一版核对。",
};
const fieldNames = {
  purpose: "业务目标",
  summary: "摘要",
  description: "说明",
  title: "标题",
  name: "名称",
  scope: "范围",
  question: "业务问题",
  conclusion: "结论",
  findings: "发现",
  limitations: "范围与限制",
  unknowns: "待补充",
  questions: "待澄清问题",
  conflicts: "冲突",
  nextStep: "下一步",
  reason: "依据",
  validation: "程序检查",
  preview: "实例预览",
  errors: "检查问题",
  warnings: "需要留意",
  valid: "检查通过",
  rowCount: "记录数",
  objectCount: "对象数",
  edgeCount: "关系数",
  unmatched: "未关联项",
  sourceVersions: "资料版本",
  sourceId: "资料",
  modelVersion: "本体版本",
  baseModel: "基础模型",
  asOf: "资料时点",
  createdAt: "保存时间",
  before: "修改前",
  after: "修改后",
  changes: "变化内容",
  impact: "影响",
  format: "格式",
  columns: "字段",
  definition: "业务含义",
  formula: "计算规则",
  status: "状态",
  statement: "陈述",
  author: "记录者",
  key: "事项",
  companyName: "企业名称",
  business: "业务",
  goals: "目标",
  role: "职责",
  department: "部门",
  metadata: "资料信息",
  count: "数量",
  total: "总数",
  complete: "完整",
  truncated: "部分展示",
  version: "版本",
  observed: "资料观察",
  alternatives: "备选定义",
  rationale: "定义理由",
  result: "结果",
  evidenceGaps: "证据缺口",
  facts: "已知事实",
  interpretations: "解释",
  unresolved: "未决项",
};
const state = {
  token: null,
  model: {},
  task: null,
  tasks: [],
  artifacts: [],
  messages: [],
  events: [],
  busy: false,
  streaming: "",
};
const ui = {
  taskId: null,
  newTask: false,
  view: "conversation",
  selected: null,
  detail: null,
  detailOpen: false,
  editing: false,
  sending: false,
  uploading: false,
  polling: false,
  pollGeneration: 0,
  lastSavedRefs: new Set(),
  initialized: false,
  connectionFailed: false,
  settingsDirty: false,
  pendingMessage: null,
  objectBrowser: null,
  objectReturn: null,
  objectRequest: 0,
};
let toastTimer;
let messageFingerprint = "";
let taskFingerprint = "";
let libraryFingerprint = "";
let pendingFingerprint = "";
let outcomeFingerprint = "";
let savedFingerprint = "";
const messageElements = new Map();
const savedArtifacts = node("div", "saved-artifacts");
$("#messages").after(savedArtifacts);

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name in kindNames ? name : name || "report"}`);
  svg.append(use);
  return svg;
}

function button(label, className, action, iconName) {
  const element = node("button", className);
  element.type = "button";
  if (iconName) element.append(icon(iconName));
  element.append(node("span", "", label));
  element.addEventListener("click", action);
  return element;
}

function dateLabel(value, timeOnly = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(
    "zh-CN",
    timeOnly
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
  ).format(date);
}

function plain(value) {
  if (value === null || value === undefined) return "未提供";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").classList.toggle("error", error);
  $("#toast").hidden = false;
  toastTimer = setTimeout(
    () => {
      $("#toast").hidden = true;
    },
    error ? 7000 : 4200,
  );
}

async function api(path, body) {
  const headers =
    body === undefined
      ? {}
      : {
          "Content-Type": "application/json",
          "X-DataEngine-Token": state.token || "",
        };
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response
    .json()
    .catch(() => ({ error: "服务返回了无法读取的内容，请重试。" }));
  if (!response.ok || data.error)
    throw new Error(data.error || `请求未完成（${response.status}）`);
  return data;
}

function displayedTask() {
  return ui.newTask ? null : state.task;
}
function taskInput() {
  return !ui.newTask && ui.taskId ? { taskId: ui.taskId } : {};
}
function latestArtifact(id) {
  return state.artifacts.find((artifact) => artifact.id === id);
}
function referenceKey(ref) {
  return `${ref.id || ref.sourceId}@${ref.version}`;
}

async function refresh(bootstrap = false) {
  if (ui.polling && !bootstrap) return;
  ui.polling = true;
  const generation = ui.pollGeneration;
  try {
    const query =
      ui.taskId && !ui.newTask
        ? `?taskId=${encodeURIComponent(ui.taskId)}`
        : "";
    const snapshot = await api(
      bootstrap || !state.token ? "/api/bootstrap" : `/api/state${query}`,
    );
    if (generation !== ui.pollGeneration) return;
    if (snapshot.token) state.token = snapshot.token;
    for (const key of [
      "model",
      "task",
      "tasks",
      "artifacts",
      "messages",
      "events",
      "busy",
      "streaming",
    ]) {
      if (Object.prototype.hasOwnProperty.call(snapshot, key))
        state[key] = snapshot[key];
    }
    if (!ui.taskId && !ui.newTask && !ui.pendingMessage)
      ui.taskId = state.task?.id || null;
    state.artifacts ||= [];
    state.tasks ||= [];
    state.messages ||= [];
    state.events ||= [];
    $("#connection-notice").hidden = true;
    ui.connectionFailed = false;
    render();
    const refs = new Set(state.artifacts.map(referenceKey));
    if (
      ui.initialized &&
      !ui.editing &&
      !ui.pendingMessage &&
      !ui.objectBrowser
    ) {
      const added = state.artifacts.filter(
        (artifact) => !ui.lastSavedRefs.has(referenceKey(artifact)),
      );
      if (added.length && state.busy && !ui.selected?.pinned) {
        const priority =
          added.find((artifact) => artifact.kind !== "source") || added.at(-1);
        await openArtifact(priority.id, priority.version, false, {
          automatic: true,
        });
      } else if (ui.selected && !ui.selected.pinned) {
        const latest = latestArtifact(ui.selected.id);
        if (latest && latest.version !== ui.detail?.version)
          await openArtifact(latest.id, latest.version, false, {
            automatic: true,
          });
      }
    }
    ui.lastSavedRefs = refs;
    ui.initialized = true;
  } catch (error) {
    ui.connectionFailed = true;
    $("#connection-notice").textContent =
      `暂时无法连接本地服务。已显示的成果会保留，连接恢复后自动更新。${bootstrap ? ` ${error.message}` : ""}`;
    $("#connection-notice").hidden = false;
  } finally {
    ui.polling = false;
  }
}

function render() {
  const task = displayedTask();
  const messages = ui.newTask
    ? []
    : state.messages.filter((message) => !task || message.taskId === task.id);
  if (task && state.streaming && state.busy)
    messages.push({
      id: `streaming-${task.executionId}`,
      taskId: task.id,
      role: "assistant",
      content: state.streaming,
      createdAt: "",
    });
  const hasWork = Boolean(task || messages.length);
  $("#welcome").hidden = hasWork;
  $("#messages").hidden = !hasWork;
  $("#page-title").textContent =
    ui.view === "conversation"
      ? task?.goal || "与 Agent 协作"
      : kindNames[ui.view];
  $("#topbar-eyebrow").textContent =
    ui.view === "conversation"
      ? task
        ? statusNames[task.status] || "企业记忆助手"
        : "企业记忆助手"
      : "企业记忆";
  const modelLabel = state.model.configured
    ? state.model.model || "模型已连接"
    : "连接模型";
  $("#model-label").textContent = modelLabel;
  $("#model-chip").title = state.model.configured
    ? `当前模型：${modelLabel} · 点击设置`
    : "配置模型以开始协作";
  $$(".status-dot").forEach((dot) =>
    dot.classList.toggle("connected", Boolean(state.model.configured)),
  );
  $$(".nav-count").forEach((count) => {
    count.textContent = artifactsForView(count.dataset.count).length;
  });
  const profile = state.artifacts.find((item) => item.kind === "profile");
  const company =
    profile?.content?.companyName ||
    profile?.content?.statements?.find((statement) =>
      ["companyName", "company_name", "name", "企业名称"].includes(
        statement.key,
      ),
    )?.text;
  $("#workspace-name").textContent =
    company && company.length < 36 ? company : "我的企业空间";
  renderTasks();
  renderMessages(messages);
  renderSavedArtifacts(task);
  renderPending(task);
  renderProgress(task);
  renderOutcome(task);
  if (ui.view !== "conversation") renderLibrary();
  const adoptButton = $("[data-adopt-version]");
  if (adoptButton)
    adoptButton.disabled =
      state.busy ||
      ui.detail?.content?.validation?.valid !== true ||
      !ui.detail?.content?.preview;
  updateComposer();
}

function renderTasks() {
  const fingerprint = JSON.stringify([
    state.tasks.map((task) => [task.id, task.goal, task.status]),
    ui.taskId,
    ui.newTask,
  ]);
  if (fingerprint === taskFingerprint) return;
  taskFingerprint = fingerprint;
  const list = $("#task-list");
  list.replaceChildren();
  if (!state.tasks.length)
    list.append(node("p", "sidebar-empty", "从第一个业务问题开始"));
  for (const task of state.tasks.slice(0, 14)) {
    const item = button(task.goal || "企业记忆任务", "task-button", () =>
      selectTask(task.id),
    );
    item.prepend(node("span", `task-indicator ${task.status}`));
    item.classList.toggle("active", task.id === ui.taskId && !ui.newTask);
    item.title = `${task.goal} · ${statusNames[task.status] || task.status}`;
    list.append(item);
  }
}

function inlineText(element, text) {
  const pieces = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  for (const piece of pieces) {
    if (piece.startsWith("**") && piece.endsWith("**"))
      element.append(node("strong", "", piece.slice(2, -2)));
    else if (piece.startsWith("`") && piece.endsWith("`"))
      element.append(node("code", "", piece.slice(1, -1)));
    else element.append(document.createTextNode(piece));
  }
}

function renderMessageText(container, text) {
  container.replaceChildren();
  const blocks = String(text || "").split(/\n{2,}/);
  for (const block of blocks) {
    if (/^```/.test(block)) {
      const code = block.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "");
      container.append(node("pre", "", code));
    } else if (/^#{1,4}\s/.test(block)) {
      const lines = block.split("\n");
      const heading = node("h3");
      inlineText(heading, lines.shift().replace(/^#{1,4}\s+/, ""));
      container.append(heading);
      if (lines.length) {
        const paragraph = node("p");
        inlineText(paragraph, lines.join("\n"));
        container.append(paragraph);
      }
    } else if (
      block.split("\n").every((line) => /^\s*([-*]|\d+[.)、])\s+/.test(line))
    ) {
      const list = node(/^\s*\d/.test(block) ? "ol" : "ul");
      for (const line of block.split("\n")) {
        const item = node("li");
        inlineText(item, line.replace(/^\s*([-*]|\d+[.)、])\s+/, ""));
        list.append(item);
      }
      container.append(list);
    } else {
      const paragraph = node("p");
      inlineText(paragraph, block);
      container.append(paragraph);
    }
  }
}

function renderMessages(messages) {
  const fingerprint = JSON.stringify(
    messages.map((message) => [message.id, message.content]),
  );
  if (fingerprint === messageFingerprint) return;
  messageFingerprint = fingerprint;
  const scroller = $("#conversation-scroll");
  const shouldScroll =
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 130 ||
    !messageElements.size;
  const liveIds = new Set(messages.map((message) => message.id));
  for (const [id, element] of messageElements)
    if (!liveIds.has(id)) {
      element.remove();
      messageElements.delete(id);
    }
  for (const message of messages) {
    let element = messageElements.get(message.id);
    if (!element) {
      element = node(
        "article",
        `message ${message.role === "user" ? "user" : "assistant"}`,
      );
      const avatar = node("div", "message-avatar");
      if (message.role === "user") avatar.textContent = "你";
      else avatar.append(icon("spark"));
      avatar.setAttribute("aria-hidden", "true");
      const body = node("div", "message-body");
      const meta = node("div", "message-meta");
      meta.append(
        node(
          "span",
          "message-author",
          message.role === "user" ? "你" : "DataEngine",
        ),
        node("span", "message-time", dateLabel(message.createdAt, true)),
      );
      body.append(meta, node("div", "message-content"));
      element.append(avatar, body);
      messageElements.set(message.id, element);
      $("#messages").append(element);
    }
    if (element.dataset.content !== message.content) {
      renderMessageText(
        element.querySelector(".message-content"),
        message.content,
      );
      element.dataset.content = message.content;
    }
  }
  if (shouldScroll)
    requestAnimationFrame(() => {
      scroller.scrollTop = scroller.scrollHeight;
    });
}

function renderSavedArtifacts(task) {
  const refs = task?.artifactRefs || [];
  const fingerprint = JSON.stringify(refs);
  if (fingerprint === savedFingerprint) return;
  savedFingerprint = fingerprint;
  savedArtifacts.replaceChildren();
  savedArtifacts.hidden = !refs.length;
  if (!refs.length) return;
  savedArtifacts.append(node("p", "", "此任务已保存"));
  const links = node("div", "saved-artifact-links");
  for (const ref of refs) {
    const artifact = latestArtifact(ref.id);
    const label = artifact?.title || kindNames[ref.kind] || "查看成果";
    links.append(
      button(
        `${label} · v${ref.version}`,
        "artifact-link",
        () => openArtifact(ref.id, ref.version, true),
        artifact?.kind || "report",
      ),
    );
  }
  savedArtifacts.append(links);
}

function renderPending(task) {
  const pending = task?.pending;
  const fingerprint = JSON.stringify(pending);
  if (fingerprint === pendingFingerprint) return;
  pendingFingerprint = fingerprint;
  const card = $("#pending-card");
  card.replaceChildren();
  card.hidden = !pending;
  if (!pending) return;
  card.append(node("h3", "", "需要你的一点补充"));
  card.append(
    node(
      "p",
      "",
      pending.question ||
        pending.message ||
        pending.text ||
        "请补充当前任务所需的信息。",
    ),
  );
  if (pending.reason) card.append(node("p", "pending-reason", pending.reason));
  const candidateId =
    pending.candidateId || pending.artifactId || pending.candidate?.id;
  if (candidateId)
    card.append(
      button(
        "查看具体候选",
        "secondary-button",
        () =>
          openArtifact(
            candidateId,
            pending.version || pending.candidate?.version,
            true,
          ),
        "ontology",
      ),
    );
}

function renderProgress(task) {
  const running = Boolean(state.busy && task?.status === "running");
  $("#run-progress").hidden = !running;
  $("#stop-button").hidden = !state.busy || !task;
  if (!running) return;
  const event = [...state.events]
    .reverse()
    .find(
      (item) =>
        item.taskId === task.id &&
        /operation|tool|artifact|run/.test(item.kind),
    );
  const kind = event?.kind || "";
  let label = "正在处理你的任务";
  if (/artifact.*saved|artifact.*created/.test(kind))
    label = "成果已保存，正在继续查证";
  else if (/operation|tool/.test(kind)) label = "正在读取资料与操作企业记忆";
  $("#run-progress-label").textContent = label;
  $("#run-progress-detail").textContent =
    task.nextStep || "可以随时补充信息或停止当前工作";
}

function renderOutcome(task) {
  const fingerprint = JSON.stringify([
    task?.status,
    task?.nextStep,
    state.busy,
  ]);
  if (fingerprint === outcomeFingerprint) return;
  outcomeFingerprint = fingerprint;
  const outcome = $("#task-outcome");
  outcome.replaceChildren();
  outcome.hidden =
    !task || !["completed", "paused"].includes(task.status) || state.busy;
  if (outcome.hidden) return;
  outcome.classList.toggle("paused", task.status === "paused");
  outcome.append(
    icon(task.status === "completed" ? "check" : "change"),
    node(
      "p",
      "",
      task.status === "completed"
        ? "当前任务已完成。已保存的成果可以继续复用，也可以提出修改。"
        : `当前任务已暂停，已经保存的成果仍然保留。${task.nextStep ? `\n${task.nextStep}` : "发一条消息即可继续。"}`,
    ),
  );
}

function setView(view) {
  ui.view = view;
  $$(".nav-item[data-view]").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === view);
    item.setAttribute(
      "aria-current",
      item.dataset.view === view ? "page" : "false",
    );
  });
  $("#conversation-scroll").hidden = view !== "conversation";
  $("#library-view").hidden = view === "conversation";
  closeSidebar();
  render();
}

function artifactsForView(view) {
  return state.artifacts.filter((item) =>
    view === "change" ? item.version > 1 : item.kind === view,
  );
}

function renderLibrary() {
  const artifacts = artifactsForView(ui.view);
  const fingerprint = JSON.stringify([ui.view, artifacts, ui.selected]);
  if (fingerprint === libraryFingerprint) return;
  libraryFingerprint = fingerprint;
  const library = $("#library-view");
  library.replaceChildren();
  const heading = node("div", "library-heading");
  heading.append(
    node("h2", "", kindNames[ui.view]),
    node("p", "", libraryDescriptions[ui.view]),
  );
  library.append(heading);
  if (!artifacts.length) {
    const empty = node("div", "empty-library");
    const descriptions = {
      profile:
        "还没有保存企业理解。介绍一下你的企业，Agent 会根据对话与资料整理初稿。",
      source:
        "还没有接入资料。你可以先上传一份文档或 CSV，随后在这里查看真实内容。",
      ontology:
        "还没有本体候选。接入资料后，围绕一个业务问题让 Agent 梳理概念、关系和规则。",
      report:
        "还没有调查报告。提出具体问题，Agent 会查证资料、使用企业对象并保存结果。",
      change: "还没有记忆更新。纠正企业理解或补充资料后，相关变更会留在这里。",
    };
    empty.append(node("p", "", descriptions[ui.view]));
    empty.append(
      button(
        ui.view === "source" ? "上传第一份资料" : "回到对话",
        "secondary-button",
        ui.view === "source"
          ? () => $("#file-input").click()
          : () => {
              setView("conversation");
              $("#message-input").focus();
            },
        ui.view === "source" ? "plus" : "chat",
      ),
    );
    library.append(empty);
    return;
  }
  const list = node("div", "library-list");
  for (const artifact of artifacts) {
    const card = button("", "library-card", () =>
      openArtifact(artifact.id, artifact.version, false),
    );
    card.replaceChildren(icon(artifact.kind));
    card.classList.toggle("selected", artifact.id === ui.selected?.id);
    const body = node("div", "library-card-main");
    body.append(
      node("h3", "", artifact.title),
      node(
        "p",
        "",
        `v${artifact.version} · ${statusNames[artifact.status] || artifact.status || "已保存"} · ${dateLabel(artifact.createdAt)}`,
      ),
    );
    const summary =
      artifact.content?.summary ||
      artifact.content?.purpose ||
      artifact.content?.description;
    if (typeof summary === "string")
      body.append(node("div", "library-card-summary", summary));
    if (ui.view === "change")
      body.append(
        node(
          "div",
          "library-card-summary",
          `版本更新 v${artifact.version - 1} → v${artifact.version} · 打开后可查看上一版`,
        ),
      );
    if (artifact.kind === "source") {
      const content = artifact.content || {};
      const detail =
        content.format === "csv"
          ? `${content.columns?.length || 0} 个字段 · ${content.rows?.length ?? content.rowCount ?? 0} 条记录`
          : "企业文档 · 可查看原文";
      body.append(node("div", "library-card-summary", detail));
    }
    card.append(body, icon("right"));
    list.append(card);
  }
  library.append(list);
}

async function selectTask(id) {
  if (ui.editing) {
    toast("请先保存或取消当前的企业理解编辑。");
    return;
  }
  ui.pendingMessage = null;
  ui.taskId = id;
  ui.newTask = false;
  state.task = null;
  state.messages = [];
  state.streaming = "";
  ui.pollGeneration += 1;
  ui.polling = false;
  messageFingerprint = "";
  setView("conversation");
  await refresh();
}

function startTask() {
  if (ui.editing) {
    toast("请先保存或取消当前的企业理解编辑。");
    return;
  }
  ui.pendingMessage = null;
  ui.objectBrowser = null;
  ui.objectReturn = null;
  ui.objectRequest += 1;
  ui.newTask = true;
  ui.taskId = null;
  ui.pollGeneration += 1;
  ui.selected = null;
  setDetailOpen(false);
  setView("conversation");
  $("#message-input").focus();
}

function updateComposer() {
  const input = $("#message-input");
  $("#send-button").disabled =
    !input.value.trim() || ui.sending || !state.token;
  $("#upload-button").disabled = ui.uploading || !state.token;
  $("#load-sample").disabled = ui.uploading || !state.token;
  $("#upload-hint").textContent = ui.uploading ? "正在接入资料…" : "文档与 CSV";
  $("#focus-context").hidden = !ui.selected;
  if (ui.selected)
    $("#focus-label").textContent =
      `围绕「${ui.detail?.title || "当前成果"}」继续 · v${ui.selected.version || ""}`;
  input.placeholder = displayedTask()?.pending
    ? "补充信息，或告诉我你对这项建议的决定…"
    : displayedTask()
      ? "继续提问、补充资料，或纠正当前理解…"
      : "介绍你的企业，或提出一个想解决的业务问题…";
}

async function sendMessage(event) {
  event?.preventDefault();
  const input = $("#message-input");
  const text = input.value.trim();
  if (!text || ui.sending) return;
  if (!state.model.configured) {
    openSettings();
    return;
  }
  const body = {
    text,
    ...taskInput(),
    ...(ui.selected
      ? { focusId: ui.selected.id, focusVersion: ui.selected.version }
      : {}),
  };
  const signature = JSON.stringify(body);
  if (ui.pendingMessage?.signature !== signature)
    ui.pendingMessage = {
      signature,
      body: { ...body, messageId: crypto.randomUUID() },
    };
  const attempt = ui.pendingMessage;
  ui.sending = true;
  updateComposer();
  try {
    const result = await api("/api/messages", attempt.body);
    if (ui.pendingMessage === attempt) ui.pendingMessage = null;
    if (input.value.trim() === text) {
      input.value = "";
      resizeInput();
    }
    if (result.task?.id) {
      ui.taskId = result.task.id;
      ui.newTask = false;
    }
    setView("conversation");
    ui.pollGeneration += 1;
    ui.polling = false;
    await refresh();
    requestAnimationFrame(() => {
      $("#conversation-scroll").scrollTop = $(
        "#conversation-scroll",
      ).scrollHeight;
    });
  } catch (error) {
    toast(error.message, true);
  } finally {
    ui.sending = false;
    updateComposer();
  }
}

async function uploadFiles(files) {
  if (ui.uploading || !files.length) return;
  const accepted = [...files].filter((file) =>
    /\.(md|txt|csv)$/i.test(file.name),
  );
  if (accepted.length !== files.length)
    toast("当前支持 Markdown、文本和 CSV 文件。其他格式未接入。", true);
  if (!accepted.length) return;
  ui.uploading = true;
  updateComposer();
  let uploaded = 0;
  let last;
  try {
    for (const file of accepted) {
      if (file.size > 5_000_000)
        throw new Error(`「${file.name}」超过 5 MB，请拆分为较小资料。`);
      const result = await api("/api/upload", {
        name: file.name,
        content: await file.text(),
        ...taskInput(),
      });
      if (result.task?.id) {
        ui.taskId = result.task.id;
        ui.newTask = false;
      }
      if (result.artifact) last = result.artifact;
      uploaded += 1;
    }
    ui.pollGeneration += 1;
    ui.polling = false;
    await refresh();
    if (last) await openArtifact(last.id, last.version, false);
    toast(
      `已接入 ${uploaded} 份资料${state.model.configured ? "，可以围绕资料继续协作。" : "。连接模型后即可交给 Agent 阅读。"}`,
    );
  } catch (error) {
    toast(
      `${uploaded ? `已接入 ${uploaded} 份资料。` : ""}${error.message}`,
      true,
    );
    await refresh();
  } finally {
    ui.uploading = false;
    $("#file-input").value = "";
    updateComposer();
  }
}

async function loadSample() {
  if (ui.uploading) return;
  ui.uploading = true;
  updateComposer();
  try {
    const result = await api("/api/sample", taskInput());
    if (result.task?.id) {
      ui.taskId = result.task.id;
      ui.newTask = false;
    }
    ui.pollGeneration += 1;
    ui.polling = false;
    await refresh();
    setView("source");
    toast("澄川热力示例资料已接入。这是一家虚构企业，内容可逐份查看。");
    if (!$("#message-input").value)
      $("#message-input").value =
        "请先阅读澄川热力的企业介绍和资料目录，帮我建立企业理解，再一起明确一个适合验证的业务问题。";
    resizeInput();
  } catch (error) {
    toast(error.message, true);
  } finally {
    ui.uploading = false;
    updateComposer();
  }
}

async function stopTask() {
  if (!ui.taskId) return;
  $("#stop-button").disabled = true;
  try {
    await api("/api/stop", { taskId: ui.taskId });
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    $("#stop-button").disabled = false;
  }
}

function setDetailOpen(open) {
  ui.detailOpen = open;
  $("#detail-panel").hidden = !open;
  $("#app-shell").classList.toggle("detail-open", open);
  $("#toggle-detail").setAttribute("aria-expanded", String(open));
  $("#toggle-detail").setAttribute(
    "aria-label",
    open ? "收起成果面板" : "打开成果面板",
  );
}

async function openArtifact(id, version, pinned = false, options = {}) {
  if (ui.editing) {
    toast("请先保存或取消当前的企业理解编辑。");
    return;
  }
  try {
    const query =
      version !== undefined && version !== null
        ? `?version=${encodeURIComponent(version)}`
        : "";
    const artifact = await api(
      `/api/artifacts/${encodeURIComponent(id)}${query}`,
    );
    if (
      !options.automatic &&
      (ui.selected?.id !== artifact.id ||
        ui.selected?.version !== artifact.version)
    )
      ui.pendingMessage = null;
    ui.objectBrowser = null;
    ui.objectRequest += 1;
    if (!options.preserveObjectReturn) ui.objectReturn = null;
    ui.detail = artifact;
    ui.selected = { id: artifact.id, version: artifact.version, pinned };
    ui.editing = false;
    renderDetail(artifact, options);
    setDetailOpen(true);
    updateComposer();
    if (ui.view !== "conversation") renderLibrary();
  } catch (error) {
    toast(`无法打开成果：${error.message}`, true);
  }
}

function contentSection(title, content) {
  const section = node("section", "content-section");
  section.append(node("h3", "", title));
  if (content instanceof Node) section.append(content);
  else section.append(node("div", "prose", content));
  return section;
}

function renderDetail(artifact, options = {}) {
  const detail = $("#detail-content");
  detail.replaceChildren();
  if (ui.objectReturn) {
    const previous = ui.objectReturn;
    detail.append(
      button(
        `返回 ${previous.type || "调查"} 对象`,
        "object-back-button",
        () => openObjectBrowser(previous.artifact, previous.type, previous),
        "ontology",
      ),
    );
  }
  const latest = latestArtifact(artifact.id);
  if (latest && latest.version !== artifact.version)
    detail.append(
      button(
        `正在查看历史版本 v${artifact.version}，打开最新 v${latest.version}`,
        "detail-update-note",
        () => openArtifact(latest.id, latest.version, false),
      ),
    );
  const header = node("div", "artifact-header");
  const kicker = node("div", "artifact-kicker");
  kicker.append(
    icon(artifact.kind),
    document.createTextNode(kindNames[artifact.kind] || "企业成果"),
  );
  const metadata = node("div", "artifact-meta");
  metadata.append(
    node(
      "span",
      `status-tag ${artifact.status || ""}`,
      statusNames[artifact.status] || artifact.status || "已保存",
    ),
    node("span", "", `v${artifact.version}`),
    node("span", "", dateLabel(artifact.createdAt)),
  );
  header.append(kicker, node("h2", "", artifact.title), metadata);
  detail.append(header);
  const toolbar = node("div", "artifact-toolbar");
  toolbar.append(
    button(
      "围绕这份成果提问",
      "secondary-button",
      () => {
        setView("conversation");
        $("#message-input").focus();
        if (window.innerWidth <= 760) setDetailOpen(false);
      },
      "chat",
    ),
  );
  if (artifact.version > 1)
    toolbar.append(
      button(`查看上一版 v${artifact.version - 1}`, "secondary-button", () =>
        openArtifact(artifact.id, artifact.version - 1, true),
      ),
    );
  detail.append(toolbar);
  const content = artifact.content || {};
  if (artifact.kind === "source")
    renderSource(detail, content, options.evidenceRow);
  else if (artifact.kind === "profile") renderProfile(detail, artifact);
  else if (artifact.kind === "ontology") renderOntology(detail, artifact);
  else if (artifact.kind === "report") renderReport(detail, artifact);
  else renderFields(detail, content, new Set());
  if (
    artifact.kind !== "ontology" &&
    artifact.kind !== "report" &&
    Array.isArray(content.evidence)
  )
    detail.append(renderEvidence(content.evidence));
}

function renderSource(detail, content, evidenceRow) {
  const rows = content.rows || [];
  const columns =
    content.columns ||
    (rows[0] && typeof rows[0] === "object" ? Object.keys(rows[0]) : []);
  if (content.summary)
    detail.append(contentSection("接入摘要", content.summary));
  if (
    Number.isInteger(evidenceRow) &&
    evidenceRow >= 1 &&
    evidenceRow <= rows.length
  ) {
    detail.append(
      contentSection(
        `当前引用 · 第 ${evidenceRow} 条原始记录`,
        propertyList(rows[evidenceRow - 1]),
      ),
    );
  }
  if (content.format === "csv" || columns.length) {
    const table = node("table");
    const head = node("thead");
    const header = node("tr");
    header.append(node("th", "", "#"));
    for (const column of columns)
      header.append(
        node("th", "", typeof column === "string" ? column : column.name),
      );
    head.append(header);
    const body = node("tbody");
    rows.slice(0, 40).forEach((row, index) => {
      const tr = node("tr");
      tr.append(node("td", "", index + 1));
      columns.forEach((column, columnIndex) => {
        const key = typeof column === "string" ? column : column.name;
        const value = Array.isArray(row) ? row[columnIndex] : row[key];
        const td = node("td", "", plain(value));
        td.title = plain(value);
        tr.append(td);
      });
      body.append(tr);
    });
    table.append(head, body);
    const scroll = node("div", "table-scroll");
    scroll.tabIndex = 0;
    scroll.setAttribute("aria-label", "资料表格，可横向滚动");
    scroll.append(table);
    detail.append(contentSection("原始记录", scroll));
    detail.append(
      node(
        "p",
        "data-note",
        `共 ${content.rowCount ?? rows.length} 条记录 · ${columns.length} 个字段${rows.length > 40 ? " · 当前展示前 40 条" : ""}`,
      ),
    );
  }
  if (typeof content.raw === "string") {
    const raw = node("pre", "source-text", content.raw);
    const section = contentSection("原始内容", raw);
    if (columns.length) {
      const disclosure = node("details");
      disclosure.append(node("summary", "", "查看原始 CSV"), section);
      detail.append(disclosure);
    } else detail.append(section);
  }
  renderFields(
    detail,
    content,
    new Set([
      "format",
      "columns",
      "rows",
      "raw",
      "hash",
      "summary",
      "rowCount",
      "evidence",
    ]),
  );
}

function renderProfile(detail, artifact) {
  const content = artifact.content || {};
  if (content.summary)
    detail.append(contentSection("当前理解", content.summary));
  if (Array.isArray(content.statements)) {
    const statements = node("div");
    for (const statement of content.statements) {
      const card = node("div", "statement");
      card.append(
        node(
          "p",
          "",
          typeof statement === "string"
            ? statement
            : statement.text || statement.statement || statement.value || "",
        ),
      );
      if (typeof statement === "object") {
        const meta = node("div", "statement-meta");
        if (statement.key)
          meta.append(
            node("span", "", fieldNames[statement.key] || statement.key),
          );
        const origin = statement.userEdited
          ? "你已编辑"
          : {
              user: "用户陈述",
              source: "来自资料",
              inference: "推断",
              agent: "Agent 整理",
              hypothesis: "待查证",
              suggestion: "待查证建议",
            }[statement.origin] || statement.origin;
        if (origin) meta.append(node("span", "", origin));
        if (statement.status)
          meta.append(
            node("span", "", statusNames[statement.status] || statement.status),
          );
        card.append(meta);
        if (
          statement.key &&
          (!latestArtifact(artifact.id) ||
            latestArtifact(artifact.id).version === artifact.version)
        )
          card.append(
            button("纠正这条理解", "statement-edit-button", () =>
              editStatement(card, artifact, statement),
            ),
          );
        if (Array.isArray(statement.evidence) && statement.evidence.length) {
          const disclosure = node("details");
          disclosure.append(
            node("summary", "", "查看依据"),
            renderEvidence(statement.evidence),
          );
          card.append(disclosure);
        }
      }
      statements.append(card);
    }
    detail.append(contentSection("已保存的企业陈述", statements));
  }
  renderFields(detail, content, new Set(["summary", "statements", "evidence"]));
}

function editStatement(card, artifact, statement) {
  if (ui.editing) {
    toast("请先保存或取消当前编辑。");
    return;
  }
  ui.editing = true;
  const previous = [...card.childNodes];
  const input = node("textarea", "profile-editor");
  input.value = statement.text || statement.statement || statement.value || "";
  input.setAttribute(
    "aria-label",
    `纠正${fieldNames[statement.key] || statement.key}`,
  );
  const actions = node("div", "edit-actions");
  const save = button("保存纠正", "primary-button", async () => {
    if (!input.value.trim()) {
      toast("请填写这条企业理解。");
      input.focus();
      return;
    }
    save.disabled = true;
    try {
      const result = await api("/api/profile", {
        key: statement.key,
        text: input.value.trim(),
        id: artifact.id,
        expectedVersion: artifact.version,
      });
      ui.editing = false;
      await refresh();
      await openArtifact(
        result.artifact?.id || artifact.id,
        result.artifact?.version,
        false,
      );
      toast("纠正已保存，后续任务会读取新的企业理解。");
    } catch (error) {
      toast(error.message, true);
      save.disabled = false;
    }
  });
  actions.append(
    save,
    button("取消", "secondary-button", () => {
      ui.editing = false;
      card.replaceChildren(...previous);
    }),
  );
  card.replaceChildren(
    input,
    node("p", "edit-note", "你的编辑会保存为新的版本，原有理解仍可回查。"),
    actions,
  );
  input.focus();
}

function renderOntology(detail, artifact) {
  const content = artifact.content || {};
  if (content.purpose)
    detail.append(contentSection("围绕的业务问题", content.purpose));
  const types = content.types || content.concepts || [];
  if (types.length) {
    const cards = node("div");
    for (const type of types) {
      const card = node("div", "definition-card");
      card.append(
        node("h4", "", type.name || type.label || type.id),
        node(
          "div",
          "prose",
          type.description || type.definition || "定义待补充",
        ),
      );
      if (type.idField)
        card.append(node("p", "field-caption", `身份字段 · ${type.idField}`));
      if (type.fields && typeof type.fields === "object") {
        const disclosure = node("details");
        disclosure.append(
          node(
            "summary",
            "",
            `查看 ${Object.keys(type.fields).length} 项字段映射`,
          ),
          propertyList(type.fields),
        );
        card.append(disclosure);
      }
      if (type.sourceId)
        card.append(
          evidenceButton({
            sourceId: type.sourceId,
            version: content.sourceVersions?.[type.sourceId],
          }),
        );
      if (content.validation?.valid === true && content.preview)
        card.append(
          button(
            "浏览对象",
            "secondary-button object-browse-button",
            () => openObjectBrowser(artifact, type.name),
            "ontology",
          ),
        );
      cards.append(card);
    }
    detail.append(contentSection(`业务概念 · ${types.length}`, cards));
  }
  if (Array.isArray(content.relations) && content.relations.length) {
    const relations = node("div");
    for (const relation of content.relations) {
      const row = node("div", "relation-row");
      row.append(
        node("strong", "", relation.from || relation.source || "来源概念"),
        icon("right"),
        node("span", "", relation.name || relation.label || "关联"),
        icon("right"),
        node("strong", "", relation.to || relation.target || "目标概念"),
      );
      relations.append(row);
    }
    detail.append(contentSection("概念怎样关联", relations));
  }
  if (Array.isArray(content.functions) && content.functions.length) {
    const methods = node("div");
    for (const method of content.functions) {
      const card = node("div", "definition-card");
      card.append(
        node("h4", "", method.name || method.label || "业务规则"),
        node(
          "div",
          "prose",
          method.description ||
            method.definition ||
            method.formula ||
            (method.implementation === "recovery_evidence"
              ? "检查关联回访是否包含改善反馈，并保留证据缺失与冲突。"
              : ""),
        ),
      );
      if (method.type)
        card.append(
          node(
            "p",
            "field-caption",
            `适用于 ${method.type}${method.relation ? ` · 沿 ${method.relation} 查证` : ""}`,
          ),
        );
      methods.append(card);
    }
    detail.append(contentSection("可使用的业务规则", methods));
  }
  if (content.validation)
    detail.append(contentSection("检查结果", genericValue(content.validation)));
  if (content.preview) detail.append(renderObjectPreview(content.preview));
  if (Array.isArray(content.evidence))
    detail.append(renderEvidence(content.evidence));
  renderFields(
    detail,
    content,
    new Set([
      "purpose",
      "types",
      "concepts",
      "relations",
      "functions",
      "validation",
      "preview",
      "evidence",
      "sourceVersions",
      "baseModel",
    ]),
  );
  if (
    [
      "candidate",
      "draft",
      "proposed",
      "preview",
      "pending_confirmation",
      "validated",
    ].includes(artifact.status)
  ) {
    const box = node("div", "decision-box");
    const ready =
      content.validation?.valid === true && Boolean(content.preview);
    box.append(
      node(
        "p",
        "",
        ready
          ? "此版本已完成程序检查与实例预览。请检查概念、关系和业务口径，再决定是否用于后续调查。"
          : "当前仍是建模候选。完成程序检查和实例预览后，才可以采用这份定义。",
      ),
    );
    const actions = node("div", "decision-actions");
    const adopt = button(
      "采用这一版定义",
      "primary-button",
      () => decide(artifact, "adopt"),
      "check",
    );
    adopt.dataset.adoptVersion = artifact.version;
    adopt.disabled = !ready || state.busy;
    if (state.busy) adopt.title = "请等当前运行结束后采用";
    else if (!ready) adopt.title = "需要通过检查并生成实例预览";
    actions.append(
      adopt,
      button("提出修改", "secondary-button", () => {
        setView("conversation");
        $("#message-input").value =
          `关于「${artifact.title}」v${artifact.version}，我想修改：`;
        resizeInput();
        $("#message-input").focus();
        if (window.innerWidth <= 760) setDetailOpen(false);
      }),
      button("暂不采用", "secondary-button", () => decide(artifact, "reject")),
    );
    box.append(actions);
    detail.append(box);
  }
}

async function decide(artifact, decision) {
  if (!ui.taskId) {
    toast("请先打开提出这份候选的任务，再作出决定。", true);
    return;
  }
  try {
    await api("/api/decision", {
      taskId: ui.taskId,
      candidateId: artifact.id,
      version: artifact.version,
      decision,
    });
    toast(
      decision === "adopt"
        ? "这版定义已采用，后续任务可以使用新定义。"
        : "已记录暂不采用，可以在对话中说明调整方向。",
    );
    await refresh();
    await openArtifact(artifact.id, undefined, false);
  } catch (error) {
    toast(error.message, true);
  }
}

function renderReport(detail, artifact) {
  const content = artifact.content || {};
  detail.append(
    button(
      "查看调查对象",
      "secondary-button object-browse-button",
      () => openObjectBrowser(artifact),
      "ontology",
    ),
  );
  const newerSources = Object.entries(content.sourceVersions || {}).filter(
    ([id, version]) => (latestArtifact(id)?.version || version) > version,
  );
  if (newerSources.length) {
    const notice = node("div", "report-refresh-note");
    notice.append(
      node(
        "p",
        "",
        `有 ${newerSources.length} 份资料更新。此报告仍保留原来的依据与对象快照。`,
      ),
    );
    const refreshButton = button(
      "使用最新资料继续",
      "secondary-button",
      () => refreshReport(artifact, refreshButton),
      "change",
    );
    notice.append(refreshButton);
    detail.append(notice);
  }
  if (content.question)
    detail.append(contentSection("调查问题", content.question));
  if (content.summary)
    detail.append(
      contentSection(
        "调查摘要",
        typeof content.summary === "object"
          ? genericValue(content.summary)
          : content.summary,
      ),
    );
  if (Array.isArray(content.sections)) {
    for (const section of content.sections)
      detail.append(
        contentSection(
          section.title || section.heading || "调查发现",
          genericValue(
            section.content ?? section.text ?? section.body ?? section,
          ),
        ),
      );
  }
  if (Array.isArray(content.findings)) {
    const findings = node("div");
    for (const finding of content.findings) {
      const card = node("div", "definition-card");
      if (typeof finding === "string") card.append(node("p", "prose", finding));
      else {
        card.append(
          node(
            "p",
            "field-caption",
            {
              fact: "来源事实",
              interpretation: "基于资料的解释",
              unknown: "证据不足，仍待查证",
            }[finding.kind] || "调查发现",
          ),
        );
        card.append(
          node("p", "prose", finding.text || finding.description || ""),
        );
        if (Array.isArray(finding.evidence))
          for (const ref of finding.evidence) card.append(evidenceButton(ref));
      }
      findings.append(card);
    }
    detail.append(contentSection("查证结果", findings));
  }
  renderFields(
    detail,
    content,
    new Set([
      "question",
      "summary",
      "sections",
      "findings",
      "evidence",
      "sourceVersions",
    ]),
  );
  if (content.sourceVersions && typeof content.sourceVersions === "object") {
    const versions = Object.entries(content.sourceVersions).map(
      ([sourceId, version]) => ({ sourceId, version }),
    );
    detail.append(renderEvidence(versions, "使用的资料版本"));
  }
  if (Array.isArray(content.evidence))
    detail.append(renderEvidence(content.evidence));
}

function renderObjectPreview(preview) {
  if (!Array.isArray(preview.types))
    return contentSection("实例预览", genericValue(preview));
  const container = node("div");
  container.append(
    node(
      "p",
      "data-note",
      "以下是实际映射得到的对象样例，样例数量不代表全部。",
    ),
  );
  for (const type of preview.types) {
    const group = node("details", "object-preview-group");
    group.append(
      node("summary", "", `${type.name} · ${type.total ?? "未知"} 个对象`),
    );
    for (const example of type.examples || []) {
      const card = node("div", "definition-card");
      card.append(
        node("h4", "", example.id || example.name || "对象"),
        propertyList(example.fields || {}),
      );
      for (const ref of example.evidence || [])
        card.append(evidenceButton(ref));
      group.append(card);
    }
    container.append(group);
  }
  if (Array.isArray(preview.unresolved) && preview.unresolved.length) {
    container.append(node("p", "preview-subheading", "关系关联检查"));
    for (const relation of preview.unresolved)
      container.append(
        node(
          "p",
          "data-note",
          `${relation.from || ""} · ${relation.relation}：${relation.missing} 条尚未关联`,
        ),
      );
  }
  return contentSection("业务对象预览", container);
}

async function refreshReport(artifact, trigger) {
  const owner = state.tasks.find((task) =>
    task.artifactRefs?.some((ref) => ref.id === artifact.id),
  );
  if (!owner) {
    toast("请先打开生成这份报告的任务，再使用最新资料继续。", true);
    return;
  }
  if (!state.model.configured) {
    openSettings();
    return;
  }
  trigger.disabled = true;
  trigger.dataset.messageId ||= crypto.randomUUID();
  try {
    const result = await api("/api/refresh", {
      taskId: owner.id,
      messageId: trigger.dataset.messageId,
    });
    ui.pendingMessage = null;
    ui.taskId = result.task?.id || owner.id;
    ui.newTask = false;
    ui.pollGeneration += 1;
    ui.polling = false;
    await refresh();
    setView("conversation");
    toast("已按最新资料继续调查，原报告的依据仍然保留。");
  } catch (error) {
    toast(error.message, true);
  } finally {
    trigger.disabled = false;
  }
}

async function openObjectBrowser(artifact, type = null, options = {}) {
  if (ui.editing) {
    toast("请先保存或取消当前的企业理解编辑。");
    return;
  }
  const request = ++ui.objectRequest;
  const previous = ui.objectBrowser;
  const browser = {
    artifact,
    type,
    id: options.id || null,
    relation: options.relation || null,
    offset: Math.max(0, options.offset || 0),
    search: options.search ?? options.id ?? "",
    trail: options.trail || [],
    data: null,
  };
  ui.objectBrowser = browser;
  const loading = node("p", "object-loading", "正在读取这一版本的业务对象…");
  $("#detail-content").append(loading);
  const params = new URLSearchParams({
    artifactId: artifact.id,
    version: String(artifact.version),
    limit: "20",
  });
  if (type) params.set("type", type);
  if (browser.id) params.set("id", browser.id);
  if (browser.relation) params.set("relation", browser.relation);
  params.set("offset", String(browser.offset));
  try {
    const data = await api(`/api/objects?${params}`);
    if (request !== ui.objectRequest) return;
    browser.data = data;
    ui.detail = artifact;
    if (
      ui.selected?.id !== artifact.id ||
      ui.selected?.version !== artifact.version
    )
      ui.pendingMessage = null;
    ui.selected = { id: artifact.id, version: artifact.version, pinned: true };
    ui.objectReturn = null;
    renderObjectBrowser(browser);
    setDetailOpen(true);
    updateComposer();
  } catch (error) {
    if (request === ui.objectRequest) ui.objectBrowser = previous;
    toast(`无法读取对象：${error.message}`, true);
  } finally {
    loading.remove();
  }
}

function objectLocation(browser) {
  return {
    artifact: browser.artifact,
    type: browser.type,
    id: browser.id,
    relation: browser.relation,
    offset: browser.offset,
    search: browser.search,
    trail: browser.trail,
  };
}

function renderObjectBrowser(browser) {
  const { artifact, data } = browser;
  const detail = $("#detail-content");
  detail.replaceChildren();
  const back = node("div", "object-back-row");
  back.append(
    button(
      artifact.kind === "report" ? "返回报告" : "返回本体",
      "object-back-button",
      () => openArtifact(artifact.id, artifact.version, true),
      artifact.kind,
    ),
  );
  if (browser.trail.length) {
    const prior = browser.trail.at(-1);
    back.append(
      button(
        "上一对象",
        "object-back-button",
        () => openObjectBrowser(prior.artifact, prior.type, prior),
        "change",
      ),
    );
  }
  detail.append(back);
  const header = node("div", "artifact-header");
  const kicker = node("div", "artifact-kicker");
  kicker.append(
    icon("ontology"),
    document.createTextNode(
      artifact.kind === "report" ? "报告使用的业务对象" : "本体映射的业务对象",
    ),
  );
  header.append(
    kicker,
    node(
      "h2",
      "",
      browser.id
        ? `${browser.type} · ${browser.id}`
        : browser.type || "选择一类业务对象",
    ),
  );
  const meta = node("div", "artifact-meta");
  meta.append(
    node(
      "span",
      "status-tag",
      data.model?.status === "candidate" ? "候选预览" : "固定版本",
    ),
    node("span", "", `${artifact.title} · v${artifact.version}`),
  );
  header.append(meta);
  detail.append(header);
  detail.append(
    node(
      "p",
      "object-scope-note",
      "当前对象、关系与证据来自这份成果的同一数据快照，新的资料不会改写此处内容。",
    ),
  );

  const controls = node("div", "object-controls");
  const typeLabel = node("label", "", "对象类型");
  typeLabel.htmlFor = "object-type";
  const typeSelect = node("select");
  typeSelect.id = "object-type";
  const placeholder = node("option", "", "选择要查看的业务对象");
  placeholder.value = "";
  typeSelect.append(placeholder);
  for (const type of data.types || []) {
    const option = node("option", "", type.name);
    option.value = type.name;
    option.selected = type.name === browser.type;
    typeSelect.append(option);
  }
  typeSelect.addEventListener("change", () =>
    openObjectBrowser(artifact, typeSelect.value || null),
  );
  controls.append(typeLabel, typeSelect);
  if (browser.type) {
    const searchForm = node("form", "object-search");
    const search = node("input");
    search.type = "text";
    search.placeholder = "输入对象编号，如 CS009";
    search.setAttribute("aria-label", "按对象编号查找");
    search.value = browser.search;
    search.addEventListener("input", () => {
      browser.search = search.value;
    });
    const submit = button("查找", "secondary-button", () => {});
    submit.type = "submit";
    searchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      openObjectBrowser(artifact, browser.type, {
        id: search.value.trim() || null,
        search: search.value,
        trail: browser.trail,
      });
    });
    searchForm.append(search, submit);
    controls.append(searchForm);
  }
  detail.append(controls);
  const definition = data.types?.find((type) => type.name === browser.type);
  if (definition?.description)
    detail.append(node("p", "object-description", definition.description));
  if (!browser.type) {
    const list = node("div", "object-type-list");
    for (const type of data.types || []) {
      const item = button("", "object-list-item", () =>
        openObjectBrowser(artifact, type.name),
      );
      item.replaceChildren(icon("ontology"));
      const text = node("span");
      text.append(
        node("strong", "", type.name),
        node("span", "", type.description || "查看对象、关联与来源"),
      );
      item.append(text, icon("right"));
      list.append(item);
    }
    detail.append(list);
    return;
  }

  const result = data.result;
  if (Array.isArray(result?.items)) {
    detail.append(renderObjectCollection(browser, result));
    return;
  }
  if (!result) {
    detail.append(
      node("p", "prose", "没有返回对象。可以选择类型，或输入一个对象编号。"),
    );
    return;
  }
  detail.append(
    button(
      "返回这类对象列表",
      "object-back-button",
      () => openObjectBrowser(artifact, browser.type),
      "source",
    ),
  );
  detail.append(contentSection("对象字段", propertyList(result.fields || {})));
  detail.append(
    button(
      "围绕这个对象提问",
      "secondary-button",
      () => {
        setView("conversation");
        const input = $("#message-input");
        const prefix = `关于「${browser.type} / ${result.id}」（${artifact.title} v${artifact.version}）：`;
        if (!input.value.startsWith(prefix))
          input.value = `${prefix}\n${input.value}`;
        resizeInput();
        input.focus();
        if (window.innerWidth <= 760) setDetailOpen(false);
      },
      "chat",
    ),
  );
  const relations = definition?.relations || [];
  if (relations.length) {
    const relationControls = node("div", "object-relations");
    for (const relation of relations) {
      const control = button(
        `${relation.name} → ${relation.to}`,
        "secondary-button",
        () =>
          openObjectBrowser(artifact, browser.type, {
            ...objectLocation(browser),
            relation: relation.name,
            offset: 0,
          }),
      );
      control.classList.toggle("selected", browser.relation === relation.name);
      control.setAttribute(
        "aria-pressed",
        String(browser.relation === relation.name),
      );
      relationControls.append(control);
    }
    detail.append(contentSection("沿关系继续查看", relationControls));
  } else
    detail.append(node("p", "data-note", "这个类型尚未定义可展开的关系。"));
  if (data.related)
    detail.append(
      contentSection(
        `${browser.relation} · 关联对象`,
        renderObjectCollection(browser, data.related, true),
      ),
    );
  if (Array.isArray(result.evidence)) {
    const evidence = node("div");
    result.evidence.forEach((ref) =>
      evidence.append(objectEvidenceButton(ref, browser)),
    );
    detail.append(contentSection("对象的来源证据", evidence));
  }
}

function renderObjectCollection(browser, collection, related = false) {
  const container = node("div", "object-collection");
  const allItems = collection.items || [];
  const clientPagination = related && collection.offset === undefined;
  const offset = clientPagination
    ? browser.offset
    : Number(
        collection.offset ?? collection.coverage?.offset ?? browser.offset,
      );
  const items = clientPagination
    ? allItems.slice(offset, offset + 20)
    : allItems;
  const total = collection.total ?? collection.coverage?.total;
  const displayedEnd = offset + items.length;
  const totalLabel = Number.isFinite(total) ? `共 ${total} 个` : "总数尚不确定";
  const scope = node(
    "p",
    "object-collection-scope",
    items.length
      ? `${totalLabel} · 当前 ${offset + 1}–${displayedEnd}`
      : `${totalLabel} · 当前没有对象`,
  );
  container.append(scope);
  if (collection.coverage?.input?.complete === false)
    container.append(
      node(
        "p",
        "data-note",
        "关联结果来自部分输入对象，不能当作完整业务范围。",
      ),
    );
  if (!items.length)
    container.append(
      node(
        "p",
        "object-empty-note",
        related
          ? "没有解析出关联对象。缺少关联不等于业务事实不存在，请回查原始资料与映射。"
          : "这个范围中没有对象。可以检查资料和身份映射。",
      ),
    );
  const list = node("div", "object-list");
  for (const entity of items) {
    const item = button("", "object-list-item", () =>
      openObjectBrowser(
        browser.artifact,
        entity.type || collection.type || browser.type,
        { id: entity.id, trail: [...browser.trail, objectLocation(browser)] },
      ),
    );
    item.replaceChildren();
    const text = node("span");
    text.append(node("strong", "", entity.id));
    const fields = Object.entries(entity.fields || {})
      .slice(0, 2)
      .map(([key, value]) => `${fieldNames[key] || key}：${plain(value)}`)
      .join(" · ");
    text.append(node("span", "", fields || entity.type));
    item.append(text, icon("right"));
    list.append(item);
  }
  container.append(list);
  const hasPrevious = offset > 0;
  const hasNext = Number.isFinite(total)
    ? displayedEnd < total
    : Boolean(collection.truncated && items.length);
  if (hasPrevious || hasNext) {
    const pager = node("div", "object-pagination");
    const previous = button("上一页", "secondary-button", () =>
      openObjectBrowser(browser.artifact, browser.type, {
        ...objectLocation(browser),
        offset: Math.max(0, offset - 20),
      }),
    );
    previous.disabled = !hasPrevious;
    const next = button("下一页", "secondary-button", () =>
      openObjectBrowser(browser.artifact, browser.type, {
        ...objectLocation(browser),
        offset: offset + 20,
      }),
    );
    next.disabled = !hasNext;
    pager.append(
      previous,
      node("span", "", `第 ${Math.floor(offset / 20) + 1} 页`),
      next,
    );
    container.append(pager);
  }
  return container;
}

function objectEvidenceButton(ref, browser) {
  const sourceId = ref.sourceId || ref.artifactId || ref.id;
  const source = latestArtifact(sourceId);
  const label = `${source?.title || sourceId} · v${ref.version}${ref.row ? ` · 第 ${ref.row} 条` : ""}`;
  return button(
    label,
    "evidence-button",
    () => {
      ui.objectReturn = objectLocation(browser);
      return openArtifact(sourceId, ref.version, true, {
        preserveObjectReturn: true,
        evidenceRow: ref.row,
      });
    },
    "source",
  );
}

function evidenceButton(ref) {
  if (typeof ref === "string") return node("p", "prose", ref);
  const sourceId = ref.sourceId || ref.artifactId || ref.id;
  const source = latestArtifact(sourceId);
  const label = `${source?.title || ref.title || sourceId || "资料依据"}${ref.version ? ` · v${ref.version}` : ""}${ref.row ? ` · 第 ${ref.row} 条` : ""}`;
  if (!sourceId)
    return node("p", "prose", ref.text || ref.description || plain(ref));
  return button(
    label,
    "evidence-button",
    () => openArtifact(sourceId, ref.version, true, { evidenceRow: ref.row }),
    "source",
  );
}

function renderEvidence(evidence, title = "来源依据") {
  const list = node("div");
  for (const ref of evidence.slice(0, 60)) list.append(evidenceButton(ref));
  if (evidence.length > 60)
    list.append(
      node(
        "p",
        "data-note",
        `共 ${evidence.length} 条引用，当前展示前 60 条。`,
      ),
    );
  return contentSection(title, list);
}

function propertyList(values) {
  const list = node("dl", "property-list");
  for (const [key, value] of Object.entries(values)) {
    const property = node("div", "property");
    property.append(
      node("dt", "", fieldNames[key] || key),
      node(
        "dd",
        "",
        typeof value === "object" && value !== null
          ? Array.isArray(value)
            ? value.map(plain).join("\n")
            : plain(value)
          : statusNames[value] || plain(value),
      ),
    );
    list.append(property);
  }
  return list;
}

function genericValue(value) {
  if (Array.isArray(value)) {
    const list = node("div");
    value.slice(0, 50).forEach((item) => {
      if (item && typeof item === "object") {
        const card = node("div", "definition-card");
        card.append(propertyList(item));
        list.append(card);
      } else list.append(node("p", "prose", `• ${plain(item)}`));
    });
    if (value.length > 50)
      list.append(
        node("p", "data-note", `共 ${value.length} 项，当前展示前 50 项。`),
      );
    if (!value.length) list.append(node("p", "prose", "暂无记录"));
    return list;
  }
  if (value && typeof value === "object") return propertyList(value);
  return node("div", "prose", plain(value));
}

function renderFields(container, content, exclude) {
  for (const [key, value] of Object.entries(content)) {
    if (exclude.has(key) || value === null || value === undefined) continue;
    container.append(
      contentSection(fieldNames[key] || key, genericValue(value)),
    );
  }
}

function openSettings() {
  $("#provider-input").value = state.model.provider || "deepseek";
  $("#model-input").value = state.model.model || "deepseek-v4-flash";
  $("#api-key-input").value = "";
  $("#api-key-input").placeholder = state.model.configured
    ? "已配置凭据；留空表示沿用"
    : "输入你的 API Key";
  $("#settings-status").hidden = true;
  ui.settingsDirty = false;
  $("#settings-dialog").showModal();
}

function closeSettings() {
  $("#api-key-input").value = "";
  $("#settings-dialog").close();
}

function settingsStatus(message, error = false) {
  $("#settings-status").textContent = message;
  $("#settings-status").classList.toggle("error", error);
  $("#settings-status").hidden = false;
}

async function saveSettings(event) {
  event.preventDefault();
  $("#save-settings").disabled = true;
  const key = $("#api-key-input").value.trim();
  try {
    await api("/api/settings", {
      provider: $("#provider-input").value,
      model: $("#model-input").value.trim(),
      ...(key ? { apiKey: key } : {}),
    });
    $("#api-key-input").value = "";
    ui.settingsDirty = false;
    await refresh();
    settingsStatus("模型设置已保存。可以测试连接，或关闭设置开始协作。");
  } catch (error) {
    settingsStatus(error.message, true);
  } finally {
    $("#save-settings").disabled = false;
  }
}

async function testSettings() {
  if (ui.settingsDirty) {
    settingsStatus("请先保存刚才修改的设置，再测试连接。", true);
    return;
  }
  $("#test-settings").disabled = true;
  settingsStatus("正在测试当前模型连接…");
  try {
    const result = await api("/api/settings/test", {});
    settingsStatus(
      result.message ||
        (result.ok
          ? "连接成功，可以开始协作。"
          : "连接未通过，请检查模型名称和凭据。"),
      !result.ok,
    );
    await refresh();
  } catch (error) {
    settingsStatus(error.message, true);
  } finally {
    $("#test-settings").disabled = false;
  }
}

function resizeInput() {
  const input = $("#message-input");
  if (ui.pendingMessage && input.value.trim() !== ui.pendingMessage.body.text)
    ui.pendingMessage = null;
  input.style.height = "auto";
  input.style.height = `${Math.min(170, Math.max(49, input.scrollHeight))}px`;
  updateComposer();
}

function closeSidebar() {
  $("#app-shell").classList.remove("sidebar-open");
  $("#sidebar-backdrop").hidden = true;
}

$("#message-form").addEventListener("submit", sendMessage);
$("#message-input").addEventListener("input", resizeInput);
$("#message-input").addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229
  ) {
    event.preventDefault();
    sendMessage();
  }
});
$("#new-task").addEventListener("click", startTask);
$$(".nav-item[data-view]").forEach((item) =>
  item.addEventListener("click", () => setView(item.dataset.view)),
);
$("#open-settings").addEventListener("click", openSettings);
$("#model-chip").addEventListener("click", openSettings);
$("#close-settings").addEventListener("click", closeSettings);
$("#settings-dialog").addEventListener("close", () => {
  $("#api-key-input").value = "";
});
$("#settings-dialog").addEventListener("click", (event) => {
  if (event.target === $("#settings-dialog")) {
    const rect = event.target.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      closeSettings();
  }
});
$("#settings-form").addEventListener("submit", saveSettings);
$("#settings-form").addEventListener("input", () => {
  ui.settingsDirty = true;
});
$("#test-settings").addEventListener("click", testSettings);
$("#provider-input").addEventListener("change", () => {
  $("#model-input").value =
    $("#provider-input").value === "deepseek" ? "deepseek-v4-flash" : "";
  $("#model-input").placeholder = "填写当前服务可用的模型名称";
  ui.settingsDirty = true;
});
$("#upload-button").addEventListener("click", () => $("#file-input").click());
$("#start-upload").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", (event) =>
  uploadFiles(event.target.files),
);
$("#load-sample").addEventListener("click", loadSample);
$("#start-understanding").addEventListener("click", () => {
  $("#message-input").value =
    "我想先建立企业理解。请带我从企业业务、我的职责和当前目标开始，一次讨论一个重点。";
  resizeInput();
  $("#message-input").focus();
});
$("#stop-button").addEventListener("click", stopTask);
$("#toggle-detail").addEventListener("click", () =>
  setDetailOpen(!ui.detailOpen),
);
$("#close-detail").addEventListener("click", () => setDetailOpen(false));
$("#clear-focus").addEventListener("click", () => {
  ui.selected = null;
  ui.pendingMessage = null;
  updateComposer();
});
$("#open-sidebar").addEventListener("click", () => {
  $("#app-shell").classList.add("sidebar-open");
  $("#sidebar-backdrop").hidden = false;
});
$("#sidebar-backdrop").addEventListener("click", closeSidebar);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#settings-dialog").open) {
    closeSidebar();
    if (!ui.editing) setDetailOpen(false);
  }
});
let dragDepth = 0;
document.addEventListener("dragenter", (event) => {
  if (event.dataTransfer?.types.includes("Files")) {
    event.preventDefault();
    dragDepth += 1;
    $("#drop-overlay").hidden = false;
  }
});
document.addEventListener("dragover", (event) => {
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
});
document.addEventListener("dragleave", (event) => {
  if (event.dataTransfer?.types.includes("Files")) {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $("#drop-overlay").hidden = true;
  }
});
document.addEventListener("drop", (event) => {
  if (event.dataTransfer?.files.length) {
    event.preventDefault();
    dragDepth = 0;
    $("#drop-overlay").hidden = true;
    uploadFiles(event.dataTransfer.files);
  }
});
window.addEventListener("focus", () => refresh());
await refresh(true);
setInterval(() => {
  if (document.visibilityState === "visible") refresh();
}, 1200);

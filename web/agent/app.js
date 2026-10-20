import { createSessions } from "./sessions.js";
import { createWorkspaceStore, connectWorkspaceEvents, createScopeQueue } from "./workspace-store.js";
import { createAgentPanel } from "./agent-panel.js";
import { createTaskCenter } from "./task-center.js";
import { renderPendingCenter } from "./pending-center.js";
import { createDataProfile } from "./data-profile.js";
import { renderSharedAccess } from "./share-workspace.js";
import { developerView, setDeveloperView, safeText, displayValue, fieldLabel, technicalDetails } from "./ui-display.js";
import { renderEngineWorkspace, openSource as openEngineSource, showEngineBuilds } from "./engine-workspace.js";
import { renderReleaseWorkspace } from "./release-workspace.js";
import { dialog as engineDialog } from "./engine-ui.js";
import { renderOnboarding } from "./onboarding.js";
import { renderDatasetWorkspace } from "./dataset-workspace.js";
import { renderEvidenceWorkspace } from "./evidence.js";
import { renderFoundationWorkspace } from "./foundation-workspace.js";
import { renderOntologySpace } from "./ontology-space.js";
import { renderLiveObjects } from "./live-objects.js";
import { renderFoundation } from "./foundation.js";
import { createCapabilitiesPanel } from "./capabilities.js";
import {
  renderDefinitionGraph,
  renderObjectGraph,
} from "./ontology-workspace.js";
import { renderLiveWorkspace } from "./live-workspace.js";
import { createDraftStore } from "./drafts.js";
import { createShareMode } from "./share-mode.js";

const shareMode = createShareMode(document);

// Give static and dynamically mounted dialogs the same dismissal affordance.
const styledDialogs = new WeakSet();
function styleDialog(dialog) {
  if (styledDialogs.has(dialog)) return;
  styledDialogs.add(dialog);
  dialog.classList.add("unified-dialog");
  let close = [...dialog.querySelectorAll("button")].find(button =>
    button.closest("dialog") === dialog &&
    (button.textContent.trim() === "关闭" || (button.getAttribute("aria-label") || "").startsWith("关闭")));
  if (!close) {
    close = document.createElement("button");
    close.type = "button";
    close.addEventListener("click", () => dialog.close());
    dialog.prepend(close);
  }
  close.classList.add("unified-dialog-close");
  close.setAttribute("aria-label", "关闭弹窗");
  close.title = "关闭";
  close.textContent = "×";
  const outside = event => {
    const rect = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
  };
  let backdropDown = false;
  dialog.addEventListener("pointerdown", event => { backdropDown = outside(event); });
  dialog.addEventListener("click", event => {
    if (backdropDown && outside(event)) close.click();
    backdropDown = false;
  });
}
function styleDialogsIn(root) {
  if (root instanceof Element && root.matches("dialog")) styleDialog(root);
  root.querySelectorAll?.("dialog").forEach(styleDialog);
}
styleDialogsIn(document);
new MutationObserver(records => {
  for (const record of records) for (const added of record.addedNodes) styleDialogsIn(added);
}).observe(document.body, { childList: true, subtree: true });


const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const pageLabels = {
  setup: "数据",
  ontology: "本体",
  consumption: "发布与接入",
};
const placeholders = {
  setup: "需要接入什么数据？我可以协助配置与检查…",
  ontology: "我们需要理解哪些业务对象？",
  consumption: "检查这次发布，或分析接入方的升级影响…",
};
const demoQuestions = {
  setup: "这家企业是什么样的？",
  ontology: "哪些投诉还缺恢复依据？",
  consumption: "谁可以调用这些记忆？",
};
const fieldLabels = {
  "company.legalName": "企业主体",
  "company.foundingDate": "成立时间",
  "company.history": "发展沿革",
  "company.products": "产品",
  "company.services": "服务",
  "company.name": "企业名称",
  "company.business": "业务",
  "company.goal": "当前目标",
  "company.industry": "行业",
  "company.location": "所在地区",
  "company.scope": "服务范围",
  "company.customers": "服务对象",
  "company.customer": "服务对象",
  customers: "服务对象",
  "company.departments": "部门",
  "company.process": "业务流程",
  "company.boundary": "业务边界",
  "company.scale": "服务规模",
  "company.stations": "换热站",
  "company.communities": "服务小区",
  "company.organization": "组织",
  "company.role": "你的职责",
  name: "名称",
  company_name: "企业名称",
  business: "业务",
  goal: "当前目标",
  goals: "目标",
  scope: "范围",
  role: "职责",
  industry: "行业",
  location: "地区",
  organization: "组织",
  departments: "部门",
  description: "说明",
  status: "状态",
  $id: "对象编号",
};
const accessFragment = new URLSearchParams(location.hash.slice(1));
let initialAccess = accessFragment.get("access") || "";
if (accessFragment.has("access")) {
  accessFragment.delete("access");
  history.replaceState(
    null,
    "",
    `${location.pathname}${location.search}${accessFragment.size ? `#${accessFragment}` : ""}`,
  );
}
const state = {
  token: initialAccess,
  workspaceId: null,
  onboarding: null,
  setupSection: "company",
  legacyHistory: [],
  currentPage: "setup",
  page: "setup",
  pages: [],
  model: {},
  busy: false,
  streaming: "",
  messages: [],
  prompt: "你的企业叫什么？",
  profile: null,
  sources: [],
  ontologies: [],
  foundation: null,
  automaticBuild: null,
  automaticApiBuild: null,
  engine: null,
  data: null,
  agentTask: null,
  evidence: [],
  outlines: [],
  verifications: [],
  sourcePolicies: [],
  sourcePolicyFields: {},
  attention: [],
  consumers: [],
  accessLogs: [],
  pending: null,
  demo: null,
  sourceSummary: { sources: [], total: 0, counts: {} },
  messagePage: { nextBefore: null },
  session: null,
  currentSessionId: null,
  pools: { interactive: [], background: { active: null, queued: [] } },
  live: { connections: [], models: [], consumers: [], audit: [] },
};
initialAccess = "";
const ui = {
  page: "setup",
  initialized: false,
  enterpriseTab: "overview",
  polling: false,
  requesting: false,
  uploading: false,
  generation: 0,
  detailRequest: 0,
  detail: null,
  focus: null,
  contextRequest: 0,
  contextResolving: false,
  contextRevision: 0,
  draftRef: { id: crypto.randomUUID(), revision: 0 },
  drafts: new Map(),
  draftStore: null,
  importedDrafts: [],
  ontologyView: "definitions",
  definitionId: null,
  graphSelections: new Map(),
  canvasDirty: true,
  dialogueKey: "",
  chatMode: "compact",
  pendingMessage: null,
  settingsBusy: false,
};

const workspace = createWorkspaceStore(state);
const { renderDialogue } = createAgentPanel({ state, ui, $, node, button, api, hasCanvasContent, inspectContext, errorMessage });
const { renderAgentTask } = createTaskCenter({ state, ui, $, node, button, navigate, setChatMode, dataActions, openDefinitions, isOnboarding: () => onboardingDialog?.open });
const { renderDataProfile } = createDataProfile({ state, ui, $, pageLabels, node, button, api, mutate, navigate, draftKey, applySnapshot, label, openStatement, resizeInput, rememberDraft, openComposer, foundationPanel, shareMode, showCredential, renderSources, renderCanvas, startOnboarding, setFocus, errorMessage, updateComposer });
function openDefinitions() { $("#canvas").firstElementChild?.openDefinitions?.(); }
let sessions, disconnectEvents;
function snapshotPath(scope) {
  const params = new URLSearchParams({ page: ui.page });
  if (state.currentSessionId) params.set("sessionId", state.currentSessionId);
  if (scope) params.set("scope", scope);
  return `/api/snapshot?${params}`;
}
async function switchSession(id) {
  rememberDraft();
  const generation = ++ui.sessionGeneration;
  state.currentSessionId = id; state.messages = []; state.messagePage = { nextBefore: null }; state.streaming = "";
  ui.dialogueKey = "";
  restoreDraft(ui.drafts.get(draftKey()) ?? ui.draftStore?.read(draftKey()));
  try { sessionStorage.setItem(`dataengine:session:${state.workspaceId}`, id); } catch {}
  sessions?.render(); renderDialogue(); updateComposer();
  const snapshot = await api(snapshotPath("agent"));
  if (generation === ui.sessionGeneration) { applySnapshot(snapshot, "agent"); sessions?.render(); }
}
const scopeUpdates = createScopeQueue(async scope => {
  if (scope === "sessions") { await sessions?.load(); return; }
  const sessionId = state.currentSessionId, generation = ui.generation, sessionGeneration = ui.sessionGeneration, pageGeneration = ui.pageGeneration;
  const snapshot = await api(snapshotPath(scope));
  if (sessionId !== state.currentSessionId || generation !== ui.generation || sessionGeneration !== ui.sessionGeneration || pageGeneration !== ui.pageGeneration) { scopeUpdates.add([scope]); return; }
  applySnapshot(snapshot, scope); sessions?.render();
  if ($("#request-error").dataset.connection === "true") { errorMessage(); delete $("#request-error").dataset.connection; }
}, error => errorMessage(error.message));
async function initializeEvents() {
  if (!sessions) {
    ui.sessionGeneration = 0;
    sessions = createSessions({ state, api, switchSession, error: errorMessage, host: $(".interaction") });
    await sessions.load();
    await switchSession(state.currentSessionId);
  }
  disconnectEvents?.();
  disconnectEvents = connectWorkspaceEvents({ cursor: ui.eventCursor,
    onEvent: event => {
      if (event.type === "delta") {
        if (event.sessionId !== state.currentSessionId) return;
        state.streaming += event.text || ""; state.busy = true; renderDialogue(); updateComposer(); return;
      }
      scopeUpdates.add(event.scopes || []);
    },
    onCorrect: () => { void refresh(); scopeUpdates.add(["data", "ontology", "release", "agent", "sessions"]); },
    onError: error => { $("#request-error").dataset.connection = "true"; errorMessage(error.message); },
  });
}

function node(tag, className = "", text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = safeText(text);
  return element;
}
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}
function button(label, className, action, iconName) {
  const element = node("button", className);
  element.type = "button";
  if (iconName) element.append(icon(iconName));
  if (label) element.append(node("span", "", label));
  element.addEventListener("click", action);
  return element;
}
function plain(value) {
  if (value === null || value === undefined || value === "") return "未提供";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "object") return displayValue(value);
  return safeText(value);
}
function label(key) {
  return fieldLabels[key] || key.replace(/^company\./, "");
}
function errorMessage(message = "") {
  document.querySelector(".onboarding")?.showError?.(message);
  if (message && ui.chatMode === "collapsed") setChatMode("composer");
  $("#request-error").textContent = message;
  $("#request-error").hidden = !message;
}
async function api(path, body, method) {
  if (shareMode) return shareMode.request(path, body);
  const response = await fetch(path, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers: {
      ...(state.token ? { "X-DataEngine-Token": state.token } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response
    .json()
    .catch(() => ({ error: "暂时无法读取页面，请重试。" }));
  if (response.status === 401)
    throw new Error("请使用本机服务启动时提供的链接打开企业记忆。");
  if (!response.ok || data.error)
    throw Object.assign(new Error(data.error || "请求未完成，请重试。"), {
      status: response.status,
    });
  return data;
}
function draftKey(page = ui.page) { return `${state.currentSessionId || "default"}:${page}`; }
function rememberDraft() {
  const key = draftKey();
  const text = $("#message-input").value;
  if (ui.drafts.get(key)?.text !== text) ui.draftRef.revision += 1;
  const draft = {
    draftRef: { ...ui.draftRef },
    contextRevision: ui.contextRevision,
    text,
    focus: ui.focus,
    pendingMessage: ui.pendingMessage,
    nextRefreshSources: ui.nextRefreshSources === true,
  };
  ui.drafts.set(draftKey(), draft);
  ui.draftStore?.save(draftKey(), draft);
}
function restoreDraft(draft) {
  $("#message-input").value = draft?.text || "";
  ui.focus = draft?.focus || null;
  ui.pendingMessage = draft?.pendingMessage || null;
  ui.nextRefreshSources = draft?.nextRefreshSources === true;
  ui.draftRef = draft?.draftRef || { id: crypto.randomUUID(), revision: 0 };
  ui.contextRevision = draft?.contextRevision || 0;
  ui.contextRequest += 1;
  ui.contextResolving = false;
}
function changePage(page) {
  if (ui.page === page) return;
  rememberDraft();
  ui.page = page;
  ui.pageGeneration = (ui.pageGeneration || 0) + 1;
  const draft = ui.drafts.get(draftKey(page)) ?? ui.draftStore?.read(draftKey(page)) ?? ui.draftStore?.read(page);
  restoreDraft(draft);
  ui.detail = null;
  ui.detailRequest += 1;
  ui.canvasDirty = true;
  ui.dialogueKey = "";
  $("#canvas").scrollTop = 0;
  resizeInput();
}
function applySnapshot(snapshot, scope) {
  if (!snapshot || typeof snapshot !== "object") return;
  const firstLoad = !ui.initialized;
  if (!shareMode && snapshot.workspaceId && snapshot.workspaceId !== state.workspaceId) {
    ui.drafts.clear();
    try {
      ui.draftStore = createDraftStore(localStorage, snapshot.workspaceId, () => errorMessage("浏览器无法保存草稿，请复制内容后再关闭页面。"));
      ui.importedDrafts = ui.draftStore.read("legacy") || [];
      const savedPage = sessionStorage.getItem(`dataengine:page:${snapshot.workspaceId}`);
      ui.page = pageLabels[savedPage] ? savedPage : "setup";
      const savedSession = sessionStorage.getItem(`dataengine:session:${snapshot.workspaceId}`);
      state.currentSessionId = savedSession || snapshot.currentSessionId || null;
    } catch { errorMessage("浏览器无法保存草稿，请复制内容后再关闭页面。"); }
  }
  const agentKeys = ["session", "currentSessionId", "messages", "messagePage", "streaming", "busy", "pending", "prompt"];
  if (!shareMode && state.currentSessionId && snapshot.currentSessionId && snapshot.currentSessionId !== state.currentSessionId)
    snapshot = Object.fromEntries(Object.entries(snapshot).filter(([key]) => !agentKeys.includes(key)));
  if (snapshot.messages && (!snapshot.currentSessionId || snapshot.currentSessionId === state.currentSessionId)) {
    const newest = new Set(snapshot.messages.map(message => message.id));
    const earlier = state.messages.filter(message => !newest.has(message.id));
    if (earlier.length) { snapshot.messages = [...earlier, ...snapshot.messages]; snapshot.messagePage = state.messagePage; }
  }
  const pageFields = ui.page === "setup" ? ["sources", "sourceSummary", "data", "engine", "profile"] : ui.page === "ontology" ? ["foundation", "sourceSummary"] : ["consumers", "accessLogs"];
  if (firstLoad || Object.keys(snapshot).some(key => pageFields.includes(key))) ui.canvasDirty = true;
  workspace.patch(snapshot);
  if (snapshot.eventCursor) ui.eventCursor = snapshot.eventCursor;
  if (shareMode && snapshot.currentPage) changePage(snapshot.currentPage);
  ui.initialized = true;
  if (firstLoad) {
    const draft = ui.draftStore?.read(draftKey()) ?? ui.draftStore?.read(ui.page);
    restoreDraft(draft); if (draft) ui.drafts.set(draftKey(), draft); resizeInput();
    if (state.setupSection === "sources") ui.enterpriseTab = "sources";
  }
  if (scope) workspace.emit(scope, snapshot);
  render();
}
async function refresh(bootstrap = false) {
  if (ui.polling || ui.requesting) return;
  ui.polling = true;
  const generation = ui.generation;
  const sessionGeneration = ui.sessionGeneration, pageGeneration = ui.pageGeneration;
  try {
    const snapshot = await api(
      bootstrap || !state.token
        ? "/api/canvas/bootstrap"
        : shareMode ? `/api/canvas?page=${encodeURIComponent(ui.page)}` : snapshotPath(),
    );
    if (generation !== ui.generation || sessionGeneration !== ui.sessionGeneration || pageGeneration !== ui.pageGeneration) return;
    applySnapshot(snapshot);
    if (!shareMode && bootstrap) await initializeEvents();
    if ($("#request-error").dataset.connection === "true") {
      errorMessage();
      delete $("#request-error").dataset.connection;
    }
  } catch (error) {
    if (generation === ui.generation) {
      errorMessage(error.message);
      $("#request-error").dataset.connection = "true";
    }
  } finally {
    ui.polling = false;
  }
}
async function mutate(path, body, after, onError, detached = {}) {
  if (ui.requesting) return false;
  const origin = { sessionId: state.currentSessionId, page: ui.page, sessionGeneration: ui.sessionGeneration, pageGeneration: ui.pageGeneration, draftKey: draftKey() };
  const current = () => origin.sessionId === state.currentSessionId && origin.page === ui.page && origin.sessionGeneration === ui.sessionGeneration && origin.pageGeneration === ui.pageGeneration;
  const dialog = [...document.querySelectorAll("dialog[open]")].at(-1);
  let receipt;
  const controls = dialog ? [...dialog.querySelectorAll("button,input,select,textarea")].map(control => [control, control.disabled]) : [];
  if (dialog) {
    receipt = dialog.querySelector(":scope > .mutation-receipt") || node("p", "mutation-receipt");
    receipt.setAttribute("role", "status"); receipt.textContent = "正在处理，请稍候…"; dialog.prepend(receipt);
    dialog.setAttribute("aria-busy", "true"); controls.forEach(([control]) => control.disabled = true);
  }
  ui.requesting = true;
  ui.generation += 1;
  errorMessage();
  updateComposer();
  try {
    const result = await api(path, path.startsWith("/api/canvas/") && body ? { ...body, sessionId: body.sessionId || state.currentSessionId } : body);
    if (current()) { after?.(result); applySnapshot(result); }
    else detached.after?.(result, origin);
    if (receipt) receipt.textContent = path.endsWith("/adopt") ? "已采用，当前定义已更新。关闭后重新打开可查看最新版本。" : "操作已完成。";
    return true;
  } catch (error) {
    if (receipt) {receipt.setAttribute("role", "alert"); receipt.textContent = error.message;}
    if (current()) { onError?.(error); errorMessage(error.message); }
    else detached.error?.(error, origin);
    return false;
  } finally {
    dialog?.removeAttribute("aria-busy"); controls.forEach(([control, disabled]) => control.disabled = disabled);
    ui.requesting = false;
    updateComposer();
  }
}
async function navigate(page) {
  if (["company", "sources"].includes(page)) { ui.enterpriseTab = page; page = "setup"; }
  if (!pageLabels[page]) return;
  if (page === ui.page) return;
  changePage(page);
  if (shareMode) { applySnapshot(await api("/api/canvas/navigate", { page })); return; }
  try { sessionStorage.setItem(`dataengine:page:${state.workspaceId}`, page); } catch {}
  render(); await refresh();
}
const capabilityPanel = createCapabilitiesPanel(api, () => renderCanvas(true));

/** FEATURE_041 T041-04c: the main UI shows the working version; other definition versions live in the developer view. */
function syncWorkspaceVersion() {
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;
  let chip = document.getElementById("workspace-version");
  if (!chip) {
    chip = document.createElement("span");
    chip.id = "workspace-version";
    chip.className = "workspace-version";
    topbar.append(chip);
  }
  const version = state.workspaceVersion;
  chip.hidden = !version;
  chip.textContent = version ? `工作版 v${version.number}` : "";
  chip.title = version ? `当前工作版本 v${version.number}；发布时固定这一版。其他定义版本号在开发者视图显示。` : "";
}

function render() {
  syncWorkspaceVersion();
  capabilityPanel.button.hidden = !!shareMode || !!state.demo || !developerView();
  $("#demo-badge").hidden = !state.demo;
  $("#demo-badge").title = shareMode
    ? "虚构热力企业的离线快照，可直接浏览；示例问答不调用 AI，也不修改数据。"
    : "虚构企业与样本数据；演示问答在本地运行，无需模型密钥。";
  $("#demo-badge").textContent = shareMode ? "离线演示" : "演示数据";
  $("#open-settings").hidden = !!state.demo;
  for (const control of $$("[data-page]")) {
    const page = control.dataset.page;
    const entry = state.pages.find((item) => item.id === page);
    control.disabled =
      (page !== "setup" && !entry?.available && page !== ui.page);
    control.textContent = pageLabels[page];
    if (page === ui.page) control.setAttribute("aria-current", "page");
    else control.removeAttribute("aria-current");
  }
  document.title = `${state.profile ? companyName() : "DataEngine"} · ${pageLabels[ui.page]}`;
  renderCanvas();
  syncOnboarding();
  renderDialogue();
  renderAgentTask();
  updateComposer();
}
function renderCanvas(force = false) {
  const canvas = $("#canvas"), current = canvas.firstElementChild;
  if (ui.detail) return;
  const samePage = ui.renderedPage === ui.page;
  if (!force && !ui.canvasDirty && samePage && current) { current.updateStatus?.(state); return; }
  ui.canvasDirty = false;
  if (samePage && current?.updateWorkspace?.(state) !== false && current?.updateWorkspace) return;
  const scroll = samePage ? canvas.scrollTop : 0;
  const spatial = ui.page === "ontology" && !shareMode && !state.demo;
  $(".canvas-app").classList.toggle("is-ontology-space", spatial);
  for (const element of $$(".os-chat-metrics,.os-chat-footer")) element.hidden = !spatial;
  current?.dispose?.();
  if (spatial && ["compact", "collapsed"].includes(ui.chatMode)) setChatMode("composer");
  if (ui.page === "setup") canvas.replaceChildren(renderSetup());
  else if (ui.page === "consumption") canvas.replaceChildren(shareMode || state.demo ? renderSharedAccess(state) : renderReleaseWorkspace(state, {
    api, events: workspace, ontology: () => navigate("ontology"), ask: askAssistant,
    onChanged: () => { if (ui.page === "consumption") renderCanvas(true); },
  }));
  else if (shareMode || state.demo) canvas.replaceChildren(renderOntology());
  else canvas.replaceChildren(renderOntologyBoard({
    selections: ui.graphSelections,
    select: (model, target, isCurrent, focusComposer = false) => selectLiveContext(model, target, undefined, focusComposer, isCurrent),
    read: (model, target) => api("/api/canvas/context/read", { page: "ontology", context: {
      ...currentWorkContext(), view: "ontology.definitions",
      selection: [{ spaceId: state.workspaceId, id: model.id, version: model.version, ...target }],
      scope: { where: {}, offset: 0, limit: 20 },
    }}),
  }));
  ui.renderedPage = ui.page;
  renderAttention(canvas);
  canvas.scrollTop = scroll;
}
function renderOntologyBoard(actions) {
  const managementContent = () => {
  const management = node("div");
  const directory = node("details", "live-legacy");
  directory.append(node("summary", "", "定义与映射目录"), renderFoundationWorkspace(state.foundation, actions));
  const full = node("details", "live-legacy");
  full.append(node("summary", "", "完整基础定义与采用操作"), foundationPanel());
  management.append(directory, full, renderLiveWorkspace("ontology", state.live, {
    api, mutate, showCredential, selections:ui.graphSelections, onSelectContext:selectLiveContext, onSaved:refresh,
  }));
  return management;
  };
  const objectContent = () => {
  const objects = node("div", "ontology-board-objects");
  let loaded = false;
  const loadObjects = () => {
    if (loaded) return;
    loaded = true;
    const models = state.live.models;
    if (!models.length) {
      const empty = node("div", "ontology-object-empty");
      empty.append(node("h2", "", "先让概念对应到真实记录"), node("p", "", "当前尚未建立执行映射。连接来源并完成映射后，这里展示具体对象与逐属性依据。"));
      objects.append(empty); return;
    }
    const picker = node("select", "model-select"); picker.setAttribute("aria-label", "对象的执行映射");
    for (const model of models) {
      const option = node("option", "", `${model.title} · v${model.version} · ${model.status === "adopted" ? "已采用" : "候选预览"}`);
      option.value = model.id; picker.append(option);
    }
    const saved = ui.graphSelections.get("ontology-object-model");
    picker.value = models.find(m => m.id === saved)?.id || models.find(m => m.status === "adopted")?.id || models[0].id;
    const host = node("div"); objects.append(picker, host);
    const show = () => {
      const model = models.find(m => m.id === picker.value);
      ui.graphSelections.set("ontology-object-model", model.id);
      host.replaceChildren();
      if (model.status !== "adopted") host.append(node("p", "source-meta", "候选映射下的对象预览，尚未采用。"));
      host.append(renderLiveObjects(model, {api, selections: ui.graphSelections,
        select: (m, t, scope, guard) => selectLiveContext(m, t, scope, false, () => objects.closest("dialog")?.open && (!guard || guard()))}));
    };
    picker.onchange = show; show();
  };
  loadObjects(); return objects;
  };
  return renderOntologySpace(state.foundation, {
    ...actions,
    automaticBuild: state.automaticBuild,
    automaticApiBuild: state.automaticApiBuild,
    connectModel: openSettings,
    retryBuild: () => mutate("/api/canvas/foundation/automatic", {}),
    engine: state.engine,
    sourceSummary: state.sourceSummary,
    programBuild: () => showEngineBuilds(state, {...dataActions(),management:openDefinitions}),
    management: managementContent,
    objects: objectContent,
    evidence: () => renderEvidenceWorkspace(state, {api, mutate}),
    onLayout: updateOntologyComposer,
    onSelection: followOntologySelection,
  });
}
function followOntologySelection(artifact, target, guard) {
  if (ui.page !== "ontology" || (ui.focus && ui.focus.source !== "viewport")) return;
  if (!target) {
    ui.dismissedSelection = null;
    if (ui.focus?.source === "viewport") {
      ui.focus = null; ui.contextRequest++; ui.contextRevision++; ui.contextResolving = false;
      rememberDraft(); updateComposer();
    }
    return;
  }
  const key = JSON.stringify([artifact.id, artifact.version, target]);
  if (ui.dismissedSelection === key) return;
  ui.dismissedSelection = null;
  void selectLiveContext(artifact, target, undefined, false, guard, "viewport");
}
function updateOntologyComposer({stage, stats}) {
  $(".canvas-app").dataset.ontologyStage = stage;
  let metrics = $(".os-chat-metrics");
  if (!metrics) {
    metrics = node("div", "os-chat-metrics");
    $("#chat-surface .composer-wrap").prepend(metrics);
    const footer = node("div", "os-chat-footer");
    footer.append(node("span", "", "DataEngine Agent"),
      button("对话记录", "", () => setChatMode(ui.chatMode === "history" ? "composer" : "history")),
      button("继续提问", "os-chat-discuss", openComposer));
    $("#chat-surface").append(footer);
  }
  metrics.replaceChildren();
  for (const [name, count] of [["业务概念", stats.concepts], ["业务关系", stats.relations], ["已映射", stats.mapped], ["定义依据", stats.evidence]]) {
    const item = node("div"); item.append(node("span", "", name), node("strong", "", String(count))); metrics.append(item);
  }
  metrics.hidden = false;
  $(".os-chat-footer").hidden = false;
  $(".interaction").setAttribute("aria-label", "本体助手");
  $("#message-input").dataset.spatialPlaceholder = stage === "global" ? "向企业本体提问…" : "输入问题，或先引用本体内容…";
  updateComposer();
}
function foundationPanel() {
  return renderFoundation(state.foundation, {
    page: ui.page,
    live: state.live,
    api,
    mutate,
    busy: state.busy || ui.requesting,
    adopt: (body) => mutate("/api/canvas/foundation/adopt", body),
    discuss: (artifact) => askAbout(artifact, "基础定义"),
    locate: (args) =>
      api(`/api/foundation/evidence?${new URLSearchParams(args)}`),
  });
}
function askAssistant(text) {
  const input=$("#message-input");input.value=input.value.trim()?`${input.value}\n${text}`:text;
  rememberDraft();resizeInput();openComposer();
}
function dataActions() {return {api,events:workspace,apply:applySnapshot,upload:()=>$("#file-input").click(),refresh,ask:askAssistant,ontology:()=>navigate("ontology")};}
let onboardingDialog;
let onboardingWorkspace;
let onboardingClosing = false;
let onboardingDismissed = null;
function setOnboardingDismissed(dismissed) {
  onboardingDismissed = dismissed ? state.workspaceId : null;
  try {
    const key = `de-onboarding-dismissed:${state.workspaceId}`;
    if (dismissed) sessionStorage.setItem(key, "true");
    else sessionStorage.removeItem(key);
  } catch { /* A blocked browser store still allows dismissal in this tab. */ }
}
async function startOnboarding(origin) {
  if (state.onboarding?.active) {
    setOnboardingDismissed(false);
    origin?.closest("dialog")?.close();
    syncOnboarding();
    return true;
  }
  return mutate("/api/onboarding/start", {
    expectedVersion: state.onboarding?.version ?? 0,
    flow: state.onboarding?.flow || "engine",
  }, () => { setOnboardingDismissed(false); origin?.closest("dialog")?.close(); });
}
async function dismissOnboarding() {
  const component = onboardingDialog?.component;
  if (onboardingClosing || component?.isWorking()) return;
  if (state.busy) {
    setOnboardingDismissed(true);
    onboardingDialog.close();
    renderAgentTask();
    return;
  }
  onboardingClosing = true;
  onboardingDialog.closeButton.disabled = true;
  try {
    applySnapshot(await api("/api/onboarding/suspend", {
      expectedVersion: state.onboarding.version,
    }));
  } catch (error) {
    component?.showError(error.message);
  } finally {
    onboardingClosing = false;
    if (onboardingDialog) onboardingDialog.closeButton.disabled = false;
  }
}
function syncOnboarding() {
  if (onboardingWorkspace !== state.workspaceId) {
    try { onboardingDismissed = sessionStorage.getItem(`de-onboarding-dismissed:${state.workspaceId}`) ? state.workspaceId : null; } catch { onboardingDismissed = null; }
  }
  const active = ui.page === "setup" && state.onboarding?.active && onboardingDismissed !== state.workspaceId && !shareMode && !state.demo;
  if (onboardingDialog && (onboardingWorkspace !== state.workspaceId || (!state.onboarding?.active && state.onboarding?.completedAt))) {
    onboardingDialog.close();
    onboardingDialog.remove();
    onboardingDialog = null;
  }
  if (!active) {
    onboardingDialog?.close();
    return;
  }
  if (!onboardingDialog) {
    const dialog = node("dialog", "onboarding-dialog");
    dialog.setAttribute("aria-label", "初始化数据工作区");
    const close = button("关闭", "quiet-button", dismissOnboarding);
    const component = renderOnboarding(state, {
      ...dataActions(), connect: kind => openEngineSource(kind, dataActions()),
    });
    dialog.component = component;
    dialog.closeButton = close;
    dialog.append(close, component);
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      void dismissOnboarding();
    });
    document.body.append(dialog);
    styleDialog(dialog);
    onboardingDialog = dialog;
    onboardingWorkspace = state.workspaceId;
  } else onboardingDialog.component.update(state);
  if (!onboardingDialog.open) onboardingDialog.showModal();
  onboardingDialog.closeButton.disabled = onboardingClosing;
}
function renderSetup() {
  if (shareMode || state.demo) return renderDataProfile();
  const workspace = renderEngineWorkspace(state, {...dataActions(),
    initialize: !state.onboarding?.completedAt || state.onboarding?.active ? () => startOnboarding() : null,
    advanced: () => {
    const dialog = engineDialog("企业资料与已有连接", true);
    dialog.body.append(renderDataProfile());
    dialog.addEventListener("close", () => dialog.body.firstElementChild?.dispose?.());
  }});
  return workspace;
}
function emptyCanvas(fallback) {
  const section = node("section", "empty-canvas");
  section.append(node("h1", "", state.prompt || fallback));
  return section;
}
function statements() {
  return Array.isArray(state.profile?.content?.statements)
    ? state.profile.content.statements
    : [];
}
function findStatement(keys) {
  return statements().find(
    (item) => keys.includes(item.key) && item.origin !== "suggestion",
  );
}
function companyName() {
  return (
    findStatement(["company.name", "company_name", "companyName", "name"])
      ?.text ||
    state.foundation?.current?.content.enterprise.name ||
    "企业"
  );
}
function renderSources() {
  if (!state.sources.length) return emptyCanvas("接入第一份企业资料");
  const section = node("section", "sources-canvas");

  const grid = node("div", "source-grid");
  for (const source of state.sources) {
    const card = button("", "source-card", () => openSource(source));
    card.append(icon("source"), node("h2", "", source.title));
    const columns = source.content.columns || [];
    const excerpt = columns.length
      ? columns.slice(0, 4).join(" · ")
      : String(source.content.raw || "")
          .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
          .replace(/^#+\s*/gm, "")
          .slice(0, 100);
    card.append(
      node(
        "p",
        source.content.parseError ? "source-problem" : "",
        source.content.parseError ? "内容需要修正" : excerpt,
      ),
    );
    const policy = state.sourcePolicies.find(
      (item) => item.content.sourceId === source.id,
    );
    card.append(
      node(
        "span",
        "source-meta",
        [
          source.content.format === "csv"
            ? `${source.content.rows?.length || 0} 条记录`
            : "文档 · 可用于概念定义",
          `文件上传 · ${(source.content.format || "文档").toUpperCase()}`,
          `第 ${source.version} 版`,
        ].join(" · "),
      ),
    );
    if (policy?.content.purpose)
      card.append(node("p", "source-purpose", policy.content.purpose));
    if (policy?.content.sensitiveFields?.length)
      card.append(
        node(
          "span",
          "source-meta",
          `${policy.content.sensitiveFields.length} 个字段限制对外使用`,
        ),
      );
    grid.append(card);
  }
  section.append(grid);
  return section;
}
function heading(title, description) {
  const header = node("div", "canvas-heading");
  const text = node("div");
  text.append(node("h1", "", title));
  if (description) text.append(node("p", "", description));
  header.append(text);
  return header;
}
function currentOntology() {
  const pending = state.pending;
  const candidate =
    pending?.candidateId &&
    state.ontologies.find(
      (item) =>
        item.id === pending.candidateId &&
        item.version === Number(pending.version),
    );
  return (
    candidate ||
    [...state.ontologies].sort((a, b) =>
      String(b.createdAt).localeCompare(String(a.createdAt)),
    )[0]
  );
}
function canAdopt(artifact) {
  return (
    artifact &&
    artifact.status === "candidate" &&
    artifact.content.validation?.valid === true &&
    artifact.content.preview &&
    state.pending?.candidateId === artifact.id &&
    Number(state.pending.version) === artifact.version
  );
}
function currentDefinition() {
  const options = [...state.ontologies, ...state.outlines];
  return (
    options.find((item) => item.id === ui.definitionId) ||
    (state.pending?.candidateId &&
      options.find((item) => item.id === state.pending.candidateId)) ||
    options.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  );
}
function ontologyViews() {
  const nav = node("nav", "view-tabs");
  nav.setAttribute("aria-label", "本体查看方式");
  for (const [id, title] of [
    ["definitions", "定义"],
    ["objects", "对象"],
    ["verification", "验证"],
  ]) {
    const control = button(title, "view-tab", () => {
      ui.detailRequest += 1;
      ui.ontologyView = id;
      renderCanvas(true);
      $("#canvas").scrollTop = 0;
    });
    control.setAttribute("aria-pressed", String(ui.ontologyView === id));
    nav.append(control);
  }
  return nav;
}
function renderOntology() {
  const artifact = currentDefinition();
  const section = node("section", "ontology-canvas");
  const goal = findStatement(["company.goal", "goal", "goals"]);
  section.append(
    heading("业务记忆", goal?.text || artifact?.content.purpose),
    ontologyViews(),
  );
  if (ui.ontologyView === "verification") {
    section.append(renderVerifications(artifact));
    return section;
  }
  if (!artifact) {
    const empty = node("div", "view-empty");
    empty.append(
      node(
        "h2",
        "",
        ui.ontologyView === "objects"
          ? "定义对应的记录，会在这里成为对象。"
          : "从一个业务问题，开始理解这些资料。",
      ),
    );
    empty.append(
      node("p", "", "可以先用文档整理概念，再用业务记录建立对象与关系。"),
    );
    empty.append(
      button("查看企业资料", "quiet-button", () => navigate("sources")),
    );
    section.append(empty);
    return section;
  }
  const options = [...state.ontologies, ...state.outlines].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const modelBar = node("div", "model-bar");
  const select = node("select", "model-select");
  select.setAttribute("aria-label", "选择定义版本");
  for (const model of options) {
    const option = node(
      "option",
      "",
      `${model.title} · ${model.kind === "ontology_outline" ? "概念草稿" : model.status === "adopted" ? "已采用" : model.status === "rejected" ? "已放下" : "待确认"}`,
    );
    option.value = model.id;
    select.append(option);
  }
  select.value = artifact.id;
  select.addEventListener("change", () => {
    ui.detailRequest += 1;
    ui.definitionId = select.value;
    renderCanvas(true);
  });
  modelBar.append(select);
  section.append(modelBar);
  const outlined = artifact.kind === "ontology_outline";
  const selectionKey = `${artifact.id}:${artifact.version}:${ui.ontologyView}`;
  if (!ui.graphSelections.has(selectionKey))
    ui.graphSelections.set(selectionKey, {});
  const graphOptions = {
    readOnly: !!shareMode,
    selection: ui.graphSelections.get(selectionKey),
    api,
    onSelectionChange: () => {
      ui.detailRequest += 1;
    },
    renderEvidence: (refs) => evidenceButtons(refs, closeDetail),
    onAsk: (suffix) => askAbout(artifact, suffix),
    onOpenRelated: (entity, relation) =>
      loadObjects(artifact, entity.type, {
        id: entity.id,
        relation: relation.name,
        back: closeDetail,
      }),
    onAdjust: (suffix) => adjustArtifact(artifact, suffix),
    onOpenType: (type) =>
      outlined
        ? openConcept(artifact, type)
        : openType(artifact, typeof type === "string" ? type : type.name),
    onOpenObjects: (type) => {
      ui.ontologyView = "objects";
      ui.graphSelections.set(`${artifact.id}:${artifact.version}:objects`, {
        type,
      });
      renderCanvas(true);
    },
  };
  if (ui.ontologyView === "objects") {
    if (
      outlined ||
      !artifact.content.validation?.valid ||
      !artifact.content.preview
    ) {
      section.append(
        node(
          "p",
          "view-empty",
          "这些定义还没有对应到可用记录。接入业务数据并检查映射后，就可以查看具体对象。",
        ),
      );
    } else {
      if (artifact.status !== "adopted")
        section.append(
          node("p", "detail-note", "这是候选定义对应的对象预览，尚未采用。"),
        );
      section.append(renderObjectGraph(artifact, graphOptions));
    }
    return section;
  }
  section.append(renderDefinitionGraph(artifact, graphOptions));
  if (outlined)
    section.append(
      node(
        "p",
        "detail-note",
        "这些概念来自资料，仍需业务确认与记录映射。概念草稿不会生成对象或开放访问。",
      ),
    );
  else {
    for (const error of artifact.content.validation?.errors || [])
      section.append(node("p", "persistent-note", `需要修正：${error}`));
    if (!shareMode && canAdopt(artifact)) {
      const decision = node("div", "decision-strip");
      decision.append(node("p", "", "这些定义和关系，是否符合你的业务？"));
      const adopt = button("采用这组定义", "primary-button", () =>
        decide(artifact, "adopt"),
      );
      adopt.disabled = ui.requesting || state.busy;
      decision.append(
        adopt,
        button("先用业务问题验证", "quiet-button", () => {
          ui.ontologyView = "verification";
          renderCanvas(true);
        }),
      );
      section.append(decision);
    } else if (artifact.status === "candidate")
      section.append(
        node(
          "p",
          "detail-note",
          artifact.content.validation?.valid
            ? "程序检查已完成，业务含义仍需确认。"
            : "需要检查定义与资料之间的映射。",
        ),
      );
  }
  return section;
}
function openConcept(artifact, concept, relation = false) {
  const section = detailFrame(concept.name, closeDetail, "返回定义");
  if (relation)
    section.append(node("p", "detail-note", `${concept.from} → ${concept.to}`));
  section.append(
    node("p", "source-text", concept.description),
    node("h2", "subsection-title", "定义依据"),
    evidenceButtons(concept.evidence, () =>
      openConcept(artifact, concept, relation),
    ),
  );
  if (!shareMode)
    section
      .querySelector(".canvas-heading")
      .append(
        button("调整定义", "quiet-button", () =>
          adjustArtifact(artifact, concept.name),
        ),
      );
  showDetail(
    {
      key: `concept:${artifact.id}:${artifact.version}:${concept.name}`,
      artifact,
    },
    section,
  );
}
function verificationStale(record) {
  const active = [...state.ontologies]
    .filter((item) => item.status === "adopted")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const changedModel =
    record.content.modelStatus === "adopted" &&
    active &&
    (record.content.modelId !== active.id ||
      record.content.modelVersion !== active.version);
  return (
    changedModel ||
    Object.entries(record.content.sourceVersions || {}).some(
      ([id, version]) =>
        state.sources.find((source) => source.id === id)?.version !== version,
    )
  );
}
const verificationLabels = {
  unreviewed: "待业务确认",
  matches_expectation: "符合预期",
  needs_adjustment: "需要调整",
};
function renderVerifications(artifact) {
  const section = node("div", "verification-canvas");
  section.append(
    node("p", "view-intro", "用一个实际问题，检查定义和关系是否足以解释业务。"),
  );
  const form = node("form", "verification-form");
  const input = node("input");
  input.type = "text";
  input.maxLength = 1200;
  input.setAttribute("aria-label", "要验证的业务问题");
  input.placeholder = "例如：这条投诉办结后，有没有供暖恢复的依据？";
  input.value =
    ui.verificationQuestion ||
    (state.demo
      ? demoQuestions.ontology
      : findStatement(["company.goal", "goal", "goals"])?.text) ||
    "";
  input.addEventListener("input", () => {
    ui.verificationQuestion = input.value;
  });
  const submit = node("button", "primary-button", "验证这个问题");
  submit.type = "submit";
  submit.disabled = ui.requesting || state.busy;
  form.append(input, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!input.value.trim()) return input.focus();
    const mapped = artifact?.kind === "ontology" ? artifact : currentOntology();
    if (mapped) setFocus(mapped);
    $("#message-input").value =
      `请用已保存的本体与真实对象验证这个业务问题：${input.value.trim()}。请保存实际查询结果和依据；如果资料不足，保留具体缺口。`;
    resizeInput();
    ui.nextRefreshSources = true;
    sendMessage();
  });
  if (!shareMode) section.append(form);
  if (!state.verifications.length)
    section.append(
      node(
        "p",
        "detail-note",
        "验证结果和依据会留在这里。资料不足时先补资料，不能把未知当作已解决。",
      ),
    );
  for (const record of [...state.verifications].sort(
    (a, b) =>
      String(b.content.generatedAt || b.createdAt).localeCompare(
        String(a.content.generatedAt || a.createdAt),
      ) ||
      (Number(b.content.runNumber) || 0) - (Number(a.content.runNumber) || 0),
  )) {
    const card = button("", "verification-card", () =>
      openVerification(record),
    );
    card.append(
      node("h2", "", record.content.question),
      node(
        "span",
        "verification-status",
        `${verificationLabels[record.status] || "待确认"}${verificationStale(record) ? " · 资料或定义已有更新，可重新验证" : ""}`,
      ),
    );
    const titles = Object.keys(record.content.sourceVersions || {})
      .map((id) => state.sources.find((source) => source.id === id)?.title)
      .filter(Boolean);
    card.append(node("p", "", titles.join(" · ")));
    section.append(card);
  }
  return section;
}
const resultLabels = {
  negative_callback_evidence: "回访显示未改善",
  positive_callback_evidence: "回访显示已改善",
  conflicting_callback_evidence: "回访证据有冲突",
  no_evidence: "缺少回访依据",
  not_recovered: "未恢复",
  not_improved: "未改善",
  improved: "已改善",
  recovered: "已恢复",
  no_callback_evidence: "缺少回访依据",
  unknown_callback_evidence: "回访结果尚不明确",
};
function renderVerificationValue(value, artifact, depth = 0) {
  const section = node("div", "verification-result");
  if (depth > 4 || value === null || typeof value !== "object") {
    section.append(node("p", "", plain(value)));
    return section;
  }
  if (Array.isArray(value)) {
    for (const item of value)
      section.append(
        renderVerificationValue(
          typeof item === "string" ? resultLabels[item] || item : item,
          artifact,
          depth + 1,
        ),
      );
  } else if (value.items) {
    if (value.coverage?.complete === false || value.truncated)
      section.append(
        node("p", "persistent-note", "当前结果只覆盖部分记录，不能代表全部。"),
      );
    if (!value.items.length)
      section.append(
        node("p", "detail-note", "没有匹配记录，业务事实仍需核实。"),
      );
    for (const item of value.items.slice(0, 20))
      section.append(renderVerificationValue(item, artifact, depth + 1));
    if (value.items.length > 20)
      section.append(
        node(
          "p",
          "detail-note",
          `这里显示前 20 条，共返回 ${value.items.length} 条。`,
        ),
      );
  } else if (value.fields && value.id) {
    section.append(
      node("h3", "", `${value.type} · ${value.id}`),
      propertyList(value.fields),
    );
    section.append(
      button("查看本次查证的对象与依据", "quiet-button", () =>
        loadObjects(artifact, value.type, {
          id: value.id,
          back: () => openVerification(artifact),
        }),
      ),
    );
    if (value.evidence)
      section.append(
        evidenceButtons(value.evidence, () => openVerification(artifact)),
      );
  } else {
    const omitted = new Set([
      "snapshot",
      "evidence",
      "sourceVersions",
      "collectionId",
      "model",
      "coverage",
    ]);
    for (const [key, entry] of Object.entries(value)) {
      if (omitted.has(key)) continue;
      const labels = {
        status: "依据显示",
        recovered: "是否恢复",
        scope: "适用范围",
        note: "说明",
        object: "对象",
        type: "类型",
        id: "编号",
        method: "检查口径",
        outcomes: "回访结果",
        partial: "是否仅部分记录",
        count: "数量",
        total: "总数",
      };
      if (entry && typeof entry === "object") {
        section.append(
          node("h3", "", labels[key] || key),
          renderVerificationValue(entry, artifact, depth + 1),
        );
      } else
        section.append(
          node(
            "p",
            "result-line",
            `${labels[key] || key}：${resultLabels[entry] || plain(entry)}`,
          ),
        );
    }
  }
  return section;
}
function openVerification(record) {
  const section = detailFrame(record.content.question, closeDetail, "返回验证");
  section.append(
    node("p", "detail-note", verificationLabels[record.status] || "待业务确认"),
  );
  if (verificationStale(record))
    section.append(
      node(
        "p",
        "persistent-note",
        "资料或定义已有更新。这里保留当时的结果和依据，可重新验证查看变化。",
      ),
    );
  if (record.content.modelStatus === "candidate")
    section.append(node("p", "detail-note", "此结果来自候选定义，尚未采用。"));
  const results = Object.entries(record.content.result?.results || {});
  const operationLabels = {
    get: "对象记录",
    query: "查询记录",
    related: "关联记录",
    call: "业务判断",
    aggregate: "汇总结果",
    evidence: "来源记录",
    describe: "对象定义",
  };
  results.forEach(([handle, value]) => {
    const operation = (record.content.operations || [])
      .map((op, index) => ({ ...op, handle: op.as || `step${index + 1}` }))
      .findLast((op) => op.handle === handle);
    section.append(
      node(
        "h2",
        "subsection-title",
        `${operationLabels[operation?.op] || "结果"}${operation?.type ? ` · ${operation.type}` : ""}`,
      ),
      renderVerificationValue(value, record),
    );
  });
  section.append(
    node("h2", "subsection-title", "验证依据"),
    evidenceButtons(record.content.evidence || [], () =>
      openVerification(record),
    ),
  );
  section.append(
    node(
      "p",
      "detail-note",
      "结果来自已保存的记录。是否足以回答业务问题，由你确认。",
    ),
  );
  const actions = node("div", "review-actions");
  for (const [status, title] of [
    ["matches_expectation", "符合预期"],
    ["needs_adjustment", "需要调整"],
  ]) {
    const control = button(title, "quiet-button", async () => {
      const ok = await mutate("/api/verifications/review", {
        id: record.id,
        version: record.version,
        status,
      });
      const updated = state.verifications.find((item) => item.id === record.id);
      if (ok && updated) openVerification(updated);
    });
    control.disabled = state.busy || ui.requesting || record.status === status;
    actions.append(control);
  }
  actions.append(
    button("重新验证", "quiet-button", () => {
      ui.verificationQuestion = record.content.question;
      ui.ontologyView = "verification";
      closeDetail();
    }),
  );
  if (!shareMode) section.append(actions);
  showDetail(
    { key: `verification:${record.id}:${record.version}`, artifact: record },
    section,
  );
}
function renderAttention(canvas) {
  if (shareMode || canvas.querySelector(".ontology-space")) return;
  const section = renderPendingCenter(state, {page: ui.page, node, button, open: entry => {
    const artifact = [...state.sources, ...state.ontologies, ...state.outlines, ...state.verifications].find(item => item.id === entry.artifactId);
    if (artifact?.kind === "source") openSource(artifact);
    else if (artifact?.kind === "verification") openVerification(artifact);
    else { if (artifact) setFocus(artifact); $("#message-input").value = entry.detail || entry.title; resizeInput(); openComposer(); }
  }});
  if (section) canvas.querySelector("section")?.append(section);
}
const credentialQueue = [];
let credentialShowing = false;
function showCredential(credential, name) {
  credentialQueue.push({credential,name});
  showNextCredential();
}
function showNextCredential() {
  if (credentialShowing || !credentialQueue.length) return;
  credentialShowing = true;
  const {credential,name} = credentialQueue.shift();
  $("#credential-consumer").textContent =
    `${name}现在可以按已确认的范围读取企业记忆。`;
  $("#consumer-api-key").value = credential.apiKey;
  $("#credential-status").textContent = "";
  $("#credential-status").hidden = true;
  $("#credential-dialog").showModal();
}

function closeDetail() {
  ui.detail = null;
  ui.detailRequest += 1;
  ui.canvasDirty = true;
  renderCanvas(true);
  $("#canvas").scrollTop = 0;
}
function showDetail(detail, content) {
  ui.detailRequest += 1;
  ui.detail = detail;
  $("#canvas").firstElementChild?.dispose?.();
  $(".canvas-app").classList.remove("is-ontology-space");
  for (const element of $$(".os-chat-metrics,.os-chat-footer")) element.hidden = true;
  $("#canvas").replaceChildren(content);
  $("#canvas").scrollTop = 0;
}
function detailFrame(
  title,
  back = closeDetail,
  backLabel = `返回${pageLabels[ui.page]}`,
) {
  const section = node("section", "detail-canvas");
  section.append(button(backLabel, "back-button", back, "back"));
  section.append(heading(title));
  return section;
}
function currentWorkContext() {
  return {
    view:
      ui.focus?.view ||
      (ui.page === "setup"
        ? `setup.${state.setupSection}`
        : ui.page === "ontology"
          ? "ontology.definitions"
          : "consumption"),
    revision: ui.contextRevision,
    selection: ui.focus
      ? [
          ui.focus.ref || {
            spaceId: state.workspaceId,
            kind: "artifact",
            id: ui.focus.id,
            version: ui.focus.version,
          },
        ]
      : [],
    scope: ui.focus?.scope || { where: {}, offset: 0, limit: 20 },
    draftRef: { ...ui.draftRef },
  };
}
async function selectLiveContext(
  model,
  target,
  scope = { where: {}, offset: 0, limit: 20 },
  focusComposer = true,
  isCurrent = () => true,
  source = "explicit",
) {
  const request = ++ui.contextRequest;
  const page = ui.page;
  ui.contextResolving = true;
  updateComposer();
  try {
    const context = {
      ...currentWorkContext(),
      view: target.objectId ? "ontology.objects" : "ontology.definitions",
      revision: ui.contextRevision + 1,
      selection: [
        {
          spaceId: state.workspaceId,
          id: model.id,
          version: model.version,
          ...target,
        },
      ],
      scope,
    };
    const resolved = await api("/api/canvas/context", { page, context });
    if (request !== ui.contextRequest || page !== ui.page || !isCurrent())
      return false;
    ui.focus = {
      id: model.id,
      version: model.version,
      label: resolved.target.label,
      ref: resolved.target.ref,
      view: context.view,
      scope,
      source,
    };
    ui.contextRevision += 1;
    rememberDraft();
    errorMessage();
    if (focusComposer) openComposer();
    return resolved;
  } catch (error) {
    if (request === ui.contextRequest) errorMessage(error.message);
    return false;
  } finally {
    if (request === ui.contextRequest) {
      ui.contextResolving = false;
      updateComposer();
    }
  }
}
async function inspectContext(context, page = ui.page) {
  const dialog = node("dialog", "live-dialog");
  dialog.append(
    node("h2", "", "本次讨论的内容"),
    button("关闭", "quiet-button", () => dialog.close()),
  );
  const body = node("div", "context-detail", "正在读取…");
  dialog.append(body);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  try {
    const value = await api("/api/canvas/context/read", { page, context });
    if (!dialog.isConnected) return;
    body.replaceChildren(node("h3", "", value.target?.label || "当前页面"));
    if (value.target) {
      body.append(
        node(
          "p",
          "source-meta",
          `本体 / 成果第 ${value.target.ref.version} 版 · ${{ adopted: "已采用", candidate: "待确认", draft: "草稿", ready: "可用", confirmed: "已确认", active: "已启用", disabled: "已停用", revoked: "已停用" }[value.target.status] || "已保存"}`,
        ),
      );
      const details = node("dl", "memory-properties");
      for (const [key, item] of Object.entries(value.target.definition).filter(([key]) => ["name", "description", "from", "to", "type", "property", "title", "fields", "fromField", "toField"].includes(key))) {
        const row = node("div");
        row.append(
          node(
            "dt",
            "",
            {
              from: "起点类型",
              to: "终点类型",
              name: "名称",
              description: "说明",
              fromField: "起点属性",
              toField: "终点属性",
              property: "业务属性",
              sourceField: "来源字段",
              type: "对象类型",
              fields: "属性映射",
              sourceId: "来源标识",
              capability: "读取能力",
              title: "成果名称",
              kind: "内容类别",
            }[key] || key,
          ),
          node("dd", "", plain(item)),
        );
        details.append(row);
      }
      body.append(details, technicalDetails(value.target.definition));
    }
    body.append(
      node(
        "p",
        "source-meta",
        `范围：${Object.keys(context.scope.where).length ? displayValue(context.scope.where) : "无额外筛选"} · 从第 ${context.scope.offset + 1} 条起，最多 ${context.scope.limit} 条`,
      ),
    );
    if (value.result) {
      const table = node("table");
      const keys = Object.keys(value.result.items[0] || {});
      const head = node("tr");
      keys.forEach((key) => head.append(node("th", "", key)));
      table.append(head);
      value.result.items.forEach((item) => {
        const row = node("tr");
        keys.forEach((key) => row.append(node("td", "", plain(item[key]))));
        table.append(row);
      });
      const wrap = node("div", "live-table");
      wrap.append(table);
      body.append(wrap);
      body.append(
        node(
          "p",
          "source-meta",
          `当前显示 ${value.result.coverage.shown} 条 · ${value.result.coverage.complete ? "当前结果完整" : "仅当前页"} · 读取于 ${value.result.reads.map((r) => r.readAt).join(" / ")}`,
        ),
      );
      body.append(
        node(
          "p",
          "source-meta",
          "按消息原范围重新读取当前来源；不是历史数据快照。",
        ),
      );
    }
  } catch (error) {
    body.textContent = error.message;
  }
}
function setFocus(artifact, suffix = "") {
  ui.contextRequest += 1;
  ui.contextResolving = false;
  ui.contextRevision += 1;
  ui.focus = {
    id: artifact.id,
    version: artifact.version,
    label: suffix ? `${artifact.title} · ${suffix}` : artifact.title,
  };
  rememberDraft();
  updateComposer();
}
function askAbout(artifact, suffix = "") {
  if (shareMode) {
    ui.focus = null;
    $("#message-input").value = shareMode.question(ui.page);
    resizeInput();
    updateComposer();
    openComposer();
    return;
  }
  setFocus(artifact, suffix);
  const input = $("#message-input");
  if (suffix && !input.value.trim()) input.value = `关于${suffix}，`;
  resizeInput();
  openComposer();
}
function adjustArtifact(artifact, suffix) {
  askAbout(artifact, suffix);
  closeDetail();
}
function evidenceButtons(refs, back) {
  const list = node("div", "evidence-list");
  for (const ref of refs || []) {
    const source = state.sources.find((item) => item.id === ref.sourceId);
    const title = source?.title || "来源资料";
    list.append(
      button(
        `${title}${ref.row ? ` · 第 ${ref.row} 条` : ""}`,
        "evidence-button",
        async () => {
          const request = ++ui.detailRequest;
          try {
            const artifact = await api(
              `/api/artifacts/${encodeURIComponent(ref.sourceId)}?version=${encodeURIComponent(ref.version)}`,
            );
            if (request !== ui.detailRequest) return;
            openSource(artifact.artifact || artifact, { row: ref.row, back });
          } catch (error) {
            if (request === ui.detailRequest) errorMessage(error.message);
          }
        },
      ),
    );
  }
  return list;
}
function openStatement(statement, artifact = state.profile) {
  const section = detailFrame(label(statement.key));
  if (statement.origin === "suggestion") {
    section
      .querySelector(".canvas-heading > div")
      .append(node("p", "", "待确认"));
  }
  const form = node("form", "memory-edit-form");
  const input = node("textarea");
  input.value = statement.text;
  input.rows = 3;
  input.maxLength = 5000;
  input.setAttribute("aria-label", `编辑${label(statement.key)}`);
  const save = node("button", "primary-button", "保存修改");
  save.type = "submit";
  save.disabled = ui.requesting || state.busy;
  form.append(input, save);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const ok = await mutate(
      "/api/profile",
      {
        id: artifact.id,
        expectedVersion: artifact.version,
        key: statement.key,
        text: input.value,
      },
      (result) => {
        state.profile = result.artifact;
        closeDetail();
      },
    );
    if (ok) await refresh();
  });
  if (shareMode) section.append(node("p", "source-text", statement.text));
  else section.append(form);
  if (statement.evidence?.length) {
    section.append(
      node("h2", "subsection-title", "来源"),
      evidenceButtons(statement.evidence, () =>
        openStatement(statement, artifact),
      ),
    );
  }
  const actions = node("div", "detail-heading-actions");
  actions.append(
    button("通过对话调整", "quiet-button", () =>
      adjustArtifact(artifact, label(statement.key)),
    ),
  );
  if (!shareMode) section.querySelector(".canvas-heading").append(actions);
  showDetail(
    {
      key: `statement:${artifact.id}:${artifact.version}:${statement.key}`,
      artifact,
    },
    section,
  );
}
function openSource(artifact, options = {}) {
  ui.detailRequest += 1;
  const offset =
    options.offset ??
    (options.row ? Math.floor((options.row - 1) / 50) * 50 : 0);
  const section = detailFrame(
    artifact.title,
    options.back || closeDetail,
    options.back ? "返回对象" : "返回数据",
  );
  const actions = node("div", "detail-heading-actions");
  actions.append(
    button(
      shareMode ? "查看示例问题" : "围绕这份资料提问",
      "quiet-button",
      () => askAbout(artifact),
    ),
  );
  section.querySelector(".canvas-heading").append(actions);
  if (
    state.sources.find((source) => source.id === artifact.id)?.version ===
    artifact.version
  )
    section.append(sourcePolicyEditor(artifact));
  if (artifact.content.parseError)
    section.append(
      node(
        "p",
        "source-error",
        `这份资料未能解析：${artifact.content.parseError}`,
      ),
    );
  const rows = artifact.content.rows;
  const columns = artifact.content.columns;
  if (
    Array.isArray(rows) &&
    Array.isArray(columns) &&
    columns.length &&
    !artifact.content.parseError
  ) {
    const wrap = node("div", "table-wrap");
    const table = node("table");
    const head = node("thead");
    const header = node("tr");
    header.append(node("th", "row-number", ""));
    for (const column of columns) header.append(node("th", "", column));
    head.append(header);
    const body = node("tbody");
    rows.slice(offset, offset + 50).forEach((row, index) => {
      const number = offset + index + 1;
      const line = node("tr", number === options.row ? "highlight" : "");
      line.append(node("td", "row-number", number));
      for (const column of columns) {
        const cell = node("td", "", plain(row[column]));
        cell.title = plain(row[column]);
        line.append(cell);
      }
      body.append(line);
    });
    table.append(head, body);
    wrap.append(table);
    section.append(wrap);
    if (rows.length > 50)
      section.append(
        pagination(
          offset,
          Math.min(50, rows.length - offset),
          rows.length,
          (next) => openSource(artifact, { ...options, offset: next }),
          50,
        ),
      );
    section.append(
      node(
        "p",
        "detail-note",
        `${rows.length} 条记录 · 来源第 ${artifact.version} 版`,
      ),
    );
  } else {
    section.append(
      node(
        "pre",
        "source-text",
        artifact.content.raw || "这份资料没有文本内容。",
      ),
    );
    section.append(node("p", "detail-note", `来源第 ${artifact.version} 版`));
  }
  showDetail(
    { key: `source:${artifact.id}:${artifact.version}:${offset}`, artifact },
    section,
  );
}
function sourcePolicyEditor(source) {
  const policy = state.sourcePolicies.find(
    (item) => item.content.sourceId === source.id,
  );
  if (shareMode) {
    const section = node("details", "share-source-policy");
    section.append(node("summary", "", "用途与使用范围"));
    section.append(
      propertyList({
        用途: policy?.content.purpose,
        资料负责人: policy?.content.owner,
        限制对外使用的字段:
          policy?.content.sensitiveFields?.join("、") || "未标记",
      }),
    );
    return section;
  }
  const details = node("details", "source-policy");
  const summary = node("summary", "", "用途与使用范围");
  details.append(summary);
  const form = node("form", "memory-edit-form");
  const field = (title, value, name) => {
    const wrap = node("label", "edit-field");
    const input = node("input");
    input.type = "text";
    input.name = name;
    input.value = value || "";
    input.maxLength = name === "owner" ? 200 : 1000;
    wrap.append(node("span", "", title), input);
    form.append(wrap);
    return input;
  };
  const purpose = field(
    "这份资料用来解决什么问题",
    policy?.content.purpose,
    "purpose",
  );
  const owner = field("资料负责人", policy?.content.owner, "owner");
  const inputs = [];
  const policyColumns = [
    ...new Set([
      ...(state.sourcePolicyFields[source.id] || source.content.columns || []),
      ...(policy?.content.sensitiveFields || []),
    ]),
  ];
  if (policyColumns.length) {
    const fields = node("fieldset", "sensitive-fields");
    fields.append(node("legend", "", "限制对外使用的字段"));
    for (const column of policyColumns) {
      const wrap = node("label");
      const input = node("input");
      input.type = "checkbox";
      input.value = column;
      input.checked =
        policy?.content.sensitiveFields?.includes(column) || false;
      inputs.push(input);
      wrap.append(input, node("span", "", column));
      fields.append(wrap);
    }
    form.append(
      fields,
      node(
        "p",
        "detail-note",
        "勾选的字段不允许通过消费 API 读取，已有调用方也会受到限制。",
      ),
    );
  } else
    form.append(
      node(
        "p",
        "detail-note",
        "文档原文不向消费 API 开放；未来形成对象时，仍需单独确认访问范围。",
      ),
    );
  const actions = node("div", "review-actions");
  const save = node("button", "primary-button", "保存使用范围");
  save.type = "submit";
  save.disabled = ui.requesting || state.busy;
  actions.append(save);
  form.append(actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const ok = await mutate("/api/sources/policy", {
      sourceId: source.id,
      version: policy?.version || 0,
      purpose: purpose.value,
      owner: owner.value,
      sensitiveFields: inputs
        .filter((input) => input.checked)
        .map((input) => input.value),
    });
    if (ok) {
      openSource(source);
      $(".source-policy").open = true;
    }
  });
  details.append(form);
  return details;
}
function propertyList(fields, className = "object-fields") {
  const list = node("dl", className);
  for (const [key, value] of Object.entries(fields)) {
    const group = node("div");
    group.append(node("dt", "", label(key)), node("dd", "", plain(value)));
    list.append(group);
  }
  return list;
}
function openType(artifact, typeName) {
  const type = artifact.content.types.find((item) => item.name === typeName);
  if (!type) return;
  const section = detailFrame(type.name, closeDetail, "返回本体");
  if (type.description)
    section
      .querySelector(".canvas-heading > div")
      .append(node("p", "", type.description));
  const actions = node("div", "detail-heading-actions");
  actions.append(
    button("调整定义", "quiet-button", () =>
      adjustArtifact(artifact, type.name),
    ),
  );
  if (!shareMode) section.querySelector(".canvas-heading").append(actions);
  section.append(
    node("h2", "subsection-title", "业务属性对应的资料列"),
    propertyList(type.fields || {}, "definition-fields"),
  );
  const source = state.sources.find((item) => item.id === type.sourceId);
  section.append(
    node(
      "p",
      "detail-note",
      `对象身份来自 ${source?.title || "来源资料"} 的 ${type.idField} 字段。`,
    ),
  );
  if (artifact.content.evidence?.length)
    section.append(
      node("h2", "subsection-title", "定义依据"),
      evidenceButtons(artifact.content.evidence, () =>
        openType(artifact, typeName),
      ),
    );
  const relations = (artifact.content.relations || []).filter(
    (item) => item.from === typeName,
  );
  if (relations.length) {
    const links = node("div", "object-relations");
    for (const relation of relations)
      links.append(
        button(`${relation.name} → ${relation.to}`, "quiet-button", () =>
          openType(artifact, relation.to),
        ),
      );
    section.append(node("h2", "subsection-title", "关联"), links);
  }
  if (artifact.content.validation?.valid && artifact.content.preview) {
    section.append(node("h2", "subsection-title", "对象"));
    const objects = node("div", "type-objects");
    section.append(objects);
    showDetail(
      { key: `type:${artifact.id}:${artifact.version}:${typeName}`, artifact },
      section,
    );
    loadObjects(artifact, typeName, { container: objects });
  } else {
    section.append(
      node("p", "detail-note", "定义检查完成后，这里会出现对应的对象。"),
    );
    showDetail(
      { key: `type:${artifact.id}:${artifact.version}:${typeName}`, artifact },
      section,
    );
  }
}
async function loadObjects(artifact, type, options = {}) {
  const request = ++ui.detailRequest;
  const prior = ui.detail;
  const loading = node("p", "loading-note", "正在读取…");
  const container = options.container || $("#canvas");
  container.append(loading);
  const params = new URLSearchParams({
    artifactId: artifact.id,
    version: String(artifact.version),
    type,
    limit: "18",
    offset: String(options.offset || 0),
  });
  if (options.id) params.set("id", options.id);
  if (options.relation) params.set("relation", options.relation);
  try {
    const data = await api(`/api/objects?${params}`);
    if (request !== ui.detailRequest) return;
    if (options.container && !options.id) {
      options.container.replaceChildren(
        renderCollection(artifact, type, data.result, options),
      );
    } else {
      renderObject(artifact, type, data, options);
    }
  } catch (error) {
    if (request === ui.detailRequest) {
      ui.detail = prior;
      errorMessage(error.message);
    }
  } finally {
    loading.remove();
  }
}
function pagination(offset, count, total, action, size = 18) {
  const pager = node("div", "pagination");
  const previous = button("上一页", "quiet-button", () =>
    action(Math.max(0, offset - size)),
  );
  const next = button("下一页", "quiet-button", () => action(offset + size));
  previous.disabled = offset <= 0;
  next.disabled = offset + count >= total;
  pager.append(
    previous,
    node(
      "span",
      "",
      count ? `${offset + 1}–${offset + count} / ${total}` : "暂无对象",
    ),
    next,
  );
  return pager;
}
function renderCollection(artifact, type, collection, options = {}) {
  const section = node("div");
  const items = collection?.items || [];
  const allRelated = Boolean(options.related);
  const offset = allRelated
    ? options.offset || 0
    : (collection?.coverage?.offset ??
      collection?.offset ??
      options.offset ??
      0);
  const displayed = allRelated ? items.slice(offset, offset + 18) : items;
  const total =
    collection?.total ?? collection?.coverage?.total ?? items.length;
  const list = node("div", "object-list");
  for (const entity of displayed) {
    const item = button("", "object-item", () =>
      loadObjects(artifact, entity.type || type, {
        id: entity.id,
        back: options.back,
      }),
    );
    item.append(node("strong", "", entity.id));
    const excerpt = Object.entries(entity.fields || {})
      .slice(0, 2)
      .map(([key, value]) => `${label(key)}：${plain(value)}`)
      .join(" · ");
    if (excerpt) item.append(node("span", "", excerpt));
    list.append(item);
  }
  section.append(list);
  if (!displayed.length)
    section.append(
      node(
        "p",
        "detail-note",
        options.related
          ? "暂无关联记录；这不代表业务事实不存在。"
          : "这里还没有对象。",
      ),
    );
  if (collection?.coverage?.input?.complete === false)
    section.append(node("p", "detail-note", "仅显示当前输入范围内的关联。"));
  if (total > 18) {
    section.append(
      pagination(offset, displayed.length, total, (next) => {
        if (allRelated)
          options.container.replaceChildren(
            renderCollection(artifact, type, collection, {
              ...options,
              offset: next,
            }),
          );
        else loadObjects(artifact, type, { ...options, offset: next });
      }),
    );
  }
  return section;
}
function renderObject(artifact, type, data, options) {
  const entity = data.result;
  if (!entity || !entity.id) return;
  const definition = data.types.find((item) => item.name === type);
  const back = options.back || (() => openType(artifact, type));
  const section = detailFrame(`${type} · ${entity.id}`, back, "返回对象");
  const actions = node("div", "detail-heading-actions");
  actions.append(
    button(shareMode ? "查看示例问题" : "围绕它提问", "quiet-button", () =>
      askAbout(artifact, `${type} / ${entity.id}`),
    ),
  );
  section.querySelector(".canvas-heading").append(actions);
  section.append(propertyList(entity.fields || {}));
  const relations = definition?.relations || [];
  if (relations.length) {
    const links = node("div", "object-relations");
    for (const relation of relations)
      links.append(
        button(`${relation.name} → ${relation.to}`, "quiet-button", () =>
          loadObjects(artifact, type, {
            id: entity.id,
            relation: relation.name,
            back,
          }),
        ),
      );
    section.append(node("h2", "subsection-title", "关联"), links);
  }
  if (data.related) {
    const related = node("div");
    const relatedOptions = {
      related: true,
      container: related,
      back: () => loadObjects(artifact, type, options),
    };
    related.append(
      renderCollection(
        artifact,
        data.related.type,
        data.related,
        relatedOptions,
      ),
    );
    section.append(node("h2", "subsection-title", options.relation), related);
  }
  if (entity.evidence?.length) {
    section.append(
      node("h2", "subsection-title", "来源"),
      evidenceButtons(entity.evidence, () =>
        loadObjects(artifact, type, options),
      ),
    );
  }
  showDetail(
    {
      key: `object:${artifact.id}:${artifact.version}:${type}:${entity.id}:${options.relation || ""}`,
      artifact,
    },
    section,
  );
}
async function decide(artifact, decision) {
  if (!canAdopt(artifact)) return;
  await mutate(
    "/api/canvas/decision",
    {
      page: ui.page,
      candidateId: artifact.id,
      version: artifact.version,
      decision,
    },
    () => {
      ui.detail = null;
      ui.detailRequest += 1;
      ui.canvasDirty = true;
    },
  );
}
function setChatMode(mode) {
  ui.chatMode = mode;
  $(".interaction").dataset.mode = mode;
  $(".canvas-app").dataset.chatMode = mode;
  $("#open-composer").hidden = mode !== "collapsed";
  $("#open-composer").setAttribute("aria-expanded", String(mode !== "collapsed"));
  $("#chat-surface").hidden = mode === "collapsed";
  $("#dialogue").hidden = mode !== "history";
  $("#toggle-history").setAttribute("aria-expanded", String(mode === "history"));
  updateComposer();
  if (mode !== "collapsed") resizeInput();
  if (mode === "history") $("#dialogue").scrollTop = $("#dialogue").scrollHeight;
}
function openComposer() {
  // A discussion action inside a management dialog must release its modal focus trap.
  for (const dialog of $$(".os-management[open]")) dialog.close();
  if (ui.chatMode === "collapsed" || ui.chatMode === "compact") setChatMode("composer");
  updateComposer();
  $("#message-input").focus();
}
function hasCanvasContent() {
  return ui.page === "setup"
    ? statements().length > 0 ||
        state.sources.length > 0 ||
        state.live.connections.length > 0
    : ui.page === "ontology"
      ? Boolean(currentDefinition() || state.verifications.length)
      : state.consumers.length > 0;
}
function updateComposer() {
  for (const control of $$("[data-busy-control]")) control.disabled = !!(state.busy || ui.requesting || control.dataset.blocked === "true");
  const input = $("#message-input");
  const busy = state.busy;
  const blocked =
    ui.requesting || ui.uploading || ui.contextResolving || !ui.initialized;
  input.placeholder = $(".canvas-app").classList.contains("is-ontology-space") ? input.dataset.spatialPlaceholder || "向企业本体提问…" : ui.chatMode === "compact" ? "随心输入" : shareMode
    ? "选择下方示例问题，了解这一页…"
    : placeholders[ui.page];
  $("#demo-question").hidden = !state.demo || busy || !!input.value.trim();
  $("#demo-question").textContent =
    `试问：${shareMode ? shareMode.question(ui.page) : demoQuestions[ui.page]}`;
  $("#demo-question").disabled = blocked;
  $("#send-button").hidden = busy;
  $("#stop-button").hidden = !busy;
  $("#send-button").disabled =
    blocked || (!input.value.trim() && !ui.pendingMessage);
  $("#send-button").setAttribute(
    "aria-label",
    ui.pendingMessage
      ? ui.pendingMessage.body
        ? "重试上次发送"
        : "核对上次发送"
      : "发送消息",
  );
  $("#send-button").title = ui.pendingMessage?.body
    ? "重试上次发送，保留原目标与原范围"
    : "发送消息";
  $("#stop-button").disabled = ui.requesting;
  $("#upload-button").disabled = blocked;
  $("#upload-button").hidden = !!shareMode || ui.page === "consumption";
  $("#composer-note").textContent = shareMode
    ? "示例问答"
    : ui.contextResolving
      ? "正在核对引用…"
      : ui.pendingMessage && !busy
        ? ui.pendingMessage.body
          ? `待核对上次发送：${ui.pendingMessage.label || "当前页面"}（点击发送重试原消息）`
          : "旧版请求结果待核对，点击发送只查询原回执"
        : ui.uploading
          ? "正在接入资料…"
          : busy
            ? "正在整理…"
            : !state.model.configured && ui.initialized
              ? "先连接一个模型"
              : state.demo
                ? "模拟问答"
                : "";
  $("#focus-context").hidden = !ui.focus;
  $("#focus-label").textContent = ui.focus
    ? `${ui.focus.source === "viewport" ? "当前浏览 · " : ""}${ui.focus.label} · 第 ${ui.focus.version} 版${ui.focus.ref ? "" : " · 整份成果"}`
    : "";
  $("#inspect-focus").hidden = !ui.focus || !!shareMode;
  $("#focus-context").dataset.kind = ui.focus?.ref?.kind || "artifact";
  for (const control of $$("[data-page]")) {
    const entry = state.pages.find((page) => page.id === control.dataset.page);
    control.disabled =
      (control.dataset.page !== "setup" &&
        !entry?.available &&
        control.dataset.page !== ui.page);
  }
}
function resizeInput() {
  const input = $("#message-input");
  input.style.height = "auto";
  input.style.height = `${Math.min(100, Math.max(20, input.scrollHeight))}px`;
}
window.addEventListener("resize", resizeInput);
// A spatial transition changes the input width after the window resize event.
// Re-measure wrapped text at its final width, without reacting to height-only changes.
let measuredInputWidth = 0;
new ResizeObserver(([entry]) => {
  if (Math.abs(entry.contentRect.width - measuredInputWidth) < .5) return;
  measuredInputWidth = entry.contentRect.width;
  resizeInput();
}).observe($("#message-input"));
new ResizeObserver(([entry]) => {
  $(".canvas-app").style.setProperty("--os-composer-height", `${entry.target.getBoundingClientRect().height}px`);
}).observe($(".interaction"));
async function sendMessage() {
  const input = $("#message-input");
  const text = input.value.trim();
  if (
    (!text && !ui.pendingMessage) ||
    ui.requesting ||
    state.busy ||
    ui.contextResolving
  )
    return;
  if (ui.pendingMessage?.id && !ui.pendingMessage.body) {
    const legacy = ui.pendingMessage;
    await mutate(
      "/api/canvas/message/receipt",
      { page: ui.page, text: legacy.text, messageId: legacy.id },
      (result) => {
        ui.pendingMessage = null;
        rememberDraft();
        errorMessage(
          result.messageReceipt.received
            ? "旧消息已被服务接收，没有重复执行。当前草稿已保留。"
            : "旧消息尚未被服务接收。当前输入和引用已保留，可作为新消息发送。",
        );
      },
    );
    return;
  }
  if (!state.model.configured) {
    openSettings();
    return;
  }
  setChatMode("history");
  rememberDraft();
  if (!ui.pendingMessage?.body) {
    const body = {
      page: ui.page,
      sessionId: state.currentSessionId,
      text,
      messageId: crypto.randomUUID(),
      ...(ui.page === "ontology" && ui.nextRefreshSources
        ? { refreshSources: true }
        : {}),
      ...(!shareMode && !state.demo
        ? { workContext: currentWorkContext() }
        : ui.focus
          ? { focusId: ui.focus.id, focusVersion: ui.focus.version }
          : {}),
    };
    // Keep the entire request until its receipt is known. Retrying must never
    // pick up a later selection, input edit or source-refresh flag.
    ui.pendingMessage = {
      body: structuredClone(body),
      text,
      label: ui.focus?.label,
      draftRevision: ui.draftRef.revision,
      contextRevision: ui.contextRevision,
    };
  }
  const pending = ui.pendingMessage;
  const settleOriginal = (origin, accepted) => {
    const draft = ui.drafts.get(origin.draftKey) ?? ui.draftStore?.read(origin.draftKey);
    if (draft?.pendingMessage?.body?.messageId !== pending.body.messageId) return;
    draft.pendingMessage = null;
    if (accepted) draft.nextRefreshSources = false;
    if (accepted && draft.draftRef?.revision === pending.draftRevision && draft.contextRevision === pending.contextRevision && draft.text.trim() === pending.text) draft.text = "";
    ui.drafts.set(origin.draftKey, draft); ui.draftStore?.save(origin.draftKey, draft);
  };
  rememberDraft();
  await mutate(
    "/api/canvas/message",
    pending.body,
    () => {
      ui.pendingMessage = null;
      ui.nextRefreshSources = false;
      if (
        ui.draftRef.revision === pending.draftRevision &&
        ui.contextRevision === pending.contextRevision &&
        input.value.trim() === pending.text
      )
        input.value = "";
      rememberDraft();
      resizeInput();
    },
    (error) => {
      // A definitive rejection permits correcting this draft. A lost response
      // keeps the original request, even after selecting or clearing a target.
      if (
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status)
      ) {
        ui.pendingMessage = null;
        rememberDraft();
      }
    },
    {
      after: (_result, origin) => settleOriginal(origin, true),
      error: (error, origin) => { if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) settleOriginal(origin, false); },
    },
  );
}
async function uploadFile(file) {
  if (shareMode)
    return errorMessage("离线演示只提供已保存的样本资料，不能上传或修改数据。");
  if (!file || ui.requesting || ui.uploading) return;
  if (ui.page === "consumption") {
    errorMessage("请返回企业与数据页接入资料。");
    return;
  }
  if (!/\.(csv|md|txt)$/i.test(file.name)) {
    errorMessage("请先上传 CSV、Markdown 或 TXT 文件。");
    return;
  }
  if (file.size > 5_000_000) {
    errorMessage("请使用不超过 5 MB 的文件。");
    return;
  }
  ui.uploading = true;
  updateComposer();
  try {
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
    } catch {
      throw new Error("文件不是有效的 UTF-8 文本，请转换编码后再上传。");
    }
    await mutate(
      "/api/canvas/upload",
      { page: ui.page, name: file.name, content },
      () => {
        ui.detail = null;
        ui.detailRequest += 1;
        ui.canvasDirty = true;
      },
    );
  } catch (error) {
    errorMessage(error.message);
  } finally {
    ui.uploading = false;
    $("#file-input").value = "";
    updateComposer();
  }
}
function updateCustomApiFields() {
  const provider = $("#provider-input").value;
  const custom = provider === "custom";
  $("#glm-key-note").hidden = !["zhipu", "zhipu-coding", "zai-coding"].includes(provider);
  $("#custom-api-fields").hidden = !custom;
  $("#base-url-input").required = custom;
  $("#base-url-input").disabled = !custom;
  $("#protocol-input").disabled = !custom;
}
function clearEndpointKey() {
  settingsStatus("");
  $("#api-key-input").value = "";
  $("#api-key-input").placeholder = "填写该接口的密钥；不会沿用其他地址的密钥";
}
function openSettings() {
  if (ui.settingsBusy) return;
  const model = state.model;
  $("#provider-input").value = model.provider || "deepseek";
  $("#model-input").value = model.model || "deepseek-v4-flash";
  $("#base-url-input").value = model.baseUrl || "";
  $("#protocol-input").value = model.protocol || "openai";
  updateCustomApiFields();
  $("#api-key-input").value = "";
  $("#api-key-input").placeholder = model.configured
    ? "已配置；留空继续使用"
    : "填写密钥";
  $("#key-note").textContent = "密钥保存在本机服务端，刷新或重启后保留，直到主动删除。";
  $("#delete-model-key").hidden = !model.configured;
  $("#settings-status").hidden = true;
  $("#developer-view-input").checked = developerView();
  $("#settings-dialog").showModal();
}
function settingsStatus(message) {
  $("#settings-status").textContent = message;
  $("#settings-status").hidden = !message;
}
function setModelSettingsBusy(busy) {
  ui.settingsBusy = busy;
  for (const field of $("#settings-dialog").querySelectorAll("input, select, button")) field.disabled = busy;
  $("#open-settings").disabled = busy;
  if (!busy) updateCustomApiFields();
}
async function saveSettings(test = false) {
  if (ui.settingsBusy) return;
  const model = $("#model-input").value.trim();
  if (!model) {
    settingsStatus("填写要使用的模型名称。");
    return;
  }
  setModelSettingsBusy(true);
  try {
    const result = await api("/api/settings", {
      provider: $("#provider-input").value,
      model,
      apiKey: $("#api-key-input").value,
      testConnection: test,
      ...($("#provider-input").value === "custom" ? {
        baseUrl: $("#base-url-input").value.trim(),
        protocol: $("#protocol-input").value,
      } : {}),
    });
    state.model = result.model;
    $("#api-key-input").value = "";
    if (test) {
      settingsStatus("正在测试连接…");
      settingsStatus(result.connection?.message || "连接成功。");
    } else {
      $("#settings-dialog").close();
      openComposer();
    }
    await refresh();
  } catch (error) {
    settingsStatus(error.message);
  } finally {
    setModelSettingsBusy(false);
    updateComposer();
  }
}

for (const control of $$("[data-page]"))
  control.addEventListener("click", () => navigate(control.dataset.page));
$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});
$("#open-composer").addEventListener("click", (event) => {
  if (event.detail === 0) openComposer();
  else {
    setChatMode("compact");
    $("#chat-surface").focus();
  }
});
$("#message-input").addEventListener("focus", () => {
  if (ui.chatMode === "compact") setChatMode("composer");
});
$("#canvas").addEventListener("pointerdown", () => {
  if (ui.page !== "ontology" && ui.chatMode === "composer" && !$("#message-input").value && !ui.focus && !state.busy && !$("#request-error").textContent)
    setChatMode("compact");
});
$("#toggle-history").addEventListener("click", () => {
  setChatMode(ui.chatMode === "history" ? "composer" : "history");
});
$("#collapse-composer").addEventListener("click", () => {
  setChatMode("collapsed");
  $("#open-composer").focus();
});
$(".interaction").addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.isComposing) return;
  event.preventDefault();
  if (ui.chatMode === "history") {
    setChatMode("composer");
    $("#toggle-history").focus();
  } else if (ui.page !== "ontology" && (ui.chatMode === "composer" || ui.chatMode === "compact")) {
    setChatMode("collapsed");
    $("#open-composer").focus();
  }
});
$("#demo-question").addEventListener("click", () => {
  $("#message-input").value = shareMode
    ? shareMode.question(ui.page)
    : demoQuestions[ui.page];
  resizeInput();
  sendMessage();
});
$("#message-input").addEventListener("input", () => {
  resizeInput();
  updateComposer();
  rememberDraft();
});
$("#message-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendMessage();
  }
});
$("#stop-button").addEventListener("click", () =>
  mutate("/api/canvas/stop", { page: ui.page }),
);
$("#clear-focus").addEventListener("click", () => {
  if (ui.focus?.source === "viewport") {
    const {kind, member} = ui.focus.ref;
    ui.dismissedSelection = JSON.stringify([ui.focus.id, ui.focus.version, {kind, member}]);
  }
  ui.focus = null;
  ui.contextRequest += 1;
  ui.contextResolving = false;
  ui.contextRevision += 1;
  updateComposer();
  rememberDraft();
});
$("#inspect-focus").addEventListener("click", () =>
  inspectContext(currentWorkContext()),
);
$("#upload-button").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", (event) =>
  uploadFile(event.target.files[0]),
);
$("#developer-view-input").addEventListener("change", event => {
  setDeveloperView(event.target.checked);
  ui.canvasDirty = true; ui.dialogueKey = "";
  render();
});
$("#open-settings").addEventListener("click", openSettings);
$("#close-settings").addEventListener("click", () =>
  $("#settings-dialog").close(),
);
$("#settings-dialog").addEventListener("cancel", (event) => {
  if (ui.settingsBusy) event.preventDefault();
});
$("#settings-dialog").addEventListener("close", () => {
  $("#api-key-input").value = "";
});
function clearCredential() {
  $("#consumer-api-key").value = "";
  $("#credential-consumer").textContent = "";
  $("#credential-status").textContent = "";
  $("#credential-status").hidden = true;
}
for (const selector of ["#close-credential", "#finish-credential"])
  $(selector).addEventListener("click", () => {
    clearCredential();
    $("#credential-dialog").close();
  });
$("#credential-dialog").addEventListener("cancel", clearCredential);
$("#credential-dialog").addEventListener("close", () => { clearCredential(); credentialShowing = false; queueMicrotask(showNextCredential); });
$("#copy-credential").addEventListener("click", async () => {
  const status = $("#credential-status");
  const copiedKey = $("#consumer-api-key").value;
  try {
    await navigator.clipboard.writeText(copiedKey);
    if (!$("#credential-dialog").open || $("#consumer-api-key").value !== copiedKey) return;
    status.textContent = "密钥已复制。";
  } catch {
    if (!$("#credential-dialog").open || $("#consumer-api-key").value !== copiedKey) return;
    $("#consumer-api-key").focus();
    $("#consumer-api-key").select();
    status.textContent = "请复制选中的密钥。";
  }
  status.hidden = false;
});
$("#settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  saveSettings();
});
$("#delete-model-key").addEventListener("click", async () => {
  if(ui.settingsBusy)return;
  setModelSettingsBusy(true);
  try { const result=await api("/api/settings/key/delete",{});state.model=result.model;$("#api-key-input").value="";$("#api-key-input").placeholder="填写密钥";$("#delete-model-key").hidden=true;settingsStatus("当前模型密钥已删除。");await refresh(); }
  catch(error){settingsStatus(error.message);}finally{setModelSettingsBusy(false);}
});
$("#test-connection").addEventListener("click", () => saveSettings(true));
$("#provider-input").addEventListener("change", () => {
  settingsStatus("");
  const provider = $("#provider-input").value;
  $("#model-input").value =
    provider === state.model.provider
      ? state.model.model
      : provider === "deepseek"
        ? "deepseek-v4-flash"
        : "";
  $("#api-key-input").value = "";
  $("#api-key-input").placeholder = "填写该服务商的密钥";
  updateCustomApiFields();
});
$("#model-input").addEventListener("input", () => settingsStatus(""));
$("#api-key-input").addEventListener("input", () => settingsStatus(""));
$("#base-url-input").addEventListener("input", clearEndpointKey);
$("#protocol-input").addEventListener("change", clearEndpointKey);
let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  dragDepth += 1;
  if (!shareMode && !ui.requesting && ui.page !== "consumption")
    $("#drop-overlay").hidden = false;
});
window.addEventListener("dragover", (event) => {
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("#drop-overlay").hidden = true;
});
window.addEventListener("drop", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  dragDepth = 0;
  $("#drop-overlay").hidden = true;
  if (event.dataTransfer.files.length > 1) {
    errorMessage("先接入一份资料，再继续添加下一份。");
    return;
  }
  uploadFile(event.dataTransfer.files[0]);
});
new ResizeObserver(([entry]) => {
  $(".canvas-app").style.setProperty(
    "--interaction-height",
    `${entry.target.getBoundingClientRect().height}px`,
  );
}).observe($(".interaction"));

if (!shareMode) {
  window.addEventListener("focus", () => refresh());
  window.addEventListener("pagehide", rememberDraft);
}
refresh(true);

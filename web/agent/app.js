import { renderEnterpriseProfile } from "./enterprise-profile.js";
import { renderEvidenceWorkspace } from "./evidence.js";
import { renderFoundationWorkspace } from "./foundation-workspace.js";
import { renderLiveObjects } from "./live-objects.js";
import { renderFoundation } from "./foundation.js";
import { createCapabilitiesPanel } from "./capabilities.js";
import {
  renderDefinitionGraph,
  renderObjectGraph,
} from "./ontology-workspace.js";
import { renderLiveWorkspace } from "./live-workspace.js";
import { createDraftStore, parseLegacyDrafts } from "./drafts.js";
import { createShareMode } from "./share-mode.js";

const shareMode = createShareMode(document);

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const pageLabels = {
  setup: "企业与数据",
  ontology: "本体工作区",
  consumption: "消费与治理",
};
const placeholders = {
  setup: "介绍你的企业，或告诉我需要接入哪些数据…",
  ontology: "我们需要理解哪些业务对象？",
  consumption: "哪些应用需要使用这些企业记忆？",
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
  consumerPanels: new Map(),
  canvasKey: "",
  dialogueKey: "",
  chatMode: "compact",
  pendingMessage: null,
  settingsBusy: false,
};

function node(tag, className = "", text) {
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
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
function label(key) {
  return fieldLabels[key] || key.replace(/^company\./, "");
}
function errorMessage(message = "") {
  if (message && ui.chatMode === "collapsed") setChatMode("composer");
  $("#request-error").textContent = message;
  $("#request-error").hidden = !message;
}
async function api(path, body) {
  if (shareMode) return shareMode.request(path, body);
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
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
function rememberDraft() {
  const text = $("#message-input").value;
  if (ui.drafts.get(ui.page)?.text !== text) ui.draftRef.revision += 1;
  const draft = {
    draftRef: { ...ui.draftRef },
    contextRevision: ui.contextRevision,
    text,
    focus: ui.focus,
    pendingMessage: ui.pendingMessage,
  };
  ui.drafts.set(ui.page, draft);
  ui.draftStore?.save(ui.page, draft);
}
function restoreDraft(draft) {
  $("#message-input").value = draft?.text || "";
  ui.focus = draft?.focus || null;
  ui.pendingMessage = draft?.pendingMessage || null;
  ui.draftRef = draft?.draftRef || { id: crypto.randomUUID(), revision: 0 };
  ui.contextRevision = draft?.contextRevision || 0;
  ui.contextRequest += 1;
  ui.contextResolving = false;
}
function changePage(page) {
  if (ui.page === page) return;
  rememberDraft();
  ui.page = page;
  const draft = ui.drafts.get(page) ?? ui.draftStore?.read(page);
  restoreDraft(draft);
  ui.detail = null;
  ui.detailRequest += 1;
  ui.canvasKey = "";
  ui.dialogueKey = "";
  $("#canvas").scrollTop = 0;
  resizeInput();
}
function applySnapshot(snapshot) {
  if (
    !shareMode &&
    snapshot.workspaceId &&
    snapshot.workspaceId !== state.workspaceId
  ) {
    ui.drafts.clear();
    try {
      ui.draftStore = createDraftStore(localStorage, snapshot.workspaceId, () =>
        errorMessage("浏览器无法保存草稿，请复制内容后再关闭页面。"),
      );
      ui.importedDrafts = ui.draftStore.read("legacy") || [];
      const draft = ui.draftStore.read(snapshot.currentPage);
      ui.page = snapshot.currentPage;
      restoreDraft(draft);
      if (draft) ui.drafts.set(ui.page, draft);
      resizeInput();
    } catch {
      errorMessage("浏览器无法保存草稿，请复制内容后再关闭页面。");
    }
  }
  const target = pageLabels[snapshot.currentPage]
    ? snapshot.currentPage
    : ui.page;
  const previousPage = ui.page;
  changePage(target);
  for (const key of Object.keys(state)) {
    if (Object.hasOwn(snapshot, key)) state[key] = snapshot[key];
  }
  if (snapshot.page && snapshot.page !== ui.page) {
    state.messages = [];
    state.streaming = "";
    state.pending = null;
    state.prompt = "";
    if (previousPage !== ui.page) setTimeout(() => refresh(), 0);
  }
  const firstLoad = !ui.initialized;
  ui.initialized = true;
  if (firstLoad && state.setupSection === "sources") ui.enterpriseTab = "sources";
  render();
  if (firstLoad && ui.page === "setup" && state.setupSection === "sources")
    document
      .getElementById("setup-sources")
      ?.scrollIntoView({ block: "start" });
}
async function refresh(bootstrap = false) {
  if (ui.polling || ui.requesting) return;
  ui.polling = true;
  const generation = ui.generation;
  try {
    const snapshot = await api(
      bootstrap || !state.token
        ? "/api/canvas/bootstrap"
        : `/api/canvas?page=${encodeURIComponent(ui.page)}`,
    );
    if (generation !== ui.generation) return;
    applySnapshot(snapshot);
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
async function mutate(path, body, after, onError) {
  if (ui.requesting) return false;
  ui.requesting = true;
  ui.generation += 1;
  errorMessage();
  updateComposer();
  try {
    const result = await api(path, body);
    if (after) after(result);
    applySnapshot(result);
    return true;
  } catch (error) {
    onError?.(error);
    errorMessage(error.message);
    return false;
  } finally {
    ui.requesting = false;
    updateComposer();
  }
}
async function navigate(page) {
  if (page === ui.page || ui.requesting) return;
  const ok = await mutate("/api/canvas/navigate", { page });
  if (ok && ["company", "sources"].includes(page))
    document
      .getElementById(`setup-${page}`)
      ?.scrollIntoView({ block: "start" });
}
const capabilityPanel = createCapabilitiesPanel(api);

function render() {
  capabilityPanel.button.hidden = !!shareMode || !!state.demo;
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
      ui.requesting ||
      (page !== "setup" && !entry?.available && page !== ui.page);
    if (page === ui.page) control.setAttribute("aria-current", "page");
    else control.removeAttribute("aria-current");
  }
  document.title = `${state.profile ? companyName() : "DataEngine"} · ${pageLabels[ui.page]}`;
  renderCanvas();
  renderDialogue();
  updateComposer();
}
function canvasFingerprint() {
  const refs = (items) =>
    items.map((item) => `${item.id}:${item.version}:${item.status}`);
  return JSON.stringify({
    page: ui.page,
    profile: state.profile && `${state.profile.id}:${state.profile.version}`,
    sources: refs(state.sources),
    live: state.live,
    ontologies: refs(state.ontologies),
    foundation: state.foundation,
    evidence: refs(state.evidence),
    outlines: refs(state.outlines),
    verifications: refs(state.verifications),
    sourcePolicies: refs(state.sourcePolicies),
    sourcePolicyFields: state.sourcePolicyFields,
    attention: state.attention,
    ontologyView: ui.ontologyView,
    definitionId: ui.definitionId,
    consumers: refs(state.consumers),
    accessLogs: ui.page === "consumption" ? state.accessLogs : [],
    pending: state.pending,
    prompt: state.prompt,
    detail: ui.detail?.key,
    deciding:
      ["setup", "ontology", "consumption"].includes(ui.page) &&
      (state.busy || ui.requesting),
  });
}
function renderCanvas(force = false) {
  const fingerprint = canvasFingerprint();
  if (!force && fingerprint === ui.canvasKey) return;
  ui.canvasKey = fingerprint;
  if (ui.detail) {
    if (ui.detail.kind === "consumer") {
      const consumer = state.consumers.find(
        (item) => item.id === ui.detail.consumerId,
      );
      if (consumer) {
        const scroll = $("#canvas").scrollTop;
        const input = document.activeElement?.matches(
          ".consumer-clone-form input",
        )
          ? document.activeElement
          : null;
        const selection = input && {
          name: input.name,
          start: input.selectionStart,
          end: input.selectionEnd,
        };
        $("#canvas").replaceChildren(renderConsumerDetail(consumer));
        if (selection) {
          const restored = $$(".consumer-clone-form input").find(
            (item) => item.name === selection.name,
          );
          restored?.focus({ preventScroll: true });
          restored?.setSelectionRange(selection.start, selection.end);
        }
        $("#canvas").scrollTop = scroll;
      }
    }
    return;
  }
  const canvas = $("#canvas");
  if (ui.page === "setup") canvas.replaceChildren(renderSetup());
  else if (!shareMode && !state.demo) {
    const livePage = ui.page;
    const live = renderLiveWorkspace(ui.page, state.live, {
      api,
      mutate,
      showCredential,
      selections: ui.graphSelections,
      onSelectContext: selectLiveContext,
      onSaved: () => { if (ui.page === livePage) refresh(); },
    });
    const legacy =
      ui.page === "ontology"
        ? state.ontologies.length || state.outlines.length
        : state.consumers.length;
    if (legacy) {
      const details = node("details", "live-legacy");
      details.append(
        node("summary", "", "查看已有文件实验"),
        ui.page === "ontology" ? renderOntology() : renderConsumption(),
      );
      live.append(details);
    }
    if (ui.page === "ontology") {
      const workspace = renderFoundationWorkspace(state.foundation, {
        selections: ui.graphSelections,
        select: (model, target, isCurrent, focusComposer = false) =>
          selectLiveContext(model, target, undefined, focusComposer, isCurrent),
        read: (model, target) =>
          api("/api/canvas/context/read", {
            page: "ontology",
            context: {
              ...currentWorkContext(),
              view: "ontology.definitions",
              selection: [
                {
                  spaceId: state.workspaceId,
                  id: model.id,
                  version: model.version,
                  ...target,
                },
              ],
              scope: { where: {}, offset: 0, limit: 20 },
            },
          }),
      });
      const full = node("details", "live-legacy");
      full.append(
        node("summary", "", "完整基础定义与采用操作"),
        foundationPanel(),
      );
      canvas.replaceChildren(renderOntologyBoard(workspace, full, live));
    } else canvas.replaceChildren(live);
  } else if (ui.page === "ontology") canvas.replaceChildren(renderOntology());
  else canvas.replaceChildren(renderConsumption());

  renderAttention(canvas);
}
function renderOntologyBoard(workspace, full, operations) {
  const board = node("section", "ontology-board");
  board.setAttribute("aria-label", "企业本体画布");
  const header = node("header", "ontology-board-header");
  const title = node("div");
  title.append(node("p", "source-meta", state.foundation?.current?.content.enterprise?.name || "企业语义底座"), node("h1", "", "企业本体"));
  const actions = node("div", "ontology-board-actions");
  function panel(label, contents) {
    const dialog = node("dialog", "live-dialog ontology-panel");
    dialog.setAttribute("aria-label", label);
    dialog.append(node("h2", "", label), button("关闭", "quiet-button", () => dialog.close()), contents);
    board.append(dialog);
    return button(label, "quiet-button", () => dialog.showModal());
  }
  const management = node("div");
  management.append(full, operations);
  actions.append(panel("定义与映射", management), panel("共同取证", renderEvidenceWorkspace(state, { api, mutate })));
  header.append(title, actions);
  const tabs = node("div", "ontology-board-tabs");
  tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "本体视角");
  const definitions = node("div", "ontology-board-definitions");
  definitions.id = "ontology-definitions";
  definitions.append(workspace);
  const objects = node("div", "ontology-board-objects"); objects.id = "ontology-objects";
  let loaded = false;
  const modes = [["definitions", "概念与关系", definitions], ["objects", "实际对象", objects]];
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
        select: (m, t, scope, guard) => selectLiveContext(m, t, scope, false, () => !objects.hidden && (!guard || guard()))}));
    };
    picker.onchange = show; show();
  };
  const choose = (mode) => {
    ui.graphSelections.set("ontology-board-mode", mode);
    for (const [id, , pane] of modes) {
      pane.hidden = id !== mode;
      tabs.querySelector(`[data-mode="${id}"]`).setAttribute("aria-selected", String(id === mode));
    }
    if (mode === "objects") loadObjects();
  };
  for (const [id, label, pane] of modes) {
    const control = button(label, "quiet-button", () => choose(id));
    control.dataset.mode = id; control.id = `ontology-tab-${id}`;
    control.setAttribute("role", "tab"); control.setAttribute("aria-controls", pane.id);
    pane.setAttribute("role", "tabpanel"); pane.setAttribute("aria-labelledby", control.id);
    control.addEventListener("keydown", (event) => {
      if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        const next = id === "definitions" ? "objects" : "definitions";
        choose(next); tabs.querySelector(`[data-mode="${next}"]`).focus();
      }
    });
    tabs.append(control);
  }
  board.prepend(header, tabs, definitions, objects);
  choose(ui.graphSelections.get("ontology-board-mode") || "definitions");
  return board;
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
function renderSetup() {
  const changeTab = async (tab) => {
    ui.enterpriseTab = tab;
    renderCanvas(true);
    document.querySelector(".ep-tab.active")?.focus({ preventScroll: true });
    if (!shareMode) await mutate("/api/canvas/navigate", {
      page: "setup", section: tab === "sources" ? "sources" : "company",
    });
    if (ui.page === "setup" && ui.enterpriseTab === tab && !ui.detail)
      document.querySelector(".ep-tab.active")?.focus({ preventScroll: true });
  };
  const { root: section, sources } = renderEnterpriseProfile(state, {
    tab: ui.enterpriseTab, readonly: shareMode, label, edit: openStatement,
    api: !shareMode && !state.demo ? api : null,
    upload: () => $("#file-input").click(),
    changeTab,
    ask: (text) => {
      const input = $("#message-input");
      input.value = input.value.trim() ? `${input.value}\n${text}` : text;
      rememberDraft();
      resizeInput();
      openComposer();
    },
    ontology: () => mutate("/api/canvas/navigate", { page: "ontology" }),
    foundation: !shareMode && !state.demo ? foundationPanel : null,
  });
  if (!shareMode && !state.demo) {
    sources.append(
      renderLiveWorkspace("sources", state.live, {
        api,
        mutate,
        showCredential,
      }),
    );
    const files = node("section", "data-files");
    files.append(
      node(
        "h2",
        "",
        `文件资料${state.sources.length ? ` · ${state.sources.length} 份` : ""}`,
      ),
    );
    files.append(button("上传资料", "quiet-button", () => $("#file-input").click()));
    files.append(
      state.sources.length
        ? renderSources()
        : node("p", "muted", "可通过底部附件接入 CSV、Markdown 或 TXT。"),
    );
    sources.append(files);
  } else sources.append(renderSources());
  if (!shareMode && !state.demo) {
    const evidence = node("details", "data-evidence");
    evidence.append(node("summary", "", "跨来源共同取证"), renderEvidenceWorkspace(state, { api, mutate }));
    sources.append(evidence);
  }
  if (!shareMode && (state.legacyHistory.length || ui.importedDrafts.length)) {
    const history = node("details", "setup-history");
    history.append(node("summary", "", "升级前保留的内容"));
    for (const entry of state.legacyHistory) {
      const title = entry.section === "company" ? "企业信息" : "数据接入";
      const content = node("div", "legacy-history-content");
      const open = button(`查看${title}旧记录`, "quiet-button", async () => {
        try {
          const result = await api(
            `/api/canvas/history?section=${entry.section}`,
          );
          content.replaceChildren();
          if (result.task.pending)
            content.append(
              node("p", "", `待确认：${result.task.pending.question}`),
            );
          for (const message of result.messages)
            content.append(
              node(
                "p",
                "",
                `${message.role === "user" ? "你" : "助手"}：${message.content}`,
              ),
            );
          if (!result.messages.length)
            content.append(
              node("p", "", "没有保留的聊天消息；已保存内容继续可用。"),
            );
        } catch (error) {
          errorMessage(error.message);
        }
      });
      history.append(
        open,
        node("p", "muted", entry.pending?.question || entry.nextStep),
        content,
      );
    }
    for (const draft of ui.importedDrafts.filter((item) => item.text)) {
      const title = { company: "企业信息", sources: "数据接入", ...pageLabels }[
        draft.page
      ];
      const item = node("details", "legacy-draft");
      item.append(
        node("summary", "", `${title}旧草稿`),
        node("p", "", draft.text),
        button("放入输入框", "quiet-button", async () => {
          const target = ["company", "sources"].includes(draft.page)
            ? "setup"
            : draft.page;
          const existing =
            target === ui.page
              ? { text: $("#message-input").value }
              : (ui.drafts.get(target) ?? ui.draftStore?.read(target));
          if (existing?.text?.trim())
            return errorMessage(
              `${pageLabels[target]}已有草稿，请先保存或清空，再恢复旧草稿。`,
            );
          if (
            target !== ui.page &&
            !(await mutate("/api/canvas/navigate", { page: target }))
          )
            return;
          $("#message-input").value = draft.text;
          ui.focus = null;
          ui.pendingMessage = null;
          rememberDraft();
          resizeInput();
          updateComposer();
          openComposer();
        }),
      );
      history.append(item);
    }
    sources.append(history);
  }
  if (!shareMode) {
    const file = node("input");
    file.type = "file";
    file.accept = "application/json,.json";
    file.hidden = true;
    file.addEventListener("change", async () => {
      try {
        const selected = file.files[0];
        if (!selected) return;
        if (selected.size > 100000) throw new Error("草稿文件过大。");
        const drafts = parseLegacyDrafts(await selected.text());
        // Retain previously imported text; importing again never replaces it.
        for (const draft of drafts)
          if (
            !ui.importedDrafts.some(
              (item) => item.page === draft.page && item.text === draft.text,
            )
          )
            ui.importedDrafts.push(draft);
        ui.draftStore?.save("legacy", ui.importedDrafts);
        renderCanvas(true);
      } catch (error) {
        errorMessage(error.message);
      }
    });
    sources.append(
      button("导入旧版草稿", "quiet-button import-drafts", () => file.click()),
      file,
    );
  }
  for (const heading of sources.querySelectorAll("h1")) {
    const replacement = node("h2", heading.className, heading.textContent);
    heading.replaceWith(replacement);
  }
  return section;
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
  if (shareMode) return;
  const entries = (state.attention || []).filter(
    (item) =>
      item.page === ui.page &&
      !(
        ui.page === "ontology" &&
        ui.ontologyView === "verification" &&
        item.kind.startsWith("verification_")
      ),
  );
  if (!entries.length) return;
  const section = node("aside", "attention-list");
  section.setAttribute("aria-label", "待处理的企业记忆");
  section.append(node("h2", "subsection-title", "待处理"));
  for (const entry of entries) {
    const row = button("", "attention-item", () => {
      const artifact = [
        ...state.sources,
        ...state.ontologies,
        ...state.outlines,
        ...state.verifications,
      ].find((item) => item.id === entry.artifactId);
      if (artifact?.kind === "source") openSource(artifact);
      else if (artifact?.kind === "verification") openVerification(artifact);
      else {
        if (artifact) setFocus(artifact);
        $("#message-input").value = entry.detail || entry.title;
        resizeInput();
        openComposer();
      }
    });
    row.append(node("strong", "", entry.title));
    if (entry.detail && entry.detail !== entry.title)
      row.append(node("span", "", entry.detail));
    section.append(row);
  }
  canvas.querySelector("section")?.append(section);
}
const consumerStatuses = {
  draft: "待启用",
  active: "已启用",
  revoked: "已停用",
};
function consumerName(consumer) {
  return consumer.content.name || consumer.title || "调用方";
}
function consumerPanel(consumer) {
  const key = `${consumer.id}:${consumer.version}`;
  if (!ui.consumerPanels.has(key)) {
    ui.consumerPanels.set(key, {
      connectionOpen: false,
      connection: null,
      connectionBusy: false,
      connectionError: "",
      connectionTab: "mcp",
      copyStatus: "",
      preview: null,
      previewBusy: false,
      previewError: "",
      publishBusy: false,
      cloneOpen: false,
      cloneName: "",
      clonePurpose: "",
      notice: "",
      grantsOpen: false,
    });
  }
  return ui.consumerPanels.get(key);
}
function consumerScreenCurrent(consumer, request) {
  return (
    ui.page === "consumption" &&
    ui.detail?.consumerId === consumer.id &&
    (request === undefined || request === ui.detailRequest) &&
    state.consumers.some(
      (item) => item.id === consumer.id && item.version === consumer.version,
    )
  );
}
function changedConsumerSources(consumer) {
  const model = state.ontologies.find(
    (item) =>
      item.id === consumer.content.modelId &&
      item.version === consumer.content.modelVersion,
  );
  if (!model) return null;
  const ids = new Set((model.content.types || []).map((type) => type.sourceId));
  return state.sources.filter(
    (source) =>
      ids.has(source.id) &&
      source.version >
        Number(consumer.content.sourceVersions?.[source.id] || 0),
  );
}
function consumerDataLabel(consumer) {
  if (consumer.status === "draft") return "确认范围后启用";
  if (consumer.status === "revoked") return "已停止数据访问";
  const changed = changedConsumerSources(consumer);
  if (changed?.length) return `${changed.length} 份资料有更新，待发布`;
  return changed ? "已发布的数据与当前资料一致" : "可检查并发布数据更新";
}
function renderConsumption() {
  if (
    !state.consumers.length &&
    !state.ontologies.some((item) => item.status === "adopted")
  ) {
    const section = node("section", "empty-canvas");
    const content = node("div");
    content.append(
      node("h1", "", "让合适的应用，使用合适的企业记忆。"),
      node("p", "empty-note", "先建立并采用本体，再确认每个调用方的可读范围。"),
      button("查看本体", "quiet-button", () => navigate("ontology")),
    );
    section.append(content);
    return section;
  }
  if (!state.consumers.length)
    return emptyCanvas("哪个 Agent 需要使用这些企业记忆？");
  const section = node("section", "consumption-canvas");
  section.append(
    heading(
      "连接与使用企业记忆",
      "让外部 Agent 按明确范围读取企业对象。资料持续维护，检查后发布给调用方。",
    ),
  );
  const connections = node("div", "consumer-connections");
  const memory = node("div", "memory-origin");
  memory.append(
    node("span", "memory-origin-label", "企业记忆"),
    node("h2", "", companyName()),
    node(
      "p",
      "memory-origin-description",
      `本体定义业务含义
数据持续补充与更新`,
    ),
  );
  const bridge = node("div", "consumer-bridge");
  bridge.append(
    node("strong", "", "MCP / HTTP API"),
    node("span", "", "独立密钥 · 按范围只读"),
  );
  const consumers = node("div", "consumer-list");
  const order = { active: 0, draft: 1, revoked: 2 };
  const ordered = [...state.consumers].sort(
    (a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3),
  );
  for (const consumer of ordered) {
    const card = button("", "consumer-card", () => openConsumer(consumer));
    card.dataset.consumerId = consumer.id;
    card.dataset.status = consumer.status;
    const title = node("div", "consumer-card-heading");
    title.append(
      node("h2", "", consumerName(consumer)),
      node("span", "consumer-status", consumerStatuses[consumer.status] || ""),
    );
    card.append(title);
    if (consumer.status === "revoked") {
      consumers.append(card);
      continue;
    }
    if (consumer.content.purpose)
      card.append(node("p", "consumer-purpose", consumer.content.purpose));
    card.append(
      node(
        "p",
        "consumer-types",
        (consumer.content.grants || []).map((grant) => grant.type).join(" · "),
      ),
      node("p", "consumer-data-label", consumerDataLabel(consumer)),
      node(
        "span",
        "consumer-version-label",
        `本体 v${consumer.content.modelVersion} · 数据 v${consumer.version}`,
      ),
    );
    consumers.append(card);
  }
  connections.append(memory, bridge, consumers);
  section.append(connections);
  section.append(
    node(
      "p",
      "consumption-local-note",
      shareMode
        ? "此页展示接入方式、读取范围与示例调用记录。离线文件不开放实际连接，也不包含密钥。"
        : "当前是本机实验：支持本机 Agent 的 MCP 配置，或可访问此服务的 HTTP 客户端。",
    ),
  );
  if (state.accessLogs.length)
    section.append(
      node("h2", "subsection-title", shareMode ? "示例调用记录" : "最近调用"),
      renderAccessLogs(state.accessLogs.slice(0, 5)),
    );
  return section;
}
function renderGrants(consumer) {
  const container = node("div", "grant-list");
  for (const grant of consumer.content.grants || []) {
    const row = node("section", "grant");
    row.append(node("h3", "", grant.type));
    const fields = node("div", "grant-fields");
    for (const field of grant.fields || [])
      fields.append(node("span", "", label(field)));
    row.append(fields);
    if (grant.relations?.length)
      row.append(
        node(
          "p",
          "grant-relations",
          `可访问关系：${grant.relations.join("、")}`,
        ),
      );
    container.append(row);
  }
  return container;
}
async function loadConsumerConnection(consumer) {
  const panel = consumerPanel(consumer);
  panel.connectionOpen = !panel.connectionOpen;
  renderCanvas(true);
  if (!panel.connectionOpen || panel.connection || panel.connectionBusy) return;
  panel.connectionBusy = true;
  panel.connectionError = "";
  const request = ui.detailRequest;
  renderCanvas(true);
  try {
    const connection = await api("/api/consumers/connection");
    if (consumerScreenCurrent(consumer, request)) panel.connection = connection;
  } catch (error) {
    if (consumerScreenCurrent(consumer, request))
      panel.connectionError = error.message;
  } finally {
    panel.connectionBusy = false;
    if (consumerScreenCurrent(consumer)) renderCanvas(true);
  }
}
function consumerConnectionText(consumer, panel) {
  if (panel.connectionTab === "mcp")
    return JSON.stringify(panel.connection.mcp, null, 2);
  const objects = new URL(panel.connection.http.objects);
  if (consumer.content.grants?.[0]?.type)
    objects.searchParams.set("type", consumer.content.grants[0].type);
  return `GET ${panel.connection.http.schema}
Authorization: Bearer <本调用方 API Key>

GET ${objects.href}
Authorization: Bearer <本调用方 API Key>`;
}
async function copyConsumerConnection(consumer, text, success) {
  const panel = consumerPanel(consumer);
  const request = ui.detailRequest;
  try {
    await navigator.clipboard.writeText(text);
    if (consumerScreenCurrent(consumer, request)) panel.copyStatus = success;
  } catch {
    if (consumerScreenCurrent(consumer, request))
      panel.copyStatus = "浏览器未允许复制，请选中配置文字复制。";
  }
  if (consumerScreenCurrent(consumer, request)) renderCanvas(true);
}
function renderConsumerConnection(consumer) {
  const panel = consumerPanel(consumer);
  const section = node("section", "consumer-connection-panel");
  const heading = node("div", "consumer-section-heading");
  const text = node("div");
  text.append(
    node("h2", "subsection-title", "接入你的 Agent"),
    node(
      "p",
      "detail-note",
      "支持 MCP 的 Agent 添加配置；其他应用通过 HTTP API 读取相同的授权内容。",
    ),
  );
  const toggle = button(
    panel.connectionOpen ? "收起配置" : "接入配置",
    "quiet-button",
    () => loadConsumerConnection(consumer),
  );
  toggle.setAttribute("aria-expanded", String(panel.connectionOpen));
  heading.append(text, toggle);
  section.append(heading);
  if (panel.connectionOpen) {
    const box = node("div", "connection-config");
    if (panel.connectionBusy)
      box.append(node("p", "detail-note", "正在读取接入配置…"));
    else if (panel.connectionError)
      box.append(node("p", "detail-note", panel.connectionError));
    else if (panel.connection) {
      const tabs = node("nav", "view-tabs connection-tabs");
      tabs.setAttribute("aria-label", "接入方式");
      for (const [id, name] of [
        ["mcp", "MCP 配置"],
        ["http", "HTTP API"],
      ]) {
        const tab = button(name, "view-tab", () => {
          panel.connectionTab = id;
          panel.copyStatus = "";
          renderCanvas(true);
        });
        tab.setAttribute("aria-pressed", String(panel.connectionTab === id));
        tabs.append(tab);
      }
      const code = consumerConnectionText(consumer, panel);
      box.append(
        tabs,
        node(
          "p",
          "detail-note",
          panel.connectionTab === "mcp"
            ? "将配置加入本机 Agent，填入此调用方启用时获得的 API Key。连接后可了解对象定义、查询对象及授权关系。"
            : "先读取可用对象定义，再按类型、编号或关系查询。两个接口都使用此调用方的 API Key。",
        ),
      );
      const pre = node("pre", "request-example", code);
      pre.tabIndex = 0;
      pre.setAttribute(
        "aria-label",
        panel.connectionTab === "mcp" ? "MCP 接入配置" : "HTTP 请求示例",
      );
      const actions = node("div", "connection-copy-actions");
      actions.append(
        button(
          panel.connectionTab === "mcp" ? "复制 MCP 配置" : "复制请求示例",
          "quiet-button",
          () =>
            copyConsumerConnection(
              consumer,
              code,
              "已复制，请替换 API Key 占位文字。",
            ),
        ),
        button("复制 API 地址", "quiet-button", () =>
          copyConsumerConnection(
            consumer,
            panel.connection.http.objects,
            "已复制对象接口地址。",
          ),
        ),
      );
      box.append(pre, actions);
      if (panel.copyStatus) {
        const status = node("p", "detail-note", panel.copyStatus);
        status.setAttribute("role", "status");
        box.append(status);
      }
      box.append(
        node(
          "p",
          "detail-note",
          "每个调用方使用自己的密钥。这里显示配置模板，已有密钥不会再次展示；需要新密钥时可创建独立接入。",
        ),
      );
      if (panel.connection.localOnly)
        box.append(
          node(
            "p",
            "detail-note",
            "当前 MCP 桥接程序在本机运行，需要 DataEngine 服务保持开启。云端 Agent 尚不能直接连接此本机地址。",
          ),
        );
    } else
      box.append(
        button("读取接入配置", "quiet-button", () => {
          panel.connectionOpen = false;
          loadConsumerConnection(consumer);
        }),
      );
    section.append(box);
  }
  return section;
}
async function checkConsumerData(consumer) {
  const panel = consumerPanel(consumer);
  if (panel.previewBusy || ui.requesting) return;
  panel.previewBusy = true;
  panel.previewError = "";
  panel.preview = null;
  panel.notice = "";
  const request = ui.detailRequest;
  renderCanvas(true);
  try {
    const preview = await api("/api/consumers/data-preview", {
      id: consumer.id,
      version: consumer.version,
    });
    if (consumerScreenCurrent(consumer, request)) panel.preview = preview;
  } catch (error) {
    if (consumerScreenCurrent(consumer, request))
      panel.previewError = error.message;
  } finally {
    panel.previewBusy = false;
    if (consumerScreenCurrent(consumer)) renderCanvas(true);
  }
}
async function publishConsumerData(consumer) {
  const panel = consumerPanel(consumer);
  const preview = panel.preview;
  if (
    !preview?.valid ||
    !preview.changedSources?.length ||
    panel.publishBusy ||
    ui.requesting
  )
    return;
  panel.publishBusy = true;
  renderCanvas(true);
  const completed = await mutate(
    "/api/consumers/data-publish",
    {
      id: consumer.id,
      version: consumer.version,
      sourceVersions: preview.nextSourceVersions,
    },
    (result) => {
      const next = result.consumers?.find((item) => item.id === consumer.id);
      if (next)
        ui.consumerPanels.set(`${next.id}:${next.version}`, {
          ...panel,
          preview: null,
          previewBusy: false,
          previewError: "",
          publishBusy: false,
          notice:
            "数据已发布。此调用方下一次请求将读取新数据，原密钥继续有效。",
        });
    },
  );
  panel.publishBusy = false;
  if (!completed && consumerScreenCurrent(consumer)) renderCanvas(true);
}
function renderConsumerData(consumer) {
  const panel = consumerPanel(consumer);
  const section = node("section", "consumer-data-panel");
  const heading = node("div", "consumer-section-heading");
  const text = node("div");
  text.append(
    node("h2", "subsection-title", "持续更新的数据"),
    node("p", "detail-note", consumerDataLabel(consumer)),
  );
  const check = button(
    panel.previewBusy ? "正在检查…" : "检查数据更新",
    "quiet-button",
    () => checkConsumerData(consumer),
  );
  check.disabled =
    panel.previewBusy || panel.publishBusy || ui.requesting || state.busy;
  heading.append(text);
  if (!shareMode) heading.append(check);
  section.append(heading);
  const current = node("div", "consumer-data-current");
  current.append(
    node("span", "", `已发布数据 v${consumer.version}`),
    node("span", "", `本体 v${consumer.content.modelVersion}`),
  );
  if (consumer.content.dataPublishedAt)
    current.append(
      node(
        "span",
        "",
        `发布于 ${accessTime(consumer.content.dataPublishedAt)}`,
      ),
    );
  section.append(
    current,
    node(
      "p",
      "detail-note",
      "先在数据页补充或更新资料，再检查并发布。发布保留原密钥、本体定义和访问范围；后续请求读取新数据，旧结果仍保留原来的依据。",
    ),
  );
  if (shareMode) {
    const flow = node("div", "share-update-flow");
    for (const step of ["更新资料", "检查变化", "确认发布", "Agent 读取新版本"])
      flow.append(node("span", "", step));
    section.append(
      flow,
      node(
        "p",
        "detail-note",
        "这里展示产品中的更新流程。当前 HTML 保留导出时的数据快照，不会自动更新。",
      ),
    );
    return section;
  }
  if (panel.previewError)
    section.append(node("p", "consumer-update-status", panel.previewError));
  if (panel.notice) {
    const notice = node("p", "consumer-update-status", panel.notice);
    notice.setAttribute("role", "status");
    section.append(notice);
  }
  if (panel.preview) {
    const preview = panel.preview;
    const box = node("div", "consumer-update-preview");
    const changes = preview.changedSources || [];
    for (const source of changes) {
      const row = node("div", "consumer-source-change");
      row.append(
        node("span", "", source.title),
        node("span", "", `v${source.fromVersion} → v${source.toVersion}`),
      );
      box.append(row);
    }
    if (!preview.valid) {
      box.append(
        node("p", "consumer-update-status", "暂时不能发布，请先修正以下问题。"),
      );
      for (const error of preview.errors || [])
        box.append(
          node(
            "p",
            "detail-note",
            typeof error === "string" ? error : plain(error),
          ),
        );
    } else if (!changes.length)
      box.append(
        node(
          "p",
          "consumer-update-status",
          "检查完成，当前没有需要发布的数据更新。",
        ),
      );
    else {
      box.append(
        node(
          "p",
          "detail-note",
          "已检查对象映射与访问范围。确认后，这组资料版本一起生效。",
        ),
      );
      const publish = button(
        panel.publishBusy ? "正在发布…" : "发布给此调用方",
        "primary-button",
        () => publishConsumerData(consumer),
      );
      publish.disabled = panel.publishBusy || ui.requesting || state.busy;
      box.append(publish);
    }
    section.append(box);
  }
  section.append(
    node(
      "p",
      "detail-note",
      "字段或关系的含义发生变化时，需要回到本体页确认新定义，再单独调整授权。当前不自动同步，也不开放外部写入。",
    ),
  );
  return section;
}
function renderConsumerClone(consumer) {
  const panel = consumerPanel(consumer);
  const section = node("section", "consumer-clone-panel");
  const toggle = button(
    panel.cloneOpen ? "收起独立接入" : "创建同范围的独立接入",
    "quiet-button",
    () => {
      panel.cloneOpen = !panel.cloneOpen;
      if (panel.cloneOpen) panel.grantsOpen = true;
      renderCanvas(true);
    },
  );
  toggle.setAttribute("aria-expanded", String(panel.cloneOpen));
  toggle.disabled = ui.requesting || state.busy;
  section.append(toggle);
  if (!panel.cloneOpen) return section;
  const form = node("form", "consumer-clone-form");
  form.append(
    node(
      "p",
      "detail-note",
      "为另一个 Agent 创建单独的身份和密钥。沿用上面的可读范围，提交后先确认，再启用。新接入从本体保存时的数据起步，启用后可检查并发布资料更新。",
    ),
  );
  for (const [field, title, placeholder, max] of [
    ["cloneName", "调用方名称", "例如：供热客服 Agent", 120],
    ["clonePurpose", "使用目的", "例如：查询投诉和回访，辅助客服答复", 500],
  ]) {
    const label = node("label", "consumer-form-label");
    label.append(node("span", "", title));
    const input = node("input");
    input.name = field;
    input.required = true;
    input.maxLength = max;
    input.placeholder = placeholder;
    input.value = panel[field];
    input.addEventListener("input", () => {
      panel[field] = input.value;
    });
    label.append(input);
    form.append(label);
  }
  const submit = node("button", "primary-button", "创建接入草稿");
  submit.type = "submit";
  submit.disabled = ui.requesting || state.busy;
  form.append(submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!panel.cloneName.trim() || !panel.clonePurpose.trim()) return;
    const request = ui.detailRequest;
    await mutate(
      "/api/consumers/prepare",
      {
        templateId: consumer.id,
        templateVersion: consumer.version,
        name: panel.cloneName.trim(),
        purpose: panel.clonePurpose.trim(),
      },
      (result) => {
        if (
          result.preparedConsumerId &&
          consumerScreenCurrent(consumer, request)
        ) {
          ui.detail = {
            key: `consumer:${result.preparedConsumerId}`,
            kind: "consumer",
            consumerId: result.preparedConsumerId,
          };
          ui.detailRequest += 1;
          $("#canvas").scrollTop = 0;
        }
      },
    );
  });
  section.append(form);
  return section;
}
function renderShareConnection() {
  const section = node("section", "share-connection");
  section.append(node("h2", "subsection-title", "接入方式"));
  const methods = node("div", "share-connection-methods");
  for (const [name, description] of [
    ["MCP", "Agent 先了解获准读取的对象、字段和关系，再查询企业记忆。"],
    [
      "HTTP API",
      "应用直接读取授权范围内的对象，通过数据版本判断内容是否更新。",
    ],
  ]) {
    const method = node("div", "share-connection-method");
    method.append(node("h3", "", name), node("p", "", description));
    methods.append(method);
  }
  section.append(methods);
  return section;
}
function renderConsumerDetail(consumer) {
  const section = detailFrame(consumerName(consumer), closeDetail, "返回连接");
  section.classList.add("consumer-detail");
  const title = section.querySelector(".canvas-heading > div");
  if (consumer.content.purpose)
    title.append(node("p", "", consumer.content.purpose));
  const actions = node("div", "detail-heading-actions");
  actions.append(
    node(
      "span",
      "consumer-detail-status",
      consumerStatuses[consumer.status] || "",
    ),
  );
  const adjust = button("调整范围", "quiet-button", () =>
    adjustArtifact(consumer, consumerName(consumer)),
  );
  adjust.disabled = ui.requesting || state.busy;
  if (!shareMode) actions.append(adjust);
  section.querySelector(".canvas-heading").append(actions);
  if (consumer.status === "active") {
    section.append(
      shareMode ? renderShareConnection() : renderConsumerConnection(consumer),
      renderConsumerData(consumer),
    );
    const grants = node("details", "consumer-grants-disclosure");
    const panel = consumerPanel(consumer);
    grants.open = shareMode || panel.grantsOpen;
    grants.addEventListener("toggle", () => {
      panel.grantsOpen = grants.open;
    });
    grants.append(
      node(
        "summary",
        "",
        `可读取的内容 · ${consumer.content.grants?.length || 0} 类对象`,
      ),
      renderGrants(consumer),
      node(
        "p",
        "detail-note",
        "只允许读取这里列出的对象、字段和关系。来源原文不对调用方开放。",
      ),
    );
    section.append(grants);
    if (!shareMode) section.append(renderConsumerClone(consumer));
  } else {
    section.append(
      node("h2", "subsection-title", "可读取的内容"),
      renderGrants(consumer),
      node(
        "p",
        "detail-note",
        "只允许读取这里列出的对象、字段和关系。来源原文不对调用方开放。",
      ),
    );
    if (consumer.status === "draft" && !shareMode) {
      const decision = node("div", "consumer-decision");
      decision.append(
        node(
          "p",
          "",
          "确认以上范围后，这个调用方才能访问企业记忆。启用时会交付一次独立密钥。",
        ),
      );
      const activate = button("启用访问", "primary-button", () =>
        activateConsumer(consumer),
      );
      const pending =
        state.pending?.consumerId === consumer.id &&
        Number(state.pending.version) === consumer.version;
      activate.disabled = ui.requesting || state.busy || !pending;
      if (pending) decision.append(activate);
      else
        decision.append(
          button("通过对话确认范围", "quiet-button", () =>
            adjustArtifact(consumer, consumerName(consumer)),
          ),
        );
      section.append(decision);
    } else if (consumer.status === "revoked")
      section.append(
        node("p", "consumer-revoked", "访问已停用，原来的密钥不再有效。"),
      );
  }
  section.append(
    node(
      "p",
      "detail-note",
      `授权依据：本体第 ${consumer.content.modelVersion} 版。新定义不会自动扩大这份授权。`,
    ),
    node("h2", "subsection-title", shareMode ? "示例调用记录" : "最近调用"),
    renderAccessLogs(
      state.accessLogs
        .filter((log) => log.consumerId === consumer.id)
        .slice(0, 12),
      false,
    ),
  );
  if (consumer.status === "active" && !shareMode) {
    const revoke = button(
      "停用访问",
      "quiet-button consumer-revoke-action",
      () => revokeConsumer(consumer),
    );
    revoke.disabled = ui.requesting;
    section.append(revoke);
  }
  return section;
}
function openConsumer(consumer) {
  showDetail(
    {
      key: `consumer:${consumer.id}`,
      kind: "consumer",
      consumerId: consumer.id,
    },
    renderConsumerDetail(consumer),
  );
}
function accessTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(date);
}
const accessReasons = {
  ok: "请求在授权范围内完成。",
  invalid_credential: "调用凭据无效或已停用。",
  method_not_allowed: "只允许读取数据。",
  unsupported_resource: "请求的入口没有开放。",
  unsupported_parameter: "请求使用了未开放的查询方式。",
  type_denied: "对象类型没有获得授权。",
  identity_denied: "对象编号没有获得授权。",
  relation_denied: "关系、目标或连接字段没有获得完整授权，或缺少起始对象编号。",
  field_denied: "请求包含未获授权的字段。",
  invalid_page: "分页参数需要修正。",
  sensitive_field: "请求涉及已限制对外使用的资料字段。",
  memory_unavailable: "授权对应的企业记忆暂时无法读取。",
};
function renderAccessLogs(logs, showConsumer = true) {
  const list = node("div", "access-list");
  if (!logs.length) {
    list.append(
      node(
        "p",
        "detail-note",
        showConsumer ? "还没有真实调用。" : "最近的记录中没有该调用方的访问。",
      ),
    );
    return list;
  }
  for (const log of logs) {
    const item = node("details", "access-log");
    const summary = node("summary");
    const allowed = log.result === "allowed";
    const consumer = state.consumers.find(
      (entry) => entry.id === log.consumerId,
    );
    const identity =
      log.consumerName ||
      (consumer && consumerName(consumer)) ||
      "未识别调用方";
    const operation = log.operation === "read" ? "读取" : "未开放的操作";
    const resource = [log.resource?.type, log.resource?.relation]
      .filter(Boolean)
      .join(" / ");
    summary.append(
      node(
        "span",
        "access-resource",
        `${showConsumer ? `${identity} · ` : ""}${operation}${resource ? ` ${resource}` : ""}`,
      ),
      node("span", "access-result", allowed ? "允许" : "拒绝"),
      node("time", "access-time", accessTime(log.at)),
    );
    item.append(summary);
    const detail = node("div", "access-detail");
    detail.append(
      node(
        "p",
        "",
        accessReasons[log.reason] ||
          (allowed ? "请求在授权范围内完成。" : "请求未通过访问校验。"),
      ),
    );
    if (log.model?.version)
      detail.append(node("p", "", `本体第 ${log.model.version} 版`));
    if (log.sourceVersions && typeof log.sourceVersions === "object") {
      const sources = Object.entries(log.sourceVersions).map(
        ([id, version]) => {
          const source = state.sources.find((entry) => entry.id === id);
          return `${source?.title || "来源资料"} · 第 ${version} 版`;
        },
      );
      if (sources.length) detail.append(node("p", "", sources.join("、")));
    }
    item.append(detail);
    list.append(item);
  }
  return list;
}
async function activateConsumer(consumer) {
  await mutate(
    "/api/consumers/activate",
    { id: consumer.id, version: consumer.version },
    (result) => {
      if (result.credential?.apiKey)
        showCredential(result.credential, consumerName(consumer));
    },
  );
}
async function revokeConsumer(consumer) {
  await mutate("/api/consumers/revoke", {
    id: consumer.id,
    version: consumer.version,
  });
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
  ui.canvasKey = "";
  renderCanvas(true);
  $("#canvas").scrollTop = 0;
}
function showDetail(detail, content) {
  ui.detailRequest += 1;
  ui.detail = detail;
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
      for (const [key, item] of Object.entries(value.target.definition)) {
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
      body.append(details);
    }
    body.append(
      node(
        "p",
        "source-meta",
        `范围：${Object.keys(context.scope.where).length ? JSON.stringify(context.scope.where) : "无额外筛选"} · 从第 ${context.scope.offset + 1} 条起，最多 ${context.scope.limit} 条`,
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
      ui.canvasKey = "";
    },
  );
}
function renderDialogue() {
  const lines = state.messages
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({ ...message }));
  if (state.streaming)
    lines.push({
      id: "streaming",
      role: "assistant",
      content: state.streaming,
      streaming: true,
    });
  else if (
    !state.busy &&
    state.pending?.question &&
    lines.at(-1)?.role !== "assistant"
  )
    lines.push({
      id: "question",
      role: "assistant",
      content: state.pending.question,
    });
  else if (!lines.length && hasCanvasContent() && state.prompt)
    lines.push({ id: "prompt", role: "assistant", content: state.prompt });
  const visible = lines;
  $("#history-label").textContent = state.busy ? "对话记录 · 正在处理…" : "对话记录";
  $("#chat-activity").hidden = !state.busy;
  const fingerprint = JSON.stringify(visible);
  if (ui.dialogueKey === fingerprint) return;
  ui.dialogueKey = fingerprint;
  const container = $("#dialogue");
  const followLatest = container.scrollHeight - container.scrollTop - container.clientHeight < 48;
  const previousScroll = container.scrollTop;
  container.replaceChildren();
  if (!visible.length) container.append(node("p", "dialogue-empty", "还没有对话，从下面介绍你的企业开始。"));
  visible.forEach((message, index) => {
    const distance = visible.length - 1 - index;
    const age = distance === 0 ? "latest" : distance === 1 ? "older" : "oldest";
    const text = String(message.content)
      .replace(/\*\*/g, "")
      .replace(/^#{1,6}\s+/gm, "");
    const line = node(
      "p",
      `dialogue-line ${message.role} ${age}${message.streaming ? " streaming" : ""}`,
    );
    line.append(node("span", "message-text", text));
    if (message.workContext?.target) {
      const ref = message.workContext.target;
      line.append(
        button(
          `引用：${ref.label} · 第 ${ref.ref.version} 版`,
          "message-context",
          () =>
            inspectContext(
              message.workContext.context,
              message.workContext.context.view.split(".")[0],
            ),
        ),
      );
    }
    container.append(line);
  });
  container.scrollTop = followLatest ? container.scrollHeight : previousScroll;
}
function setChatMode(mode) {
  ui.chatMode = mode;
  $(".interaction").dataset.mode = mode;
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
  const input = $("#message-input");
  const busy = state.busy;
  const blocked =
    ui.requesting || ui.uploading || ui.contextResolving || !ui.initialized;
  input.placeholder = ui.chatMode === "compact" ? "随心输入" : shareMode
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
  $("#upload-button").disabled = blocked || busy;
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
    ? `${ui.focus.label} · 第 ${ui.focus.version} 版${ui.focus.ref ? "" : " · 整份成果"}`
    : "";
  $("#inspect-focus").hidden = !ui.focus || !!shareMode;
  $("#focus-context").dataset.kind = ui.focus?.ref?.kind || "artifact";
  for (const control of $$("[data-page]")) {
    const entry = state.pages.find((page) => page.id === control.dataset.page);
    control.disabled =
      ui.requesting ||
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
  );
}
async function uploadFile(file) {
  if (shareMode)
    return errorMessage("离线演示只提供已保存的样本资料，不能上传或修改数据。");
  if (!file || ui.requesting || ui.uploading || state.busy) return;
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
        ui.canvasKey = "";
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
  $("#key-note").textContent = "密钥仅用于当前服务进程。";
  $("#settings-status").hidden = true;
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
      ...($("#provider-input").value === "custom" ? {
        baseUrl: $("#base-url-input").value.trim(),
        protocol: $("#protocol-input").value,
      } : {}),
    });
    state.model = result.model;
    $("#api-key-input").value = "";
    if (test) {
      settingsStatus("正在测试连接…");
      const checked = await api("/api/settings/test", {});
      settingsStatus(checked.message || "连接成功。");
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
  if (ui.chatMode === "composer" && !$("#message-input").value && !ui.focus && !state.busy && !$("#request-error").textContent)
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
  } else if (ui.chatMode === "composer" || ui.chatMode === "compact") {
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
  if (!shareMode && !state.busy && !ui.requesting && ui.page !== "consumption")
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
if (!shareMode)
  setInterval(() => {
    if (!document.hidden) refresh();
  }, 1200);

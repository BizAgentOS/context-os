const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const pageLabels = {
  company: "企业",
  sources: "数据",
  ontology: "本体",
  consumption: "数据消费",
};
const placeholders = {
  company: "从你的企业开始…",
  sources: "告诉我资料在哪里，或上传一份文件…",
  ontology: "我们需要理解哪些业务对象？",
  consumption: "哪些应用需要使用这些企业记忆？",
};
const fieldLabels = {
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
  currentPage: "company",
  page: "company",
  pages: [],
  model: {},
  busy: false,
  streaming: "",
  messages: [],
  prompt: "你的企业叫什么？",
  profile: null,
  sources: [],
  ontologies: [],
  outlines: [],
  verifications: [],
  sourcePolicies: [],
  sourcePolicyFields: {},
  attention: [],
  consumers: [],
  accessLogs: [],
  pending: null,
};
initialAccess = "";
const ui = {
  page: "company",
  initialized: false,
  polling: false,
  requesting: false,
  uploading: false,
  generation: 0,
  detailRequest: 0,
  detail: null,
  focus: null,
  drafts: new Map(),
  ontologyView: "definitions",
  definitionId: null,
  canvasKey: "",
  dialogueKey: "",
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
  $("#request-error").textContent = message;
  $("#request-error").hidden = !message;
}
async function api(path, body) {
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
    throw new Error(data.error || "请求未完成，请重试。");
  return data;
}
function rememberDraft() {
  ui.drafts.set(ui.page, {
    text: $("#message-input").value,
    focus: ui.focus,
    pendingMessage: ui.pendingMessage,
  });
}
function changePage(page) {
  if (ui.page === page) return;
  rememberDraft();
  ui.page = page;
  const draft = ui.drafts.get(page);
  $("#message-input").value = draft?.text || "";
  ui.focus = draft?.focus || null;
  ui.pendingMessage = draft?.pendingMessage || null;
  ui.detail = null;
  ui.detailRequest += 1;
  ui.canvasKey = "";
  ui.dialogueKey = "";
  $("#canvas").scrollTop = 0;
  resizeInput();
}
function applySnapshot(snapshot) {
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
  ui.initialized = true;
  render();
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
async function mutate(path, body, after) {
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
    errorMessage(error.message);
    return false;
  } finally {
    ui.requesting = false;
    updateComposer();
  }
}
async function navigate(page) {
  if (page === ui.page || ui.requesting) return;
  await mutate("/api/canvas/navigate", { page });
}
function render() {
  for (const control of $$("[data-page]")) {
    const page = control.dataset.page;
    const entry = state.pages.find((item) => item.id === page);
    control.disabled =
      ui.requesting ||
      (page !== "company" && !entry?.available && page !== ui.page);
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
    ontologies: refs(state.ontologies),
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
      ["ontology", "consumption"].includes(ui.page) &&
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
        $("#canvas").replaceChildren(renderConsumerDetail(consumer));
        $("#canvas").scrollTop = scroll;
      }
    }
    return;
  }
  const canvas = $("#canvas");
  if (ui.page === "company") canvas.replaceChildren(renderCompany());
  else if (ui.page === "sources") canvas.replaceChildren(renderSources());
  else if (ui.page === "ontology") canvas.replaceChildren(renderOntology());
  else canvas.replaceChildren(renderConsumption());
  renderAttention(canvas);
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
      ?.text || "企业"
  );
}
function renderCompany() {
  const rows = statements();
  if (!rows.length) return emptyCanvas("你的企业叫什么？");
  const section = node("section", "company-canvas");
  const nameRow = findStatement([
    "company.name",
    "company_name",
    "companyName",
    "name",
  ]);
  const business = findStatement([
    "company.business",
    "business",
    "business_description",
    "description",
  ]);
  const identity = node("div", "company-identity");
  if (nameRow)
    identity.append(
      node("div", "company-monogram", [...nameRow.text.trim()][0]),
    );
  const intro = node("div", "company-introduction");
  intro.append(node("h1", "company-name", nameRow?.text || "关于这家企业"));
  if (business)
    intro.append(
      button(business.text, "company-business editable-text", () =>
        openStatement(business),
      ),
    );
  intro
    .querySelector("h1")
    .addEventListener("click", () => nameRow && openStatement(nameRow));
  if (nameRow) {
    const edit = button("编辑企业信息", "quiet-button", () =>
      openStatement(nameRow),
    );
    intro.append(edit);
  }
  identity.append(intro);
  section.append(identity);
  const rest = rows.filter((item) => item !== nameRow && item !== business);
  if (rest.length) {
    const facts = node("div", "company-facts");
    for (const statement of rest) {
      const fact = button("", "company-fact", () => openStatement(statement));
      fact.append(
        node(
          "span",
          "fact-label",
          `${label(statement.key)}${statement.origin === "suggestion" ? " · 待确认" : ""}`,
        ),
        node("span", "fact-value", statement.text),
      );
      facts.append(fact);
    }
    section.append(facts);
  }
  if (!findStatement(["company.goal", "goal", "goals"])) {
    const prompt = button("先选一个想解决的业务问题", "inline-prompt", () => {
      $("#message-input").value = "我们这次最想解决的问题是：";
      resizeInput();
      $("#message-input").focus();
    });
    section.append(prompt);
  }
  return section;
}
function renderSources() {
  if (!state.sources.length) return emptyCanvas("接入第一份企业资料");
  const section = node("section", "sources-canvas");
  section.append(heading("企业资料"));
  const grid = node("div", "source-grid");
  for (const source of state.sources) {
    const card = button("", "source-card", () => openSource(source));
    card.append(icon("source"), node("h2", "", source.title));
    const columns = source.content.columns || [];
    const excerpt = columns.length
      ? columns.slice(0, 4).join(" · ")
      : String(source.content.raw || "")
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
    ui.definitionId = select.value;
    renderCanvas(true);
  });
  modelBar.append(select);
  section.append(modelBar);
  if (ui.ontologyView === "objects") {
    if (
      artifact.kind === "ontology_outline" ||
      !artifact.content.validation?.valid
    ) {
      section.append(
        node(
          "p",
          "view-empty",
          "这些定义还没有对应到可用记录。接入业务数据并检查映射后，就可以查看具体对象。",
        ),
      );
    } else {
      section.append(
        node(
          "p",
          "detail-note",
          artifact.status === "adopted"
            ? "这里是所选定义保存时的记录。查看资料更新后的结果，可在“验证”中重新查证。"
            : "这是候选定义对应的对象预览，尚未采用。",
        ),
      );
      const list = node("div", "definition-list");
      for (const type of artifact.content.types) {
        const count = artifact.content.preview?.types?.find?.(
          (entry) => entry.name === type.name,
        )?.count;
        const item = button("", "definition-card", () =>
          openType(artifact, type.name),
        );
        item.append(
          node("h2", "", type.name),
          node("p", "", type.description),
          node(
            "span",
            "source-meta",
            count === undefined ? "查看对象与依据 →" : `${count} 个对象 →`,
          ),
        );
        list.append(item);
      }
      section.append(list);
    }
    return section;
  }
  const outlined = artifact.kind === "ontology_outline";
  const types = outlined ? artifact.content.concepts : artifact.content.types;
  const list = node("div", "definition-list");
  for (const type of types || []) {
    const item = button("", "definition-card", () =>
      outlined ? openConcept(artifact, type) : openType(artifact, type.name),
    );
    item.append(
      node("h2", "", type.name),
      node("p", "", type.description),
      node(
        "span",
        "source-meta",
        outlined ? "概念草稿 · 查看定义依据 →" : "查看含义、映射与依据 →",
      ),
    );
    list.append(item);
  }
  section.append(list);
  if (artifact.content.relations?.length) {
    const relations = node("div", "definition-relations");
    for (const relation of artifact.content.relations) {
      const row = button(
        `${relation.from}  →  ${relation.name}  →  ${relation.to}`,
        "relation-row",
        () =>
          outlined
            ? openConcept(artifact, relation, true)
            : adjustArtifact(
                artifact,
                `${relation.from}的${relation.name}关系`,
              ),
      );
      relations.append(row);
    }
    section.append(node("h2", "subsection-title", "关系"), relations);
  }
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
    if (canAdopt(artifact)) {
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
    findStatement(["company.goal", "goal", "goals"])?.text ||
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
  section.append(form);
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
  section.append(actions);
  showDetail(
    { key: `verification:${record.id}:${record.version}`, artifact: record },
    section,
  );
}
function renderAttention(canvas) {
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
        $("#message-input").focus();
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
    return emptyCanvas("哪些应用需要使用这些企业记忆？");
  const section = node("section", "consumption-canvas");
  section.append(heading("数据消费"));
  const connections = node("div", "consumer-connections");
  const memory = node("div", "memory-origin");
  memory.append(
    node("span", "memory-origin-label", "企业记忆"),
    node("h2", "", companyName()),
  );
  const consumers = node("div", "consumer-list");
  for (const consumer of state.consumers) {
    const card = button("", "consumer-card", () => openConsumer(consumer));
    card.dataset.consumerId = consumer.id;
    card.dataset.status = consumer.status;
    const title = node("div", "consumer-card-heading");
    title.append(
      node("h2", "", consumerName(consumer)),
      node("span", "consumer-status", consumerStatuses[consumer.status] || ""),
    );
    card.append(title);
    if (consumer.content.purpose)
      card.append(node("p", "consumer-purpose", consumer.content.purpose));
    card.append(
      node(
        "p",
        "consumer-types",
        (consumer.content.grants || []).map((grant) => grant.type).join(" · "),
      ),
    );
    consumers.append(card);
  }
  connections.append(memory, consumers);
  section.append(connections);
  if (state.accessLogs.length) {
    section.append(
      node("h2", "subsection-title", "最近调用"),
      renderAccessLogs(state.accessLogs.slice(0, 5)),
    );
  }
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
function consumerEndpoint(consumer) {
  const url = new URL("/v1/objects", location.origin);
  const type = consumer.content.grants?.[0]?.type;
  if (type) url.searchParams.set("type", type);
  return url.href;
}
function renderConsumerDetail(consumer) {
  const section = detailFrame(
    consumerName(consumer),
    closeDetail,
    "返回数据消费",
  );
  const title = section.querySelector(".canvas-heading > div");
  if (consumer.content.purpose)
    title.append(node("p", "", consumer.content.purpose));
  const actions = node("div", "detail-heading-actions");
  const adjust = button("调整范围", "quiet-button", () =>
    adjustArtifact(consumer, consumerName(consumer)),
  );
  adjust.disabled = ui.requesting || state.busy;
  actions.append(adjust);
  section.querySelector(".canvas-heading").append(actions);
  section.append(
    node("h2", "subsection-title", "可读取的内容"),
    renderGrants(consumer),
    node(
      "p",
      "detail-note",
      "只允许读取这里列出的对象、字段和关系。来源原文不对调用方开放。",
    ),
  );
  if (consumer.status === "draft") {
    const decision = node("div", "consumer-decision");
    decision.append(
      node("p", "", "确认以上范围后，这个调用方才能访问企业记忆。"),
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
  } else if (consumer.status === "active") {
    const endpoint = node("section", "consumer-endpoint");
    endpoint.append(
      node("h2", "subsection-title", "接入方式"),
      node(
        "pre",
        "request-example",
        `GET ${consumerEndpoint(consumer)}\nAuthorization: Bearer <本调用方 API Key>`,
      ),
      node(
        "p",
        "detail-note",
        "使用启用时保存的调用方密钥。密钥遗失时，先停用，再通过对话创建新的访问授权。",
      ),
    );
    const revoke = button("停用访问", "quiet-button", () =>
      revokeConsumer(consumer),
    );
    revoke.disabled = ui.requesting;
    endpoint.append(revoke);
    section.append(endpoint);
  } else {
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
    node("h2", "subsection-title", "最近调用"),
    renderAccessLogs(
      state.accessLogs
        .filter((log) => log.consumerId === consumer.id)
        .slice(0, 12),
      false,
    ),
  );
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
function showCredential(credential, name) {
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
function setFocus(artifact, suffix = "") {
  ui.focus = {
    id: artifact.id,
    version: artifact.version,
    label: suffix ? `${artifact.title} · ${suffix}` : artifact.title,
  };
  updateComposer();
}
function askAbout(artifact, suffix = "") {
  setFocus(artifact, suffix);
  const input = $("#message-input");
  if (suffix && !input.value.trim()) input.value = `关于${suffix}，`;
  resizeInput();
  input.focus();
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
  section.append(form);
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
  section.querySelector(".canvas-heading").append(actions);
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
    button("围绕这份资料提问", "quiet-button", () => askAbout(artifact)),
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
  section.querySelector(".canvas-heading").append(actions);
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
    button("围绕它提问", "quiet-button", () =>
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
    .slice(-3)
    .map((message) => ({ ...message }));
  if (state.streaming)
    lines.push({
      id: "streaming",
      role: "assistant",
      content: state.streaming.slice(-700),
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
  const visible = lines.slice(-3);
  const fingerprint = JSON.stringify(visible);
  if (ui.dialogueKey === fingerprint) return;
  ui.dialogueKey = fingerprint;
  const container = $("#dialogue");
  container.replaceChildren();
  visible.forEach((message, index) => {
    const distance = visible.length - 1 - index;
    const age = distance === 0 ? "latest" : distance === 1 ? "older" : "oldest";
    const text = String(message.content)
      .replace(/\*\*/g, "")
      .replace(/^#{1,6}\s+/gm, "");
    const line = node(
      "p",
      `dialogue-line ${message.role} ${age}${message.streaming ? " streaming" : ""}`,
      text,
    );
    container.append(line);
  });
}
function hasCanvasContent() {
  return ui.page === "company"
    ? statements().length > 0
    : ui.page === "sources"
      ? state.sources.length > 0
      : ui.page === "ontology"
        ? Boolean(currentDefinition() || state.verifications.length)
        : state.consumers.length > 0;
}
function updateComposer() {
  const input = $("#message-input");
  const busy = state.busy;
  const blocked = ui.requesting || ui.uploading || !ui.initialized;
  input.placeholder = placeholders[ui.page];
  $("#send-button").hidden = busy;
  $("#stop-button").hidden = !busy;
  $("#send-button").disabled = blocked || !input.value.trim();
  $("#stop-button").disabled = ui.requesting;
  $("#upload-button").disabled = blocked || busy;
  $("#upload-button").hidden = ui.page === "consumption";
  $("#composer-note").textContent = ui.uploading
    ? "正在接入资料…"
    : busy
      ? "正在整理…"
      : !state.model.configured && ui.initialized
        ? "先连接一个模型"
        : "";
  $("#focus-context").hidden = !ui.focus;
  $("#focus-label").textContent = ui.focus?.label || "";
  for (const control of $$("[data-page]")) {
    const entry = state.pages.find((page) => page.id === control.dataset.page);
    control.disabled =
      ui.requesting ||
      (control.dataset.page !== "company" &&
        !entry?.available &&
        control.dataset.page !== ui.page);
  }
}
function resizeInput() {
  const input = $("#message-input");
  input.style.height = "auto";
  input.style.height = `${Math.min(110, Math.max(48, input.scrollHeight))}px`;
}
async function sendMessage() {
  const input = $("#message-input");
  const text = input.value.trim();
  if (!text || ui.requesting || state.busy) return;
  if (!state.model.configured) {
    openSettings();
    return;
  }
  $(".canvas-app").dataset.reading = "false";
  const page = ui.page;
  const focus = ui.focus;
  const contextKey = `${page}:${focus?.id || ""}:${focus?.version || ""}`;
  if (
    !ui.pendingMessage ||
    ui.pendingMessage.text !== text ||
    ui.pendingMessage.contextKey !== contextKey
  )
    ui.pendingMessage = { text, contextKey, id: crypto.randomUUID() };
  await mutate(
    "/api/canvas/message",
    {
      page,
      text,
      messageId: ui.pendingMessage.id,
      ...(page === "ontology" && ui.nextRefreshSources
        ? { refreshSources: true }
        : {}),
      ...(focus ? { focusId: focus.id, focusVersion: focus.version } : {}),
    },
    () => {
      ui.pendingMessage = null;
      ui.nextRefreshSources = false;
      if (input.value.trim() === text) input.value = "";
      rememberDraft();
      resizeInput();
    },
  );
}
async function uploadFile(file) {
  if (!file || ui.requesting || ui.uploading || state.busy) return;
  if (ui.page === "consumption") {
    errorMessage("请返回数据页接入资料。");
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
    const content = await file.text();
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
function openSettings() {
  const model = state.model;
  $("#provider-input").value = model.provider || "deepseek";
  $("#model-input").value = model.model || "deepseek-v4-flash";
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
async function saveSettings(test = false) {
  if (ui.settingsBusy) return;
  const model = $("#model-input").value.trim();
  if (!model) {
    settingsStatus("填写要使用的模型名称。");
    return;
  }
  ui.settingsBusy = true;
  $("#save-settings").disabled = true;
  $("#test-connection").disabled = true;
  try {
    const result = await api("/api/settings", {
      provider: $("#provider-input").value,
      model,
      apiKey: $("#api-key-input").value,
    });
    state.model = result.model;
    $("#api-key-input").value = "";
    if (test) {
      settingsStatus("正在测试连接…");
      const checked = await api("/api/settings/test", {});
      settingsStatus(checked.message || "连接成功。");
    } else {
      $("#settings-dialog").close();
      $("#message-input").focus();
    }
    await refresh();
  } catch (error) {
    settingsStatus(error.message);
  } finally {
    ui.settingsBusy = false;
    $("#save-settings").disabled = false;
    $("#test-connection").disabled = false;
    updateComposer();
  }
}

for (const control of $$("[data-page]"))
  control.addEventListener("click", () => navigate(control.dataset.page));
$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
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
  ui.pendingMessage = null;
  updateComposer();
  rememberDraft();
});
$("#upload-button").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", (event) =>
  uploadFile(event.target.files[0]),
);
$("#open-settings").addEventListener("click", openSettings);
$("#close-settings").addEventListener("click", () =>
  $("#settings-dialog").close(),
);
$("#settings-dialog").addEventListener("close", () => {
  $("#api-key-input").value = "";
});
for (const selector of ["#close-credential", "#finish-credential"])
  $(selector).addEventListener("click", () => $("#credential-dialog").close());
$("#credential-dialog").addEventListener("close", () => {
  $("#consumer-api-key").value = "";
  $("#credential-consumer").textContent = "";
  $("#credential-status").textContent = "";
});
$("#copy-credential").addEventListener("click", async () => {
  const status = $("#credential-status");
  try {
    await navigator.clipboard.writeText($("#consumer-api-key").value);
    if (!$("#credential-dialog").open) return;
    status.textContent = "密钥已复制。";
  } catch {
    if (!$("#credential-dialog").open) return;
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
  const provider = $("#provider-input").value;
  $("#model-input").value =
    provider === state.model.provider
      ? state.model.model
      : provider === "deepseek"
        ? "deepseek-v4-flash"
        : "";
  $("#api-key-input").value = "";
  $("#api-key-input").placeholder = "填写该服务商的密钥";
});
let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  dragDepth += 1;
  if (!state.busy && !ui.requesting && ui.page !== "consumption")
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

const readCanvas = () => {
  $(".canvas-app").dataset.reading = "true";
};
$("#canvas").addEventListener("pointerdown", readCanvas);
$("#canvas").addEventListener("focusin", readCanvas);
$("#canvas").addEventListener("wheel", readCanvas, { passive: true });
$("#message-input").addEventListener("focus", () => {
  $(".canvas-app").dataset.reading = "false";
});
window.addEventListener("focus", () => refresh());
refresh(true);
setInterval(() => {
  if (!document.hidden) refresh();
}, 1200);

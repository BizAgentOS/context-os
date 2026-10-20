import { el, btn, modal, field } from "./relation-corrections.js";

const when = value => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚无读取";
const ref = a => ({ id: a.id, version: a.version });
function action(text, callback, primary = false) {
  const b = btn(text, callback); b.className = primary ? "ds-button ds-primary" : "ds-button"; return b;
}
function dialog(title, wide = false) {
  const d = modal(title); d.classList.add("ds-dialog"); if (wide) d.classList.add("ds-dialog-wide");
  d.content = el("div", "", "ds-dialog-content"); d.append(d.content); return d;
}
function notice() { const n = el("p", "", "ds-notice"); n.setAttribute("role", "status"); return n; }
function check(label, description, checked, change) {
  const row = el("label", "", "ds-check");
  const input = el("input"); input.type = "checkbox"; input.checked = checked; input.onchange = change;
  const copy = el("span"); copy.append(el("strong", label)); if (description) copy.append(el("small", description));
  row.append(input, copy); return { row, input };
}
async function copy(text, message, fallback) {
  try { await navigator.clipboard.writeText(text); message.textContent = "已复制"; }
  catch { fallback(); message.textContent = "浏览器未允许复制，已显示完整配置，请手动复制并妥善保管。"; }
}
function lock(d, busy) {
  d.dataset.busy = String(busy);
  for (const control of d.querySelectorAll("button,input,select")) {
    if (busy) { control.dataset.previousDisabled = String(control.disabled); control.disabled = true; }
    else { control.disabled = control.dataset.previousDisabled === "true"; delete control.dataset.previousDisabled; }
  }
}
function guard(d) { d.addEventListener("cancel", e => { if (d.dataset.busy === "true") e.preventDefault(); }); }

export function renderDatasetWorkspace(state, { api, ontology, legacy, onChanged }) {
  const root = el("section", "", "dataset-workspace"); root.setAttribute("aria-label", "MCP 数据集工作台");
  let disposed = false, generation = 0, data;
  root.dispose = () => { disposed = true; generation++; };
  const refreshList = () => { if (disposed) onChanged?.(); else void load(); };

  async function connection(dataset, initialKey = "") {
    const d = dialog("接入你的 Agent"); guard(d);
    const subtitle = el("p", `${dataset.title}`, "ds-muted");
    const message = notice(); d.content.append(subtitle, message);
    let keyInput, configText, config;
    d.addEventListener("close", () => { initialKey = ""; if (keyInput) keyInput.value = ""; if (configText) configText.value = ""; });
    const keyLabel = el("label", "", "ds-field");
    keyLabel.append(el("span", initialKey ? "接入密钥 · 仅本次显示，请妥善保存" : "接入密钥"));
    keyInput = el("input"); keyInput.type = "password"; keyInput.autocomplete = "off"; keyInput.spellcheck = false;
    keyInput.value = initialKey; initialKey = ""; keyInput.placeholder = "粘贴启用时保存的密钥";
    keyLabel.append(keyInput); d.content.append(keyLabel);
    const keyControls = el("div", "", "ds-actions");
    keyControls.append(action("显示 / 隐藏密钥", () => { keyInput.type = keyInput.type === "password" ? "text" : "password"; }), action("复制密钥", () => {
      if (!keyInput.value.trim()) { message.textContent = "请先填入保存的接入密钥。"; return; }
      void copy(keyInput.value.trim(), message, () => { keyInput.type = "text"; keyInput.focus(); keyInput.select(); });
    }));
    d.content.append(keyControls);
    try {
      const result = await api(`/api/datasets/connection?id=${encodeURIComponent(dataset.id)}&version=${dataset.version}`);
      if (!d.isConnected) return;
      config = result.mcp;
      d.content.append(el("p", "在支持 stdio MCP 的本机 Agent 中添加以下配置，保持 DataEngine 服务运行。", "ds-description"));
      const configLabel = el("label", "", "ds-field"); configLabel.append(el("span", "MCP 配置"));
      configText = el("textarea", "", "ds-config"); configText.readOnly = true; configText.spellcheck = false;
      const materialize = () => {
        const value = structuredClone(config);
        for (const entry of Object.values(value.mcpServers)) entry.env.DATAENGINE_CONSUMER_KEY = keyInput.value.trim() || "<本数据集接入密钥>";
        return JSON.stringify(value, null, 2);
      };
      // The visible config uses a placeholder until the user explicitly reveals or copies the credential.
      configText.value = JSON.stringify(config, null, 2); configLabel.append(configText); d.content.append(configLabel);
      const controls = el("div", "", "ds-actions");
      controls.append(action("复制完整配置", () => {
        if (!keyInput.value.trim()) { message.textContent = "请先填入保存的接入密钥。"; keyInput.focus(); return; }
        void copy(materialize(), message, () => { configText.value = materialize(); configText.focus(); configText.select(); });
      }, true), action("测试 MCP", async () => {
        if (!keyInput.value.trim()) { message.textContent = "请先填入接入密钥。"; return; }
        lock(d, true); message.textContent = "正在启动 MCP 客户端，检查连接与读取…";
        try {
          const checked = await api("/api/datasets/test", { id: dataset.id, key: keyInput.value.trim() });
          if (d.isConnected) message.textContent = `测试通过 · ${when(checked.checkedAt)} · 发现 ${checked.tools.length} 项工具，读取 ${checked.conceptCount} 个概念的目录及 ${checked.checkedConcepts} 个定义。此结果仅验证本机 MCP，不代表其他 Agent 已连接。`;
          refreshList();
        } catch (e) { if (d.isConnected) message.textContent = e.message; }
        finally { if (d.isConnected) lock(d, false); }
      }));
      d.content.append(controls, el("p", "密钥不在服务器保留明文。若丢失，请停用此数据集并重新创建；浏览器关闭前可复制完整配置。", "ds-muted"));
    } catch (e) {
      message.textContent = `${e.message}。接入密钥仍可保存，请重试加载配置。`;
      d.content.append(action("重新加载配置", () => { const savedKey = keyInput.value; d.close(); void connection(dataset, savedKey); }));
    }
  }

  function scope(dataset) {
    const d = dialog("已开放的本体范围");
    d.content.append(el("p", `${dataset.title} · ${dataset.status === "active" ? "已启用" : "已停用"}`, "ds-muted"));
    for (const c of dataset.content.concepts) { const item = el("section", "", "ds-scope-item"); item.append(el("h3", c.name), el("p", c.description)); d.content.append(item); }
    if (dataset.content.relations.length) {
      const names = new Map(dataset.content.concepts.map(c => [c.id, c.name]));
      d.content.append(el("h3", "关系", "ds-section-heading"));
      for (const r of dataset.content.relations) d.content.append(el("p", `${names.get(r.from)} → ${r.name} → ${names.get(r.to)}`, "ds-relation"));
    }
    for (const g of dataset.content.business?.grants || []) {
      d.content.append(el("h3", `${g.type} · 业务字段`, "ds-section-heading"), el("p", g.fields.join("、"), "ds-muted"));
      if (g.evidence?.fields.length) d.content.append(el("p", `可读取依据：${g.evidence.fields.join("、")}`, "ds-muted"));
    }
    d.content.append(el("p", "固定发布时的本体范围与版本。业务值按需读取，源数据变化后可能返回新值。", "ds-muted"));
  }

  function revoke(dataset) {
    const d = dialog("停用 MCP 数据集"); guard(d);
    d.content.append(el("p", `停用“${dataset.title}”后，使用此密钥的 Agent 将无法继续读取。企业资料与本体仍会保留。`, "ds-description"));
    const message = notice(); d.content.append(message, action("确认停用", async () => {
      lock(d, true);
      try { await api("/api/datasets/revoke", ref(dataset)); d.close(); refreshList(); }
      catch (e) { message.textContent = e.message; lock(d, false); }
    }, true));
  }

  function create() {
    const foundation = data.foundation, model = data.model;
    const d = dialog("创建 MCP 数据集", true); guard(d);
    d.content.append(el("p", `选择要交给 Agent 的内容 · ${foundation.enterprise}`, "ds-muted"));
    const form = el("form"); d.content.append(form);
    const title = field(form, "数据集名称", `${foundation.enterprise} · 本体知识`); title.required = true; title.maxLength = 200;
    let operationId = crypto.randomUUID(); form.addEventListener("input", () => { operationId = crypto.randomUUID(); });
    const layout = el("div", "", "ds-create-grid"), selection = el("div"), summary = el("aside", "", "ds-publish-summary");
    layout.append(selection, summary); form.append(layout);
    selection.append(el("h3", "01 / 选择本体概念", "ds-section-heading"));
    const concepts = new Map(), relations = new Map(), businessGroups = [];
    const conceptList = el("div", "", "ds-check-list"); selection.append(conceptList);
    const relationList = el("div", "", "ds-check-list");
    for (const c of foundation.concepts) { const item = check(c.name, c.description, false, update); concepts.set(c.id, item.input); conceptList.append(item.row); }
    if (foundation.relations.length) {
      selection.append(el("h3", "02 / 开放概念间的关系", "ds-section-heading"), relationList);
      const names = new Map(foundation.concepts.map(c => [c.id, c.name]));
      for (const r of foundation.relations) { const item = check(r.name, `${names.get(r.from)} → ${names.get(r.to)}`, false, update); relations.set(r.id, item.input); relationList.append(item.row); }
    }
    if (model) {
      selection.append(el("h3", "可选 / 开放业务记录", "ds-section-heading"), el("p", "勾选类型后选择字段。对象身份为必选；属性依据需另行授权。", "ds-muted"));
      for (const t of model.types) {
        const group = el("details", "", "ds-business-group"); group.append(el("summary", t.name));
        const enabled = check(`开放${t.name}业务记录`, "仅在选择对应本体概念后可用", false, update); group.append(enabled.row);
        const fields = t.fields.map(name => {
          const item = check(name === "$id" ? "对象身份（必选）" : name, "", name === "$id", update); group.append(item.row);
          let evidence;
          if (name !== "$id") { const e = check(`同时开放“${name}”的依据`, "可能包含该属性的不同来源观测值", false, update); e.row.classList.add("ds-evidence-choice"); group.append(e.row); evidence = e.input; }
          return { name, input: item.input, evidence };
        });
        businessGroups.push({ type: t.name, conceptId: t.conceptId, enabled: enabled.input, fields }); selection.append(group);
      }
    }
    summary.append(el("p", "开放前核对", "ds-eyebrow"), el("h3", "一份清晰的数据范围"));
    const counts = el("p", "", "ds-scope-count"), selectedNames = el("p", "", "ds-muted"), businessSummary = el("div", "", "ds-business-summary"); summary.append(counts, selectedNames, businessSummary);
    summary.append(el("hr"), el("p", "只读访问 · 独立密钥", "ds-summary-label"), el("p", "Agent 可发现、读取和查询所选内容。新本体版本不会自动替换这份数据集。", "ds-muted"), el("p", "源文件原文与连接凭据不会随本体定义开放。", "ds-muted"));
    const message = notice(), submit = el("button", "启用 MCP 数据集", "ds-button ds-primary"); submit.type = "submit";
    summary.append(message, submit);
    function update() {
      const selected = [...concepts].filter(([, input]) => input.checked).map(([id]) => id);
      for (const r of foundation.relations) { const input = relations.get(r.id); input.disabled = !selected.includes(r.from) || !selected.includes(r.to); if (input.disabled) input.checked = false; }
      for (const g of businessGroups) {
        g.enabled.disabled = !selected.includes(g.conceptId); if (g.enabled.disabled) g.enabled.checked = false;
        for (const f of g.fields) { f.input.disabled = !g.enabled.checked || f.name === "$id"; if (f.evidence) { f.evidence.disabled = !g.enabled.checked || !f.input.checked; if (f.evidence.disabled) f.evidence.checked = false; } }
      }
      counts.textContent = `${selected.length} 个概念 · ${[...relations.values()].filter(i => i.checked).length} 条关系`;
      selectedNames.textContent = selected.length ? foundation.concepts.filter(c => selected.includes(c.id)).map(c => c.name).join(" / ") : "从左侧选择要开放的本体范围。";
      businessSummary.replaceChildren(...businessGroups.filter(g => g.enabled.checked).map(g => {
        const item = el("p", "", "ds-muted");
        item.textContent = `${g.type}业务字段：${g.fields.filter(f => f.input.checked).map(f => f.name === "$id" ? "对象身份" : f.name).join("、")}；依据：${g.fields.filter(f => f.evidence?.checked).map(f => f.name).join("、") || "未开放"}`;
        return item;
      }));
      submit.disabled = !selected.length;
    }
    update();
    form.onsubmit = async event => {
      event.preventDefault(); if (!form.reportValidity()) return;
      const grants = businessGroups.filter(g => g.enabled.checked).map(g => ({ type: g.type, fields: g.fields.filter(f => f.input.checked).map(f => f.name), relations: [], evidence: { fields: g.fields.filter(f => f.evidence?.checked).map(f => f.name), relations: [] } }));
      const input = { operationId, name: title.value, foundationRef: ref(foundation), conceptIds: [...concepts].filter(([, i]) => i.checked).map(([id]) => id), relationIds: [...relations].filter(([, i]) => i.checked).map(([id]) => id), ...(grants.length ? { business: { modelRef: ref(model), grants } } : {}) };
      lock(d, true); message.textContent = "正在保存开放范围并签发密钥…";
      try {
        const result = await api("/api/datasets/publish", input); d.close();
        void connection(result.dataset, result.key || ""); refreshList();
      } catch (e) { message.textContent = e.message; lock(d, false); update(); }
    };
  }

  function render() {
    root.replaceChildren();
    const hero = el("header", "", "ds-hero"), copy = el("div", "", "ds-hero-copy");
    copy.append(el("p", "ONTOLOGY → AGENT", "ds-eyebrow"), el("h1", "让本体，成为 Agent 的数据"), el("p", "把整理好的企业知识与业务数据，开放为一份可连接、可查询、可管理的 MCP 数据集。", "ds-description"));
    const visual = el("div", "", "ds-flow"); visual.setAttribute("aria-label", "本体经 MCP 连接外部 Agent");
    visual.append(el("span", "企业本体", "ds-flow-end"), el("span", "", "ds-flow-line"));
    const core = el("div", "", "ds-flow-core"); core.append(el("strong", "MCP"), el("small", "只读数据服务"));
    visual.append(core, el("span", "", "ds-flow-line"), el("span", "外部 Agent", "ds-flow-end")); hero.append(copy, visual); root.append(hero);
    const steps = el("div", "", "ds-steps");
    for (const [number, title, text] of [["01", "选择本体范围", "选择概念、关系与可用业务字段"], ["02", "启用 MCP 数据集", "固定版本，生成独立接入密钥"], ["03", "连接你的 Agent", "复制配置，按需读取企业数据"]]) {
      const step = el("div"); step.append(el("span", number), el("strong", title), el("small", text)); steps.append(step);
    }
    root.append(steps);
    if (!data) { root.append(el("p", "正在读取本体与数据集…", "ds-muted")); return; }
    const workspace = el("div", "", "ds-workspace-grid"), source = el("aside", "", "ds-source ds-panel"), datasets = el("section", "", "ds-datasets");
    source.append(el("p", "本体数据来源", "ds-eyebrow"));
    if (data.foundation) {
      const f = data.foundation;
      source.append(el("h2", f.enterprise), el("span", "已采用", "ds-badge"));
      const stats = el("div", "", "ds-source-stats");
      for (const [value, label] of [[f.concepts.length, "个概念"], [f.relations.length, "条关系"]]) { const s = el("div"); s.append(el("strong", String(value)), el("span", label)); stats.append(s); }
      source.append(stats, el("p", data.model ? "已连接业务映射，可按字段开放真实记录。" : "当前可开放本体知识。连接业务映射后，还可开放真实业务记录。", "ds-muted"));
      source.append(action("查看本体 ↗", ontology));
    } else {
      source.append(el("h2", data.current ? "本体等待确认" : "先整理企业本体"), el("p", data.current ? `当前为 v${data.current.version} 候选。到本体工作区核对并采用后，即可选择内容开放。` : "在本体工作区整理企业概念与关系，采用后即可在这里开放给 Agent。", "ds-description"), action("前往本体工作区 ↗", ontology, true));
    }
    source.append(el("div", "本体定义固定版本\n业务数据按需读取\n随时停用访问", "ds-source-notes"));
    const head = el("header", "", "ds-list-head"), heading = el("div"); heading.append(el("h2", "我的 MCP 数据集"), el("p", `${data.datasets.filter(d => d.status === "active").length} 份已启用 · ${data.datasets.length} 份数据集`, "ds-muted"));
    const add = action("＋ 创建数据集", create, true); add.disabled = !data.foundation || !api; head.append(heading, add); datasets.append(head);
    if (!data.datasets.length) {
      const empty = el("div", "", "ds-empty ds-panel"); empty.append(el("span", "MCP", "ds-empty-mark"), el("h3", "让整理好的本体开始被使用"), el("p", "为不同 Agent 选择不同范围，生成各自的接入配置。", "ds-muted"));
      if (!api) empty.append(el("p", "离线预览不开放真实 MCP 连接。", "ds-muted"));
      datasets.append(empty);
    }
    for (const dataset of data.datasets) {
      const card = el("article", "", "ds-dataset ds-panel"), top = el("header");
      top.append(el("h3", dataset.title), el("span", dataset.status === "active" ? "已启用" : "已停用", `ds-badge ${dataset.status === "active" ? "" : "ds-inactive"}`)); card.append(top);
      card.append(el("p", `${dataset.content.concepts.length} 个概念 · ${dataset.content.relations.length} 条关系 · ${(dataset.content.business?.grants || []).length} 类业务对象`, "ds-dataset-scope"));
      const names = el("div", "", "ds-tags"); for (const c of dataset.content.concepts.slice(0, 5)) names.append(el("span", c.name)); if (dataset.content.concepts.length > 5) names.append(el("span", `+${dataset.content.concepts.length - 5}`)); card.append(names);
      card.append(el("p", `${dataset.access ? `最近读取 ${when(dataset.access.lastReadAt)} · ${dataset.access.count} 次（含连接测试）` : "尚无读取记录"}`, "ds-muted"));
      const actions = el("div", "", "ds-actions"); actions.append(action("查看范围", () => scope(dataset)));
      if (dataset.status === "active") actions.append(action("接入配置 ↗", () => void connection(dataset), true), action("停用", () => revoke(dataset)));
      card.append(actions); datasets.append(card);
    }
    workspace.append(source, datasets); root.append(workspace);
    const footer = el("footer", "", "ds-footer"); footer.append(el("span", "本机 MCP · 浏览器关闭后，DataEngine 服务需继续运行"), action("刷新状态", () => void load()));
    const owned = new Set(data.datasets.map(d => d.content.business?.viewRef.id));
    if (legacy && (state.consumers?.length || state.live?.consumers?.length || state.live?.views?.some(v => !owned.has(v.id)))) footer.append(action("管理已有访问范围", legacy));
    root.append(footer);
  }
  async function load() {
    const request = ++generation;
    try {
      const next = api ? await api("/api/datasets") : { foundation: null, current: null, datasets: [], model: null };
      if (disposed || request !== generation) return;
      data = next; render();
    } catch (e) {
      if (disposed || request !== generation) return;
      root.replaceChildren(el("h1", "MCP 数据集"), el("p", e.message, "ds-notice"), action("重试", () => void load()));
    }
  }
  render(); void load(); return root;
}

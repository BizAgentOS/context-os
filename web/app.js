"use strict";
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const titles = {
  home: "实验室首页",
  company: "企业空间",
  modeling: "建模流程",
  concepts: "概念与关系",
  objects: "对象与证据",
  agent: "Agent 工作台",
};
const sourceNames = {
  "company-brief.md": "公司与服务范围",
  "service-rules.md": "客服处理与统计规则",
  "source-guide.md": "数据来源导航",
  "stations.csv": "换热站台账",
  "buildings.csv": "楼栋台账",
  "equipment.csv": "设备台账",
  "tickets.csv": "投诉记录",
  "callbacks.csv": "回访记录",
  "room-measurements.csv": "入户测温",
  "work-orders.csv": "维修工单",
  "station-hourly.csv": "站点小时监测",
  "weather-daily.csv": "每日气象",
  "address-book-note.md": "客服地址说明",
  "handover-note.md": "监测交接说明",
  "weekly-review-draft.md": "周复盘草稿",
  "shift-log-20260110.md": "1 月 10 日值班日志",
  "shift-log-20260114.md": "1 月 14 日值班日志",
  "channel-register.csv": "监测通道登记",
};
const label = (path) =>
  sourceNames[path.split("/").pop()] || path.split("/").pop();
let state,
  page = "home",
  step = "scope",
  type = "Ticket",
  source = "sources/company/company-brief.md";
let objectType = "Ticket",
  query = "",
  objectOffset = 0,
  sourceOffset = 0,
  generation = 0,
  selectedObject = "";
let messages = [],
  chatBusy = false,
  toastTimer,
  dialogReturnFocus;
let detailGeneration = 0;
async function api(path, body) {
  const response = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Lab-Token": state.session_token,
          },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "暂时无法读取，请重试。");
  return result;
}
function badge(text, cls = "") {
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}
function heading(kicker, title, desc, status = "") {
  return `<div class="page-heading"><div><span class="eyebrow">${kicker}</span><h1>${title}</h1><p>${desc}</p></div>${status}</div>`;
}
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 3000);
}
function evidence(items) {
  return items
    .map((e) => {
      const available = state.sources.some((s) => s.path === e.path);
      const sourceLink = available
        ? `<button class="text-button" data-source="${esc(e.path)}">${esc(e.path)} ↗</button>`
        : `<small>${esc(e.path)}<br>历史试样依据：当前快照未包含此来源。请按项目说明生成 Jan19 完整快照后重启。</small>`;
      return `<div class="evidence"><small>来源依据</small><blockquote>${esc(e.quote || e.record_id)}</blockquote>${sourceLink}</div>`;
    })
    .join("");
}
function kv(obj) {
  return `<dl class="kv">${Object.entries(obj)
    .map(
      ([k, v]) =>
        `<dt>${esc(k)}</dt><dd>${esc(v === null ? "缺失 / 未知" : v)}</dd>`,
    )
    .join("")}</dl>`;
}
function table(columns, rows) {
  return `<div class="table-wrap"><table><thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td title="${esc(r[c])}">${esc(r[c] === "" ? "—" : r[c])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function stats() {
  const c = state.company;
  return `<div class="stats">${[
    [c.stations, "座换热站"],
    [c.communities, "个小区"],
    [c.buildings, "栋楼"],
    [c.households.toLocaleString(), "户合同住户"],
  ]
    .map(
      ([n, l]) =>
        `<div class="stat"><strong>${n}</strong><small>${l}</small></div>`,
    )
    .join("")}</div>`;
}
function home() {
  return (
    heading(
      "A SMALL EXPERIMENT, A CLEAR QUESTION",
      "让企业数据，成为可理解的业务世界。",
      "以澄川热力为样本，观察从原始资料到本体，再到 Agent 维护的每一步。",
      badge("实验进行中"),
    ) +
    `<section class="hero"><div class="hero-copy"><span class="eyebrow">EXPERIMENT 001 / 澄川热力</span><h1>从一条投诉，<br>看见数据之间的联系。</h1><p>数据已经存在于台账、监测、客服和维修记录中。<br>我们想验证：明确对象、关系和业务口径，是否能让 Agent 更可靠地理解和使用它们。</p><div class="actions"><a class="primary" href="#modeling">进入建模流程 <span>↗</span></a><a class="secondary" href="#company">认识这家企业</a></div></div><div class="hero-visual" aria-label="原始资料经过本体组织，供 Agent 按需访问的设计示意"><div class="visual-grid"><div class="visual-stack"><div class="visual-node">台账 · 设施身份</div><div class="visual-node">监测 · 时间与读数</div><div class="visual-node">客服 · 维修记录</div></div><span class="visual-arrow">→</span><div class="visual-core"><b>◇</b>企业本体<small>对象 · 关系 · 口径</small></div><span class="visual-arrow">→</span><div class="visual-stack"><div class="visual-node">Agent 按需查证</div><div class="visual-node">有来源的回答</div><div class="visual-node">持续修订语义</div></div></div><div class="visual-caption">实验目标示意 · 完整链路仍在建设</div></div></section>
  <div class="section-heading"><h2>这次实验，验证什么</h2><p>先验证一条链路，再判断方法收益</p></div><div class="three-col">${[
    [
      "01",
      "能否建立有依据的模型",
      "把分散记录组织为有业务含义的对象与关系，解释每个定义为什么需要、从哪里来。",
    ],
    [
      "02",
      "能否支持新的问题组合",
      "与有组织的原始资料、专用表公平对照，观察复用是否减少临时拼接和口径误判。",
    ],
    [
      "03",
      "能否随着业务变化维护",
      "在来源或业务定义变化后，让 Agent 提出可检查的修订，再验证结果与维护成本。",
    ],
  ]
    .map(
      ([n, t, d]) =>
        `<article class="panel"><span class="question-number">${n}</span><h3>${t}</h3><p>${d}</p></article>`,
    )
    .join("")}</div>
  <div class="two-col"><section><div class="section-heading"><h2>实验进程</h2><span class="muted">01 → 05</span></div><div class="panel step-list">${[
    [
      "01",
      "构建虚构企业数据",
      "企业、小样、历史回放与原始基线",
      "已完成",
      "company",
      "",
    ],
    [
      "02",
      "设计本体建模方法",
      "业务任务 → 概念 → 映射 → 验证",
      "设计中",
      "modeling",
      "amber",
    ],
    [
      "03",
      "构建维护 Agent",
      "KodaX Runtime + NOOA 思路",
      "待接入",
      "agent",
      "gray",
    ],
    [
      "04",
      "验证语义演变",
      "有依据的修改、确认与版本回归",
      "待开始",
      "agent",
      "gray",
    ],
    [
      "05",
      "对照方法与成本",
      "质量、证据、Token 和人工投入",
      "待开始",
      "home",
      "gray",
    ],
  ]
    .map(
      ([n, t, d, s, p, c]) =>
        `<a class="journey-row" href="#${p}"><span class="step-number">${n}</span><div><h3>${t}</h3><p>${d}</p></div>${badge(s, c)}</a>`,
    )
    .join(
      "",
    )}</div></section><section><div class="section-heading"><h2>当前实验样本</h2><a class="text-button" href="#company">查看企业 ↗</a></div><div class="panel"><span class="eyebrow">A FICTIONAL HEATING COMPANY</span><h2>澄川热力有限公司</h2><p>负责澄川市北城区的区域供热服务。围绕站点运行、投诉处理、维修与回访开展实验。</p>${stats()}<div class="callout">当前重点：把建模过程展开。已有对象保留为技术试样，业务定义尚未定稿。</div><button class="text-button" data-document="baseline">查看原始资料基线的真实结果 ↗</button></div></section></div>`
  );
}
async function company() {
  const view = await api(
    `/api/source?path=${encodeURIComponent(source)}&offset=${sourceOffset}`,
  );
  const typeMatch = state.ontology.types.find((t) => t.source === source);
  return (
    heading(
      "COMPANY / SOURCES",
      "认识澄川热力",
      "一个足够小、也保留真实业务复杂度的虚构企业。先看清资料，再讨论如何组织。",
      badge("来源已准备"),
    ) +
    `<div class="two-col"><div class="panel"><span class="eyebrow">COMPANY PROFILE</span><h2>${state.company.name}</h2><p>一个外购热源入口，两个换热站。运行调度、设备维修和客户服务各自记录业务，服务同一批小区与楼栋。</p>${stats()}</div><div class="panel"><span class="eyebrow">SERVICE NETWORK</span><h3>从热源到居民，跨越多个业务环节</h3><div class="mini-topology"><span class="node-tag">外购热源 R01</span><span>→</span><div class="station">清河站 Z01<small>柳岸 · 松园</small></div><div class="station">育新站 Z02<small>文苑 · 新桥</small></div></div><p>合同供热面积 12 万平方米；站内读数与住户体验需要各自的证据。</p></div></div>
  <div class="section-heading"><div><h2>接入资料</h2><p>${state.sources.length} 份可见来源 · 当前使用本地快照</p></div>${badge("真实系统连接器待建设", "gray")}</div><div class="split-view"><div class="source-list" aria-label="企业来源">${state.sources.map((s) => `<button data-source-select="${esc(s.path)}" class="${s.path === source ? "selected" : ""}">${esc(label(s.path))}<small>${s.format === "csv" ? `${s.rows} 条记录 · CSV` : "业务文档 · Markdown"}</small></button>`).join("")}</div><div class="source-content"><div class="source-head"><div><h3>${esc(label(source))}</h3><small>${esc(source)}</small></div>${typeMatch ? `<button class="secondary small" data-concept="${esc(typeMatch.id)}">关联概念试样 ↗</button>` : badge("原始业务资料", "gray")}</div>${view.text !== undefined ? `<pre class="document">${esc(view.text)}</pre>` : table(view.columns, view.rows) + pagination(view.total, view.offset, "source")}<div class="callout">原始来源保留自己的字段与业务表达。可以打开右下角助手，针对当前资料提问。</div></div></div>`
  );
}
function pagination(total, offset, target) {
  return `<div class="pagination"><span>共 ${total} 条${total ? ` · 当前 ${offset + 1}–${Math.min(offset + 20, total)}` : ""}</span><button class="secondary small" data-paging="${target}" data-offset="${Math.max(0, offset - 20)}" ${offset === 0 ? "disabled" : ""}>上一页</button><button class="secondary small" data-paging="${target}" data-offset="${offset + 20}" ${offset + 20 >= total ? "disabled" : ""}>下一页</button></div>`;
}
function modeling() {
  const s = state.steps.find((s) => s.id === step);
  return (
    heading(
      "ONTOLOGY / MODELING PROCESS",
      "沿业务问题，逐步设计企业本体。",
      "逐步查看每个阶段要研究的问题、需要的资料和应留下的产物。当前是流程设计草案。",
      badge("尚未完整执行", "amber"),
    ) +
    `<div class="workflow"><div class="workflow-nav">${state.steps.map((s, i) => `<button class="${s.id === step ? "selected" : ""}" data-step="${s.id}"><span class="step-number">0${i + 1}</span><span><b>${s.name}</b><small>${s.status}</small></span></button>`).join("")}</div><section class="panel workflow-detail"><span class="eyebrow">STEP 0${state.steps.indexOf(s) + 1} / ${s.name}</span><h2>${s.question}</h2>${badge(s.status, s.id === "scope" ? "amber" : "gray")}<dl class="definition"><dt>输入 · 从哪里开始</dt><dd>${s.input}</dd><dt>产物 · 这一步要留下什么</dt><dd>${s.output}</dd><dt>检查 · 进入下一步的依据</dt><dd>${s.decision}</dd></dl><div class="callout">热力案例的关注点：${s.focus}</div><button class="text-button" data-source="${s.source}">查看相关资料 · ${esc(label(s.source))} ↗</button><label for="step-note" class="note-label">本步骤的想法与讨论</label><textarea id="step-note" class="note-input" maxlength="5000" placeholder="记录你对业务范围、概念边界或下一步的想法…">${esc(state.notes[s.id] || "")}</textarea><div class="note-footer"><small>笔记保存在本机；保存笔记不会执行步骤或确认本体。</small><button class="primary small" id="save-note">保存笔记</button></div></section></div><div class="section-heading"><p>来源导入技术试样已存在，业务建模仍从范围与任务开始。</p><button class="text-button" data-document="modeling">阅读完整流程设计 ↗</button></div>`
  );
}
function concepts() {
  const ontology = state.ontology,
    t = ontology.types.find((t) => t.id === type) || ontology.types[0];
  const related = ontology.relations.filter(
      (r) => r.from_type === t.id || r.to_type === t.id,
    ),
    name = (id) => ontology.types.find((t) => t.id === id)?.name || id;
  return (
    heading(
      "ONTOLOGY / CONCEPTS & RELATIONS",
      "先看概念，再追问它为什么存在。",
      "这里呈现之前来源抽取的技术试样，用于讨论与追溯；后续按建模流程修订定义。",
      badge("技术试样 · 非正式本体", "amber"),
    ) +
    `<div class="callout warn">此前的 9 类对象并不代表已经完成业务建模。概念粒度、身份、生命周期与任务用途仍需要研究；当前没有正式 v1。</div><div class="type-tabs">${ontology.types.map((t) => `<button class="${t.id === type ? "selected" : ""}" data-concept-select="${t.id}">${esc(t.name)}<small>${ontology.counts[t.id] ?? "—"}</small></button>`).join("")}</div><div class="concept-layout"><section class="panel"><div class="concept-title"><div><h2>${esc(t.name)}</h2><small>${t.id}</small></div>${badge("候选定义", "gray")}</div><dl class="definition"><dt>定义 · 当前技术试样</dt><dd>${esc(t.description)}</dd><dt>实例身份 · 当前导入规则</dt><dd>${esc(t.id)} : ${esc(t.key)}</dd><dt>仍需补齐的建模说明</dt><dd>包含与排除的范围、生命周期、任务用途，以及与其他概念的边界备选。</dd></dl><button class="secondary small" data-show-objects="${t.id}">查看 ${ontology.counts[t.id] ?? 0} 个试样对象 ↗</button>${evidence(t.evidence)}</section><section class="panel"><span class="eyebrow">RELATION NEIGHBORHOOD</span><h2>与「${esc(t.name)}」相关的关系</h2><p>这里的连线表示候选规则，具体实例是否成立仍需核对证据。</p><div class="relation-list">${related.length ? related.map((r) => `<div class="relation-item"><button class="node-tag" data-concept-select="${r.from_type}">${esc(name(r.from_type))}</button><span>${esc(r.name)}<br>────→</span><button class="node-tag" data-concept-select="${r.to_type}">${esc(name(r.to_type))}</button><button class="text-button" data-relation="${r.id}">依据</button></div>`).join("") : '<div class="empty">该类型当前没有关系定义。</div>'}</div></section></div>
  <div class="section-heading"><h2>业务口径与边界</h2><span class="muted">定义试样 · 计算函数待接入</span></div><div class="two-col">${ontology.metrics.map((m) => `<section class="panel"><span class="eyebrow">METRIC DEFINITION</span><h3>${esc(m.name)}</h3><p>${esc(m.definition)}</p><div class="callout">统计集合：${esc(m.population)}<br>无样本时：${esc(m.empty_result)}</div><button class="text-button" data-metric="${m.id}">查看口径依据 ↗</button></section>`).join("")}</div>`
  );
}
async function objects() {
  const result = await api(
    `/api/objects?type=${encodeURIComponent(objectType)}&q=${encodeURIComponent(query)}&offset=${objectOffset}`,
  );
  const o = state.ontology;
  return (
    heading(
      "ONTOLOGY / OBJECT EXPLORER",
      "每一个对象，都可以回到原始记录。",
      "从一个具体对象开始，查看属性、关系、时间版本和来源证据。",
      badge("对象试样", "amber"),
    ) +
    `<div class="panel"><div class="source-head"><div><h2>对象浏览器</h2><p>${o.object_count} 个实例 · ${o.relation_count} 条关系 · ${o.unmatched_count} 项未匹配引用</p></div><button class="secondary small" data-object="Ticket:CS-009" ${!o.available ? "disabled" : ""}>示例：投诉 CS-009 ↗</button></div>${!o.available ? '<div class="callout warn">当前没有与来源快照匹配的对象包。请先按项目说明生成技术试样，再重启本地服务。</div>' : ""}<form id="object-search" class="filters"><label class="sr-only" for="object-type">对象类型</label><select id="object-type"><option value="">全部类型</option>${o.types.map((t) => `<option value="${t.id}" ${t.id === objectType ? "selected" : ""}>${esc(t.name)} (${o.counts[t.id] ?? 0})</option>`).join("")}</select><label class="sr-only" for="object-query">搜索对象</label><input id="object-query" maxlength="200" placeholder="搜索编号、地址或属性，例如 CS-009" value="${esc(query)}"><button class="primary small">查找对象</button></form>${result.items.length ? `<div class="table-wrap"><table><thead><tr><th>对象引用</th><th>类型</th><th>原始主键</th><th>来源</th><th></th></tr></thead><tbody>${result.items.map((item) => `<tr><td><button class="object-link" data-object="${esc(item.id)}">${esc(item.id)}</button></td><td>${esc(o.types.find((t) => t.id === item.type)?.name)}</td><td>${esc(item.source.record_id)}</td><td>${esc(label(item.source.path))}</td><td><button class="text-button" data-object="${esc(item.id)}">查看证据 ↗</button></td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">没有找到匹配的对象，可以调整类型或关键词。</div>'}${pagination(result.total, result.offset, "objects")}<div class="callout">关系未匹配并不自动代表错误。比如尚无回访或测温记录，应保留未知，不能补造结论。</div></div>`
  );
}
function agent() {
  return (
    heading(
      "AGENT / RUNTIME & OBJECT TOOLS",
      "让 Agent 按需查证，再提出修订。",
      "目标是把执行过程、使用的对象和修改依据放在同一处查看。以下是当前设计与接入状态。",
      badge("KodaX 尚未接入", "gray"),
    ) +
    `<section class="panel"><span class="eyebrow">TARGET ARCHITECTURE</span><h2>KodaX Runtime + NOOA 的对象访问思路</h2><div class="architecture"><div class="architecture-block"><span class="eyebrow">01 / INVESTIGATE</span><h3>业务问题与变化</h3><p>一个明确任务<br>当前资料时点与对象引用</p></div><span class="visual-arrow">→</span><div class="architecture-block core"><span class="eyebrow">02 / REASON & ACT</span><h3>KodaX Runtime</h3><p>模型推理、工具调用与会话<br>真实接入将在后续阶段完成</p></div><span class="visual-arrow">→</span><div class="architecture-block"><span class="eyebrow">03 / INSPECT OBJECTS</span><h3>类型化对象工具</h3><p>稳定引用、按需读属性与关系<br>确定性计算与来源追溯</p></div></div><div class="callout">预期输出：调查结论 → 带证据的修改候选 → 程序检查与人工确认 → 新版本和任务回归。当前还没有维护运行记录。</div></section>
  <div class="section-heading"><h2>当前接入状态</h2><span class="muted">以实际可运行能力为准</span></div><div class="two-col"><section class="panel"><h3>数据与工具</h3>${[
    ["原始来源读取 / 搜索 / SQL", "命令行可用", ""],
    [
      "对象读取 / 关系 / 原始证据",
      state.ontology.available ? "技术试样可用" : "未生成匹配对象包",
      state.ontology.available ? "amber" : "gray",
    ],
    ["确定性业务函数与 MCP", "待建设", "gray"],
    ["受限代码组合执行", "待建设", "gray"],
  ]
    .map(
      ([t, s, c]) =>
        `<div class="capability-row"><span>${t}</span>${badge(s, c)}</div>`,
    )
    .join("")}</section><section class="panel"><h3>Agent 与演变</h3>${[
    ["KodaX Runtime 实际集成", "未接入", "gray"],
    ["候选修订 / 检查 / 应用", "待建设", "gray"],
    [
      "浮窗问答助手",
      state.agent.model_configured ? "凭据已配置" : "未配置凭据",
      state.agent.model_configured ? "" : "gray",
    ],
    ["维护前后对照结果", "待运行", "gray"],
  ]
    .map(
      ([t, s, c]) =>
        `<div class="capability-row"><span>${t}</span>${badge(s, c)}</div>`,
    )
    .join(
      "",
    )}</section></div><div class="callout">右下角「实验室助手」可解释当前页面与选中资料，通过独立模型请求回答；它尚不具备维护 Agent 的工具或修改权限。</div><button class="text-button" data-document="baseline">已有运行：查看原始资料基线结果 ↗</button>`
  );
}
async function render() {
  const current = ++generation;
  page = location.hash.slice(1) in titles ? location.hash.slice(1) : "home";
  $("#breadcrumb").textContent = titles[page];
  document.title = `${titles[page]} · Context OS`;
  document.querySelectorAll("nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.page === page);
    if (a.dataset.page === page) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  $("#sidebar").classList.remove("open");
  updateChatContext();
  try {
    const html = await { home, company, modeling, concepts, objects, agent }[
      page
    ]();
    if (current !== generation) return;
    $("#main").innerHTML = html;
  } catch (error) {
    if (current === generation)
      $("#main").innerHTML =
        `<div class="error">${esc(error.message)} <button class="secondary small" id="retry-page">重新加载</button></div>`;
  }
}
function navigate(target) {
  if (location.hash === `#${target}`) render();
  else location.hash = target;
}
function updateChatContext() {
  $("#chat-context").textContent =
    `上下文：${titles[page]}${page === "company" ? ` / ${label(source)}` : ""}${page === "modeling" ? ` / ${state.steps.find((s) => s.id === step).name}` : ""}${page === "concepts" ? ` / ${type}` : ""}${selectedObject ? ` / ${selectedObject}` : ""}`;
}
function openDialog(title, html) {
  detailGeneration++;
  const dialog = $("#detail-dialog");
  $("#detail-title").textContent = title;
  $("#detail-body").innerHTML = html;
  if (!dialog.open) {
    dialogReturnFocus = document.activeElement;
    dialog.showModal();
  }
}
async function showObject(id) {
  const request = ++detailGeneration,
    view = generation;
  const object = await api(`/api/object?id=${encodeURIComponent(id)}`);
  if (request !== detailGeneration || view !== generation) return;
  selectedObject = id;
  updateChatContext();
  const link = (e) =>
    `<div class="relation-item"><button class="object-link" data-object="${esc(e.from)}">${esc(e.from)}</button><span>${esc(state.ontology.relations.find((r) => r.id === e.relation)?.name || e.relation)} →</span><button class="object-link" data-object="${esc(e.to)}">${esc(e.to)}</button></div>`;
  openDialog(
    id,
    `${badge("技术试样 · 非正式本体", "amber")} <button class="secondary small" data-ask-object="${esc(id)}">让助手解释这个对象 ✳</button><p class="muted">数据时点 ${esc(object.as_of)}<br>本体 ${esc(object.ontology_version)} / Mapping ${esc(object.mapping_version)}</p><div class="section-heading"><h3>对象属性</h3></div>${kv(object.object.attributes)}<div class="section-heading"><h3>关联对象</h3><small>共 ${object.incoming.length + object.outgoing.length} 条 · 最多显示 40 条</small></div>${object.incoming.concat(object.outgoing).slice(0, 40).map(link).join("") || "<p>暂无已匹配的关系。</p>"}<div class="section-heading"><h3>原始证据</h3></div>${object.evidence.rows.map((r) => `${evidence([r.reference])}${kv(r.record)}`).join("")}<small>源文件校验：${esc(object.object.source.source_sha256)}</small>`,
  );
}
function closeDialog() {
  detailGeneration++;
  $("#detail-dialog").close();
  selectedObject = "";
  updateChatContext();
  dialogReturnFocus?.focus();
}
async function sendChat(text) {
  if (chatBusy || !text.trim()) return;
  chatBusy = true;
  $("#chat-send").disabled = true;
  $("#chat-status").textContent = "正在读取当前上下文并生成回复…";
  const add = (role, content) => {
    const el = document.createElement("div");
    el.className = `message ${role}`;
    el.textContent = content;
    $("#chat-messages").append(el);
    el.scrollIntoView({ block: "nearest" });
    return el;
  };
  add("user", text);
  $("#chat-input").value = "";
  const pending = add("assistant", "正在思考…");
  try {
    const next = messages.concat({ role: "user", content: text }).slice(-11);
    const result = await api("/api/chat", {
      page,
      messages: next,
      source: page === "company" ? source : undefined,
      object: selectedObject || undefined,
      step: page === "modeling" ? step : undefined,
      concept: page === "concepts" ? type : undefined,
    });
    pending.textContent = result.reply;
    messages = next.concat({ role: "assistant", content: result.reply });
    $("#chat-status").textContent =
      `${result.model}${result.usage?.total_tokens ? ` · 本次 ${result.usage.total_tokens} Token` : ""}`;
  } catch (error) {
    pending.textContent = `${error.message} 你的问题已放回输入框，可重新发送。`;
    $("#chat-input").value = text;
    $("#chat-status").textContent = "本次未获得回复";
  } finally {
    chatBusy = false;
    $("#chat-send").disabled = false;
    pending.scrollIntoView({ block: "nearest" });
  }
}
function toggleChat(open) {
  $("#chat-panel").hidden = !open;
  $("#chat-launcher").setAttribute("aria-expanded", String(open));
  if (open) $("#chat-input").focus();
  else $("#chat-launcher").focus();
}
document.addEventListener("click", async (event) => {
  const el = event.target.closest("button");
  if (!el || el.disabled) return;
  try {
    if (el.dataset.source) {
      source = el.dataset.source;
      sourceOffset = 0;
      if ($("#detail-dialog").open) closeDialog();
      navigate("company");
    }
    if (el.dataset.sourceSelect) {
      source = el.dataset.sourceSelect;
      sourceOffset = 0;
      render();
    }
    if (el.dataset.step) {
      step = el.dataset.step;
      render();
    }
    if (el.dataset.concept) {
      type = el.dataset.concept;
      navigate("concepts");
    }
    if (el.dataset.conceptSelect) {
      type = el.dataset.conceptSelect;
      render();
    }
    if (el.dataset.showObjects) {
      objectType = el.dataset.showObjects;
      query = "";
      objectOffset = 0;
      navigate("objects");
    }
    if (el.dataset.paging) {
      if (el.dataset.paging === "source")
        sourceOffset = Number(el.dataset.offset);
      else objectOffset = Number(el.dataset.offset);
      render();
    }
    if (el.dataset.object) await showObject(el.dataset.object);
    if (el.dataset.askObject) {
      detailGeneration++;
      $("#detail-dialog").close();
      selectedObject = el.dataset.askObject;
      updateChatContext();
      toggleChat(true);
      $("#chat-input").value = "请解释这个对象的含义、关联关系和证据边界。";
    }
    if (el.dataset.relation) {
      const r = state.ontology.relations.find(
        (r) => r.id === el.dataset.relation,
      );
      openDialog(
        r.name,
        `<p>${esc(r.description)}</p>${kv({ from: r.from_type, to: r.to_type, kind: r.kind, from_field: r.from_field, to_field: r.to_field || "字面地址解析" })}${evidence(r.evidence)}`,
      );
    }
    if (el.dataset.metric) {
      const m = state.ontology.metrics.find((m) => m.id === el.dataset.metric);
      openDialog(
        m.name,
        `<p>${esc(m.definition)}</p>${kv({ 统计集合: m.population, 分子: m.numerator, 分母: m.denominator, 空集合: m.empty_result })}${evidence(m.evidence)}`,
      );
    }
    if (el.dataset.document) {
      const request = ++detailGeneration,
        view = generation;
      const doc = await api(`/api/document?id=${el.dataset.document}`);
      if (request !== detailGeneration || view !== generation) return;
      openDialog(
        {
          modeling: "本体建模流程设计",
          baseline: "原始资料基线结果",
          trial: "本体技术试样",
        }[el.dataset.document],
        `<pre class="document">${esc(doc.text)}</pre>`,
      );
    }
    if (el.id === "save-note") {
      const savedStep = step,
        text = $("#step-note").value;
      el.disabled = true;
      await api("/api/notes", { step: savedStep, text });
      state.notes[savedStep] = text;
      toast("笔记已保存到本机");
      el.disabled = false;
    }
    if (el.id === "retry-page") render();
    if (el.id === "menu-toggle") $("#sidebar").classList.toggle("open");
    if (el.id === "detail-close") closeDialog();
    if (el.id === "chat-launcher") toggleChat($("#chat-panel").hidden);
    if (el.id === "chat-close") toggleChat(false);
    if (el.dataset.prompt) await sendChat(el.dataset.prompt);
  } catch (error) {
    toast(error.message);
    el.disabled = false;
  }
});
document.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.target.id === "object-search") {
    objectType = $("#object-type").value;
    query = $("#object-query").value;
    objectOffset = 0;
    render();
  }
  if (event.target.id === "chat-form") sendChat($("#chat-input").value);
});
$("#detail-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog();
});
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    !$("#detail-dialog").open &&
    !$("#chat-panel").hidden
  )
    toggleChat(false);
});
window.addEventListener("hashchange", () => {
  detailGeneration++;
  selectedObject = "";
  render();
  window.scrollTo(0, 0);
});
api("/api/state")
  .then((data) => {
    state = data;
    $("#snapshot-label").textContent = `资料时点 ${data.as_of.slice(0, 10)}`;
    render();
  })
  .catch((error) => {
    $("#main").innerHTML =
      `<div class="error">${esc(error.message)}，请刷新页面。</div>`;
    $("#chat-launcher").disabled = true;
  });

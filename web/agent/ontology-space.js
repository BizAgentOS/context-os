import { safeText, technicalDetails, developerView } from "./ui-display.js";
import { buildOntologyGraph, createOntologyNavigation } from "./ontology-space-model.js";
import { createOntologyScene } from "./ontology-scene.js";

const el = (tag, cls = "", text = "") => {
  const node = document.createElement(tag); node.className = cls; node.textContent = safeText(text); return node;
};
// Reuse the application's existing icon set.
const icon = name => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon"); svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(svg.namespaceURI, "use"); use.setAttribute("href", `#i-${name}`); svg.append(use); return svg;
};
const button = (label, action, symbol, cls = "os-button") => {
  const node = el("button", cls); node.type = "button"; node.title = safeText(label); node.setAttribute("aria-label", safeText(label));
  if (symbol) node.append(icon(symbol)); else node.textContent = label;
  node.onclick = action; return node;
};
const kindLabel = kind => ({web: "公开网页", document: "企业资料", api: "API 样本", user: "用户陈述"}[kind] || "定义依据");
const mappingLabel = item => item.mappingStatus === "bound" ? "已映射" : "未映射";
// Program (Helix) discovery vocabulary, as shown for each built entity.
const linkEvidence = kind => ({declared: "来源声明的外键", name: "字段名与值匹配", values: "值重合"}[kind] || "值重合");
const noteKind = kind => ({merged: "已合并", unmatched: "未匹配", case: "仅忽略大小写匹配", unlinked: "未关联"}[kind] || "需核对");
const severity = level => ({error: "需处理", warning: "需核对", info: "说明"}[level] || "需核对");
const memberLine = m => m.anchor ? `主来源 · ${m.rows} 条` : m.via ? `${m.matched}/${m.rows} 条匹配 · 按 ${m.via.column} = ${m.via.targetDataset}.${m.via.targetColumn}` : `${m.matched}/${m.rows} 条匹配`;
const linkLine = l => `${l.name} · ${l.matchedRows}/${l.totalRows} 条匹配 · ${linkEvidence(l.evidence)}${l.caseInsensitive ? " · 忽略大小写" : ""}${l.executable ? "" : " · 待核对"}`;
const review = helix => [...helix.notes.map(n => ({label: n.text, sub: noteKind(n.kind)})), ...helix.issues.map(i => ({label: i.message, sub: severity(i.severity)}))];

export function renderOntologySpace(value, {selections, read, select, management, objects, evidence, onLayout, onSelection, automaticBuild, automaticApiBuild, connectModel, retryBuild, engine, programBuild, sourceSummary}) {
  const root = el("section", "ontology-space"); root.setAttribute("aria-label", "三维本体空间");
  const versions = [value?.current, value?.adopted].filter((item, i, all) => item && all.findIndex(other => other?.version === item.version) === i);
  const saved = selections.get("ontology-space");
  let artifact = versions.find(item => item.id === saved?.id && item.version === saved?.version) || versions[0];
  let graph = buildOntologyGraph(artifact);
  let nav = createOntologyNavigation(graph, saved?.id === artifact?.id && saved?.version === artifact?.version ? saved?.view : null);
  let scene = null, disposed = false, generation = 0, fanFrame = 0, motion = true, activeGroup = "links", highlight = null;
  const content = el("div", "os-scene-host");
  const top = el("header", "os-header");
  const identity = el("div", "os-identity");
  const eyebrow = el("p", "os-eyebrow", "本体");
  const title = el("h1", "", artifact?.content.enterprise?.name || "企业本体");
  const version = el("select", "os-version"); version.setAttribute("aria-label", "本体内容");
  for (const item of versions) {const option = el("option", "", `${developerView() ? `v${item.version} · ` : ""}${item.status === "adopted" ? "已采用" : "候选待核对"}`); option.value = item.version; version.append(option);}
  version.value = artifact?.version || ""; version.hidden = !artifact;
  identity.append(eyebrow, title, version);
  if (!artifact?.content.helix) identity.append(el("p", "os-muted", `${sourceSummary?.total ?? 0} 个已接入来源`));
  const progressHost = el("div"); identity.append(progressHost);
  function updateProgress(automaticBuild, automaticApiBuild) {
  progressHost.replaceChildren();
  for (const [build, isApi] of [[automaticBuild, false], [automaticApiBuild, true]]) {
    if (!build || build.status === "idle") continue;
    const progress = el("div", "os-build-status"); progress.setAttribute("role", "status");
    // Data builds the structure; documents only refine the concepts it built.
    const labels = {running: "正在用资料补充本体说明…", queued: "资料已排队，用于补充本体说明", waiting_model: "资料已保存，连接模型后补充说明", waiting_data: "资料已保存，接入结构化数据后用于补充说明", completed: "资料已补充到本体说明与依据", failed: "部分资料补充失败"};
    const apiLabels = {running: "正在按数据构建本体…", queued: "数据已加入程序构建队列", waiting_model: "数据已连接，等待构建", completed: "已按数据构建本体并可查询", failed: "部分数据构建未完成"};
    progress.append(el("span", "", `${(isApi ? apiLabels : labels)[build.status]} · ${build.completed}/${build.total} ${isApi ? "个数据来源" : "份资料"}`));
    if (build.status === "waiting_model") progress.append(button("连接模型", connectModel));
    if (build.errors?.length) {
      const errors = el("details"); errors.append(el("summary", "", `查看 ${build.errors.length} 项原因`));
      for (const item of build.errors) errors.append(el("p", "", `${item.title}：${item.message}`));
      progress.append(errors);
    }
    if (build.status === "failed") progress.append(button("重试构建", retryBuild));
    progressHost.append(progress);
  }
  }
  updateProgress(automaticBuild, automaticApiBuild);
  const helixSummary = artifact?.content.helix;
  if (helixSummary) {
    const {stats, notes, unplaced} = helixSummary;
    const line = el("div", "os-helix-summary");
    line.append(el("span", "", `${stats.tables} 张表 · ${sourceSummary?.total ?? stats.sources} 个已接入来源；程序发现 ${stats.entities} 个实体 · ${stats.links} 条关联`));
    const worth = notes.filter(n => n.kind !== "merged");
    if (notes.length || unplaced.length) {
      const dialog = el("dialog", "live-dialog os-management"); dialog.setAttribute("aria-label", "程序构建说明");
      dialog.append(el("h2", "", "程序构建说明"), button("关闭", () => dialog.close(), "close"));
      for (const [heading, items] of [["已合并", notes.filter(n => n.kind === "merged").map(n => n.text)],
        ["值得核对", [...worth.map(n => `${noteKind(n.kind)}：${n.text}`), ...unplaced.map(name => `「${name}」没有可用的身份键，尚未纳入本体；数据仍作为表保留。`)]]]) {
        if (!items.length) continue;
        const section = el("section", "os-detail-section"); section.append(el("h3", "", heading));
        for (const text of items) section.append(el("p", "", text));
        dialog.append(section);
      }
      dialog.addEventListener("close", () => dialog.remove());
      line.append(button(`值得核对 ${worth.length + unplaced.length}`, () => {document.body.append(dialog); dialog.showModal();}, null, "os-helix-review"));
    }
    identity.append(line);
  }
  const toolbar = el("div", "os-toolbar"); toolbar.setAttribute("aria-label", "图谱工具");
  const back = button("返回上一层", () => {nav.back(); renderView();}, "back");
  const reset = button("复位视角", () => scene?.resetCamera(), "settings");
  const zoomIn = button("放大", () => scene?.zoom(.83), "plus");
  const zoomOut = button("缩小", () => scene?.zoom(1.2)); zoomOut.textContent = "−";
  const pause = button("暂停动态", () => {
    motion = !motion; scene?.setMotion(motion); root.classList.toggle("os-paused", !motion);
    pause.textContent = motion ? "暂停" : "继续";
    pause.setAttribute("aria-label", motion ? "暂停动态" : "继续动态"); pause.setAttribute("aria-pressed", String(!motion));
  }); pause.textContent = "暂停";
  toolbar.append(back, reset, zoomIn, zoomOut, pause);
  const utilities = el("div", "os-utilities");
  const directoryButton = button("查找概念", () => {directory.hidden = !directory.hidden; directoryButton.setAttribute("aria-expanded", String(!directory.hidden)); if (!directory.hidden) search.focus();});
  directoryButton.setAttribute("aria-expanded", "false");
  const menu = el("details", "os-menu"); menu.append(el("summary", "", "工作区"));
  const menuBody = el("div", "os-menu-body");
  function panel(label, contents) {
    const open = () => {
      menu.open = false;
      const dialog = el("dialog", "live-dialog os-management"); dialog.setAttribute("aria-label", label);
      dialog.append(el("h2", "", label), button("关闭", () => dialog.close(), "close"), typeof contents === "function" ? contents() : contents);
      // Dialogs own their lifetime. Polls and new graph versions must not discard open forms.
      dialog.addEventListener("close", () => {dialog.querySelectorAll("[data-disposable]").forEach(node => node.dispose?.()); dialog.remove();}, {once:true});
      document.body.append(dialog); dialog.showModal();
    };
    const entry = button(label, open); entry.openPanel = open; return entry;
  }
  const definitionEntry = panel("本体定义", management);definitionEntry.classList.add("os-definition-entry");
  root.openDefinitions = () => definitionEntry.openPanel();
  const objectEntry = panel("实际对象", objects);objectEntry.classList.add("os-object-entry");
  const workEntries = el("nav", "os-work-entries");workEntries.setAttribute("aria-label","本体工作入口");
  workEntries.append(definitionEntry,objectEntry);
  let buildEntry;
  if(programBuild) {
    const taskCount=(engine?.jobs||[]).filter(j=>["queued","running"].includes(j.status)).length;
    buildEntry = button(taskCount?`构建任务 · ${taskCount} 进行中`:"构建与修订",programBuild); workEntries.append(buildEntry);
  }
  menuBody.append(panel("共同取证", evidence));
  menu.append(menuBody); utilities.append(directoryButton, menu); top.append(identity, toolbar, utilities);root.append(workEntries);
  const directory = el("section", "os-directory"); directory.hidden = true; directory.setAttribute("aria-label", "本体查找目录");
  const search = el("input"); search.type = "search"; search.placeholder = "查找概念或关系…"; search.setAttribute("aria-label", "查找概念或关系");
  const entries = el("div", "os-directory-entries");
  directory.append(search, entries);
  function renderDirectory() {
    entries.replaceChildren();
    const items = [...graph.nodes.filter(item => item.kind === "concept"), ...graph.edges.filter(item => item.kind === "relation")];
    for (const item of items.filter(item => item.name.toLowerCase().includes(search.value.toLowerCase()))) {
      const control = button(`${item.kind === "concept" ? "概念" : "关系"} · ${item.name}`, () => {
        directory.hidden = true; directoryButton.setAttribute("aria-expanded", "false");
        if (item.kind === "concept") nav.focus(item.id); else nav.activate(item.key);
        renderView();
        (nav.current.stage === "local" ? local.querySelector("button.os-local-summary") : inspectorHead.querySelector("button"))?.focus({preventScroll: true});
      }); entries.append(control);
    }
    if (!entries.childElementCount) entries.append(el("p", "", "没有匹配的定义"));
  }
  search.oninput = renderDirectory;
  const legend = el("aside", "os-legend");
  legend.append(el("span", "os-eyebrow", "图例"));
  for (const [name, color] of [["焦点实体", "#e9889e"], ["业务实体", "#c0a1ed"], ["说明依据", "#83a1d8"]]) {
    const row = el("div", "", name); row.style.setProperty("--legend-color", color); legend.append(row);
  }
  legend.append(el("small", "", "连线为数据中实际匹配的关联与说明依据"));
  const status = el("div", "os-status"); status.setAttribute("aria-live", "polite");
  identity.append(status);
  const hint = el("p", "os-hint", "点击节点探索 · 拖动旋转 · 滚轮缩放");
  const local = el("section", "os-local-card"); local.hidden = true; local.setAttribute("aria-label", "当前概念概览");
  const inspector = el("aside", "os-inspector"); inspector.hidden = true; inspector.setAttribute("aria-label", "本体内容详情");
  const inspectorHead = el("header", "os-inspector-head");
  inspectorHead.append(el("span", "os-eyebrow", "本体详情"), button("关闭详情", () => {nav.back(); renderView();}, "close"));
  const inspectorBody = el("div", "os-inspector-body"); inspectorBody.setAttribute("aria-live", "polite");
  inspector.append(inspectorHead, inspectorBody);
  const fan = el("div", "os-fan"); fan.hidden = true;
  const fanCanvas = el("canvas", "os-fan-lines"); fanCanvas.setAttribute("aria-hidden", "true");
  const groups = el("div", "os-fan-groups");
  const leaves = el("div", "os-fan-leaves");
  fan.append(fanCanvas, groups, leaves);
  root.prepend(content, top, directory, legend, hint, local, fan, inspector);
  const narrow = matchMedia("(max-width: 720px)");
  const placeFan = () => {if (narrow.matches) inspector.insertBefore(fan, inspectorBody); else root.insertBefore(fan, inspector);};
  narrow.addEventListener("change", placeFan); placeFan();
  const controlsResize = new ResizeObserver(() => {
    if (root.isConnected && narrow.matches) root.style.setProperty("--os-mobile-controls-height", `${workEntries.getBoundingClientRect().bottom - root.getBoundingClientRect().top}px`);
  });
  controlsResize.observe(top); controlsResize.observe(workEntries);

  function activate(key) {highlight = null; nav.activate(key); renderView();}
  function currentConcept() {
    const state = nav.current;
    return graph.concepts.find(item => item.id === (state.target?.kind === "foundation_concept" ? state.target.member : state.focus));
  }
  function attach(target, label) {
    const request = ++generation, selectedArtifact = artifact;
    const guard = () => !disposed && root.isConnected && request === generation && artifact === selectedArtifact;
    status.textContent = `正在引用：${label}`;
    select(selectedArtifact, target, guard, true).then(result => {
      if (guard()) status.textContent = result ? `已引用：${label}` : "引用未完成，请重试";
    }).catch(error => {if (guard()) status.textContent = error.message;});
  }
  function related(concept) {return graph.relations.filter(item => item.from === concept?.id || item.to === concept?.id);}
  function renderLocal() {
    const concept = graph.concepts.find(item => item.id === nav.current.focus);
    local.replaceChildren(); if (!concept) return;
    const head = el("header");
    head.append(el("span", "os-eyebrow", "当前聚焦"), button("返回全局", () => {nav.back(); renderView();}, "close"));
    const body = button(concept.name, () => {nav.activate(`concept:${concept.id}`); renderView();}, null, "os-local-summary");
    const helix = concept.helix;
    body.append(el("p", "", concept.description || "暂无业务说明"), el("span", "os-explore", helix ? "查看合并来源、关联与待核对 →" : "探索定义与关联内容 →"));
    const bottom = el("div", "os-local-actions");
    const members = helix?.entity.members.length || 0;
    bottom.append(el("span", "", helix ? `${helix.entity.rows} 条记录 · 身份键 ${helix.entity.key} · ${members > 1 ? `合并自 ${members} 个来源` : "单一来源"}`
      : `${related(concept).length} 条关系 · 非程序构建`),
      button("引用到对话", () => attach({kind: "foundation_concept", member: concept.id}, concept.name)));
    local.append(head, body, bottom);
  }
  function renderFan() {
    const concept = currentConcept(); if (!concept) return;
    const relationships = related(concept);
    const refs = graph.evidence.filter(item => concept.evidenceRefs?.includes(item.id));
    // A program-built entity shows what the program found; leaves open the matching evidence card.
    const show = key => () => {highlight = key; renderHelix(concept); inspectorBody.querySelector(`[data-helix="${key}"]`)?.scrollIntoView({block: "nearest"});};
    const helix = concept.helix;
    const buckets = helix ? [
      {id: "members", name: "合并来源", items: helix.entity.members.map((m, i) => ({label: m.datasetName, sub: memberLine(m), action: show(`members:${i}`)}))},
      {id: "links", name: "关联", items: helix.links.map((l, i) => ({label: `${l.direction === "out" ? "→" : "←"} ${l.other.name}`, sub: linkLine(l), action: show(`links:${i}`)}))},
      {id: "properties", name: "属性", items: [helix.entity.key, ...helix.entity.properties.filter(p => p !== helix.entity.key)].map((p, i) => ({label: p, sub: i ? "属性" : "身份键", action: show("properties")}))},
      {id: "review", name: "待核对", items: review(helix).map((r, i) => ({label: r.label, sub: r.sub, action: show(`review:${i}`)}))},
    ] : [
      {id: "relations", name: "关系定义", items: relationships.map(item => ({label: item.name, sub: `${graph.concepts.find(c => c.id === item.from)?.name} → ${graph.concepts.find(c => c.id === item.to)?.name}`, action: () => activate(`relation:${item.id}`)}))},
      {id: "evidence", name: "定义依据", items: refs.map(item => ({label: item.title || "用户陈述", sub: kindLabel(item.kind), action: () => activate(`evidence:${item.id}`)}))},
    ];
    if (!buckets.some(item => item.id === activeGroup)) activeGroup = helix ? "links" : "relations";
    groups.replaceChildren(); leaves.replaceChildren();
    for (const bucket of buckets) {
      const control = button(bucket.name, () => {activeGroup = bucket.id; renderFan(); groups.querySelector('[aria-pressed="true"]')?.focus({preventScroll: true});}, null, "os-fan-group");
      control.replaceChildren(el("strong", "", String(bucket.items.length)), el("span", "", bucket.name));
      control.setAttribute("aria-pressed", String(bucket.id === activeGroup)); groups.append(control);
    }
    const bucket = buckets.find(item => item.id === activeGroup);
    for (const item of bucket.items) {
      const leaf = button(item.label, item.action, null, "os-fan-leaf");
      leaf.append(el("small", "", item.sub)); leaves.append(leaf);
    }
    if (!bucket.items.length) leaves.append(el("p", "os-fan-empty", `暂无${bucket.name}`));
    cancelAnimationFrame(fanFrame); fanFrame = requestAnimationFrame(drawFan);
  }
  function drawFan() {
    if (disposed || !root.isConnected || fan.hidden || narrow.matches) return;
    const rect = fan.getBoundingClientRect(); const scale = Math.min(devicePixelRatio, 2);
    fanCanvas.width = rect.width * scale; fanCanvas.height = rect.height * scale;
    const ctx = fanCanvas.getContext("2d"); ctx.scale(scale, scale);
    const origin = {x: rect.width * .184, y: rect.height * .5};
    const point = (node, right) => {const box = node.getBoundingClientRect(); return {x: (right ? box.right : box.left) - rect.left, y: box.top + box.height / 2 - rect.top};};
    const curve = (from, to, color) => {
      ctx.beginPath(); ctx.moveTo(from.x, from.y);
      ctx.bezierCurveTo(from.x + (to.x - from.x) * .52, from.y, to.x - 45, to.y, to.x, to.y);
      ctx.strokeStyle = color; ctx.lineWidth = .8; ctx.stroke();
    };
    for (const group of groups.children) curve(origin, point(group, false), "#8495ba66");
    const selected = groups.querySelector('[aria-pressed="true"]');
    if (selected) for (const leaf of leaves.querySelectorAll("button")) curve(point(selected, true), point(leaf, false), "#db9ca8bb");
  }
  const fanResize = new ResizeObserver(() => {cancelAnimationFrame(fanFrame); fanFrame = requestAnimationFrame(drawFan);}); fanResize.observe(fan);
  // The program's evidence for one entity: merged sources, matched links, properties and review items.
  function renderHelix(concept) {
    const helix = concept?.helix, old = inspectorBody.querySelector(".os-helix");
    if (!helix) {old?.remove(); return;}
    const section = el("section", "os-detail-section os-helix");
    const card = (key, title, lines) => {
      const details = el("details", "os-evidence-card"); details.dataset.helix = key; details.open = highlight === key;
      details.append(el("summary", "", title), ...lines.filter(Boolean).map(line => typeof line === "string" ? el("p", "", line) : line));
      return details;
    };
    section.append(el("h3", "", "合并来源"));
    helix.entity.members.forEach((m, i) => section.append(card(`members:${i}`, `${m.datasetName}${m.anchor ? " · 主来源" : ""}`, [`来源：${m.source}`, memberLine(m), `身份键 ${m.key}`])));
    section.append(el("h3", "", "关联"));
    if (!helix.links.length) section.append(el("p", "os-muted", "程序没有在数据中发现与其他实体的匹配。"));
    helix.links.forEach((l, i) => section.append(card(`links:${i}`, `${l.direction === "out" ? "→" : "←"} ${l.other.name} · ${l.name}`, [
      `${l.from.dataset}.${l.from.column} → ${l.to.dataset}.${l.to.column}`,
      `${l.matchedRows}/${l.totalRows} 条匹配 · ${linkEvidence(l.evidence)}${l.caseInsensitive ? " · 仅忽略大小写时匹配" : ""}`,
      l.executable ? "已进入执行映射，可查询" : "未进入执行映射：需经合并数据或忽略大小写才能匹配，待核对",
      l.other.conceptId && button(`前往 ${l.other.name}`, () => activate(`concept:${l.other.conceptId}`), null, "os-button"),
    ])));
    section.append(el("h3", "", "属性"));
    section.append(card("properties", `身份键 ${helix.entity.key} · ${helix.entity.properties.length} 个属性`, [helix.entity.properties.join("、")]));
    section.append(el("h3", "", "待核对"));
    const items = review(helix);
    if (!items.length) section.append(el("p", "os-muted", "程序没有发现需要核对的问题；业务含义仍需人确认。"));
    items.forEach((r, i) => section.append(card(`review:${i}`, r.sub, [r.label])));
    if (old) old.replaceWith(section); else inspectorBody.querySelector(".os-badges")?.after(section);
  }
  function renderBindings(host, bindings) {
    const section = el("section", "os-detail-section"); section.append(el("h3", "", "来源与执行映射"));
    if (!bindings.length) section.append(el("p", "os-muted", "尚未建立执行映射，暂无可查询的实际对象。"));
    for (const binding of bindings) {
      const row = el("article", "os-evidence-card");
      row.append(el("strong", "", sourceSummary?.sources.find(s => s.id === binding.sourceId)?.title || "数据对应"), el("p", "", `${binding.status === "adopted" ? "已采用" : "候选 / 不可用"} · ${binding.capability || ""}`), technicalDetails(binding));
      if (binding.reason) row.append(el("p", "", binding.reason));
      for (const [property, field] of Object.entries(binding.fields || {})) row.append(el("p", "", `${property} ← ${field}`));
      section.append(row);
    }
    const old = host.querySelector(".os-bindings"); section.classList.add("os-bindings");
    if (old) old.replaceWith(section); else host.append(section);
    return section;
  }
  async function renderDetail() {
    const request = ++generation; const state = nav.current; const selectedArtifact = artifact;
    const item = state.target?.kind === "foundation_relation" ? graph.relations.find(item => item.id === state.target.member) : currentConcept();
    inspectorBody.replaceChildren(el("h2", "", item?.name || "本体内容"), el("p", "os-muted", "正在读取定义与依据…"));
    try {
      const result = await read(selectedArtifact, state.target);
      if (disposed || !root.isConnected || request !== generation) return;
      if (!result?.target) throw new Error("未能读取所选定义");
      const {definition, ref} = result.target;
      const isRelation = ref.kind === "foundation_relation";
      const evidenceItem = state.evidenceId && definition.evidence?.find(item => item.id === state.evidenceId);
      inspectorBody.replaceChildren(el("p", "os-detail-kind", evidenceItem ? kindLabel(evidenceItem.kind) : isRelation ? "关系定义" : "概念定义"),
        el("h2", "", evidenceItem ? evidenceItem.title || "用户陈述" : definition.name),
        el("p", "os-detail-description", evidenceItem ? evidenceItem.quote : definition.description || "暂无说明"));
      const badges = el("div", "os-badges");
      badges.append(el("span", "", `${result.target.status === "adopted" ? "已采用" : "候选待核对"}`), el("span", "", mappingLabel(definition))); inspectorBody.append(badges);
      if (evidenceItem?.readAt) inspectorBody.append(el("p", "os-muted", `读取时间 ${new Date(evidenceItem.readAt).toLocaleString("zh-CN")}`));
      if (isRelation) {
        const name = id => graph.concepts.find(item => item.id === id)?.name || id;
        inspectorBody.append(el("p", "os-relation-path", `${name(definition.from)} → ${definition.name} → ${name(definition.to)}`));
      }
      const helix = !isRelation && !evidenceItem && currentConcept()?.helix;
      const numbers = el("div", "os-detail-metrics");
      const metrics = helix ? [[helix.entity.members.length, "合并来源"], [helix.links.length, "关联"], [review(helix).length, "待核对"]]
        : [[definition.evidence?.length || 0, "定义依据"], [definition.bindings?.length || 0, "来源映射"]];
      for (const [number, label] of metrics) {
        const stat = el("div"); stat.append(el("strong", "", String(number)), el("span", "", label)); numbers.append(stat);
      }
      inspectorBody.append(numbers, button("引用到对话", () => attach(state.target, definition.name), null, "os-primary"));
      if (helix) renderHelix(currentConcept());
      else if (!isRelation && !evidenceItem) {
        const legacy = el("section", "os-detail-section os-legacy");
        legacy.append(el("h3", "", "非程序构建"), el("p", "", "这个概念来自资料或对话解读，没有经过数据程序的身份、合并与关联匹配。建议按数据重新构建。"));
        if (programBuild) legacy.append(button("按数据重新构建", programBuild, null, "os-button"));
        inspectorBody.append(legacy);
      }
      renderBindings(inspectorBody, definition.bindings || []);
      const sources = el("section", "os-detail-section"); sources.append(el("h3", "", helix ? "说明依据" : "定义依据"));
      for (const proof of definition.evidence || []) {
        const details = el("details", "os-evidence-card"); details.open = proof.id === state.evidenceId;
        details.append(el("summary", "", `${kindLabel(proof.kind)} · ${proof.title || "用户陈述"}`), el("blockquote", "", proof.quote));
        if (proof.readAt) details.append(el("small", "", `读取于 ${new Date(proof.readAt).toLocaleString("zh-CN")}`));
        sources.append(details);
      }
      inspectorBody.append(sources);
      const unresolved = (definition.unknowns || []).filter(item => !item.resolvedBy);
      if (unresolved.length || definition.unresolvedConflictCount) {
        const issues = el("details", "os-detail-section os-issues");
        issues.append(el("summary", "", `本版本待核对 · ${unresolved.length} 项未知 / ${definition.unresolvedConflictCount || 0} 项冲突`));
        for (const issue of unresolved) issues.append(el("p", "", issue.description));
        for (const conflict of definition.conflicts || []) {
          issues.append(el("p", "", conflict.description));
          if (conflict.retained) issues.append(el("p", "", `原定义：${conflict.retained.description}`));
          if (conflict.proposed) issues.append(el("p", "", `建议：${conflict.proposed.description}`));
        }
        inspectorBody.append(issues);
      }
      inspectorBody.append(el("small", "os-muted", `定义标识 ${ref.member}`));
    } catch (error) {
      if (disposed || request !== generation) return;
      const message = el("p", "os-error", error.message); message.setAttribute("role", "alert");
      inspectorBody.replaceChildren(message, button("重新读取", renderDetail));
    }
  }
  let selectionKey;
  function renderView() {
    const previousFocus = document.activeElement;
    const hadFocus = root.contains(previousFocus) && !previousFocus.matches("input,select,textarea");
    const previousStage = root.dataset.stage;
    generation++;
    const state = nav.current;
    selections.set("ontology-space", {id: artifact?.id, version: artifact?.version, view: state});
    root.dataset.stage = state.stage;
    back.disabled = state.stage === "global";
    local.hidden = state.stage !== "local";
    inspector.hidden = fan.hidden = state.stage !== "detail";
    legend.hidden = state.stage === "detail";
    hint.textContent = state.stage === "global" ? "点击节点探索 · 拖动旋转 · 滚轮缩放" : state.stage === "local" ? "点击节点或关系查看内容 · 点击空白返回" : "点击分组展开关联 · 点击空白或 Esc 返回";
    status.textContent = state.stage === "global" ? `${graph.stats.concepts} 个${artifact?.content.helix ? "实体" : "概念"} · ${graph.stats.relations} 条关系` : (currentConcept()?.name || "当前关系");
    scene?.setView(state);
    if (state.stage === "local") renderLocal();
    if (state.stage === "detail") {renderFan(); void renderDetail();}
    onLayout({stage: state.stage, stats: graph.stats, label: currentConcept()?.name || "企业本体"});
    const target = state.stage === "local" ? {kind:"foundation_concept", member:state.focus} : state.target;
    const key = JSON.stringify([artifact?.id, artifact?.version, state.stage === "global" ? null : target]);
    if (selectionKey !== key) {
      selectionKey = key;
      onSelection?.(artifact, state.stage === "global" ? null : target, () => !disposed && selectionKey === key);
    }
    if (hadFocus && (previousStage !== state.stage || !previousFocus.isConnected || previousFocus.closest("[hidden]"))) {
      const nextFocus = state.stage === "detail" ? inspectorHead.querySelector("button")
        : state.stage === "local" ? local.querySelector(".os-local-summary") : directoryButton;
      nextFocus?.focus({preventScroll: true});
    }
  }
  function unavailable() {
    if (disposed) return;
    root.classList.add("os-no-webgl"); directory.hidden = false;
    directoryButton.setAttribute("aria-expanded", "true");
    status.textContent = "当前图形环境不可用，可通过目录继续探索本体";
  }
  function mountScene() {
    if (!root.isConnected || disposed) return;
    scene = createOntologyScene(content, graph, {onActivate: activate, onBackground: () => {
      if (!directory.hidden) {directory.hidden = true; directoryButton.setAttribute("aria-expanded", "false"); return;}
      if (nav.current.stage !== "global") {nav.back(); renderView();}
    }, onUnavailable: unavailable});
    scene?.setMotion(motion); scene?.setView(nav.current, true);
  }
  version.onchange = () => {
    generation++; scene?.dispose();
    artifact = versions.find(item => String(item.version) === version.value);
    graph = buildOntologyGraph(artifact); nav = createOntologyNavigation(graph);
    search.value = ""; renderDirectory(); mountScene(); renderView();
  };
  function onKeyDown(event) {
    if (disposed || !root.isConnected || event.key !== "Escape" || event.isComposing || document.querySelector("dialog[open]") || event.target.closest(".interaction") || event.target.matches("input,textarea,select")) return;
    event.preventDefault();
    if (!directory.hidden) {directory.hidden = true; directoryButton.setAttribute("aria-expanded", "false"); directoryButton.focus();}
    else {nav.back(); renderView();}
  }
  document.addEventListener("keydown", onKeyDown);
  if (!graph.concepts.length) {
    const empty = el("div", "os-empty"); empty.append(el("h2", "", "从第一个业务概念开始"), el("p", "", "接入数据后构建本体。检查候选并采用，随后可通过助手继续修订。")); root.append(empty);
  }
  root.dispose = () => {disposed = true; generation++; controlsResize.disconnect(); narrow.removeEventListener("change", placeFan); document.removeEventListener("keydown", onKeyDown); cancelAnimationFrame(fanFrame); fanResize.disconnect(); scene?.dispose();};
  let progressKey = JSON.stringify([automaticBuild, automaticApiBuild]);
  root.updateStatus = state => {
    const sourceLine = root.querySelector(".os-helix-summary > span");
    if (sourceLine && helixSummary) {
      const stats = helixSummary.stats;
      sourceLine.textContent = `${stats.tables} 张表 · ${state.sourceSummary?.total ?? stats.sources} 个已接入来源 → ${stats.entities} 个实体 · ${stats.links} 条关联`;
    }
    const nextKey = JSON.stringify([state.automaticBuild, state.automaticApiBuild]);
    if (nextKey !== progressKey) {progressKey = nextKey; updateProgress(state.automaticBuild, state.automaticApiBuild);}
    if (buildEntry) {
      const count = (state.engine?.jobs || []).filter(j => ["queued","running"].includes(j.status)).length;
      const label = count ? `构建任务 · ${count} 进行中` : "构建与修订";
      buildEntry.textContent = buildEntry.title = label; buildEntry.setAttribute("aria-label", label);
    }
  };
  const semanticVersion = [value?.current?.id, value?.current?.version, value?.adopted?.id, value?.adopted?.version];
  root.updateWorkspace = state => {
    const next = state.foundation;
    const refs = [next?.current?.id, next?.current?.version, next?.adopted?.id, next?.adopted?.version];
    if (refs.some((ref, index) => ref !== semanticVersion[index])) return false;
    root.updateStatus(state); return true;
  };
  renderDirectory(); renderView(); queueMicrotask(mountScene);
  return root;
}

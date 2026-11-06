/** UI presentation and navigation; projections, decisions and permissions stay in domain services. */
const statusLabel = (value) => ({ resolved: "当前值", conflict: "资料结果不一致", incomparable: "口径不同或不完整", uncertain: "时间不明确", missing: "资料未提供", disputed: "人工值与新来源有分歧", accepted: "已采纳", pending: "待处理候选", rejected: "已否决", queued: "排队中", running: "执行中", completed: "已完成", failed: "失败", draft: "草稿", published: "已发布", awaiting_decision: "等待业务决定", needs_recovery: "需要恢复", collecting: "收集事项中", preparing: "准备中", submitting: "提交中", built: "构建完成", archived: "已归档", superseded: "已被新批取代", approved: "已批准", ready: "可以继续", stale: "已失效" })[value] ?? value;
const objectLabel = (object) => object.summary?.name || [...new Set(object.identifiers?.map((i) => i.value) ?? [])].join(" / ") || `未命名对象 ${object.id.slice(0, 8)}`;
function createExplorer({ api, node, button, getState, readObject, openOntology, openPackage, openPlan, work, clearObject }) {
  const $ = (s) => document.querySelector(s);
  const layout = $("#explorer .explore-layout");
  layout.children[1].append($("#explore-sidebar"));
  layout.append($("#objects"));
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem("context-os-explorer") || "{}");
  } catch {
    saved = {};
  }
  const deep = new URLSearchParams(location.hash.split("?")[1] || "");
  if (deep.has("type")) saved.type = deep.get("type");
  if (deep.has("object")) saved.object = deep.get("object");
  if (saved.history) {
    for (const key of ["validAt", "knownAt"]) if (typeof saved.history[key] === "string") $("#history").elements[key].value = saved.history[key];
  }
  let restored = false, latestPublished, invalidatedFacts = false;
  let type = typeof saved.type === "string" ? saved.type : "", query = typeof saved.query === "string" ? saved.query : "", offset = Number.isInteger(saved.offset) ? Math.max(0, saved.offset) : 0, scale = Number.isFinite(saved.scale) ? Math.min(2, Math.max(0.6, saved.scale)) : 1, request = 0;
  const persist = () => {
    try {
      sessionStorage.setItem("context-os-explorer", JSON.stringify(saved));
    } catch {
    }
  };
  let graphBusy = false;
  const activate = async (task) => {
    if (graphBusy) return;
    graphBusy = true;
    try {
      await work(task);
    } finally {
      graphBusy = false;
    }
  };
  const facts = /* @__PURE__ */ new Map();
  let currentObjectId = "", objectStack = Array.isArray(saved.stack) ? saved.stack : [], navigatingBack = false;
  let currentPage = "browse";
  const remember = () => {
    saved = { ...saved, type, query, offset, scale, history: { validAt: $("#history").elements.validAt.value, knownAt: $("#history").elements.knownAt.value } };
    persist();
    if (currentPage === "browse") {
      const params = new URLSearchParams({ type });
      if (saved.object) params.set("object", saved.object);
      history.replaceState(null, "", `#browse?${params}`);
    }
  };
  const published = () => latestPublished;
  function drawGraph(target, nodes, edges, onNode, onEdge, focused = "") {
    const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 840 ${Math.max(340, Math.ceil(nodes.length / 3) * 150 + 80)}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "关系图，方向与关系名同时在下方列表显示");
    const el = (tag, attrs, text) => {
      const n = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      if (text) n.textContent = text;
      return n;
    };
    const defs = el("defs", {}), marker = el("marker", { id: `arrow-${target.id}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
    marker.append(el("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#527d70" }));
    defs.append(marker);
    svg.append(defs);
    const points = new Map(nodes.map((n, i) => [n.id, { x: 140 + i % 3 * 280, y: 80 + Math.floor(i / 3) * 150 }]));
    edges.forEach((e, i) => {
      const a = points.get(e.from), b = points.get(e.to);
      if (!a || !b) return;
      const self = e.from === e.to, bend = (i % 3 - 1) * 26;
      const d = self ? `M ${a.x - 30} ${a.y - 26} C ${a.x - 100} ${a.y - 100},${a.x + 100} ${a.y - 100},${a.x + 30} ${a.y - 26}` : `M ${a.x} ${a.y + 26} Q ${(a.x + b.x) / 2 + bend} ${(a.y + b.y) / 2 + 45 + bend} ${b.x} ${b.y - 26}`;
      const g = el("g", { "tabindex": 0, "role": "button", "aria-label": e.name });
      g.append(el("path", { d, fill: "none", stroke: focused && e.from !== focused && e.to !== focused ? "#c6d3ce" : "#527d70", "stroke-width": focused && (e.from === focused || e.to === focused) ? 3 : 2, "marker-end": `url(#arrow-${target.id})` }));
      const text = el("text", { x: self ? a.x : (a.x + b.x) / 2 + bend, y: self ? a.y - 55 : (a.y + b.y) / 2 + 25 + bend, "text-anchor": "middle", class: "edge-label" }, e.name);
      g.append(text);
      g.addEventListener("click", () => void activate(() => onEdge(e)));
      g.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void activate(() => onEdge(e));
        }
      });
      svg.append(g);
    });
    nodes.forEach((n) => {
      const p = points.get(n.id), g = el("g", { tabindex: 0, role: "button", "aria-label": n.name });
      g.append(el("rect", { x: p.x - 100, y: p.y - 26, width: 200, height: 52, rx: 12, fill: "#fff", stroke: n.id === focused ? "#bb762b" : "#17645b", "stroke-width": n.id === focused ? 4 : 2 }), el("text", { x: p.x, y: p.y + 5, "text-anchor": "middle" }, n.name.length > 20 ? n.name.slice(0, 19) + "…" : n.name));
      g.append(el("title", {}, n.name));
      g.addEventListener("click", () => void activate(() => onNode(n.id)));
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void activate(() => onNode(n.id));
        }
      });
      svg.append(g);
    });
    svg.style.width = `${840 * scale}px`;
    if (target.id !== "ontology-graph") {
      const controls = node("div");
      controls.className = "graph-local-tools";
      for (const [label, delta] of [["缩小关系图", -0.1], ["放大关系图", 0.1]]) controls.append(button(label, () => {
        scale = Math.min(2, Math.max(0.6, scale + delta));
        svg.style.width = `${840 * scale}px`;
        remember();
      }));
      target.append(controls);
    }
    target.append(svg);
    const viewportKey = target.id === "instance-graph" ? `${target.id}:${saved.object}` : target.id;
    if (!target.dataset.viewportBound) {
      target.dataset.viewportBound = "true";
      target.addEventListener("scroll", () => {
        saved.viewports ??= {};
        saved.viewports[viewportKey] = { left: target.scrollLeft, top: target.scrollTop };
        persist();
      });
    }
    const viewport = saved.viewports?.[viewportKey];
    if (viewport) {
      target.scrollLeft = viewport.left;
      target.scrollTop = viewport.top;
    }
    if (target.dataset.panBound) return;
    target.dataset.panBound = "true";
    let drag;
    target.addEventListener("pointerdown", (e) => {
      if (e.target.closest("[role=button]")) return;
      drag = { x: e.clientX, y: e.clientY, left: target.scrollLeft, top: target.scrollTop };
    });
    target.addEventListener("pointermove", (e) => {
      if (drag && e.buttons === 1) {
        target.scrollLeft = drag.left + drag.x - e.clientX;
        target.scrollTop = drag.top + drag.y - e.clientY;
      }
    });
    target.addEventListener("pointerup", () => drag = null);
  }
  function graph(target, definition, select, focus2 = "", linkSelect) {
    const oldViewport = saved.viewports?.[target.id] ?? { left: target.scrollLeft, top: target.scrollTop };
    target.replaceChildren();
    if (!definition?.types.length) {
      target.append(node("p", "暂无已发布本体。可进入知识构建，选择资料开始。"));
      return;
    }
    const showLink = async (l) => {
      if (linkSelect) return linkSelect(l);
      await select(l.from);
      const names = (id) => definition.types.find((t) => t.id === id)?.name || id;
      $("#explore-sidebar").replaceChildren(node("h3", l.name), node("p", `${names(l.from)} → ${names(l.to)}`), node("p", l.multiple ? "可关联多个对象" : "单值关系"));
    };
    drawGraph(target, definition.types, definition.links, select, showLink, focus2);
    const list = node("div");
    list.className = "graph-nodes";
    for (const t of definition.types) {
      const b = button(t.name, () => select(t.id));
      b.className = t.id === focus2 ? "graph-node selected" : "graph-node";
      b.title = t.description || t.name;
      list.append(b);
    }
    target.append(list);
    const links = node("div");
    links.className = "graph-links";
    for (const l of definition.links) {
      const names = (id) => definition.types.find((t) => t.id === id)?.name || id;
      links.append(button(`${names(l.from)} → ${l.name} → ${names(l.to)}`, () => showLink(l)));
    }
    target.append(links);
    target.scrollLeft = oldViewport.left;
    target.scrollTop = oldViewport.top;
  }
  function route() {
    const key = location.hash.slice(1).split("?")[0];
    currentPage = ["build", "sources", "ontology", "build-plans", "connections", "decision-packages"].includes(key) ? "build" : "browse";
    $("#build-workspace").hidden = currentPage !== "build";
    $("#explorer").hidden = currentPage !== "browse";
    $("#objects").hidden = currentPage !== "browse";
    document.querySelectorAll("[data-page]").forEach((a) => a.setAttribute("aria-current", a.dataset.page === currentPage ? "page" : "false"));
  }
  window.addEventListener("hashchange", () => {
    route();
    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    if (currentPage !== "browse" || !getState() || !params.has("type") && !params.has("object")) return;
    void work(async () => {
      const nextType = params.get("type") ?? type, nextObject = params.get("object") ?? "";
      if (nextType !== type) {
        type = nextType;
        offset = 0;
      }
      saved.object = nextObject;
      remember();
      render();
      await directory();
      if (nextObject) await readObject(nextObject);
      else clearObject();
    });
  });
  route();
  async function directory() {
    const seq = ++request;
    const params = new URLSearchParams({ type, query, offset: String(offset), limit: "30" });
    const result = await api(`/api/browse/objects?${params}`);
    if (seq !== request) return;
    const root = $("#explore-objects");
    root.replaceChildren(node("p", result.coverage));
    for (const o of result.items) {
      const card = node("article");
      card.className = "object-card";
      const typeName = published()?.definition.types.find((t) => t.id === o.type_id)?.name ?? o.type_id;
      card.append(button(objectLabel(o), () => readObject(o.id)), node("span", ` · ${typeName}`));
      if (o.summary) {
        for (const f of o.summary.properties) card.append(node("p", `${f.name}：${f.status === "resolved" ? String(f.value ?? "资料未提供") : statusLabel(f.status)}${f.disputed ? " · 与新来源有分歧" : ""}`));
        if (o.summary.issues.length) card.append(node("p", `⚠ ${o.summary.issues.length} 项待查证：${o.summary.issues.map((i) => i.name).join("、")}`));
      } else if (o.summaryUnavailable) card.append(node("p", o.summaryUnavailable));
      root.append(card);
    }
    if (!result.items.length) root.append(node("p", published()?"此范围暂无对象；已发布结构仍可浏览。":"尚无对象，请从资料开始构建知识。"));
    const prev = button("上一页", () => {
      offset = Math.max(0, offset - 30);
      remember();
      return directory();
    });
    prev.disabled = offset === 0;
    const next = button("下一页", () => {
      offset += 30;
      remember();
      return directory();
    });
    next.disabled = !result.hasMore;
    root.append(prev, node("span", ` 第 ${offset / 30 + 1} 页 `), next);
  }
  async function focus(id, preserveDirectory = false) {
    type = id;
    saved.object = "";
    if (!preserveDirectory) offset = 0;
    clearObject();
    currentObjectId = "";
    objectStack = [];
    saved.stack = [];
    $("#explore-sidebar").replaceChildren(node("p", "选择对象查看局部关系与事项。"));
    remember();
    render();
    await directory();
  }
  function render() {
    const model = published(), definition = model?.definition;
    $("#explore-title").textContent = type ? "类型聚焦" : "全局本体图";
    $("#explore-breadcrumb").replaceChildren(button("全局本体图", () => focus("")), node("span", type ? ` / ${definition?.types.find((t) => t.id === type)?.name || type}` : ""));
    graph($("#ontology-graph"), definition, focus, type);
    $("#ontology-graph").querySelectorAll(".graph-node").forEach((b) => b.setAttribute("aria-pressed", String(b.classList.contains("selected"))));
    const filter = $("#type-filter");
    filter.replaceChildren(button("全部类型", () => focus("")));
    for (const t of definition?.types ?? []) filter.append(button(t.name, () => focus(t.id)));
    const selected = definition?.types.find((t) => t.id === type);
    const detail = $("#type-detail");
    detail.replaceChildren();
    if (selected) {
      detail.append(node("h3", selected.name), node("p", selected.description || "尚无类型说明"), node("p", `身份范围：${selected.identityNamespaces?.join("、") || "以来源身份为准"}`));
      for (const p of selected.properties) detail.append(node("p", `${p.name}${p.required ? " · 必填" : ""}${p.description ? " · " + p.description : ""}`));
    }
    if (!model) detail.append(button("开始构建知识", () => {
      location.hash = "build";
    }));
  }
  $("#object-search").elements.query.value = query;
  $("#object-search").addEventListener("submit", (e) => {
    e.preventDefault();
    query = e.target.elements.query.value;
    offset = 0;
    remember();
    void directory().catch((e2) => $("#explore-objects").replaceChildren(node("p", e2.message)));
  });
  $("#graph-tools").append(button("缩小", () => {
    scale = Math.max(0.6, scale - 0.1);
    const svg = $("#ontology-graph svg");
    if (svg) svg.style.width = `${scale * 840}px`;
    remember();
  }), button("放大", () => {
    scale = Math.min(2, scale + 0.1);
    const svg = $("#ontology-graph svg");
    if (svg) svg.style.width = `${scale * 840}px`;
    remember();
  }), node("span", "图可横向滚动；节点与关系列表均可使用键盘操作。"));
  function pending() {
    const root = $("#pending-items"), category = $("#pending-category").value, blocking = $("#pending-blocking").value, closedOnly = $("#pending-status").value === "closed";
    root.replaceChildren();
    const add = (kind, title, run, closed = false, blocker = "unknown") => {
      if (closedOnly === closed && (!category || category === kind) && (!blocking || blocking === blocker)) {
        const row = node("div");
        row.append(node("strong", title), button("定位并处理", run));
        root.append(row);
      }
    };
    for (const o of getState()?.ontologies ?? []) {
      const validation = o.discovery?.validation, review = o.discovery?.review;
      if (o.status === "draft" && validation?.issues?.length && !(review?.definitionHash === validation.definitionHash && validation.issues.every((i) => review.issueIds?.includes(i.id)))) add("definition", `候选定义 · ${o.definition.name} · 发布前待决定`, () => openOntology(o.id), false, "publish");
    }
    for (const p of getState()?.decisionPackages ?? []) add("definition", `定义 / 身份 · ${statusLabel(p.state)}`, () => {
      location.hash = "decision-packages";
      return openPackage(p.id);
    }, ["built", "superseded", "completed", "archived"].includes(p.state));
    for (const plan of getState()?.plans ?? []) {
      if (plan.status === "approved" && plan.effective_status !== "obsolete") continue;
      const errors = plan.preview_errors ?? [], identities = plan.pending_identity_count ?? 0;
      if (identities || errors.length || plan.effective_status === "obsolete") add("definition", `构建方案 · ${plan.manifest.map((s) => s.title).join("、") || plan.id.slice(0, 8)} · ${identities ? `${identities} 组身份待决定；` : ""}${plan.effective_status === "obsolete" ? "来源或批准已失效" : errors.join("；")}（保存的预检快照，打开复核）`, () => openPlan(plan.id), false, "unknown");
    }
    for (const j of getState()?.jobs ?? []) if (j.state === "failed") add("execution", `执行失败 · ${j.kind}`, () => {
      location.hash = "sources";
      revealBuildTarget($("#job-list")).scrollIntoView();
    }, false, "execution");
    for (const [id, s] of facts) for (const f of Object.values(s.fields)) if (["conflict", "incomparable", "uncertain"].includes(f.status) || f.disputed) add("fact", `${objectLabel(s)} · ${f.name} · ${statusLabel(f.disputed ? "disputed" : f.status)} · 业务 ${s.validAt} / 获知 ${s.knownAt || "当前"}`, () => {
      location.hash = "browse";
      if (s.queryHistory) for (const key of ["validAt", "knownAt"]) $("#history").elements[key].value = s.queryHistory[key];
      return readObject(id);
    }, false, "attention");
    if (invalidatedFacts && !closedOnly) root.append(node("p", "刷新已使之前读取的对象事项缓存失效，请重新查询；历史与当前事项按各自时点显示。"), ...saved.object ? [button("重新查询选中对象事项", () => readObject(saved.object))] : []);
    if (!root.children.length) root.append(node("p", "当前已加载范围内无此类事项；不代表全库没有问题。"));
  }
  $("#pending-open").addEventListener("click", () => {
    $("#pending-center").hidden = !$("#pending-center").hidden;
    pending();
  });
  $("#pending-category").addEventListener("change", pending);
  $("#pending-blocking").addEventListener("change", pending);
  $("#pending-status").addEventListener("change", pending);
  return { async update() {
    latestPublished = await api("/api/browse/ontology");
    invalidatedFacts = facts.size > 0 || invalidatedFacts;
    facts.clear();
    render();
    pending();
    await directory();
    if (!restored) {
      restored = true;
      if (saved.object) await readObject(saved.object);
    }
  }, candidate(definition, current) {
    if (!definition) return;
    const detail = $("#candidate-detail"), changes = $("#candidate-changes"), base = published()?.definition;
    const issues = current?.discovery?.validation?.issues ?? [];
    changes.replaceChildren(node("h3", "定义变化与待决定事项"));
    const evidence = () => revealBuildTarget($("#discovery-coverage")).scrollIntoView();
    const show = (member, removed = false) => {
      detail.replaceChildren(node("h3", `${removed ? "拟删除 · " : ""}${member.name}`));
      if (member.properties) {
        detail.append(node("p", member.description || "尚无说明"));
        for (const p of member.properties) detail.append(node("p", `${p.name}${p.required ? " · 必填" : ""}`));
      } else {
        const typeName = (id) => definition.types.find((t) => t.id === id)?.name ?? base?.types.find((t) => t.id === id)?.name ?? id;
        detail.append(node("p", `${typeName(member.from)} → ${typeName(member.to)}`), node("p", member.multiple ? "可关联多个对象" : "单值关系"));
      }
      detail.append(node("p", current?.status === "published" ? "这是已发布定义。" : "候选定义尚未成为正式知识；发布与构建仍受领域门禁约束。"));
      for (const issue of issues.filter((i) => i.memberId === member.id || i.memberId === "ontology" || member.properties?.some((p) => p.id === i.memberId))) detail.append(node("p", `⚠ 待决定：${issue.question}`));
      detail.append(button("查看原始依据与业务审核", evidence));
    };
    const compare = (before, after, kind) => {
      for (const member of after) {
        const old = before.find((m) => m.id === member.id), label = old ? JSON.stringify(old) === JSON.stringify(member) ? "沿用" : "调整" : "新增";
        changes.append(button(`${kind} · ${label} · ${member.name}`, () => show(member)));
      }
      for (const member of before.filter((m) => !after.some((n) => n.id === m.id))) changes.append(button(`${kind} · 拟删除 · ${member.name}`, () => show(member, true)));
    };
    compare(base?.types ?? [], definition.types, "类型");
    compare(base?.links ?? [], definition.links, "关系");
    const marked = { ...definition, types: definition.types.map((t) => ({ ...t, name: issues.some((i) => i.memberId === t.id || t.properties.some((p) => p.id === i.memberId)) ? `⚠ ${t.name}` : t.name })), links: definition.links.map((l) => ({ ...l, name: issues.some((i) => i.memberId === l.id) ? `⚠ ${l.name}` : l.name })) };
    graph($("#candidate-graph"), marked, (id) => show(definition.types.find((t) => t.id === id)), "", (link) => show(definition.links.find((l) => l.id === link.id)));
  }, async object(snapshot) {
    if (currentObjectId && currentObjectId !== snapshot.id && !navigatingBack) objectStack.push(currentObjectId);
    objectStack = objectStack.slice(-20);
    saved.stack = objectStack;
    currentObjectId = snapshot.id;
    navigatingBack = false;
    saved.object = snapshot.id;
    remember();
    if (facts.size >= 20) facts.delete(facts.keys().next().value);
    snapshot.queryHistory = { validAt: $("#history").elements.validAt.value, knownAt: $("#history").elements.knownAt.value };
    facts.set(snapshot.id, snapshot);
    invalidatedFacts = false;
    pending();
    const side = $("#explore-sidebar");
    side.replaceChildren(node("h3", `对象局部关系 · ${objectLabel(snapshot)}`), node("p", `业务时点 ${snapshot.validAt}；系统时点 ${snapshot.knownAt || "当前"}`));
    const graphRoot = node("div");
    graphRoot.id = "instance-graph";
    graphRoot.className = "graph";
    side.append(graphRoot);
    let page = 0, outgoingPage = 0, edgePage = 0;
    const load = async () => {
      const params = new URLSearchParams({ validAt: snapshot.validAt, offset: String(page), outgoingOffset: String(outgoingPage), edgeOffset: String(edgePage) });
      if (snapshot.knownAt) params.set("knownAt", snapshot.knownAt);
      const result = await api(`/api/objects/${snapshot.id}/neighbors?${params}`);
      if (!side.contains(graphRoot)) return;
      graphRoot.replaceChildren(node("p", result.coverage));
      const names = new Map(result.nodes.map((n) => [n.id, objectLabel(n)]));
      const edgeDetail = (e) => {
        const detail = node("div");
        detail.append(node("h4", e.name), node("p", `${names.get(e.from)} → ${names.get(e.to)}`), button("查看关系依据和有效时间", () => readObject(e.from)));
        graphRoot.append(detail);
      };
      drawGraph(graphRoot, result.nodes.map((n) => ({ id: n.id, name: objectLabel(n) + (n.id === snapshot.id && Object.values(snapshot.fields).some((f) => ["conflict", "incomparable", "uncertain"].includes(f.status) || f.disputed) ? " ⚠ 待查证" : "") })), result.edges, readObject, edgeDetail);
      for (const edge of result.edges) graphRoot.append(button(`${names.get(edge.from)} → ${edge.name} → ${names.get(edge.to)}`, () => edgeDetail(edge)));
      if (edgePage) graphRoot.append(button("上一页关系", () => {
        edgePage = Math.max(0, edgePage - 40);
        return load();
      }));
      if (result.truncated) graphRoot.append(button("更多关系（当前主体页）", () => {
        edgePage = result.nextEdgeOffset;
        return load();
      }));
      if (outgoingPage) graphRoot.append(button("上一页出向关系", () => {
        edgePage = 0;
        outgoingPage = Math.max(0, outgoingPage - 20);
        return load();
      }));
      if (result.hasMoreOutgoing) graphRoot.append(button("更多出向关系", () => {
        edgePage = 0;
        outgoingPage = result.nextOutgoingOffset;
        return load();
      }));
      if (page) graphRoot.append(button("上一页入向主体", () => {
        edgePage = 0;
        page = Math.max(0, page - 12);
        return load();
      }));
      if (result.hasMore) graphRoot.append(button("更多入向主体", () => {
        edgePage = 0;
        page = result.nextOffset;
        return load();
      }));
    };
    try {
      await load();
    } catch (error) {
      graphRoot.replaceChildren(node("p", `关系查询失败：${error.message}`), button("重试关系查询", load));
    }
    if (objectStack.length) side.append(button("返回上一个对象", () => {
      navigatingBack = true;
      return readObject(objectStack.pop());
    }));
    side.append(button("返回原对象列表", () => focus(type, true)));
  } };
}
export {
  createExplorer,
  objectLabel,
  statusLabel
};

/** Disclosures move existing nodes, preserving input values and event handlers. */
export function revealBuildTarget(target) {
  const element = typeof target === 'string' ? document.querySelector(target) : target;
  if (!element) return element;
  if(element.dataset)element.dataset.buildRevealRequested='true';
  for (let current = element; current; current = current.parentElement) {
    if (current.tagName === 'DETAILS') current.open = true;
    const disclosure = current.firstElementChild;
    if (disclosure?.matches('details.build-module, details.build-disclosure')) disclosure.open = true;
  }
  return element;
}

export function installBuildDisclosures() {
  const page = document.querySelector('#build-workspace');
  const states = new Map();
  try {
    const saved = JSON.parse(sessionStorage.getItem('context-os-build-disclosures') || '{}');
    for (const [key,value] of Object.entries(saved)) if(typeof value === 'boolean') states.set(key,value);
  } catch { /* Disclosure preferences must never prevent the page from loading. */ }
  const persist = () => {
    try { sessionStorage.setItem('context-os-build-disclosures',JSON.stringify(Object.fromEntries(states))); } catch {}
  };
  function disclosure(key,title,initial=false,module=false) {
    const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('div');
    details.className=module?'build-module':'build-disclosure';details.dataset.disclosureKey=key;
    details.open=states.get(key)??initial;summary.textContent=title;body.className=module?'build-module-body':'build-disclosure-body';
    details.append(summary,body);
    details.addEventListener('toggle',()=>{states.set(key,details.open);persist();});
    return {details,summary,body};
  }
  const modules = new Map();
  for(const [id,initial] of [['connections',false],['sources',false],['decision-packages',false],['ontology',true],['build-plans',true]]) {
    const section=document.getElementById(id),heading=section.querySelector('h2');
    const group=disclosure(`module:${id}`,heading.textContent,initial,true);
    group.summary.replaceChildren(heading);
    group.body.append(...Array.from(section.childNodes));
    section.append(group.details);modules.set(id,group.summary);
  }
  const panels = [
    ['discovery-sources','选择本轮资料'],['discovery-coverage','本体审核、依据与暂缓候选'],
    ['candidate-panel','候选本体图与定义变化'],['plan-summary','本轮构建范围：对象、关系、时间与口径'],
    ['plan-manifest','来源版本、覆盖与纳入范围'],['plan-identities','身份对应与业务决定'],
    ['plan-preview','预检详情与逐来源执行结果'],['source-list','已接入资料'],['job-list','构建任务列表'],
    ['connection-list','已有连接'],['decision-package-list','已有决定批次'],
  ];
  const scan = () => {
    const status=document.querySelector('#plan-status')?.textContent;
    const summary=modules.get('build-plans');
    if(summary&&status){let badge=summary.querySelector('.build-module-status');if(!badge){badge=document.createElement('span');badge.className='build-module-status';summary.append(badge);}const text=status.slice(0,140);if(badge.textContent!==text)badge.textContent=text;}
    for(const [id,title] of panels){
      const root=document.getElementById(id);if(!root)continue;
      if(id==='candidate-panel'&&!root.querySelector('#candidate-graph')?.childElementCount)continue;
      if(!root.childNodes.length||root.firstElementChild?.matches('details.build-disclosure'))continue;
      const group=disclosure(`panel:${id}`,title);
      if(root.dataset.buildRevealRequested==='true'){group.details.open=true;delete root.dataset.buildRevealRequested;}
      group.body.append(...Array.from(root.childNodes));root.append(group.details);
    }
  };
  const observer=new MutationObserver(scan);observer.observe(page,{childList:true,subtree:true});scan();
  const followHash=()=>{const id=location.hash.slice(1).split('?')[0];if(modules.has(id))revealBuildTarget(document.getElementById(id));};
  window.addEventListener('hashchange',followHash);followHash();
  return {update(state){
    const counts={connections:`${state.connections?.length??0} 个已加载连接`,sources:`${state.sources?.length??0} 份已加载资料 · ${state.jobs?.filter(j=>['queued','running'].includes(j.state)).length??0} 个运行中任务 · ${state.jobs?.filter(j=>j.state==='failed').length??0} 个失败任务`, 'decision-packages':`${state.decisionPackages?.filter(p=>!['built','archived','superseded'].includes(p.state)).length??0} 个已加载待处理批次`};
    for(const [id,text]of Object.entries(counts)){
      const summary=modules.get(id);let badge=summary.querySelector('.build-module-status');
      if(!badge){badge=document.createElement('span');badge.className='build-module-status';summary.append(badge);}badge.textContent=text;
    }
    scan();
  }};
}

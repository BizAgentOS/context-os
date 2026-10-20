const el = (tag, cls = "", text = "") => {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = text;
  return node;
};
const button = (text, action) => {
  const node = el("button", "quiet-button", text);
  node.type = "button";
  node.onclick = action;
  return node;
};
const status = (item) => (item.mappingStatus === "bound" ? "已映射" : "未映射");

// Layout is a UI projection. Selection and explanation come from the shared context service.
export function renderFoundationWorkspace(value, { selections, select, read }) {
  const section = el("section", "definition-workspace");
  section.setAttribute("aria-label", "基础定义与映射");

  if (!value?.current) {
    section.append(
      el(
        "p",
        "muted",
        "尚无基础定义。可在企业与数据页介绍企业；没有来源也可以先构建概念。",
      ),
    );
    return section;
  }
  const versions = [value.current];
  if (value.adopted && value.adopted.version !== value.current.version)
    versions.push(value.adopted);
  const ui = selections.get("foundation-view") || {
    version: value.current.version,
    mode: "graph",
    query: "",
    member: null,
    kind: null,
  };
  selections.set("foundation-view", ui);
  if (!versions.some((v) => v.version === ui.version)) {
    ui.version = value.current.version;
    ui.member = null;
  }
  let generation = 0;
  const toolbar = el("div", "definition-toolbar");
  const version = el("select");
  version.setAttribute("aria-label", "基础定义版本");
  for (const artifact of versions) {
    const option = el(
      "option",
      "",
      `${artifact.status === "adopted" ? "已采用" : "候选待核对"}`,
    );
    option.value = artifact.version;
    version.append(option);
  }
  version.value = ui.version;
  const search = el("input");
  search.type = "search";
  search.placeholder = "查找概念或关系";
  search.setAttribute("aria-label", "查找基础定义");
  search.value = ui.query;
  const graphMode = button("局部图", () => {
    ui.mode = "graph";
    draw();
  });
  const listMode = button("等价列表", () => {
    ui.mode = "list";
    draw();
  });
  toolbar.append(version, search, graphMode, listMode);
  const scope = el("p", "source-meta");
  const body = el("div", "definition-body");
  const diagram = el("div", "definition-diagram");
  const list = el("div", "foundation-definition-list");
  const detail = el("section", "definition-detail");
  detail.setAttribute("aria-label", "所选基础定义");
  detail.setAttribute("aria-live", "polite");
  const dialog = el("dialog", "live-dialog definition-dialog");
  dialog.setAttribute("aria-label", "基础定义详情");
  const close = button("关闭", () => { generation++; dialog.close(); });
  close.classList.add("definition-close");
  dialog.append(close, detail);
  dialog.addEventListener("cancel", () => { generation++; });
  body.append(diagram, list, dialog);
  section.append(toolbar, scope, body);
  const artifact = () => versions.find((v) => v.version === ui.version);
  const target = () => ({ kind: ui.kind, member: ui.member });
  const show = async (kind, member, attach = false, focusComposer = false) => {
    const request = ++generation;
    const model = artifact();
    ui.kind = kind;
    ui.member = member;
    detail.replaceChildren(el("p", "muted", "正在读取同一业务引用…"));
    draw(false);
    if (!dialog.open) dialog.showModal();
    try {
      const result = await (attach
        ? select(
            model,
            target(),
            () => request === generation && section.isConnected,
            focusComposer,
          )
        : read(model, target()));
      if (request !== generation || !section.isConnected) return;
      if (!result?.target) throw new Error("未能选择该定义，请重新选择");
      const { ref, label, definition } = result.target;
      detail.replaceChildren(
        el("h2", "", label),
        el("p", "", definition.description),
        el(
          "p",
          "source-meta",
          `${result.target.status === "adopted" ? "已采用" : "候选待核对"} · ${status(definition)}`,
        ),
        el("p", "source-meta", `定义标识：${ref.member}`),
      );
      if (!attach)
        detail.append(
          el("p", "muted", "正在查看定义；点“引用到对话”固定本次讨论目标。"),
        );
      detail.append(button("引用到对话", () => {
        // Close first so native dialog focus restoration precedes composer focus.
        dialog.close();
        const guard = ++generation;
        select(model, target(), () => guard === generation && section.isConnected, true)
          .catch((error) => { if (guard === generation && section.isConnected) { detail.replaceChildren(el("p", "", error.message)); dialog.showModal(); } });
      }));
      if (kind === "foundation_concept") detail.append(button("以此概念为中心", () => {
        ui.center = member; ui.edgePage = 0; dialog.close(); draw();
      }));
      const describeMeaning = (item) => {
        const concepts = model.content.concepts;
        const endpoint = (id) =>
          `${concepts.find((c) => c.id === id)?.name || id} (${id})`;
        return `${item.from ? `${endpoint(item.from)} → ${item.name} → ${endpoint(item.to)}` : `${item.name} (${item.id})`}：${item.description}`;
      };
      for (const issue of definition.conflicts || []) {
        detail.append(
          el(
            "p",
            "",
            `${issue.resolvedBy ? "已核对冲突" : "待解决冲突"}：${issue.description}`,
          ),
        );
        if (issue.retained)
          detail.append(
            el("p", "", `原含义：${describeMeaning(issue.retained)}`),
          );
        if (issue.proposed)
          detail.append(
            el("p", "", `另一含义：${describeMeaning(issue.proposed)}`),
          );
      }
      const unknowns = (definition.unknowns || []).filter((i) => !i.resolvedBy);
      if (definition.unresolvedConflictCount || unknowns.length) {
        const issues = el("details");
        issues.append(
          el(
            "summary",
            "",
            `整版本待核对：${definition.unresolvedConflictCount} 项冲突、${unknowns.length} 项未知`,
          ),
        );
        for (const issue of unknowns)
          issues.append(el("p", "", issue.description));
        issues.append(
          el(
            "p",
            "muted",
            "未决项不一定只属于当前目标，完整内容见页面“定义与映射”中的“完整基础定义与采用操作”。",
          ),
        );
        detail.append(issues);
      }
      const mappings = el("details", "definition-mappings");
      mappings.open = true;
      mappings.append(el("summary", "", "来源与执行映射"));
      if (!definition.bindings?.length)
        mappings.append(
          el("p", "muted", "尚无执行映射；此定义不代表已有实例。"),
        );
      for (const binding of definition.bindings || []) {
        const card = el("article", "definition-binding");
        card.append(
          el(
            "p",
            "",
            `${{ adopted: "已采用", candidate: "候选", unavailable: "不可用" }[binding.status] || binding.status} · 映射 v${binding.modelVersion}`,
          ),
        );
        if (binding.reason) card.append(el("p", "", binding.reason));
        if (binding.sourceId)
          card.append(
            el(
              "p",
              "source-meta",
              `来源 ${binding.sourceId} · ${binding.capability} · 身份字段 ${binding.identity || "未提供"}`,
            ),
          );
        for (const [property, field] of Object.entries(binding.fields || {}))
          card.append(el("p", "", `${property} ← ${field}`));
        for (const supplement of binding.supplements || []) {
          card.append(
            el("h3", "", `附来源：${supplement.name}`),
            el(
              "p",
              "source-meta",
              `来源 ${supplement.sourceId} · ${supplement.capability} · ${supplement.match.primaryField} → ${supplement.match.sourceField}`,
            ),
          );
          for (const [property, field] of Object.entries(supplement.fields))
            card.append(el("p", "", `${property} ← ${field}`));
          card.append(el("p", "", supplement.rationale));
        }
        for (const relation of binding.mappings || [])
          card.append(
            el(
              "p",
              "",
              `${relation.from}.${relation.fromField} → ${relation.to}.${relation.toField} · ${relation.name}`,
            ),
          );
        mappings.append(card);
      }
      detail.append(mappings);
      const evidence = el("details");
      evidence.append(el("summary", "", "定义依据"));
      for (const item of definition.evidence || [])
        evidence.append(
          el("blockquote", "", item.quote),
          el(
            "p",
            "source-meta",
            `${item.kind} · ${item.title || "用户陈述"} · ${item.id}`,
          ),
        );
      detail.append(
        evidence,
        el(
          "p",
          "muted",
          "映射描述不代表实际值或业务正确性；可在“实际对象”中按需查看记录与证据。",
        ),
      );
    } catch (error) {
      if (request !== generation || !section.isConnected) return;
      const message = el("p", "", error.message);
      message.setAttribute("role", "alert");
      detail.replaceChildren(
        message,
        button("重新读取定义", () => show(kind, member, attach)),
      );
    }
  };
  function draw(resetDetail = false) {
    const focused = section.contains(document.activeElement)
      ? document.activeElement?.dataset
      : null;
    const focusTarget = focused?.definitionId
      ? { id: focused.definitionId, kind: focused.definitionKind }
      : null;
    const model = artifact(),
      data = model.content;
    const matches = (item) =>
      `${item.name} ${item.description}`
        .toLowerCase()
        .includes(ui.query.toLowerCase());
    const concepts = data.concepts.filter(matches),
      relations = data.relations.filter(matches);
    scope.textContent = `当前版本：${data.concepts.length} 个概念、${data.relations.length} 条关系定义。待核对 ${(data.conflicts || []).filter((i) => !i.resolvedBy).length} 项冲突、${(data.unknowns || []).filter((i) => !i.resolvedBy).length} 项未知。${ui.query ? `搜索命中 ${concepts.length} 个概念、${relations.length} 条关系。` : ""}图仅展示焦点概念的一跳关系，实例数量未读取。`;
    graphMode.setAttribute("aria-pressed", String(ui.mode === "graph"));
    listMode.setAttribute("aria-pressed", String(ui.mode === "list"));
    diagram.hidden = ui.mode !== "graph";
    list.hidden = ui.mode !== "list";
    list.replaceChildren();
    const name = (id) => data.concepts.find((c) => c.id === id)?.name || id;
    for (const [items, kind, title] of [
      [concepts, "foundation_concept", "概念"],
      [relations, "foundation_relation", "关系定义"],
    ]) {
      list.append(el("h2", "", title));
      if (!items.length) list.append(el("p", "muted", "无匹配项"));
      for (const item of items) {
        const label =
          kind === "foundation_relation"
            ? `${name(item.from)} → ${item.name} → ${name(item.to)}`
            : item.name;
        const control = button(`${label} · ${status(item)}`, () =>
          show(kind, item.id),
        );
        control.dataset.definitionId = item.id;
        control.dataset.definitionKind = kind;
        control.setAttribute(
          "aria-pressed",
          String(ui.member === item.id && ui.kind === kind),
        );
        list.append(control);
      }
    }
    diagram.replaceChildren();
    const center = data.concepts.find((c) => c.id === ui.center && (!ui.query || matches(c))) ||
      concepts[0] || data.concepts.find((c) => c.id === relations[0]?.from);
    if (!center || (!concepts.length && !relations.length)) {
      diagram.append(el("p", "muted", "无匹配定义，请调整搜索。"));
    } else {
      const allEdges = data.relations.filter((r) => r.from === center.id || r.to === center.id);
      const pageCount = Math.max(1, Math.ceil(allEdges.length / 3));
      ui.edgePage = Math.min(ui.edgePage || 0, pageCount - 1);
      const edges = allEdges.slice(ui.edgePage * 3, ui.edgePage * 3 + 3);
      const graph = el("div", "definition-card-graph");
      graph.setAttribute("aria-label", `${center.name}的一跳关系`);
      const rows = Math.max(2, edges.length);
      graph.style.setProperty("--graph-rows", rows);
      const ns = "http://www.w3.org/2000/svg";
      const lines = document.createElementNS(ns, "svg");
      lines.setAttribute("viewBox", `0 0 1000 ${rows * 150}`);
      lines.setAttribute("preserveAspectRatio", "none");
      lines.setAttribute("aria-hidden", "true");
      lines.classList.add("definition-card-lines");
      graph.append(lines);
      const card = (item, primary = false) => {
        const b = button("", () => show("foundation_concept", item.id));
        b.className = `definition-card${primary ? " definition-card-primary" : ""}`;
        b.dataset.definitionId = item.id;
        b.dataset.definitionKind = "foundation_concept";
        b.append(el("span", "definition-card-caption", primary ? "焦点概念" : "关联概念"),
          el("strong", "", item.name), el("span", "definition-card-status", status(item)));
        if (primary) b.append(el("span", "definition-card-open", "含义与依据 ↗"));
        return b;
      };
      const main = card(center, true);
      main.style.gridRow = `1 / span ${rows}`;
      graph.append(main);
      edges.forEach((r, i) => {
        const other = data.concepts.find(c => c.id === (r.from === center.id ? r.to : r.from));
        const y = edges.length === 1 ? rows * 75 : (i + .5) * rows * 150 / edges.length;
        const path = document.createElementNS(ns, "path");
        path.setAttribute("d", `M420,${rows * 75} C545,${rows * 75} 545,${y} 670,${y}`);
        lines.append(path);
        const branch = el("div", "definition-card-branch");
        branch.style.gridRow = edges.length === 1 ? `1 / span ${rows}` : String(i + 1);
        const edge = button(`${r.from === center.id ? "" : "← "}${r.name}${r.from === center.id ? " →" : ""}`, () => show("foundation_relation", r.id));
        edge.className = "definition-card-relation";
        edge.style.transform = `translateY(${(rows * 75 - y) / 2}px)`;
        edge.setAttribute("aria-label", `${name(r.from)} → ${r.name} → ${name(r.to)} · ${status(r)}`);
        edge.dataset.definitionId = r.id; edge.dataset.definitionKind = "foundation_relation";
        branch.append(edge);
        if (other) branch.append(card(other));
        graph.append(branch);
      });
      if (!edges.length) graph.append(el("p", "definition-no-relations", "此概念尚未定义关联关系"));
      diagram.append(graph);
      if (pageCount > 1) {
        const pager = el("div", "definition-card-pager");
        const previous = button("上一组", () => { ui.edgePage--; draw(); });
        const next = button("下一组", () => { ui.edgePage++; draw(); });
        previous.disabled = ui.edgePage === 0; next.disabled = ui.edgePage === pageCount - 1;
        pager.append(previous, el("span", "source-meta", `第 ${ui.edgePage + 1}/${pageCount} 组 · 共 ${allEdges.length} 条关系`), next);
        diagram.append(pager);
      }
      const shown = new Set([center.id, ...edges.flatMap(r => [r.from, r.to])]);
      const others = concepts.filter(c => !shown.has(c.id));
      if (others.length) {
        const rest = el("div", "definition-other-concepts");
        rest.append(el("span", "source-meta", "其他概念"));
        for (const item of others.slice(0, 8)) {
          const b = button(item.name, () => { ui.center = item.id; ui.edgePage = 0; draw(); });
          b.setAttribute("aria-label", `以${item.name}为中心`); rest.append(b);
        }
        if (others.length > 8) rest.append(button(`查看全部 ${concepts.length} 个概念`, () => { ui.mode = "list"; draw(); }));
        diagram.append(rest);
      }
    }
    if (focusTarget)
      [...section.querySelectorAll("[data-definition-id]")]
        .find(
          (e) =>
            e.dataset.definitionId === focusTarget.id &&
            e.dataset.definitionKind === focusTarget.kind &&
            !e.closest("[hidden]"),
        )
        ?.focus({ preventScroll: true });
    if (resetDetail)
      detail.replaceChildren(
        el("p", "muted", "点击概念或关系，查看含义、映射与依据。"),
      );
  }
  version.onchange = () => {
    generation++;
    ui.version = Number(version.value);
    ui.member = null;
    ui.kind = null;
    ui.center = null; ui.edgePage = 0;
    draw(true);
  };
  search.oninput = () => {
    generation++;
    ui.query = search.value;
    ui.member = null;
    ui.kind = null;
    ui.center = null; ui.edgePage = 0;
    draw(true);
  };
  draw(true);

  return section;
}

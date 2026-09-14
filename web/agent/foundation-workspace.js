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
  section.append(el("h1", "", "基础定义与映射"));
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
      `${artifact.status === "adopted" ? "已采用" : "候选待核对"} · v${artifact.version}`,
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
  body.append(diagram, list, detail);
  section.append(toolbar, scope, body);
  const artifact = () => versions.find((v) => v.version === ui.version);
  const target = () => ({ kind: ui.kind, member: ui.member });
  const show = async (kind, member, attach = true) => {
    const request = ++generation;
    const model = artifact();
    ui.kind = kind;
    ui.member = member;
    detail.replaceChildren(el("p", "muted", "正在读取同一业务引用…"));
    draw(false);
    try {
      const result = await (attach
        ? select(
            model,
            target(),
            () => request === generation && section.isConnected,
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
          `${result.target.status === "adopted" ? "已采用" : "候选待核对"} · v${ref.version} · ${status(definition)}`,
        ),
        el("p", "source-meta", `定义标识：${ref.member}`),
      );
      if (!attach)
        detail.append(
          el("p", "muted", "正在查看定义；点“引用到对话”固定本次讨论目标。"),
        );
      detail.append(button("引用到对话", () => show(kind, member)));
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
            "未决项不一定只属于当前目标，完整内容见下方“完整基础定义与采用操作”。",
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
          "映射描述不代表实际值或业务正确性；具体对象与证据可在下方现有执行映射中按需查看。",
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
    scope.textContent = `当前版本：${data.concepts.length} 个概念、${data.relations.length} 条关系定义。待核对 ${(data.conflicts || []).filter((i) => !i.resolvedBy).length} 项冲突、${(data.unknowns || []).filter((i) => !i.resolvedBy).length} 项未知。${ui.query ? `搜索命中 ${concepts.length} 个概念、${relations.length} 条关系。` : ""}图仅展示所选概念的一跳关系，实例数量未读取。`;
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
    const chosenRelation = data.relations.find(
      (r) => r.id === ui.member && ui.kind === "foundation_relation",
    );
    const center =
      data.concepts.find((c) => c.id === (chosenRelation?.from || ui.member)) ||
      concepts[0] ||
      data.concepts.find((c) => c.id === relations[0]?.from);
    if (!center || (!concepts.length && !relations.length))
      diagram.append(el("p", "muted", "无匹配定义，请调整搜索。"));
    else {
      const allEdges = data.relations.filter(
        (r) => r.from === center.id || r.to === center.id,
      );
      const edges = allEdges.slice(0, 8);
      diagram.append(
        el(
          "p",
          "source-meta",
          `${center.name}的一跳局部图 · 显示 ${edges.length}/${allEdges.length} 条关系。更多定义见等价列表；关系箭头表示定义方向。`,
        ),
      );
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      const height = Math.max(220, edges.length * 100);
      svg.setAttribute("viewBox", `0 0 700 ${height}`);
      svg.setAttribute("role", "group");
      svg.setAttribute("aria-label", `${center.name}局部定义图`);
      const shape = (tag, attrs, text) => {
        const e = document.createElementNS(ns, tag);
        for (const [k, v] of Object.entries(attrs))
          e.setAttribute(k, String(v));
        if (text) e.textContent = text;
        return e;
      };
      const control = (label, kind, id, x, y) => {
        const group = shape("g", {
          role: "button",
          tabindex: 0,
          "aria-label": label,
          "aria-pressed": String(ui.member === id && ui.kind === kind),
          class: "definition-node",
        });
        group.dataset.definitionId = id;
        group.dataset.definitionKind = kind;
        group.append(
          shape("rect", {
            x: x - 95,
            y: y - 26,
            width: 190,
            height: 52,
            rx: 7,
          }),
          shape(
            "text",
            { x, y: y + 5, "text-anchor": "middle" },
            label.length > 19 ? label.slice(0, 18) + "…" : label,
          ),
        );
        group.onclick = () => show(kind, id);
        group.onkeydown = (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            show(kind, id);
          }
        };
        svg.append(group);
      };
      edges.forEach((r, i) => {
        const other = data.concepts.find(
          (c) => c.id === (r.from === center.id ? r.to : r.from),
        );
        const y = i * 100 + 50;
        svg.append(
          shape("path", {
            d: `M 215 ${height / 2} L 485 ${y}`,
            class: "definition-edge",
            "stroke-dasharray": r.mappingStatus === "bound" ? "" : "5 4",
          }),
        );
        const label = shape(
          "text",
          {
            x: 350,
            y: (height / 2 + y) / 2 - 8,
            "text-anchor": "middle",
            role: "button",
            tabindex: 0,
            class: "definition-edge-label",
            "aria-label": `${name(r.from)} → ${r.name} → ${name(r.to)} · ${status(r)}`,
          },
          `${r.from === center.id ? "→" : "←"} ${r.name} · ${status(r)}`,
        );
        label.dataset.definitionId = r.id;
        label.dataset.definitionKind = "foundation_relation";
        label.onclick = () => show("foundation_relation", r.id);
        label.onkeydown = (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            show("foundation_relation", r.id);
          }
        };
        svg.append(label);
        if (other)
          control(
            `${other.name} · ${status(other)}`,
            "foundation_concept",
            other.id,
            580,
            y,
          );
      });
      control(
        `${center.name} · ${status(center)}`,
        "foundation_concept",
        center.id,
        120,
        height / 2,
      );
      diagram.append(svg);
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
        el("p", "muted", "选择一个概念或关系，读取含义、映射和依据。"),
      );
  }
  version.onchange = () => {
    generation++;
    ui.version = Number(version.value);
    ui.member = null;
    ui.kind = null;
    draw(true);
  };
  search.oninput = () => {
    generation++;
    ui.query = search.value;
    ui.member = null;
    ui.kind = null;
    draw(true);
  };
  draw(true);
  if (ui.member && ui.kind)
    queueMicrotask(() => show(ui.kind, ui.member, false));
  return section;
}

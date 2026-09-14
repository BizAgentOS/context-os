import { createMemoryGraph } from "./memory-graph.js";
import { renderFusionEvidence } from "./fusion.js";
const el = (tag, cls = "", text = "") => {
  const n = document.createElement(tag);
  n.className = cls;
  n.textContent = text;
  return n;
};
const button = (text, fn) => {
  const n = el("button", "quiet-button", text);
  n.type = "button";
  n.onclick = fn;
  return n;
};
const key = (type, id) => JSON.stringify([type, String(id)]);
const scope = (offset = 0, limit = 20) => ({ where: {}, offset, limit });

export function renderLiveObjects(model, { api, select, selections }) {
  const host = el("section", "live-object-workspace");
  host.setAttribute("aria-label", "在线对象探索");
  const saved = selections.get(`objects:${model.id}:${model.version}`) || {
    type: model.content.types[0]?.name,
    mode: "table",
    id: "",
    offset: 0,
  };
  selections.set(`objects:${model.id}:${model.version}`, saved);
  const controls = el("div", "live-actions"),
    types = el("select");
  types.setAttribute("aria-label", "在线对象类型");
  for (const t of model.content.types) {
    const o = el("option", "", t.name);
    o.value = t.name;
    types.append(o);
  }
  types.value = saved.type;
  const idInput = el("input");
  idInput.setAttribute("aria-label", "按对象编号查找");
  idInput.placeholder = "对象编号（留空分页浏览）";
  idInput.value = saved.id || "";
  const queryForm = el("form", "live-actions");
  const submit = button("读取对象", () => {});
  submit.type = "submit";
  queryForm.append(types, idInput, submit);
  const graphButton = button("关联图", () => {
    saved.mode = "graph";
    draw();
  });
  const tableButton = button("对象表", () => {
    saved.mode = "table";
    draw();
  });
  controls.append(graphButton, tableButton);
  const summary = el("p", "source-meta"),
    pager = el("div", "live-actions"),
    view = el("div", "live-object-view"),
    detail = el("section", "live-object-detail");
  detail.setAttribute("aria-label", "在线对象详情");
  detail.setAttribute("aria-live", "polite");
  const body = el("div", "live-object-body");
  body.append(view, detail);
  host.append(
    el("h3", "", "在线对象探索"),
    queryForm,
    controls,
    summary,
    pager,
    body,
  );
  let generation = 0,
    detailGeneration = 0,
    result = null,
    root = null,
    relation = null,
    selected = null;
  const valid = (t) => t === generation && host.isConnected;
  const query = (type, args = {}) =>
    api("/api/live/query", {
      modelId: model.id,
      modelVersion: model.version,
      type,
      limit: 20,
      ...args,
    });
  const title = (e) => `${e.type} · ${e.row.$id}`;
  const metadata = (r) =>
    `返回 ${r.items.length} 条 · 总数 ${r.coverage.total ?? "未知"} · ${r.coverage.complete ? "本次范围完整" : "分页或覆盖不完整"} · 各源按需读取，非同时点快照`;
  function provenance(parent, r) {
    const d = el("details");
    d.append(
      el("summary", "", "本次读取来源与范围"),
      el("p", "source-meta", metadata(r)),
    );
    for (const read of r.reads || [])
      d.append(el("pre", "source-meta", JSON.stringify(read, null, 2)));
    parent.append(d);
  }
  async function attach(target, requestScope, guard = () => true) {
    const tick = generation,
      dt = detailGeneration;
    await select(
      model,
      target,
      requestScope,
      () => valid(tick) && dt === detailGeneration && guard(),
    );
  }
  function error(parent, e, retry) {
    const p = el("p", "", `读取失败：${e.message}`);
    p.setAttribute("role", "alert");
    parent.replaceChildren(p, button("重试读取", retry));
  }
  async function load(offset = 0) {
    const tick = ++generation;
    detailGeneration++;
    saved.offset = offset;
    if (offset === 0) saved.history = [];
    result = null;
    root = null;
    relation = null;
    selected = null;

    summary.textContent = "正在读取当前源对象…";
    pager.replaceChildren();
    view.replaceChildren();
    detail.replaceChildren();
    try {
      const r = await query(saved.type, {
        offset,
        ...(saved.id ? { id: saved.id } : {}),
      });
      if (!valid(tick)) return;
      result = r;
      summary.textContent = metadata(r);
      draw();
      const chosen =
        r.items.find((row) => key(r.type, row.$id) === saved.selected) ||
        r.items[0];
      if (chosen) inspect({ type: r.type, row: chosen }, r);
    } catch (e) {
      if (valid(tick)) {
        summary.textContent = "对象尚未读取成功";
        error(view, e, () => load(offset));
      }
    }
  }
  function entries() {
    return result?.items.map((row) => ({ type: result.type, row })) || [];
  }
  function draw() {
    graphButton.setAttribute("aria-pressed", String(saved.mode === "graph"));
    tableButton.setAttribute("aria-pressed", String(saved.mode === "table"));
    if (!result) return;
    const entities = entries();
    const all = new Map(entities.map((e) => [key(e.type, e.row.$id), e]));
    if (root && !all.has(key(root.type, root.row.$id)))
      all.set(key(root.type, root.row.$id), root);
    view.replaceChildren();
    if (!entities.length)
      view.append(
        el("p", "muted", "本次范围没有返回对象；不代表业务事实不存在。"),
      );
    if (saved.mode === "graph" && all.size) {
      const nodes = [...all.values()].map((e) => ({
        id: key(e.type, e.row.$id),
        label: String(e.row.$id),
        subtitle: e.type,
        kind:
          root && key(e.type, e.row.$id) === key(root.type, root.row.$id)
            ? "root"
            : "object",
      }));
      const edges =
        root && relation
          ? entities.map((e) => ({
              id: key(e.type, e.row.$id),
              from: key(root.type, root.row.$id),
              to: key(e.type, e.row.$id),
              label: relation.name,
            }))
          : [];
      view.append(
        createMemoryGraph({
          nodes,
          edges,
          ariaLabel: "在线对象与已读关系图",
          selectedId: selected ? key(selected.type, selected.row.$id) : null,
          onSelectNode: (n) => {
            const e = all.get(n.id);
            inspect(e, e === root ? root.result : result);
          },
          onSelectEdge: () => showRelation(),
        }),
      );
    } else if (entities.length) {
      const wrap = el("div", "live-table"),
        table = el("table"),
        head = el("tr");
      const fields = Object.keys(entities[0].row);
      head.append(el("th", "", "对象"));
      for (const f of fields) if (f !== "$id") head.append(el("th", "", f));
      table.append(head);
      for (const e of entities) {
        const tr = el("tr"),
          cell = el("td");
        cell.append(
          button(String(e.row.$id), () => {
            inspect(e, result);
          }),
        );
        tr.append(cell);
        for (const f of fields)
          if (f !== "$id")
            tr.append(
              el(
                "td",
                "",
                e.row[f] === null ? "无确定值" : String(e.row[f] ?? "缺失"),
              ),
            );
        table.append(tr);
      }
      wrap.append(table);
      view.append(wrap);
    }
    if (root)
      view.append(
        button(`返回起点 ${title(root)}`, () => {
          inspect(root, root.result);
          draw();
        }),
      );
    if (relation)
      view.append(button(`查看关系依据：${relation.name}`, showRelation));
    if (saved.mode === "graph")
      view.append(
        el(
          "p",
          "source-meta",
          "仅显示本次返回对象；未读取的关系不画边。对象表提供相同目标的键盘入口。",
        ),
      );
    pager.replaceChildren();
    const offset = relation ? relation.offset : saved.offset;
    const history = relation
      ? (relation.history ||= [])
      : (saved.history ||= []);
    const move = (next) =>
      relation ? expand(root, relation, next) : load(next);
    if (history.length)
      pager.append(button("上一页", () => move(history.pop())));
    const more =
      result.items.length > 0 &&
      (result.coverage.total === null ||
        offset + result.items.length < result.coverage.total);
    if (more)
      pager.append(
        button("下一页", () => {
          history.push(offset);
          move(offset + result.items.length);
        }),
      );
  }
  function inspect(entity, r) {
    detailGeneration++;
    selected = entity;
    saved.selected = key(entity.type, entity.row.$id);
    detail.replaceChildren(
      el("h3", "", title(entity)),
      el(
        "p",
        "source-meta",
        `映射 v${model.version} · 已读结果；重新查询可能变化`,
      ),
    );
    detail.append(
      button("引用对象到对话", () =>
        attach(
          {
            kind: "object",
            type: entity.type,
            objectId: String(entity.row.$id),
          },
          scope(0, 1),
        ),
      ),
    );
    const evidence = r.evidence?.find(
      (e) => String(e.objectId) === String(entity.row.$id),
    );
    for (const [field, value] of Object.entries(entity.row)) {
      const d = el("details", "object-property");
      d.append(
        el(
          "summary",
          "",
          `${field}：${value === null ? "无确定值" : String(value)}${evidence?.properties[field] ? ` · ${{ resolved: "已确定", conflict: "冲突", missing: "缺失", uncertain: "未确定" }[evidence.properties[field].status] || evidence.properties[field].status}` : ""}`,
        ),
      );
      if (evidence?.properties[field])
        d.append(
          renderFusionEvidence([
            {
              ...evidence,
              properties: { [field]: evidence.properties[field] },
            },
          ]),
        );
      else
        d.append(
          el(
            "p",
            "source-meta",
            "此属性来自主来源直接映射，来源字段与本次读取范围见下方。",
          ),
        );
      d.append(
        button(`引用属性 ${field}`, () =>
          attach(
            {
              kind: "property",
              type: entity.type,
              objectId: String(entity.row.$id),
              member: field,
            },
            scope(0, 1),
          ),
        ),
      );
      detail.append(d);
    }
    const type = model.content.types.find((t) => t.name === entity.type);
    const mapping = el("details");
    mapping.append(
      el("summary", "", "对象字段映射"),
      el(
        "pre",
        "source-meta",
        JSON.stringify(
          {
            sourceId: type.sourceId,
            capability: type.capability,
            fields: type.fields,
            supplements: type.supplements || [],
          },
          null,
          2,
        ),
      ),
    );
    detail.append(mapping);
    provenance(detail, r);
    const links = model.content.relations.filter((l) => l.from === entity.type);
    if (!links.length)
      detail.append(el("p", "muted", "当前定义没有出向关系。"));
    for (const l of links)
      detail.append(
        button(`展开 ${l.name}`, () => expand({ ...entity, result: r }, l, 0)),
      );
  }
  async function expand(origin, link, offset) {
    const tick = ++generation;
    detailGeneration++;
    summary.textContent = `正在读取 ${title(origin)} → ${link.name}…`;
    pager.replaceChildren();
    view.replaceChildren();
    detail.replaceChildren();
    result = null;
    try {
      const r = await query(origin.type, {
        id: String(origin.row.$id),
        relation: link.name,
        offset,
      });
      if (!valid(tick)) return;
      const refreshed =
        r.type === origin.type
          ? r.items.find((row) => String(row.$id) === String(origin.row.$id))
          : null;
      root = refreshed ? { ...origin, row: refreshed, result: r } : origin;
      relation = {
        ...link,
        offset,
        history: offset === 0 ? [] : link.history || [],
      };
      result = r;
      summary.textContent = `${title(origin)} → ${link.name} · ${metadata(r)}`;
      draw();
      showRelation();
    } catch (e) {
      if (valid(tick)) {
        summary.textContent = "关系读取失败，未确认有无关联";
        error(view, e, () => expand(origin, link, offset));
        view.append(button("返回对象列表", () => load(0)));
      }
    }
  }
  function showRelation() {
    if (!relation || !root || !result) return;
    detailGeneration++;
    const from = root,
      link = relation,
      r = result;
    detail.replaceChildren(
      el("h3", "", `${title(from)} → ${link.name}`),
      el(
        "p",
        "",
        `${link.from}.${link.fromField} → ${link.to}.${link.toField}`,
      ),
      el("p", "muted", "按本次起点关联字段匹配；不是跨源原子快照。"),
    );
    provenance(detail, r);
    detail.append(
      button("引用这条对象关系", () =>
        attach(
          {
            kind: "relation",
            type: from.type,
            objectId: String(from.row.$id),
            member: link.name,
          },
          scope(link.offset, 20),
        ),
      ),
    );
  }
  queryForm.onsubmit = (e) => {
    e.preventDefault();
    saved.type = types.value;
    saved.id = idInput.value.trim();
    load(0);
  };
  types.onchange = () => {
    saved.type = types.value;
    saved.id = "";
    idInput.value = "";
    load(0);
  };
  queueMicrotask(() => load(saved.offset || 0));
  return host;
}

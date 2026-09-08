import { createMemoryGraph } from "./memory-graph.js";

function el(tag, className = "", text) {
  const item = document.createElement(tag);
  item.className = className;
  if (text !== undefined) item.textContent = String(text);
  return item;
}
function action(text, callback, className = "quiet-button") {
  const item = el("button", className, text);
  item.type = "button";
  item.addEventListener("click", callback);
  return item;
}
function fields(values) {
  const list = el("dl", "memory-properties");
  for (const [key, value] of Object.entries(values || {})) {
    const group = el("div");
    group.append(
      el("dt", "", key),
      el(
        "dd",
        "",
        value == null
          ? "未提供"
          : typeof value === "object"
            ? JSON.stringify(value)
            : value,
      ),
    );
    list.append(group);
  }
  return list;
}
function workspace() {
  const host = el("div", "memory-workspace");
  const stage = el("div", "memory-stage");
  const inspector = el("aside", "memory-inspector");
  inspector.setAttribute("aria-label", "选中内容的含义与依据");
  host.append(stage, inspector);
  return { host, stage, inspector };
}
function sourceRef(artifact, type) {
  const version = artifact.content.sourceVersions?.[type.sourceId];
  return version ? [{ sourceId: type.sourceId, version }] : [];
}
function title(inspector, category, name, description) {
  inspector.replaceChildren(
    el("span", "memory-eyebrow", category),
    el("h2", "", name),
  );
  if (description) inspector.append(el("p", "memory-description", description));
}
function evidence(inspector, refs, renderEvidence, caption = "来源依据") {
  if (!refs?.length) return;
  inspector.append(
    el("h3", "memory-section-title", caption),
    renderEvidence(refs),
  );
}

export function renderDefinitionGraph(artifact, options) {
  const { selection, renderEvidence, onOpenObjects, onOpenType, onAdjust } =
    options;
  const { host, stage, inspector } = workspace();
  const outlined = artifact.kind === "ontology_outline";
  const types =
    (outlined ? artifact.content.concepts : artifact.content.types) || [];
  const relations = artifact.content.relations || [];
  const nodes = types.map((type) => {
    const count = artifact.content.preview?.types?.find(
      (entry) => entry.name === type.name,
    )?.total;
    return {
      id: type.name,
      label: type.name,
      subtitle: outlined
        ? "概念草稿"
        : count === undefined
          ? "业务对象"
          : `${count} 个对象`,
    };
  });
  const edges = relations.map((relation, index) => ({
    id: String(index),
    from: relation.from,
    to: relation.to,
    label: relation.name,
  }));
  const summary = el("div", "memory-summary");
  summary.append(
    el(
      "span",
      "",
      `${types.length} ${outlined ? "个概念" : "类对象"} · ${relations.length} 种关系`,
    ),
    el("span", "", "点击对象或关系，查看业务含义"),
  );
  const graph = el("div", "memory-graph-slot");
  stage.append(summary, graph);
  const diagram = createMemoryGraph({
    nodes,
    edges,
    ariaLabel: outlined ? "业务概念关系图" : "业务对象定义关系图",
    onSelectNode: (item) => {
      selection.kind = "node";
      selection.id = item.id;
      draw();
    },
    onSelectEdge: (item) => {
      selection.kind = "edge";
      selection.id = item.id;
      draw();
    },
  });
  graph.append(diagram);
  function draw() {
    options.onSelectionChange();
    diagram.updateSelection(
      selection.kind === "node" ? selection.id : undefined,
    );
    const type =
      selection.kind === "node" &&
      types.find((item) => item.name === selection.id);
    const relation =
      selection.kind === "edge" && relations[Number(selection.id)];
    if (type) {
      title(
        inspector,
        outlined ? "概念" : "对象定义",
        type.name,
        type.description,
      );
      const links = relations.filter((item) => item.from === type.name);
      if (links.length) {
        inspector.append(el("h3", "memory-section-title", "与其他对象的关系"));
        for (const link of links)
          inspector.append(
            action(
              `${link.name} → ${link.to}`,
              () => {
                selection.kind = "edge";
                selection.id = String(relations.indexOf(link));
                draw();
              },
              "memory-relation-link",
            ),
          );
      }
      if (type.fields) {
        inspector.append(
          el("h3", "memory-section-title", "业务属性"),
          el("p", "memory-field-names", Object.keys(type.fields).join(" · ")),
        );
      }
      evidence(
        inspector,
        outlined ? type.evidence : sourceRef(artifact, type),
        renderEvidence,
        outlined ? "定义依据" : "映射来源",
      );
      const actions = el("div", "memory-actions");
      if (
        !outlined &&
        artifact.content.validation?.valid &&
        artifact.content.preview
      )
        actions.append(
          action(
            "查看具体对象 →",
            () => onOpenObjects(type.name),
            "primary-button",
          ),
        );
      actions.append(
        action("查看完整定义", () => onOpenType(type)),
        action("调整定义", () => onAdjust(type.name)),
      );
      inspector.append(actions);
    } else if (relation) {
      title(
        inspector,
        "关系定义",
        relation.name,
        `${relation.from} → ${relation.to}`,
      );
      if (relation.description)
        inspector.append(el("p", "memory-description", relation.description));
      if (!outlined) {
        const fieldName = (value) => (value === "$id" ? "对象编号" : value);
        inspector.append(
          el("h3", "memory-section-title", "如何关联"),
          el(
            "p",
            "memory-description",
            `将${relation.from}的「${fieldName(relation.fromField)}」与${relation.to}的「${fieldName(relation.toField)}」对应。`,
          ),
        );
      }
      const refs = outlined
        ? relation.evidence
        : types
            .filter((item) => [relation.from, relation.to].includes(item.name))
            .flatMap((type) => sourceRef(artifact, type));
      evidence(inspector, refs, renderEvidence);
      inspector.append(
        action("讨论这条关系", () =>
          onAdjust(`${relation.from}的${relation.name}关系`),
        ),
      );
    } else {
      title(
        inspector,
        "业务结构",
        "这些资料如何连接",
        "每个节点是一类业务对象，箭头表示对象之间已经定义的关系。",
      );
      inspector.append(el("h3", "memory-section-title", "从一类对象开始"));
      const index = el("div", "memory-type-index");
      for (const type of types)
        index.append(
          action(type.name, () => {
            selection.kind = "node";
            selection.id = type.name;
            draw();
          }),
        );
      inspector.append(index);
      if (outlined)
        inspector.append(
          el(
            "p",
            "memory-description",
            "这是文档中的概念草稿，尚未连接到业务记录。",
          ),
        );
      else
        inspector.append(
          el(
            "p",
            "memory-description",
            "切换到“对象”，可以沿着一条实际记录查看它的关联与来源。",
          ),
        );
    }
  }
  draw();
  return host;
}

const objectKey = (entity) => JSON.stringify([entity.type, entity.id]);
const objectLabel = (entity) => entity.fields?.名称 || entity.id;

export function renderObjectGraph(artifact, options) {
  const { selection, api, renderEvidence, onAsk, onOpenType } = options;
  const { host, stage, inspector } = workspace();
  const types = artifact.content.types || [];
  const relations = artifact.content.relations || [];
  const controls = el("div", "memory-object-controls");
  const typeSelect = el("select", "memory-select");
  typeSelect.setAttribute("aria-label", "选择对象类型");
  for (const type of types) {
    const option = el("option", "", type.name);
    option.value = type.name;
    typeSelect.append(option);
  }
  const initial =
    types.find((type) => type.name === selection.type) ||
    [...types].sort(
      (a, b) =>
        relations.filter((r) => r.from === b.name).length -
        relations.filter((r) => r.from === a.name).length,
    )[0];
  selection.type = initial?.name;
  typeSelect.value = selection.type || "";
  const objectSelect = el("select", "memory-select memory-object-select");
  objectSelect.setAttribute("aria-label", "选择具体对象");
  const pager = el("div", "memory-object-pager");
  controls.append(typeSelect, objectSelect, pager);
  const summary = el("p", "memory-summary", "读取对象与直接关联…");
  const graph = el("div", "memory-graph-slot");
  const notes = el("div", "memory-object-notes");
  stage.append(controls, summary, graph, notes);
  let request = 0;
  const query = (type, extra = {}) =>
    api(
      `/api/objects?${new URLSearchParams({ artifactId: artifact.id, version: String(artifact.version), type, ...extra })}`,
    );
  const current = (ticket) => ticket === request && host.isConnected;
  function showError(error) {
    graph.replaceChildren(
      el("p", "view-empty", `暂时无法读取：${error.message}`),
      action("重试", () => loadList()),
    );
    summary.textContent = "关联尚未读取成功";
  }
  async function loadList() {
    options.onSelectionChange();
    const ticket = ++request;
    notes.replaceChildren();
    summary.textContent = "读取对象与直接关联…";
    objectSelect.disabled = true;
    objectSelect.replaceChildren(el("option", "", "正在读取…"));
    graph.replaceChildren(el("p", "loading-note", "正在读取…"));
    inspector.replaceChildren();
    pager.replaceChildren();
    if (!selection.type) {
      graph.replaceChildren(el("p", "view-empty", "还没有可查看的对象类型。"));
      return;
    }
    try {
      const data = await query(selection.type, {
        limit: "30",
        offset: String(selection.offset || 0),
      });
      if (!current(ticket)) return;
      const items = data.result?.items || [];
      objectSelect.replaceChildren();
      for (const entity of items) {
        const option = el(
          "option",
          "",
          `${objectLabel(entity)}${objectLabel(entity) !== entity.id ? ` · ${entity.id}` : ""}`,
        );
        option.value = entity.id;
        objectSelect.append(option);
      }
      const total =
        data.result?.total ?? data.result?.coverage?.total ?? items.length;
      if (total > 30) {
        const move = (offset) => {
          selection.offset = offset;
          selection.id = null;
          loadList();
        };
        const previous = action("上一组", () =>
          move(Math.max(0, (selection.offset || 0) - 30)),
        );
        const next = action("下一组", () => move((selection.offset || 0) + 30));
        previous.disabled = !selection.offset;
        next.disabled = (selection.offset || 0) + items.length >= total;
        pager.append(
          previous,
          el(
            "span",
            "",
            `${(selection.offset || 0) + 1}–${(selection.offset || 0) + items.length} / ${total}`,
          ),
          next,
        );
      }
      if (!selection.id) selection.id = items[0]?.id;
      if (!selection.id) {
        summary.textContent = "这一类对象暂时没有记录";
        graph.replaceChildren(
          el("p", "view-empty", "接入对应的业务资料后，这里会出现具体对象。"),
        );
        return;
      }
      // A neighbor can be outside the first page of the newly selected type.
      if (!items.some((item) => item.id === selection.id)) {
        const option = el("option", "", selection.id);
        option.value = selection.id;
        objectSelect.append(option);
      }
      objectSelect.value = selection.id;
      objectSelect.disabled = false;
      await loadNeighborhood();
    } catch (error) {
      if (current(ticket)) showError(error);
    }
  }
  async function loadNeighborhood() {
    options.onSelectionChange();
    const ticket = ++request;
    notes.replaceChildren();
    graph.replaceChildren(el("p", "loading-note", "正在读取…"));
    inspector.replaceChildren();
    summary.textContent = "读取对象与直接关联…";
    try {
      const data = await query(selection.type, { id: selection.id });
      if (!current(ticket)) return;
      const root = data.result;
      if (!root?.id) throw new Error("找不到这条对象记录");
      if (selection.rootKey !== objectKey(root)) {
        selection.rootKey = objectKey(root);
        selection.inspectedKey = objectKey(root);
      }
      const outgoing = relations.filter(
        (relation) => relation.from === root.type,
      );
      const neighborhoods = await Promise.all(
        outgoing.map(async (relation) => ({
          relation,
          data: await query(root.type, {
            id: root.id,
            relation: relation.name,
          }),
        })),
      );
      if (!current(ticket)) return;
      const entities = new Map([[objectKey(root), root]]);
      const edges = [];
      const empty = [];
      const omittedRelations = new Map();
      let omitted = 0;
      for (const { relation, data: relatedData } of neighborhoods) {
        if (relatedData.snapshot !== data.snapshot)
          throw new Error("关联记录的版本不一致，请重试");
        const related = relatedData.related?.items || [];
        if (!related.length) empty.push(relation.name);
        for (const entity of related) {
          const key = objectKey(entity);
          if (!entities.has(key) && entities.size >= 20) {
            omitted++;
            omittedRelations.set(relation.name, relation);
            continue;
          }
          entities.set(key, entity);
          edges.push({
            id: JSON.stringify([relation.name, key]),
            from: objectKey(root),
            to: key,
            label: relation.name,
          });
        }
      }
      summary.textContent = `${root.type} · ${root.id} 的直接关联${omitted ? " · 仅展示前 20 个对象" : ` · ${entities.size} 个对象`}`;
      const nodes = [...entities.values()].map((entity) => ({
        id: objectKey(entity),
        label: objectLabel(entity),
        subtitle: `${entity.type}${objectLabel(entity) !== entity.id ? ` · ${entity.id}` : ""}`,
        kind: objectKey(entity) === objectKey(root) ? "root" : "object",
      }));
      const diagram = createMemoryGraph({
        nodes,
        edges,
        selectedId: objectKey(root),
        ariaLabel: "具体对象与直接关联图",
        onSelectNode: (item) => inspect(entities.get(item.id)),
        onSelectEdge: (edge) => inspect(entities.get(edge.to)),
      });
      graph.replaceChildren(diagram);
      function inspect(entity) {
        options.onSelectionChange();
        selection.inspectedKey = objectKey(entity);
        diagram.updateSelection(objectKey(entity));
        title(
          inspector,
          entity.type,
          objectLabel(entity),
          objectLabel(entity) !== entity.id ? entity.id : undefined,
        );
        inspector.append(fields(entity.fields));
        evidence(inspector, entity.evidence, renderEvidence, "来源记录");
        const actions = el("div", "memory-actions");
        if (objectKey(entity) !== objectKey(root))
          actions.append(
            action(
              "以此对象展开 →",
              () => {
                selection.type = entity.type;
                selection.id = entity.id;
                selection.offset = 0;
                typeSelect.value = entity.type;
                loadList();
              },
              "primary-button",
            ),
          );
        actions.append(
          action("围绕它提问", () => onAsk(`${entity.type} / ${entity.id}`)),
          action("查看对象定义", () => onOpenType(entity.type)),
        );
        inspector.append(actions);
      }
      inspect(entities.get(selection.inspectedKey) || root);
      if (empty.length)
        notes.append(
          el(
            "p",
            "memory-absence",
            `本次记录中暂无：${empty.join("、")}。没有关联记录，不代表业务事实不存在。`,
          ),
        );
      notes.append(
        el(
          "p",
          "memory-snapshot-note",
          "按所选定义保存时的记录展示；点击关联对象，可继续展开。",
        ),
      );
      for (const relation of omittedRelations.values())
        notes.append(
          action(`查看全部「${relation.name}」关联`, () =>
            options.onOpenRelated(root, relation),
          ),
        );
    } catch (error) {
      if (current(ticket)) showError(error);
    }
  }
  typeSelect.addEventListener("change", () => {
    selection.type = typeSelect.value;
    selection.id = null;
    selection.offset = 0;
    notes.replaceChildren();
    loadList();
  });
  objectSelect.addEventListener("change", () => {
    selection.id = objectSelect.value;
    loadNeighborhood();
  });
  // The caller attaches the returned workspace before the first response arrives.
  loadList();
  return host;
}

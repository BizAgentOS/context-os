const el = (tag, text, cls = "") => {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const button = (text, fn) => {
  const b = el("button", text, "quiet-button");
  b.type = "button";
  b.onclick = fn;
  return b;
};
const states = {
  resolved: "已确定",
  missing: "缺失",
  conflict: "冲突",
  uncertain: "未确定",
  unique: "唯一匹配",
  ambiguous: "多个匹配",
  unknown: "覆盖或匹配未确定",
  unavailable: "来源不可用",
  missing_key: "缺少匹配键",
};
export function renderFusionEvidence(evidence) {
  const root = el("section", undefined, "fusion-evidence");
  root.setAttribute("aria-label", "多源融合依据");
  if (!evidence?.length) return root;
  root.append(
    el("h3", "多源融合依据"),
    el(
      "p",
      "冲突和未确定属性不会静默选择来源；展开查看原值与读取范围。",
      "source-meta",
    ),
  );
  for (const object of evidence) {
    const details = el("details");
    const issues = Object.values(object.properties).filter(
      (p) => p.status !== "resolved",
    ).length;
    details.append(
      el(
        "summary",
        `对象 ${object.objectId} · ${issues ? issues + " 项缺失、冲突或未确定" : "属性已确定"}`,
      ),
    );
    for (const [field, cell] of Object.entries(object.properties)) {
      const card = el("section", undefined, "live-card");
      card.append(
        el("h4", `${field} · ${states[cell.status]}`),
        el("p", cell.value === null ? "当前没有可确认值" : String(cell.value)),
      );
      for (const e of cell.evidence)
        card.append(
          el(
            "p",
            `${e.eligible ? "有效匹配" : "候选，未用于确定值"}：${e.value === null ? "空值" : String(e.value)} · ${e.sourceTitle || e.sourceId} / ${e.capability} · 记录 ${e.recordId} · 字段 ${e.field} · ${e.readAt}`,
            "source-meta",
          ),
        );
      if (cell.blockers.length)
        card.append(el("p", `尚未确定的来源：${cell.blockers.join("、")}`));
      details.append(card);
    }
    for (const m of object.matches)
      details.append(
        el(
          "p",
          `${m.binding} · ${states[m.status]}：${m.reason}${m.coverage ? ` · 返回${m.coverage.shown}条 / 总数${m.coverage.total ?? "未知"}` : ""} · ${m.readAt ? "读取于 " + m.readAt : "尝试于 " + m.attemptedAt}`,
          "source-meta",
        ),
      );
    root.append(details);
  }
  return root;
}
function input(parent, label, value = "", multiline = false) {
  const wrap = el("label", undefined, "live-field"),
    n = el(multiline ? "textarea" : "input");
  n.value = value;
  wrap.append(el("span", label), n);
  parent.append(wrap);
  return n;
}
function select(parent, label, options, value) {
  const wrap = el("label", undefined, "live-field"),
    n = el("select");
  for (const [v, title] of options) {
    const o = el("option", title);
    o.value = v;
    n.append(o);
  }
  if (value !== undefined) n.value = value;
  wrap.append(el("span", label), n);
  parent.append(wrap);
  return n;
}
export function createSupplementEditor(choices, initial = []) {
  choices = [...choices];
  for (const saved of initial) {
    if (
      !choices.some(
        (c) =>
          c.source.id === saved.sourceId && c.cap.name === saved.capability,
      )
    )
      choices.push({
        unavailable: true,
        source: { id: saved.sourceId, title: "来源不可用（请重新选择或移除）" },
        cap: {
          name: saved.capability,
          fields: [...new Set(Object.values(saved.fields))],
          filters: { [saved.match.sourceField]: saved.match.sourceField },
        },
      });
  }
  const root = el("details");
  root.addEventListener(
    "invalid",
    () => {
      root.open = true;
    },
    true,
  );
  root.append(el("summary", "附来源：按业务键补充属性"));
  root.append(
    el(
      "p",
      "最多3个附来源。主来源决定对象集合；同名业务属性用于对照，含义或单位不同请使用不同属性名。",
      "source-meta",
    ),
  );
  const entries = [],
    container = el("div");
  root.append(container);
  const add = (saved) => {
    if (entries.length >= 3) return;
    const card = el("fieldset");
    card.style.minWidth = "0";
    const title = input(card, "附来源名称", saved?.name ?? "");
    title.required = true;
    const current = Math.max(
      0,
      choices.findIndex(
        (c) =>
          c.source.id === saved?.sourceId && c.cap.name === saved?.capability,
      ),
    );
    const source = select(
      card,
      "附来源能力",
      choices.map((c, i) => [String(i), `${c.source.title} · ${c.cap.name}`]),
      String(current),
    );
    const primary = input(
      card,
      "主来源业务键（属性名或 $id）",
      saved?.match.primaryField ?? "$id",
    );
    primary.required = true;
    const targetWrap = el("div"),
      mapping = el("div");
    card.append(targetWrap, mapping);
    let target,
      rows = [];
    const addField = (property = "", field) => {
      const row = el("div", undefined, "live-card");
      const key = input(row, "融合业务属性名", property);
      key.required = true;
      const column = select(
        row,
        "附来源字段",
        choices[Number(source.value)].cap.fields.map((f) => [f, f]),
        field,
      );
      const item = { row, key, column };
      rows.push(item);
      row.append(
        button("移除此属性", () => {
          rows = rows.filter((r) => r !== item);
          row.remove();
        }),
      );
      mapping.append(row);
    };
    const rebuild = (value) => {
      targetWrap.replaceChildren();
      mapping.replaceChildren();
      rows = [];
      const cap = choices[Number(source.value)].cap;
      target = select(
        targetWrap,
        "附来源匹配字段",
        Object.keys(cap.filters).map((f) => [f, f]),
        value?.match.sourceField,
      );
      if (value)
        for (const [property, field] of Object.entries(value.fields))
          addField(property, field);
      else addField();
    };
    source.onchange = () => rebuild();
    rebuild(saved);
    card.append(button("增加融合属性", () => addField()));
    const rationale = input(
      card,
      "同实体与属性口径依据",
      saved?.rationale ?? "",
      true,
    );
    rationale.required = true;
    const entry = {
      card,
      read: () => {
        const pairs = rows.map((r) => [r.key.value.trim(), r.column.value]);
        if (
          !pairs.length ||
          new Set(pairs.map(([k]) => k)).size !== pairs.length ||
          pairs.some(([k]) => !k || k === "$id" || k === "__proto__")
        )
          throw new Error("附来源需要唯一且非保留名的业务属性");
        const choice = choices[Number(source.value)];
        if (!choice || choice.unavailable)
          throw new Error("附来源已不可用，请明确重新选择或移除该映射");
        const { source: connection, cap } = choice;
        return {
          name: title.value,
          sourceId: connection.id,
          capability: cap.name,
          match: { primaryField: primary.value, sourceField: target.value },
          fields: Object.fromEntries(pairs),
          rationale: rationale.value,
        };
      },
    };
    entries.push(entry);
    card.append(
      button("移除此附来源", () => {
        entries.splice(entries.indexOf(entry), 1);
        card.remove();
      }),
    );
    container.append(card);
  };
  for (const s of initial) add(s);
  root.append(button("添加附来源", () => add()));
  return { element: root, read: () => entries.map((e) => e.read()) };
}

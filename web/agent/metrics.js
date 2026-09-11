const el = (tag, text, cls = "") => {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const field = (form, title, type = "text") => {
  const label = el("label", undefined, "live-field");
  const input = el("input");
  input.type = type;
  label.append(el("span", title), input);
  form.append(label);
  return input;
};
const button = (title, fn) => {
  const b = el("button", title, "quiet-button");
  b.type = "button";
  b.onclick = fn;
  return b;
};
const kinds = {
  sum: "求和",
  ratio: "比率",
  average: "平均",
  distinct_count: "去重计数",
  snapshot: "时点存量",
};

/** Human projection of the same definition and observation receipt returned to the agent. */
export function renderMetricInspector(source, cap, api) {
  const root = el("section");
  root.setAttribute("aria-label", "BI 指标预览");
  const details = el("div"),
    output = el("div");
  output.setAttribute("aria-live", "polite");
  const form = el("form"),
    fields = el("fieldset");
  fields.style.border = "0";
  fields.style.padding = "0";
  const args = {
    sourceId: source.id,
    capability: cap.name,
    connectionVersion: source.version,
  };
  let generation = 0,
    definition,
    definitionHash,
    inputs = Object.create(null),
    start,
    end,
    scope;
  const refresh = button("读取指标定义", () => loadDefinition());
  const submit = button("查询指标", () => {});
  submit.type = "submit";
  const next = button("下一页观测", () => query(scope.nextOffset));
  next.hidden = true;
  form.append(fields, submit);
  form.hidden = true;
  root.append(refresh, details, form, output, next);
  const error = (e) => {
    const p = el("p", e.message);
    p.setAttribute("role", "alert");
    output.replaceChildren(p);
  };
  const loadDefinition = async () => {
    const seq = ++generation;
    refresh.disabled = true;
    form.hidden = true;
    output.replaceChildren();
    details.replaceChildren();
    next.hidden = true;
    try {
      const result = await api("/api/live/metrics/describe", args);
      if (seq !== generation || !root.isConnected) return;
      definition = result.definition;
      definitionHash = result.definitionHash;
      const d = definition,
        a = d.aggregation;
      details.append(
        el("h3", d.name),
        el("p", d.description),
        el(
          "p",
          `单位 ${d.unit} · ${d.grain === "month" ? "月" : "日"}粒度 · ${d.timeZone} · 定义版本 ${d.revision}`,
          "source-meta",
        ),
        el(
          "p",
          `${kinds[a.kind]} · ${a.timeAdditive ? "可跨期间加总" : "不可跨期间直接加总"} · 可加总维度：${a.additiveDimensions.join("、") || "无"}`,
          "source-meta",
        ),
        el(
          "p",
          `定义读取于 ${new Date(result.provenance.readAt).toLocaleString("zh-CN")}`,
          "source-meta",
        ),
      );
      fields.replaceChildren();
      inputs = Object.create(null);
      start = field(fields, "开始日期（含）", "date");
      end = field(fields, "结束日期（不含）", "date");
      start.required = end.required = true;
      fields.append(
        el(
          "p",
          `日期按 ${d.timeZone} 的日历解释，最多366天。${d.grain === "month" ? "月指标的开始和结束日期须为每月1日。" : ""}`,
          "source-meta",
        ),
      );
      for (const dimension of d.dimensions)
        inputs[dimension.name] = field(
          fields,
          `${dimension.label}（精确匹配，可留空）`,
        );
      form.hidden = false;
    } catch (e) {
      if (seq === generation) error(e);
    } finally {
      if (seq === generation) refresh.disabled = false;
    }
  };
  const query = async (offset = 0) => {
    const seq = ++generation;
    const currentScope =
      offset === 0
        ? {
            start: start.value,
            end: end.value,
            where: Object.fromEntries(
              Object.entries(inputs)
                .filter(([, input]) => input.value !== "")
                .map(([k, input]) => [k, input.value]),
            ),
          }
        : scope;
    fields.disabled = true;
    submit.disabled = true;
    refresh.disabled = true;
    next.hidden = true;
    output.replaceChildren(el("p", "正在读取指标…", "source-meta"));
    try {
      const result = await api("/api/live/metrics/query", {
        ...args,
        definitionHash,
        start: currentScope.start,
        end: currentScope.end,
        where: currentScope.where,
        offset,
        limit: 20,
      });
      if (seq !== generation || !root.isConnected) return;
      scope = { ...currentScope, nextOffset: result.coverage.nextOffset };
      const d = result.definition,
        c = result.coverage;
      output.replaceChildren(
        el("h3", `${d.name} · ${d.unit}`),
        el(
          "p",
          `${result.query.start}（含）— ${result.query.end}（不含） · ${d.timeZone} · ${d.grain === "month" ? "月" : "日"}粒度`,
          "source-meta",
        ),
        el(
          "p",
          `本次过滤：${
            Object.entries(result.query.where)
              .map(([k, v]) => `${k}=${v}`)
              .join("、") || "所授权指标的全部维度值"
          }`,
          "source-meta",
        ),
        el(
          "p",
          `返回 ${c.shown} 项观测 · ${c.complete ? "查询结果完整" : "仅部分结果，不能代表全量"} · 源数据覆盖：${c.dataComplete === null ? "未知" : c.dataComplete ? "来源声明完整" : "存在缺失或尚未完成"}`,
          "source-meta",
        ),
      );
      if (!result.items.length)
        output.append(el("p", "当前范围没有观测；不表示指标为零。"));
      else {
        const wrap = el("div", undefined, "live-table"),
          table = el("table"),
          head = el("tr");
        for (const title of [
          ...d.dimensions.map((x) => x.label),
          "期间（左闭右开）",
          `数值（${d.unit}）`,
          "状态",
        ])
          head.append(el("th", title));
        table.append(head);
        for (const item of result.items) {
          const row = el("tr");
          row.dataset.observationId = item.observationId;
          for (const value of [
            ...d.dimensions.map((x) => item.dimensions[x.name]),
            `${item.periodStart} — ${item.periodEnd}`,
            item.value === null ? "—" : String(item.value),
            item.status === "missing"
              ? `缺失：${item.missingReason}`
              : "已观测",
          ])
            row.append(el("td", value));
          table.append(row);
        }
        wrap.append(table);
        output.append(wrap);
      }
      output.append(
        el(
          "p",
          `读取于 ${new Date(result.provenance.readAt).toLocaleString("zh-CN")} · 定义版本 ${d.revision} · 汇总观测，不是业务明细；本次未执行跨维度或跨期间合计。`,
          "source-meta",
        ),
      );
      next.hidden = c.nextOffset === null;
    } catch (e) {
      if (seq === generation) error(e);
    } finally {
      if (seq === generation) {
        fields.disabled = false;
        submit.disabled = false;
        refresh.disabled = false;
      }
    }
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    void query();
  };
  void loadDefinition();
  return root;
}

import { renderFusionEvidence } from "./fusion.js";
import { safeText, displayValue, fieldLabel, technicalDetails } from "./ui-display.js";
const el = (tag, text, cls = "") => {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = safeText(text);
  return n;
};
const button = (text, action) => {
  const b = el("button", text, "quiet-button");
  b.type = "button";
  b.onclick = action;
  return b;
};
const input = (parent, title, tag = "input") => {
  const label = el("label", undefined, "live-field"),
    n = el(tag);
  label.append(el("span", title), n);
  parent.append(label);
  return n;
};
function options(select, items) {
  select.replaceChildren();
  for (const [value, text] of items) {
    const o = el("option", text);
    o.value = value;
    select.append(o);
  }
}
function dialog(title) {
  const d = el("dialog", undefined, "live-dialog");
  d.append(
    el("h2", title),
    button("关闭", () => d.close()),
  );
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}
function table(items) {
  const wrap = el("div", undefined, "live-table"),
    t = el("table");
  const keys = [...new Set(items.flatMap((x) => Object.keys(x)))];
  const head = el("tr");
  for (const key of keys) head.append(el("th", propertyLabel(key)));
  t.append(head);
  for (const item of items) {
    const row = el("tr");
    for (const key of keys)
      row.append(el("td", item[key] == null ? "—" : displayValue(item[key])));
    t.append(row);
  }
  wrap.append(t);
  return wrap;
}
const meta = (text) => el("p", text, "source-meta");
const propertyLabel = key => key === "$id" ? "对象编号" : fieldLabel(key);
const filterSummary = where => Object.entries(where || {}).map(([key, value]) => `${propertyLabel(key)}为${displayValue(value)}`).join("，") || "无额外筛选";
const originalQuote = text => { const quote = document.createElement("blockquote"); quote.textContent = text; return quote; };
const status = { collected: "选取范围已读", partial: "有缺口或冲突" };
function renderPacket(view) {
  const a = view.artifact,
    p = a.content,
    root = el("section");
  root.append(
    el("h3", a.title),
    meta(
      `${status[a.status]} · 取证于 ${p.collectedAt} · 映射 v${p.model.version}（${p.model.status === "adopted" ? "已采用" : "候选预览"}）`,
    ),
    meta("保存的读取时证据，不代表当前源状态。" + p.scope),
  );
  if (!view.modelCurrent || view.dependencies.some((d) => !d.available))
    root.append(
      el(
        "p",
        "部分映射或来源已变化/停用。以下保留历史读取，重新取证需要核对当前依赖。",
        "validation-error",
      ),
    );
  root.append(el("h3", "业务对象与关系"));
  const q = p.request.objects;
  root.append(
    meta(
      `对象范围：${q.type || "所选实体"} · ${q.id || "当前分页集合"} · 从第 ${(q.offset ?? 0) + 1} 条起，最多 ${q.limit} 条 · ${filterSummary(q.where)} · 属性 ${q.fields.map(propertyLabel).join("、")}`,
    ),
  );
  if (p.request.objects.relation)
    root.append(
      meta(
        `关系：${p.request.objects.type} / ${p.request.objects.id} → ${p.request.objects.relation}`,
      ),
    );
  const objects = p.objects;
  if (objects.status === "read") {
    root.append(
      table(objects.result.items),
      meta(
        `本次返回 ${objects.result.coverage.shown} 条 / 总数 ${objects.result.coverage.total ?? "未知"} · ${objects.result.coverage.complete ? "该查询范围完整" : "部分结果"} · ${objects.result.reads.map((r) => r.readAt).join(" / ")}`,
      ),
    );
    if (objects.result.evidence)
      root.append(renderFusionEvidence(objects.result.evidence));
  } else root.append(el("p", objects.error));
  for (const doc of p.documents) {
    const section = el("section", undefined, "live-card");
    section.append(
      el("h3", doc.status === "read" ? doc.result.title : "文档未读成"),
      meta("关联理由（待业务核对）：" + doc.rationale),
    );
    section.append(
      meta(
        `来源 ${doc.sourceTitle || "所选文档来源"} · 来源第 ${doc.request.connectionVersion} 版 · 片段修订 ${doc.request.revision} · 从第 ${(doc.request.offset ?? 0) + 1} 个字符起，最多 ${doc.request.limit} 个字符`,
      ),
    );
    if (doc.status === "read") {
      const r = doc.result;
      const excerpt = el("details");
      excerpt.append(
        el("summary", `查看全部已读片段（${r.text.length}字符）`),
        originalQuote(r.text),
      );
      section.append(
        originalQuote(r.text.slice(0, 180) + (r.text.length > 180 ? "…（预览，可展开）" : "")),
        excerpt,
        meta(
          `片段修订 ${r.revision} · 字符 ${r.start}–${r.end} / ${r.coverage.totalCharacters} · ${r.coverage.complete ? "片段完整" : "部分片段，未读部分未知"} · ${r.readAt}`,
        ),
      );
    } else section.append(el("p", doc.error));
    root.append(section);
  }
  for (const metric of p.metrics) {
    const section = el("section", undefined, "live-card");
    section.append(
      el(
        "h3",
        metric.status === "read" ? metric.result.definition.name : "指标未读成",
      ),
      meta("关联理由（待业务核对）：" + metric.rationale),
    );
    section.append(
      meta(
        `来源 ${metric.sourceTitle || "所选指标来源"} · 来源第 ${metric.request.connectionVersion} 版`,
      ),
      meta(
        `请求期间 ${metric.request.start} 至 ${metric.request.end}（结束日不含） · ${filterSummary(metric.request.where)} · 从第 ${(metric.request.offset ?? 0) + 1} 条起，最多 ${metric.request.limit} 条`,
      ),
      meta(
        `维度绑定：${metric.dimensionBindings.map((b) => b.dimension + " → " + b.property).join("、") || "无，仅作背景"}`,
      ),
    );
    if (metric.status === "read") {
      const r = metric.result,
        d = r.definition;
      section.append(
        el("p", d.description),
        meta(
          `${d.unit} · ${d.grain === "month" ? "月" : "日"}粒度 · ${d.timeZone} · ${r.query.start} 至 ${r.query.end}（结束日不含）`,
        ),
        meta(
          `口径 ${d.revision} · ${d.aggregation.timeAdditive ? "允许按时间加总" : "不可按时间直接加总"} · 可加总维度：${d.aggregation.additiveDimensions.join("、") || "无"}`,
        ),
        table(
          r.items.map((i) => ({
            ...Object.fromEntries(
              Object.entries(i.dimensions).map(([key, value]) => [
                "维度：" + key,
                value,
              ]),
            ),
            开始: i.periodStart,
            结束: i.periodEnd,
            数值: i.value,
            单位: d.unit,
            状态: i.status === "observed" ? "已观测" : i.missingReason,
          })),
        ),
        meta(
          `返回 ${r.coverage.shown} / 总数 ${r.coverage.total ?? "未知"} · ${r.coverage.complete ? "查询范围完整" : "分页/范围不完整"} · 数据覆盖 ${r.coverage.dataComplete === true ? "源声明完整" : r.coverage.dataComplete === false ? "不完整" : "未知"} · 读取 ${r.provenance.readAt}`,
        ),
        el("p", metric.association.reason),
      );
      for (const link of metric.association.links || [])
        section.append(
          meta(
            `观测 ${link.observationId.slice(0, 12)} · 匹配对象：${link.objectIds.join("、") || "无"} · 未确定对象：${link.uncertainObjectIds.join("、") || "无"}`,
          ),
        );
    } else section.append(el("p", metric.error));
    root.append(section);
  }
  root.append(technicalDetails(p));
  return root;
}
export function renderEvidenceWorkspace(state, { api, mutate }) {
  const root = el("section", undefined, "foundation-panel");
  root.setAttribute("aria-label", "共同取证");
  root.append(
    el("h2", "共同取证"),
    el(
      "p",
      "围绕一个业务问题，将文档口径、指标范围和对象依据放在一起，保留冲突与未知。",
    ),
  );
  const inspect = async (ref) => {
    const d = dialog("共同取证记录");
    try {
      const view = await api("/api/live/evidence/read", ref);
      if (!d.isConnected) return;
      d.append(
        renderPacket(view),
        button("按相同范围重新取证", async () => {
          const ok = await mutate(
            "/api/live/evidence/collect",
            view.artifact.content.request,
            (r) => inspect({ id: r.saved.id, version: r.saved.version }),
          );
          if (ok) d.close();
        }),
      );
    } catch (e) {
      d.append(el("p", e.message));
    }
  };
  root.append(
    button("新建共同取证", () => createForm(state.live, api, mutate, inspect)),
  );
  for (const item of state.evidence || []) {
    const card = el("article", undefined, "live-card");
    card.append(
      el("h3", item.title),
      meta(`${status[item.status]} · ${item.createdAt}`),
      button("查看取证记录", () =>
        inspect({ id: item.id, version: item.version }),
      ),
    );
    root.append(card);
  }
  if (!(state.evidence || []).length)
    root.append(
      meta("尚无共同取证记录，也可以让助手按明确对象、文档与期间进行取证。"),
    );
  return root;
}
function createForm(live, api, mutate, inspect) {
  const d = dialog("共同取证"),
    form = el("form"),
    fields = el("fieldset"),
    output = el("div");
  output.setAttribute("aria-live", "polite");
  fields.style.minWidth = "0";
  form.append(fields);
  d.append(form, output);
  const models = live.models
    .filter((m) => m.status === "adopted")
    .flatMap((model) => model.content.types.map((type) => ({ model, type })));
  const caps = (kind) =>
    live.connections
      .filter((s) => s.status === "ready")
      .flatMap((source) =>
        source.content.capabilities
          .filter((c) => c.contentKind === kind)
          .map((cap) => ({ source, cap })),
      );
  const knowledge = caps("knowledge"),
    metrics = caps("metrics");
  if (!models.length || !knowledge.length || !metrics.length) {
    output.textContent =
      "需要已采用的业务对象映射、知识文档能力和指标能力。请先完成接入；助手也可基于候选映射预览取证。";
    return;
  }
  const question = input(fields, "业务问题", "textarea");
  question.required = true;
  const object = input(fields, "对象类型", "select");
  options(
    object,
    models.map((m, i) => [
      String(i),
      `${m.type.name} · 映射 v${m.model.version}`,
    ]),
  );
  const objectId = input(fields, "对象编号（留空读取前5条）");
  const property = input(fields, "读取业务属性（逗号分隔；自动包含对象编号）");
  property.required = true;
  const changeType = () => {
    const t = models[Number(object.value)].type;
    property.value = [
      ...new Set([
        ...Object.keys(t.fields),
        ...(t.supplements || []).flatMap((s) => Object.keys(s.fields)),
      ]),
    ].filter(name => name !== "$id")
      .slice(0, 19)
      .join(", ");
  };
  object.onchange = changeType;
  changeType();
  const docSource = input(fields, "知识文档来源", "select");
  options(
    docSource,
    knowledge.map((k, i) => [String(i), `${k.source.title} · ${k.cap.name}`]),
  );
  const segment = input(fields, "文档片段（目录当前页）", "select"),
    docMeta = meta("");
  fields.append(docMeta);
  const docReason = input(fields, "文档关联理由", "textarea");
  docReason.required = true;
  const metricSource = input(fields, "指标来源", "select");
  options(
    metricSource,
    metrics.map((m, i) => [String(i), `${m.source.title} · ${m.cap.name}`]),
  );
  const definitionInfo = meta("");
  fields.append(definitionInfo);
  const start = input(fields, "期间开始（包含）"),
    end = input(fields, "期间结束（不含）");
  start.type = end.type = "date";
  start.required = end.required = true;
  const metricReason = input(fields, "指标关联理由", "textarea");
  metricReason.required = true;
  const binding = input(fields, "指标维度关联（可选）", "select");
  const objectField = input(fields, "对应对象属性（留空则仅为背景）");
  const save = button("读取并保存取证记录", () => {});
  save.type = "submit";
  form.append(save);
  let segments = [],
    definition,
    docGeneration = 0,
    metricGeneration = 0,
    docLoading = false,
    metricLoading = false;
  const args = (choice) => ({
    sourceId: choice.source.id,
    capability: choice.cap.name,
    connectionVersion: choice.source.version,
  });
  const loadDoc = async () => {
    const generation = ++docGeneration;
    docLoading = true;
    segments = [];
    options(segment, []);
    try {
      const r = await api("/api/live/knowledge/query", {
        ...args(knowledge[Number(docSource.value)]),
        limit: 10,
      });
      if (generation !== docGeneration) return;
      segments = r.items;
      options(
        segment,
        segments.map((x, i) => [String(i), `${x.title} · ${x.segmentId}`]),
      );
      docMeta.textContent = `目录本页 ${r.coverage.shown} 条，${r.coverage.complete ? "当前目录完整" : "不是全量目录；可由助手继续分页定位"}。取证最多读取所选片段前4000字符。`;
    } catch (e) {
      docMeta.textContent = safeText(e.message);
    } finally {
      if (generation === docGeneration) docLoading = false;
    }
  };
  const loadMetric = async () => {
    const generation = ++metricGeneration;
    metricLoading = true;
    definition = undefined;
    options(binding, [["", "仅作背景指标"]]);
    try {
      const r = await api(
        "/api/live/metrics/describe",
        args(metrics[Number(metricSource.value)]),
      );
      if (generation !== metricGeneration) return;
      definition = r;
      definitionInfo.textContent = safeText(`${r.definition.name} · ${r.definition.unit} · ${r.definition.grain === "month" ? "月" : "日"} · ${r.definition.timeZone} · ${r.definition.description}`);
      options(binding, [
        ["", "仅作背景指标"],
        ...r.definition.dimensions.map((x) => [x.name, x.label]),
      ]);
    } catch (e) {
      definitionInfo.textContent = safeText(e.message);
    } finally {
      if (generation === metricGeneration) metricLoading = false;
    }
  };
  docSource.onchange = loadDoc;
  metricSource.onchange = loadMetric;
  void loadDoc();
  void loadMetric();
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (docLoading || metricLoading || !definition || !segments.length) {
      output.textContent = "请等待来源读取成功并选择片段。";
      return;
    }
    if (Boolean(binding.value) !== Boolean(objectField.value.trim())) {
      output.textContent =
        "维度和对应对象属性需要一起填写，或一起留空仅作背景。";
      return;
    }
    const selected = models[Number(object.value)],
      doc = segments[Number(segment.value)];
    const request = {
      question: question.value,
      objects: {
        modelId: selected.model.id,
        modelVersion: selected.model.version,
        type: selected.type.name,
        ...(objectId.value.trim() ? { id: objectId.value.trim() } : {}),
        fields: [...new Set(["$id", ...property.value
          .split(/[,，]/)
          .map((x) => x.trim())
          .filter(Boolean)])],
        limit: 5,
      },
      documents: [
        {
          ...args(knowledge[Number(docSource.value)]),
          segmentId: doc.segmentId,
          revision: doc.revision,
          limit: 4000,
          rationale: docReason.value,
        },
      ],
      metrics: [
        {
          ...args(metrics[Number(metricSource.value)]),
          definitionHash: definition.definitionHash,
          start: start.value,
          end: end.value,
          limit: 20,
          rationale: metricReason.value,
          dimensionBindings: binding.value
            ? [{ dimension: binding.value, property: objectField.value.trim() }]
            : [],
        },
      ],
    };
    fields.disabled = true;
    save.disabled = true;
    output.textContent = "正在读取并核对来源…";
    const ok = await mutate(
      "/api/live/evidence/collect",
      request,
      (r) => {
        d.close();
        void inspect({ id: r.saved.id, version: r.saved.version });
      },
      (e) => {
        output.textContent = safeText(e.message);
      },
    );
    if (!ok) {
      fields.disabled = false;
      save.disabled = false;
    }
  };
}

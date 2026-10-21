import { safeText, displayValue, technicalDetails } from "./ui-display.js";
import { renderFusionEvidence, createSupplementEditor } from "./fusion.js";
const el = (tag, text, cls = "") => {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = safeText(text);
  return node;
};
const button = (text, action) => {
  const node = el("button", text, "quiet-button");
  node.type = "button";
  node.onclick = action;
  return node;
};
function dialogFor(title) {
  const dialog = el("dialog", undefined, "live-dialog");
  dialog.append(
    el("h2", title),
    button("关闭", () => dialog.close()),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
export function previewBinding(concept, binding, api) {
  const dialog = dialogFor(`${concept.name} · 业务实例`);
  const output = el("div");
  output.setAttribute("aria-live", "polite");
  const next = button("下一页", () => load(offset));
  next.hidden = true;
  let offset = 0;
  dialog.append(output, next);
  const load = async (position) => {
    next.disabled = true;
    next.hidden = true;
    output.replaceChildren(el("p", "正在读取来源…"));
    try {
      const result = await api("/api/live/query", {
        modelId: binding.modelId,
        modelVersion: binding.modelVersion,
        conceptId: concept.id,
        offset: position,
        limit: 20,
      });
      if (!dialog.isConnected) return;
      const ref = result.conceptRef;
      output.replaceChildren(
        el(
          "p",
          `${binding.status === "adopted" ? "已采用映射" : "候选预览"} · 业务对象 · 本体版本 ${ref.foundationVersion}`,
          "source-meta",
        ),
      );
      const wrap = el("div", undefined, "live-table"),
        table = el("table");
      const keys = result.items.length ? Object.keys(result.items[0]) : [];
      const head = el("tr");
      for (const key of keys) head.append(el("th", key));
      table.append(head);
      for (const item of result.items) {
        const row = el("tr");
        row.dataset.conceptId = ref.conceptId;
        row.dataset.objectId = String(item.$id);
        for (const key of keys) row.append(el("td", String(item[key] ?? "—")));
        table.append(row);
      }
      wrap.append(table);
      output.append(
        wrap,
        el(
          "p",
          `返回 ${result.coverage.shown} 条 · ${result.coverage.complete ? "当前查询完整" : "部分结果，不代表全量"} · 读取于 ${result.reads.map((r) => r.readAt).join(" / ")}`,
          "source-meta",
        ),
      );
      if (result.evidence) output.append(renderFusionEvidence(result.evidence));
      if (!result.items.length)
        output.append(el("p", "当前范围没有实例，不表示该业务概念不存在。"));
      offset = position + result.items.length;
      next.hidden =
        result.coverage.total === null
          ? !result.items.length
          : offset >= result.coverage.total;
    } catch (error) {
      const message = el("p", error.message);
      message.setAttribute("role", "alert");
      output.replaceChildren(message);
    } finally {
      next.disabled = false;
    }
  };
  void load(0);
}
export function bindConcept(artifact, concept, live, api, mutate) {
  const dialog = dialogFor(`${concept.name} · 绑定业务来源`);
  const active = live.models.find((m) => m.status === "adopted");
  const baseline = live.models.find(
    (m) =>
      m.status === "adopted" &&
      m.content.foundationRef?.id === artifact.id &&
      m.content.foundationRef.version === artifact.version,
  );
  const prior = baseline?.content.types.find((t) => t.conceptId === concept.id);
  const choices = live.connections
    .filter((s) => s.status === "ready")
    .flatMap((source) =>
      source.content.capabilities
        .filter((cap) => !cap.contentKind || cap.contentKind === "records")
        .map((cap) => ({ source, cap })),
    );
  if (
    prior &&
    !choices.some(
      (c) => c.source.id === prior.sourceId && c.cap.name === prior.capability,
    )
  )
    choices.push({
      unavailable: true,
      source: { id: prior.sourceId, title: "原主来源不可用（请重新选择）" },
      cap: {
        name: prior.capability,
        fields: [...new Set(Object.values(prior.fields))],
        idField: "未知",
        filters: {},
      },
    });
  if (!choices.length) {
    dialog.append(
      el(
        "p",
        "请先在企业与数据页连接业务记录来源。知识片段和 BI 指标不能充当业务明细。",
      ),
    );
    return;
  }
  const form = el("form"),
    fields = el("fieldset");
  fields.style.border = "0";
  const sourceLabel = el("label", undefined, "live-field"),
    select = el("select");
  sourceLabel.append(el("span", "主业务来源"), select);
  fields.append(sourceLabel);
  choices.forEach(({ source, cap }, index) => {
    const option = el("option", `${source.title} · ${cap.name}`);
    option.value = String(index);
    select.append(option);
  });
  const priorIndex = choices.findIndex(
    ({ source, cap }) =>
      source.id === prior?.sourceId && cap.name === prior?.capability,
  );
  if (priorIndex >= 0) select.value = String(priorIndex);
  const mapping = el("div"),
    output = el("div");
  output.setAttribute("aria-live", "polite");
  let inputs = [];
  const rebuild = (existing) => {
    const { cap } = choices[Number(select.value)];
    mapping.replaceChildren(
      el(
        "p",
        `对象身份 $id 来自 ${cap.idField}。勾选需要的字段，并按业务含义命名。`,
        "source-meta",
      ),
    );
    inputs = cap.fields.flatMap((field) => {
      const aliases = Object.entries(existing || {})
        .filter(([, value]) => value === field)
        .map(([key]) => key);
      return (aliases.length ? aliases : [field]).map((alias) => {
        const row = el("div", undefined, "live-actions");
        const label = el("label"),
          check = el("input");
        check.type = "checkbox";
        check.checked = !existing || Object.hasOwn(existing, alias);
        label.append(check, document.createTextNode(field));
        const property = el("input");
        property.value = alias;
        property.setAttribute("aria-label", `${field} 的业务属性名`);
        row.append(label, property);
        mapping.append(row);
        return { field, check, property };
      });
    });
  };
  select.onchange = () => rebuild();
  rebuild(priorIndex >= 0 ? prior.fields : undefined);
  fields.append(mapping);
  const rationaleLabel = el("label", undefined, "live-field"),
    rationale = el("textarea");
  rationale.required = true;
  rationale.value = baseline?.content.rationale || "";
  rationaleLabel.append(el("span", "映射依据与待确认事项"), rationale);
  fields.append(rationaleLabel);
  const supplements = createSupplementEditor(choices, prior?.supplements || []);
  fields.append(supplements.element);
  fields.append(
    el(
      "p",
      `本次映射引用当前基础本体；${baseline ? "保留当前执行子集中的其他映射。" : "创建一个新的执行子集。"}未映射的概念继续保留。`,
      "source-meta",
    ),
  );
  const save = button("检查来源并保存候选", () => {});
  save.type = "submit";
  form.append(fields, save);
  dialog.append(form, output);
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (choices[Number(select.value)]?.unavailable) {
      output.textContent = "原主来源不可用，请明确选择新的业务来源。";
      return;
    }
    const entries = inputs
      .filter((x) => x.check.checked)
      .map((x) => [x.property.value.trim(), x.field]);
    if (
      !entries.length ||
      entries.some(([key]) => !key || key === "$id" || key === "__proto__") ||
      new Set(entries.map(([key]) => key)).size !== entries.length
    ) {
      output.textContent = "请选择字段并填写唯一的业务属性名，保留名不可使用。";
      return;
    }
    let supplemental;
    try {
      supplemental = supplements.read();
    } catch (error) {
      output.textContent = error.message;
      return;
    }
    fields.disabled = true;
    save.disabled = true;
    output.textContent = "正在按当前来源检查映射…";
    const { source, cap } = choices[Number(select.value)];
    const type = {
      name: concept.name,
      description: concept.description,
      conceptId: concept.id,
      sourceId: source.id,
      capability: cap.name,
      fields: Object.fromEntries(entries),
      supplements: supplemental,
    };
    const ok = await mutate(
      "/api/live/propose",
      {
        foundationRef: { id: artifact.id, version: artifact.version },
        baseModelRef: active
          ? { id: active.id, version: active.version }
          : null,
        purpose: `${artifact.content.enterprise.name} · 业务执行子集`,
        types: [
          ...(baseline?.content.types || []).filter(
            (t) => t.conceptId !== concept.id,
          ),
          type,
        ],
        relations: baseline?.content.relations || [],
        rationale: rationale.value,
      },
      (result) => {
        const model = result.saved;
        output.replaceChildren(
          el(
            "p",
            "候选已保存。已检查少量实际记录及映射结构，业务含义仍请核对。",
          ),
        );
        for (const check of model.content.checks)
          output.append(
            el(
              "p",
              `${check.type}：已检查 ${check.checkedRecords} 条 · ${check.readAt} · ${check.coverage.complete ? "样本覆盖本次返回范围" : "部分样本，非全量验证"}`,
              "source-meta",
            ),
          );
        output.append(
          button("预览候选实例", () =>
            previewBinding(
              concept,
              {
                modelId: model.id,
                modelVersion: model.version,
                status: "candidate",
              },
              api,
            ),
          ),
          button("到待处理核对执行子集", () => {
            dialog.close(); requestPending({ ownerId: model.id });
          }),
        );
      },
      (error) => {
        output.textContent = error.message;
      },
    );
    if (!ok) {
      fields.disabled = false;
      save.disabled = false;
    }
  };
}
import { requestPending } from "./pending-center.js";

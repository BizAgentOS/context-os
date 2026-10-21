import { el, btn, modal, field } from "./relation-corrections.js";
import { safeText, displayValue, fieldLabel, technicalDetails } from "./ui-display.js";

const describeRows = rows => rows.map(row => Object.entries(row).map(([key, value]) => `${key === "$id" ? "对象编号" : fieldLabel(key)}：${displayValue(value)}`).join("；")).join("\n") || "无对象";
const drafts = new Map();
const states = {
  candidate: "候选",
  checked: "检查通过，待确认",
  adopted: "已采用",
  cancelled: "已取消",
};
function select(form, label, choices, value) {
  const wrap = el("label", "", "live-field"),
    input = el("select");
  for (const c of choices) {
    const option = el("option", c.label);
    option.value = c.value;
    input.append(option);
  }
  if (value !== undefined) input.value = value;
  wrap.append(el("span", label), input);
  form.append(wrap);
  return input;
}
function rules(model) {
  const result = [];
  for (const t of model.content.types) {
    for (const binding of [t, ...(t.supplements || [])])
      for (const property of Object.keys(binding.fields))
        result.push({
          label: `${t.name} / ${property} / ${binding === t ? "主来源" : binding.name}`,
          patch: {
            kind: "property",
            type: t.name,
            property,
            ...(binding === t ? {} : { supplement: binding.name }),
          },
          binding,
          current: binding.fields[property],
        });
  }
  for (const r of model.content.relations)
    result.push({
      label: `${r.from} / 关系 ${r.name}`,
      patch: { kind: "relation", type: r.from, relation: r.name },
      current: r,
    });
  return result;
}
function openChange(model, live, api, saved) {
  const key = `${model.id}:${model.version}`,
    old = drafts.get(key) || {},
    owner = crypto.randomUUID(),
    d = modal("提出全局映射修订"),
    form = el("form");
  d.append(
    el(
      "p",
      "修订一个已有绑定或关系规则。读取代表性实例后保存影响报告，由用户核对并确认采用。关闭保留本次草稿，刷新页面会丢失。",
      "source-meta",
    ),
    form,
  );
  const options = rules(model),
    choice = select(
      form,
      "要修订的规则",
      options.map((r, i) => ({ value: String(i), label: r.label })),
      old.choice || "0",
    ),
    inputs = el("div");
  form.append(inputs);
  let fields = [];
  const rebuild = () => {
    inputs.replaceChildren();
    fields = [];
    const r = options[Number(choice.value)];
    if (!r) return;
    if (r.patch.kind === "property") {
      const source = live.connections.find((s) => s.id === r.binding.sourceId),
        cap = source?.content.capabilities.find(
          (c) => c.name === r.binding.capability,
        );
      fields = [
        select(
          inputs,
          "新的来源字段",
          (cap?.fields || []).map((f) => ({ label: f, value: f })),
          old.choice === choice.value ? old.sourceField : r.current,
        ),
      ];
    } else {
      const from = model.content.types.find((t) => t.name === r.current.from),
        to = model.content.types.find((t) => t.name === r.current.to);
      fields = [
        select(
          inputs,
          "新的起点业务属性",
          ["$id", ...Object.keys(from.fields)].map((f) => ({
            label: f,
            value: f,
          })),
          old.choice === choice.value ? old.fromField : r.current.fromField,
        ),
        select(
          inputs,
          "新的目标业务属性",
          ["$id", ...Object.keys(to.fields)].map((f) => ({
            label: f,
            value: f,
          })),
          old.choice === choice.value ? old.toField : r.current.toField,
        ),
      ];
    }
  };
  rebuild();
  choice.onchange = rebuild;
  const reason = field(form, "修订理由", old.reason || "", true),
    evidence = field(form, "核对依据（提交者陈述）", old.evidence || "", true);
  reason.required = true;
  evidence.required = true;
  const issues = el("details"),
    issueList = el("div");
  issues.append(el("summary", "关联同类局部纠正（可选，最多20条）"), issueList);
  form.append(issues);
  const selected = new Map(
    (old.relatedCorrections || []).map((r) => [r.id, r]),
  );
  api("/api/live/changes/issues", {
    baseRef: { id: model.id, version: model.version },
  })
    .then((result) => {
      if (!d.isConnected) return;
      for (const group of result.groups) {
        issueList.append(
          el(
            "p",
            `${group.type} / ${group.relation}：${group.count}条记录（含历史状态）`,
          ),
        );
        for (const [index, r] of group.references.entries()) {
          const label = el("label", "", "live-field"),
            check = el("input");
          check.type = "checkbox";
          check.disabled = submit.disabled;
          check.checked = selected.has(r.id);
          check.onchange = () => {
            if (check.checked)
              selected.set(r.id, { id: r.id, version: r.version });
            else selected.delete(r.id);
            remember();
          };
          label.append(
            check,
            document.createTextNode(safeText(`局部纠正 ${index + 1} · ${states[r.status] || "已保存"}`)),
          );
          issueList.append(label, technicalDetails(r));
        }
      }
      if (!result.groups.length)
        issueList.append(
          el("p", "尚无已保存的局部纠正；这不代表所有数据均无问题。"),
        );
    })
    .catch((e) => {
      if (d.isConnected) issueList.textContent = safeText(`问题读取失败：${e.message}`);
    });
  const payload = () => {
    const r = options[Number(choice.value)];
    return {
      baseRef: { id: model.id, version: model.version },
      patch: {
        ...r.patch,
        ...(r.patch.kind === "property"
          ? { sourceField: fields[0].value }
          : { fromField: fields[0].value, toField: fields[1].value }),
      },
      reason: reason.value,
      evidence: evidence.value,
      relatedCorrections: [...selected.values()],
    };
  };
  const remember = () => {
    if (!options.length) return;
    drafts.set(key, {
      ...payload().patch,
      owner,
      last,
      choice: choice.value,
      reason: reason.value,
      evidence: evidence.value,
      relatedCorrections: [...selected.values()],
    });
  };
  form.addEventListener("input", (event) => {
    if (event.target !== choice) remember();
  });
  form.addEventListener("change", remember);
  const submit = btn("保存修订与影响", () => {}),
    status = el("p");
  submit.type = "submit";
  status.setAttribute("role", "status");
  form.append(submit, status);
  let last = old.last || null;
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    remember();
    const body = payload(),
      signature = JSON.stringify(body);
    if (last?.signature !== signature)
      last = { signature, operationId: crypto.randomUUID() };
    remember();
    const controls = [...form.querySelectorAll("input,textarea,select,button")];
    controls.forEach((c) => (c.disabled = true));
    status.textContent = "正在校验规则并读取前后实例…";
    try {
      const r = await api("/api/live/changes/propose", {
        ...body,
        operationId: last.operationId,
      });
      if (drafts.get(key)?.owner === owner) drafts.delete(key);
      saved(r);
      if (d.isConnected) {
        d.close();
        inspectChange(r.saved, api, saved);
      }
    } catch (e) {
      if (d.isConnected)
        status.textContent = safeText(`尚未确认保存：${e.message}。草稿保留，可按原请求重试。`);
    } finally {
      form
        .querySelectorAll("input,textarea,select,button")
        .forEach((c) => (c.disabled = false));
    }
  };
}
export function inspectChange(initial, api, saved) {
  const d = modal("映射修订与治理影响"),
    content = el("div");
  d.append(content);
  let record = initial,
    last = null;
  const draw = () => {
    const c = record.content,
      impact = c.impact;
    content.replaceChildren(
      el(
        "h3",
        `${record.title} · ${states[record.status] || "已保存"}`,
      ),
      el("p", record.createdAt ? `记录于 ${new Date(record.createdAt).toLocaleString("zh-CN")}` : "已保存的修订记录"),
      el("p", `理由：${c.draft.reason}`),
      el("p", `提交者依据：${c.draft.evidence}`),
      el("p", `提交者：${c.responsible === "local-admin" ? "本地管理员" : String(c.responsible || "").startsWith("agent:") ? "助手" : "提交者"}`),
      technicalDetails(record),
    );
    content.append(
      el("h3", "规则差异"),
      el("p", c.diff.path.map(part => part === "primary" ? "主来源" : fieldLabel(part)).join(" / ")),
      el("p", `原规则：${displayValue(c.diff.before)}`),
      el("p", `新规则：${displayValue(c.diff.after)}`),
      technicalDetails(c.diff),
    );
    const full = impact.snapshotCheck;
    if (full?.status === "checked") {
      const metricLabels = { rows: "行数", nulls: "空值", duplicates: "重复", total: "总数", matched: "匹配数", fanout: "多匹配数", cardinality: "关联数量" };
      const metrics = m => m ? Object.entries(m).filter(([key]) => metricLabels[key]).map(([key, value]) => `${metricLabels[key]} ${displayValue(value)}`).join("，") : "";
      content.append(
        el("h3", full.coverageAfter?.complete === true ? "全量快照检查" : "快照检查（仅可用范围）"),
        el(
          "p",
          full.newErrors.length
            ? `修订引入新的问题：${full.newErrors.join("、")}。检查不会通过，请调整后重新提出。`
            : `修订前${full.validBefore ? "通过" : "未通过"}，修订后${full.validAfter ? "通过" : "未通过"}；${full.changes.length ? `${full.changes.length} 项检查结果变化。` : "检查结果没有变化。"}`,
          full.newErrors.length ? "request-error" : "source-meta",
        ),
      );
      for (const c of full.changes)
        content.append(
          el(
            "p",
            `${c.passed ? "✓" : "✗"} ${c.name}：${c.detail}${c.before ? `（原：${c.before.passed ? "通过" : "未通过"}${c.before.metrics ? `，${metrics(c.before.metrics)}` : ""}）` : "（新增检查）"}`,
            "source-meta",
          ),
        );
    } else if (full?.status === "error")
      content.append(el("h3", "全量快照检查"), el("p", `未能完成：${full.message}`, "request-error"));
    const coverage = impact.scope.enumerationCoverage;
    content.append(
      el("h3", "代表性实例变化"),
      el(
        "p",
        `读取 ${impact.summary.sampleCount} 个起点，其中 ${impact.summary.changedSamples} 个返回值或证据发生变化。${coverage.complete ? "当前类型枚举完整" : "仅首批样本，非全量影响估计"}；关系结果各自保留覆盖限制。`,
        "source-meta",
      ),
    );
    for (const s of impact.samples) {
      const details = el("details");
      details.append(
        el("summary", `${s.id} · ${s.changed ? "有变化" : "当前样本无变化"}`),
        el("p", `原值：${describeRows(s.before.items)}`),
        el("p", `新值：${describeRows(s.after.items)}`),
        el(
          "p",
          `原关系/对象范围${s.before.coverage.complete ? "完整" : "不完整"}；新范围${s.after.coverage.complete ? "完整" : "不完整"}`,
          "source-meta",
        ),
      );
      const evidence = el("details");
      evidence.append(
        el("summary", "读取依据与冲突"),
        el("p", `原值读取于 ${(s.before.reads || []).map(read => read.readAt).join(" / ") || "未记录"}；新值读取于 ${(s.after.reads || []).map(read => read.readAt).join(" / ") || "未记录"}`, "source-meta"),
        el("p", "原值与新值分别保留当时读取范围；有冲突或缺失时不能当作已确认业务事实。", "source-meta"),
        technicalDetails({ before: s.before, after: s.after }),
      );
      details.append(evidence);
      content.append(details);
    }
    content.append(
      el("h3", "治理影响"),
      el(
        "p",
        "关系和事实依据保持不变的局部纠正会随新映射保留；修订改变其依据时，需先处理该纠正。既有发布继续使用原映射。点击“查看消费影响”按当前许可核对；本报告的原始样本保留不变。",
        "source-meta",
      ),
    );
    for (const g of impact.localCorrections.groups)
      content.append(
        el("p", `${g.type} / ${g.relation}：${g.count}条已有局部纠正记录`),
      );
    if (impact.dependentSupplements?.length)
      content.append(
        el(
          "p",
          `匹配键联动的附来源：${impact.dependentSupplements.map((s) => s.name + "（" + s.properties.join("、") + "）").join("、")}；上述样本已比较这些属性与匹配依据。`,
        ),
      );
    if (impact.dependencies?.length)
      content.append(
        el(
          "p",
          `依赖此字段的关系：${impact.dependencies.map((r) => r.from + " / " + r.name).join("、")}。这些关系实例尚未逐项比较。`,
        ),
      );
    if (c.check)
      content.append(
        el(
          "p",
          `检查于 ${c.check.at}。只确认结构、样本与基线；不证明业务真实。`,
        ),
      );
    if (c.resultModel)
      content.append(
        el(
          "p",
          `已采用修订并更新执行映射${c.decision?.at ? ` · ${new Date(c.decision.at).toLocaleString("zh-CN")}` : ""}`,
        ),
      );
    content.append(btn('查看消费影响',async()=>{const {inspectConsumerImpact}=await import('./consumer-migrations.js');if(d.isConnected)inspectConsumerImpact(record,api,saved);}));
    const status = el("p");
    status.setAttribute("role", "status");
    const act = async (method) => {
      const body = { id: record.id, version: record.version },
        signature = method + JSON.stringify(body);
      if (last?.signature !== signature)
        last = { signature, operationId: crypto.randomUUID() };
      const buttons = [...content.querySelectorAll("button")];
      buttons.forEach((b) => (b.disabled = true));
      status.textContent = "处理中…";
      try {
        const r = await api("/api/live/changes/" + method, {
          ...body,
          operationId: last.operationId,
        });
        record = r.saved;
        saved(r);
        if (d.isConnected) draw();
      } catch (e) {
        if (d.isConnected)
          status.textContent = safeText(`未确认完成：${e.message}。保留原回执，可重试原请求或重新读取记录。`);
      } finally {
        buttons.forEach((b) => (b.disabled = false));
      }
    };
    if (["candidate", "checked"].includes(record.status)) {
      content.append(btn("检查这份修订", () => act("check")));
      if (record.status === "checked")
        content.append(
          btn("确认采用已检查的修订", () => act("adopt")),
        );
      content.append(btn("取消未采用修订", () => act("cancel")));
    }
    content.append(status);
  };
  draw();
}
export function renderMappingChanges(model, { api, live, onSaved }) {
  const panel = el("section", "", "correction-panel"),
    list = el("div");
  panel.setAttribute("aria-label", "全局映射治理");
  let generation = 0,
    detailsGeneration = 0;
  const saved = (r) => {
    if (onSaved) onSaved(r);
    else if (panel.isConnected) load();
  };
  const load = async () => {
    const request = ++generation;
    ++detailsGeneration;
    try {
      const r = await api("/api/live/changes/list", {});
      if (!panel.isConnected || request !== generation) return;
      list.replaceChildren();
      for (const [index, a] of r.items.entries())
        list.append(
          btn(`${a.title} · ${states[a.status] || "已保存"} · ${a.createdAt ? new Date(a.createdAt).toLocaleString("zh-CN") : `记录 ${index + 1}`}`, async () => {
            const id = ++detailsGeneration;
            try {
              const full = await api("/api/live/changes/read", {
                id: a.id,
                version: a.version,
              });
              if (panel.isConnected && id === detailsGeneration)
                inspectChange(full, api, saved);
            } catch (e) {
              if (panel.isConnected && id === detailsGeneration)
                list.append(el("p", e.message));
            }
          }),
          technicalDetails(a),
        );
      if (!r.items.length) list.append(el("p", "尚无映射修订记录。"));
      if (r.items.length === 40)
        list.append(el("p", "仅列出最近40份修订记录。", "source-meta"));
    } catch (e) {
      if (panel.isConnected && request === generation)
        list.textContent = safeText(`读取失败：${e.message}`);
    }
  };
  panel.append(
    el("h2", "全局映射治理"),
    el("p", "修改规则前，先对照实际对象和治理依据。", "source-meta"),
    btn("提出全局映射修订", () => openChange(model, live, api, saved)),
    btn("刷新修订记录", load),
    list,
  );
  queueMicrotask(load);
  return panel;
}

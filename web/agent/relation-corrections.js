import { safeText, displayValue, fieldLabel, technicalDetails } from "./ui-display.js";

export const el = (tag, text = "", cls = "") => {
  const n = document.createElement(tag);
  n.className = cls;
  n.textContent = safeText(text);
  return n;
};
export const btn = (text, fn) => {
  const b = el("button", text, "quiet-button");
  b.type = "button";
  b.onclick = fn;
  return b;
};
const states = {
  candidate: "候选",
  checked: "检查通过，待确认",
  adopted: "已采用",
  cancelled: "已取消",
  superseded: "已被新决定替代",
};
const when = value => value ? new Date(value).toLocaleString("zh-CN") : "时间未记录";
const actor = value => value === "local-admin" ? "本地管理员" : String(value || "").startsWith("agent:") ? "助手" : "提交者";
export function modal(title) {
  const d = el("dialog", "", "live-dialog");
  d.append(
    el("h2", title),
    btn("关闭", () => d.close()),
  );
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}
export function field(form, label, value = "", multiline = false) {
  const l = el("label", "", "live-field"),
    n = el(multiline ? "textarea" : "input");
  n.value = value;
  l.append(el("span", label), n);
  form.append(l);
  return n;
}
export function openCorrection(model, api, initial = {}, after = () => {}) {
  const dialog = modal("提出局部关系纠正"),
    form = el("form"),
    notice = el(
      "p",
      "纠正指定起点的关联目标，保留源记录。采用后进入工作版，发布后供对应接入方使用；已有发布保持原样。",
      "source-meta",
    );
  dialog.append(notice, form);
  const type = field(
    form,
    "起点类型",
    initial.type || model.content.types[0]?.name || "",
  );
  type.required = true;
  const objectId = field(form, "起点对象编号", initial.objectId || "");
  objectId.required = true;
  const relation = field(form, "关系名称", initial.relation || "");
  relation.required = true;
  const targets = field(
    form,
    "纠正后的目标编号（每行一个；留空表示无关联）",
    (initial.targetIds || []).join("\n"),
    true,
  );
  const reason = field(form, "纠正理由", "", true),
    evidence = field(
      form,
      "核对依据（提交者陈述，不自动视为已验证事实）",
      "",
      true,
    );
  reason.required = true;
  evidence.required = true;
  const status = el("p");
  status.setAttribute("role", "status");
  const save = btn("保存候选", () => {});
  save.type = "submit";
  form.append(save, status);
  let last = null;
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (save.disabled) return;
    const payload = {
      target: {
        modelId: model.id,
        modelVersion: model.version,
        type: type.value.trim(),
        objectId: objectId.value.trim(),
        relation: relation.value.trim(),
      },
      targetIds: targets.value
        .split(/\n/)
        .map((x) => x.trim())
        .filter(Boolean),
      reason: reason.value,
      evidence: evidence.value,
    };
    const signature = JSON.stringify(payload);
    if (last?.signature !== signature)
      last = { signature, operationId: crypto.randomUUID() };
    const inputs = [...form.querySelectorAll("input,textarea")];
    inputs.forEach((n) => (n.disabled = true));
    save.disabled = true;
    status.textContent = "正在读取源基线并保存…";
    try {
      const r = await api("/api/live/corrections/propose", {
        ...payload,
        operationId: last.operationId,
      });
      after();
      if (!dialog.isConnected) return;
      status.textContent = "候选已保存";
      dialog.close();
      inspectCorrection(r.saved, api, after);
    } catch (e) {
      if (dialog.isConnected)
        status.textContent = safeText(`尚未确认保存结果：${e.message}；原输入保留，可按原请求重试`);
    } finally {
      inputs.forEach((n) => (n.disabled = false));
      save.disabled = false;
    }
  };
}
export function inspectCorrection(initial, api, after = () => {}) {
  const dialog = modal("局部关系纠正记录"),
    content = el("div");
  dialog.append(content);
  let record = initial,
    last = null;
  const draw = () => {
    const c = record.content,
      t = c.target;
    content.replaceChildren(
      el(
        "h3",
        `${record.title} · ${states[record.status] || "待处理"}`,
      ),
      el("p", `记录时间：${when(record.createdAt)} · 提交者：${actor(c.responsible)}`),
      el("p", `${t.type} ${t.objectId} · ${t.relation}`),
      el(
        "p",
        `原始目标：${c.snapshot.before.items.map((i) => i.$id).join("、") || "无"}`,
      ),
      el("p", `纠正目标：${c.targetIds.join("、") || "无关联"}`),
      el("p", `理由：${c.reason}`),
      el("p", `提交者依据：${c.evidence}`),
      el(
        "p",
        "适用条件：起点、关系规则及目标源事实保持已核对的状态。",
        "source-meta",
      ),
    );
    const evidence = el("details");
    evidence.append(
      el("summary", "查看原值与读取依据"),
      el("p", `原关系返回 ${c.snapshot.before.items.length} 个对象 · ${c.snapshot.before.coverage?.complete ? "读取范围完整" : "部分结果"}`, "source-meta"),
      ...c.snapshot.before.items.map(item => el("p", Object.entries(item).map(([key, value]) => `${key === "$id" ? "对象编号" : fieldLabel(key)}：${displayValue(value)}`).join("；"))),
      el("p", `读取于 ${(c.snapshot.before.reads || []).map(read => read.readAt).join(" / ") || "未记录"}`, "source-meta"),
      technicalDetails(c.snapshot),
    );
    content.append(evidence);
    if (c.check)
      content.append(
        el(
          "p",
          `已复验 · ${when(c.check.checkedAt)} · 已核验引用、范围和当前状态，不证明业务真实。`,
        ),
      );
    if (c.decision)
      content.append(
        el(
          "p",
          `采用决定：${actor(c.decision.actor)} · ${when(c.decision.at)}`,
        ),
      );
    const status = el("p");
    status.setAttribute("role", "status");
    const act = async (method) => {
      const payload = { id: record.id, version: record.version };
      const signature = method + JSON.stringify(payload);
      if (last?.signature !== signature)
        last = { signature, operationId: crypto.randomUUID() };
      const buttons = [...content.querySelectorAll("button")];
      buttons.forEach((b) => (b.disabled = true));
      status.textContent = "处理中…";
      try {
        const result = await api(`/api/live/corrections/${method}`, {
          ...payload,
          operationId: last.operationId,
        });
        record = result.saved;
        after();
        if (dialog.isConnected) draw();
      } catch (e) {
        if (dialog.isConnected)
          status.textContent = safeText(`未完成：${e.message}。记录保留，请按最新来源重新提议或取消候选。`);
      } finally {
        buttons.forEach((b) => (b.disabled = false));
      }
    };
    if (["candidate", "checked"].includes(record.status)) {
      content.append(btn("检查当前候选", () => act("check")));
      if (record.status === "checked")
        content.append(
          btn("到待处理核对纠正", () => { dialog.close(); requestPending({ ownerId: record.id }); }),
        );
      content.append(btn("取消未采用候选", () => act("cancel")));
    }
    content.append(
      status,
      technicalDetails(record),
      el(
        "p",
        "采用不写回源系统；已采用记录不能通过取消假装回滚。重新读取对象关系查看当前有效结果。",
        "source-meta",
      ),
    );
  };
  draw();
}
export function renderCorrections(model, { api }) {
  const panel = el("section", "", "correction-panel");
  panel.setAttribute("aria-label", "局部关系治理");
  const list = el("div");
  let generation = 0,
    detailGeneration = 0;
  const load = async () => {
    const request = ++generation;
    ++detailGeneration;
    try {
      const r = await api("/api/live/corrections/list", {});
      if (!panel.isConnected || request !== generation) return;
      list.replaceChildren();
      const items = r.items.filter(
        (a) => a.content.target.modelId === model.id,
      );
      if (!items.length)
        list.append(el("p", "尚无局部纠正记录。", "source-meta"));
      for (const [index, a] of items.entries())
        list.append(
          btn(`${a.title} · ${states[a.status] || "待处理"} · ${a.createdAt ? when(a.createdAt) : `记录 ${index + 1}`}`, async () => {
            const detailRequest = ++detailGeneration;
            try {
              const record = await api("/api/live/corrections/read", {
                id: a.id,
                version: a.version,
              });
              if (!panel.isConnected || detailRequest !== detailGeneration)
                return;
              inspectCorrection(record, api, load);
            } catch (e) {
              if (panel.isConnected && detailRequest === detailGeneration)
                list.append(el("p", `读取失败：${e.message}`, "source-meta"));
            }
          }),
        );
      if (r.items.length === 40)
        list.append(
          el("p", "仅显示最近40条记录中属于此映射的记录。", "source-meta"),
        );
    } catch (e) {
      if (panel.isConnected && request === generation)
        list.textContent = safeText(`读取失败：${e.message}`);
    }
  };
  panel.append(
    el("h3", "局部关系治理"),
    btn("提出局部关系纠正", () => openCorrection(model, api, {}, load)),
    btn("刷新纠正记录", load),
    list,
  );
  queueMicrotask(load);
  return panel;
}
import { requestPending } from "./pending-center.js";

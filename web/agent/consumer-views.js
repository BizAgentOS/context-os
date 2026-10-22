import { el, btn, modal, field } from "./relation-corrections.js";
const drafts = new Map();
const properties = (t) => [
  "$id",
  ...new Set([
    ...Object.keys(t.fields),
    ...(t.supplements || []).flatMap((s) => Object.keys(s.fields)),
  ]),
];
function contextPreview(value) {
  const box = el("div");
  box.append(
    el("p", `历史读取：${value.readAt} · 来源版本 ${value.sourceVersion}`),
  );
  if (value.kind === "document")
    box.append(
      el(
        "p",
        `文档版本 ${value.location.revision} · 字符 ${value.location.start}–${value.location.end}`,
      ),
      el("p", value.text),
    );
  else {
    const d = value.definition;
    box.append(
      el("p", d.description),
      el("p", `单位 ${d.unit} · 粒度 ${d.grain} · 时区 ${d.timeZone}`),
      el(
        "p",
        `期间 ${value.query.start} 至 ${value.query.end}；筛选 ${
          Object.entries(value.query.where || {})
            .map(([k, v]) => `${k}=${v}`)
            .join("、") || "无"
        }；偏移 ${value.query.offset}，最多 ${value.query.limit} 条`,
      ),
    );
    for (const item of value.items)
      box.append(
        el(
          "p",
          `${Object.entries(item.dimensions)
            .map(([k, v]) => `${k}=${v}`)
            .join(
              "、",
            )} · ${item.periodStart} 至 ${item.periodEnd} · ${item.value ?? "缺失"} ${d.unit}（${item.status}）`,
        ),
      );
  }
  box.append(
    el(
      "p",
      value.coverage.complete
        ? "本次所选读取覆盖完整。"
        : "本次读取不完整，仅授权已展示部分。",
      "source-meta",
    ),
  );
  const detail = el("details");
  detail.append(
    el("summary", "查看完整许可内容"),
    el("pre", JSON.stringify(value, null, 2)),
  );
  box.append(detail);
  return box;
}
function createView(models, api, saved) {
  const owner = crypto.randomUUID(),
    old = drafts.get("create") || {},
    dialog = modal("创建融合消费视图"),
    form = el("form");
  dialog.append(
    el(
      "p",
      "固定映射版本，明确选择对象、字段和关系。只开放源映射关系，内部局部纠正不自动对外发布。关闭可保留本次草稿，刷新页面会丢失。",
      "source-meta",
    ),
    form,
  );
  const appName = field(form, "调用方名称", old.name || ""),
    purpose = field(form, "使用目的", old.purpose || "", true);
  appName.required = true;
  purpose.required = true;
  const label = el("label", "", "live-field"),
    modelChoice = el("select");
  label.append(el("span", "固定执行映射"), modelChoice);
  form.append(label);
  for (const m of models) {
    const option = el(
      "option",
      `${m.title} · ${m.id.slice(0, 8)}`,
    );
    option.value = m.id;
    modelChoice.append(option);
  }
  if (models.some((m) => m.id === old.modelId)) modelChoice.value = old.modelId;
  const scope = el("div");
  form.append(scope);
  let contextSelection = old.contextEvidence || [],
    contextModelId = old.modelId,
    contextGeneration = 0;
  const contextArea = el("div");
  form.append(contextArea);
  let groups = [],
    relations = [];
  const model = () => models.find((m) => m.id === modelChoice.value);
  const grants = () =>
    groups
      .map((g) => ({
        type: g.type,
        fields: g.fields.filter((f) => f.input.checked).map((f) => f.name),
        evidence: {
          fields: g.fields
            .filter((f) => f.evidenceInput?.checked)
            .map((f) => f.name),
          relations: relations
            .filter((r) => r.from === g.type && r.evidenceInput?.checked)
            .map((r) => r.name),
        },
        relations: relations
          .filter((r) => r.from === g.type && r.input.checked)
          .map((r) => r.name),
      }))
      .filter((g) => g.fields.length);
  const updateRelations = () => {
    for (const g of groups)
      for (const f of g.fields)
        if (f.evidenceInput) {
          f.evidenceInput.disabled = !f.input.checked;
          if (!f.input.checked) f.evidenceInput.checked = false;
        }
    const selected = grants();
    for (const r of relations) {
      const from = selected.find((g) => g.type === r.from),
        to = selected.find((g) => g.type === r.to);
      r.input.disabled = !(
        from?.fields.includes("$id") &&
        from.fields.includes(r.fromField) &&
        to?.fields.includes("$id") &&
        to.fields.includes(r.toField)
      );
      if (r.input.disabled) r.input.checked = false;
      if (r.evidenceInput) {
        r.evidenceInput.disabled = !r.input.checked;
        if (!r.input.checked) r.evidenceInput.checked = false;
      }
    }
  };
  const build = () => {
    contextGeneration++;
    if (contextModelId !== modelChoice.value) {
      contextSelection = [];
      contextModelId = modelChoice.value;
    }
    contextArea.replaceChildren(
      el(
        "p",
        `已选择 ${contextSelection.length} 份历史文档/指标依据（最多6份）。`,
      ),
    );
    scope.replaceChildren();
    groups = [];
    relations = [];
    const m = model();
    for (const t of m.content.types) {
      const group = el("fieldset"),
        fields = [];
      group.append(el("legend", t.name));
      for (const name of properties(t)) {
        const row = el("label", "", "view-permission"),
          input = el("input");
        input.type = "checkbox";
        input.checked =
          old.modelId === m.id &&
          Boolean(
            old.grants?.find((g) => g.type === t.name)?.fields.includes(name),
          );
        row.append(input, document.createTextNode(name));
        group.append(row);
        let evidenceInput;
        if (name !== "$id") {
          const label = el("label", "", "view-permission");
          evidenceInput = el("input");
          evidenceInput.type = "checkbox";
          evidenceInput.checked =
            old.modelId === m.id &&
            Boolean(
              old.grants
                ?.find((g) => g.type === t.name)
                ?.evidence?.fields.includes(name),
            );
          label.append(
            evidenceInput,
            document.createTextNode(`允许读取 ${name} 的依据`),
          );
          group.append(label);
        }
        fields.push({ name, input, evidenceInput });
      }
      groups.push({ type: t.name, fields });
      scope.append(group);
    }
    const links = el("fieldset");
    links.append(el("legend", "关系许可"));
    for (const r of m.content.relations) {
      const row = el("label", "", "view-permission"),
        input = el("input");
      input.type = "checkbox";
      input.checked =
        old.modelId === m.id &&
        Boolean(
          old.grants
            ?.find((g) => g.type === r.from)
            ?.relations.includes(r.name),
        );
      row.append(
        input,
        document.createTextNode(
          `${r.from} → ${r.name} → ${r.to}（需 ${r.from}.${r.fromField}、${r.to}.${r.toField} 及两端$id）`,
        ),
      );
      const evidenceRow = el("label", "", "view-permission"),
        evidenceInput = el("input");
      evidenceInput.type = "checkbox";
      evidenceInput.checked =
        old.modelId === m.id &&
        Boolean(
          old.grants
            ?.find((g) => g.type === r.from)
            ?.evidence?.relations.includes(r.name),
        );
      evidenceRow.append(
        evidenceInput,
        document.createTextNode(`允许读取 ${r.from} → ${r.name} 的匹配依据`),
      );
      relations.push({ ...r, input, evidenceInput });
      links.append(row, evidenceRow);
    }
    scope.append(links);
    updateRelations();
  };
  build();
  let last = old.last || null;
  const remember = () =>
    drafts.set("create", {
      owner,
      name: appName.value,
      purpose: purpose.value,
      modelId: modelChoice.value,
      grants: grants(),
      contextEvidence: contextSelection,
      last,
    });
  const chooseContext = btn("选择已保存的文档/指标依据", async () => {
    const generation = ++contextGeneration,
      m = model();
    chooseContext.disabled = true;
    try {
      const result = await api(
        `/api/live/views/evidence-options?id=${encodeURIComponent(m.id)}&version=${m.version}`,
      );
      if (!dialog.isConnected || generation !== contextGeneration) return;
      contextArea.replaceChildren(el("p", result.scope));
      if (!result.items.length)
        contextArea.append(
          el("p", "没有可授权的成功读取。请先在本体工作区保存共同取证。"),
        );
      for (const item of result.items) {
        const section = el("section"),
          label = el("label", "", "view-permission"),
          input = el("input");
        input.type = "checkbox";
        const signature = JSON.stringify(item.scope);
        input.checked = contextSelection.some(
          (s) => JSON.stringify(s) === signature,
        );
        const title =
          item.preview.title ||
          item.preview.definition?.name ||
          item.scope.kind;
        label.append(
          input,
          document.createTextNode(
            `开放 ${title} 的以下完整读取（${item.scope.kind}）`,
          ),
        );
        section.append(label, contextPreview(item.preview));
        contextArea.append(section);
        input.onchange = () => {
          contextSelection = contextSelection.filter(
            (s) => JSON.stringify(s) !== signature,
          );
          if (input.checked) contextSelection.push(item.scope);
          remember();
        };
      }
    } catch (e) {
      if (dialog.isConnected && generation === contextGeneration)
        contextArea.replaceChildren(el("p", `无法读取候选：${e.message}`));
    } finally {
      chooseContext.disabled = submit.disabled;
    }
  });
  form.append(chooseContext);
  modelChoice.onchange = () => {
    build();
    remember();
  };
  form.addEventListener("input", (e) => {
    if (e.target !== modelChoice) {
      updateRelations();
      remember();
    }
  });
  form.append(
    el(
      "p",
      "每个选中类型必须明确勾选$id。关系须授权两端身份及关联字段。依据单独授权，最多20个属性；可能包含该属性的冲突读取值，文档和指标需在下方逐份选择已保存读取。",
      "source-meta",
    ),
  );
  const submit = btn("保存消费视图草稿", () => {}),
    status = el("p");
  submit.type = "submit";
  status.setAttribute("role", "status");
  form.append(submit, status);
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    contextGeneration++; // Ignore candidates fetched before this submitted snapshot.
    const m = model(),
      body = {
        name: appName.value,
        purpose: purpose.value,
        modelRef: { id: m.id, version: m.version },
        grants: grants(),
        contextEvidence: contextSelection,
      },
      signature = JSON.stringify(body);
    if (last?.signature !== signature)
      last = { signature, operationId: crypto.randomUUID() };
    remember();
    form
      .querySelectorAll("input,select,textarea,button")
      .forEach((c) => (c.disabled = true));
    status.textContent = "正在验证许可并保存…";
    try {
      const r = await api("/api/live/views/propose", {
        ...body,
        operationId: last.operationId,
      });
      if (drafts.get("create")?.owner === owner) drafts.delete("create");
      saved(r);
      if (dialog.isConnected) dialog.close();
    } catch (e) {
      if (dialog.isConnected)
        status.textContent = `未确认保存：${e.message}。输入保留，可按原请求重试。`;
    } finally {
      form
        .querySelectorAll("input,select,textarea,button")
        .forEach((c) => (c.disabled = false));
      updateRelations();
    }
  };
}
export function renderConsumerViews(live, { api, onSaved, showCredential }) {
  const section = el("section", "", "consumer-views");
  section.setAttribute("aria-label", "融合消费视图");
  section.append(
    el("h1", "融合消费视图 · v3"),
    el(
      "p",
      "为其他 Agent 开放固定映射中的融合对象和关系，保留获准字段的冲突、缺失与读取覆盖。",
      "source-meta",
    ),
  );
  const models = live.models.filter((m) => m.status === "adopted");
  const saved = (r) => onSaved?.(r);
  if (models.length)
    section.append(
      btn("创建融合消费视图", () => createView(models, api, saved)),
    );
  else section.append(el("p", "请先采用可执行映射。"));
  for (const view of live.views || []) {
    const card = el("article", "", "live-card"),
      c = view.content;
    card.append(
      el("h3", view.title),
      el("p", c.purpose),
      el(
        "p",
        `${{ draft: "待启用", active: "已启用", revoked: "已停用" }[view.status]} · 固定映射（发布时固定）`,
        "source-meta",
      ),
    );
    for (const g of c.grants)
      card.append(
        el(
          "p",
          `${g.type}：${g.fields.join("、")}${g.relations.length ? "；关系 " + g.relations.join("、") : ""}；依据：${[...(g.evidence?.fields || []), ...(g.evidence?.relations || [])].join("、") || "未开放"}`,
        ),
      );
    if (c.contextEvidence?.length)
      card.append(
        el(
          "p",
          "历史背景依据：" + c.contextEvidence.map((e) => e.label).join("、"),
        ),
      );
    const status = el("p");
    status.setAttribute("role", "status");
    const act = async (method) => {
      const buttons = [...card.querySelectorAll("button")];
      buttons.forEach((b) => (b.disabled = true));
      try {
        const r = await api("/api/live/views/" + method, {
          id: view.id,
          version: view.version,
        });
        saved(r);
        if (method === "activate") {
          if (r.saved.key) showCredential({ apiKey: r.saved.key }, view.title);
          else {
            const d = modal("消费视图已启用");
            d.append(
              el(
                "p",
                "本次未返回密钥。密钥只在首次启用时提供，无法重新读取；若未保存，请停用此视图并重新创建。",
              ),
            );
          }
        }
      } catch (e) {
        if (card.isConnected)
          status.textContent = `未确认完成：${e.message}。可重试或刷新查看当前状态。`;
      } finally {
        buttons.forEach((b) => (b.disabled = false));
      }
    };
    if (view.status === "draft")
      card.append(btn("启用此消费视图", () => act("activate")));
    if (view.status !== "revoked")
      card.append(btn("停用此消费视图", () => act("revoke")));
    if (view.status !== "revoked")
      card.append(
        btn("查看接入说明", async () => {
          const d = modal("消费视图接入说明"),
            status = el("p", "正在生成当前许可契约…");
          d.append(status);
          try {
            const info = await api(
              `/api/live/views/connection?id=${encodeURIComponent(view.id)}&version=${view.version}`,
            );
            if (!d.isConnected) return;
            status.textContent =
              "以下说明从当前视图生成，密钥为占位符。MCP需要本地Node与桥接脚本；动态属性/关系证据引用来自实际查询，最多可访问24小时；容量满时旧引用会提前淘汰。已授权文档/指标引用来自目录，绑定历史读取；均不代表最新源值。";
            for (const [label, content] of [
              [
                "HTTP 调用",
                { ...info.http, contextEvidence: info.contextEvidence },
              ],
              ["MCP 配置", info.mcp],
              ["OpenAPI 3.1", info.openapi],
            ]) {
              d.append(el("h3", label));
              const details = el("details");
              details.append(
                el("summary", `展开 ${label}`),
                el("pre", JSON.stringify(content, null, 2)),
              );
              d.append(details);
              d.append(
                btn(`下载 ${label}`, () => {
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify(content, null, 2)], {
                      type: "application/json",
                    }),
                  );
                  const a = el("a");
                  a.href = url;
                  a.download =
                    label === "OpenAPI 3.1"
                      ? "context-os-openapi.json"
                      : label === "MCP 配置"
                        ? "context-os-mcp.json"
                        : "context-os-http.json";
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }),
              );
            }
          } catch (e) {
            if (d.isConnected) status.textContent = `无法生成：${e.message}`;
          }
        }),
      );
    card.append(status);
    section.append(card);
  }
  if ((live.views || []).length === 40)
    section.append(el("p", "当前显示最近40份视图。", "source-meta"));
  return section;
}

import { el, btn, modal, field } from "./relation-corrections.js";
const drafts = new Map();
const properties = (t) => [
  "$id",
  ...new Set([
    ...Object.keys(t.fields),
    ...(t.supplements || []).flatMap((s) => Object.keys(s.fields)),
  ]),
];
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
      `${m.title} · v${m.version} · ${m.id.slice(0, 8)}`,
    );
    option.value = m.id;
    modelChoice.append(option);
  }
  if (models.some((m) => m.id === old.modelId)) modelChoice.value = old.modelId;
  const scope = el("div");
  form.append(scope);
  let groups = [],
    relations = [];
  const model = () => models.find((m) => m.id === modelChoice.value);
  const grants = () =>
    groups
      .map((g) => ({
        type: g.type,
        fields: g.fields.filter((f) => f.input.checked).map((f) => f.name),
        relations: relations
          .filter((r) => r.from === g.type && r.input.checked)
          .map((r) => r.name),
      }))
      .filter((g) => g.fields.length);
  const updateRelations = () => {
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
    }
  };
  const build = () => {
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
        fields.push({ name, input });
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
      relations.push({ ...r, input });
      links.append(row);
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
      last,
    });
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
      "每个选中类型必须明确勾选$id。关系只有在两端身份及关联字段均选中后才可勾选。",
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
    const m = model(),
      body = {
        name: appName.value,
        purpose: purpose.value,
        modelRef: { id: m.id, version: m.version },
        grants: grants(),
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
        `${{ draft: "待启用", active: "已启用", revoked: "已停用" }[view.status]} · 固定映射 ${c.modelRef.id} v${c.modelRef.version}`,
        "source-meta",
      ),
    );
    for (const g of c.grants)
      card.append(
        el(
          "p",
          `${g.type}：${g.fields.join("、")}${g.relations.length ? "；关系 " + g.relations.join("、") : ""}`,
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
    if (view.status === "active")
      card.append(
        btn("查看 v3 接入路径", () => {
          const d = modal("v3 只读接口");
          d.append(
            el(
              "p",
              "使用 Authorization: Bearer <此视图密钥>；密钥仅首次启用时显示。",
            ),
            el(
              "pre",
              `${location.origin}/v3/catalog\n${location.origin}/v3/types?type=${encodeURIComponent(c.grants[0].type)}\n${location.origin}/v3/objects?type=${encodeURIComponent(c.grants[0].type)}`,
            ),
            el(
              "p",
              "每页最多20个对象。关系查询添加id和relation；不提供证据正文和MCP生成接入说明，后续票接入。来源读取非原子，不返回内部映射、原始冲突值或隐藏字段。",
              "source-meta",
            ),
          );
        }),
      );
    card.append(status);
    section.append(card);
  }
  if ((live.views || []).length === 40)
    section.append(el("p", "当前显示最近40份视图。", "source-meta"));
  return section;
}

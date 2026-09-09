import { renderDefinitionGraph } from "./ontology-workspace.js";
const el = (tag, cls = "", text) => {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const button = (text, fn) => {
  const n = el("button", "quiet-button", text);
  n.type = "button";
  n.onclick = fn;
  return n;
};
function table(items) {
  const wrap = el("div", "live-table");
  const t = el("table");
  if (items.length) {
    const keys = Object.keys(items[0]);
    const head = el("tr");
    keys.forEach((k) => head.append(el("th", "", k)));
    t.append(head);
    for (const item of items) {
      const row = el("tr");
      keys.forEach((k) => row.append(el("td", "", String(item[k] ?? "—"))));
      t.append(row);
    }
  } else wrap.append(el("p", "", "当前范围没有记录"));
  wrap.append(t);
  return wrap;
}
function modal(title, build) {
  const dialog = el("dialog", "live-dialog");
  const close = button("关闭", () => dialog.close());
  dialog.append(el("h2", "", title), close);
  build(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
function formField(
  form,
  label,
  initial = "",
  multiline = false,
  type = "text",
) {
  const row = el("label", "live-field");
  row.append(el("span", "", label));
  const input = el(multiline ? "textarea" : "input");
  if (!multiline) input.type = type;
  input.value = initial;
  input.autocomplete = "off";
  row.append(input);
  form.append(row);
  return input;
}
function showResult(result) {
  modal("当前源系统记录", (dialog) => {
    dialog.append(table(result.items));
    dialog.append(
      el(
        "p",
        "source-meta",
        `读取于 ${result.reads?.map((r) => r.readAt).join(" / ") || result.provenance?.readAt} · 已显示 ${result.coverage.shown} 条${result.coverage.complete ? " · 当前结果完整" : " · 仅当前页，不代表全部记录"}`,
      ),
    );
  });
}
export function renderLiveWorkspace(
  page,
  live,
  { api, mutate, showCredential },
) {
  const section = el("section", "live-canvas");
  const action = async (fn) => {
    try {
      await fn();
    } catch (e) {
      modal("未完成", (d) => d.append(el("p", "", e.message)));
    }
  };
  const change = (path, body) => mutate("/api/live/" + path, body);
  if (page === "sources") {
    section.append(
      el("h1", "", "连接企业数据"),
      el("p", "live-lead", "数据保留在企业原系统。连接后，按需读取业务信息。"),
    );
    section.append(
      button("连接 API / MCP", () =>
        modal("连接企业系统", (dialog) => {
          const form = el("form");
          const name = formField(form, "系统名称");
          const url = formField(form, "接口地址（远端使用 HTTPS）");
          const protocol = el("select");
          protocol.setAttribute("aria-label", "连接方式");
          for (const value of ["http", "mcp"]) {
            const option = el(
              "option",
              "",
              value === "http"
                ? "HTTP API · 只读 GET"
                : "MCP · Streamable HTTP",
            );
            option.value = value;
            protocol.append(option);
          }
          form.append(protocol);
          const token = formField(
            form,
            "访问凭据（可选，仅交给此源系统）",
            "",
            false,
            "password",
          );
          const config = formField(
            form,
            "批准的只读能力（字段和参数由系统提供方确认）",
            JSON.stringify(
              [
                {
                  name: "list_records",
                  path: "/records",
                  fields: ["id", "name"],
                  idField: "id",
                  itemsPath: "items",
                  totalPath: "total",
                  filters: { id: "id" },
                  limitParam: "limit",
                  offsetParam: "offset",
                },
              ],
              null,
              2,
            ),
            true,
          );
          form.append(
            el(
              "p",
              "source-meta",
              "MCP 的 name 填工具名称，无需 path。只有这里明确批准的能力可被调用。",
            ),
          );
          const submit = button("连接系统", () => {});
          submit.type = "submit";
          form.append(submit);
          dialog.append(form);
          form.onsubmit = async (e) => {
            e.preventDefault();
            submit.disabled = true;
            try {
              const capabilities = JSON.parse(config.value);
              const ok = await change("connect", {
                name: name.value,
                url: url.value,
                protocol: protocol.value,
                token: token.value,
                capabilities,
              });
              if (ok) {
                token.value = "";
                dialog.close();
              }
            } catch (err) {
              dialog.append(el("p", "", err.message));
            } finally {
              submit.disabled = false;
            }
          };
        }),
      ),
    );
    const grid = el("div", "source-grid");
    for (const source of live.connections) {
      const card = el("article", "live-card");
      card.append(
        el("h2", "", source.title),
        el(
          "p",
          "source-meta",
          source.status === "ready"
            ? `${source.content.protocol.toUpperCase()} · 已配置连接`
            : "已停用",
        ),
      );
      for (const cap of source.content.capabilities) {
        card.append(el("p", "", `${cap.name} · ${cap.fields.join("、")}`));
        if (source.status === "ready")
          card.append(
            button("读取样本", () =>
              action(async () =>
                showResult(
                  await api("/api/live/read", {
                    sourceId: source.id,
                    capability: cap.name,
                    limit: 3,
                  }),
                ),
              ),
            ),
          );
      }
      if (source.status === "ready")
        card.append(
          button("停用连接", () =>
            action(() =>
              change("disable", { id: source.id, version: source.version }),
            ),
          ),
        );
      grid.append(card);
    }
    section.append(grid);
  } else if (page === "ontology") {
    section.append(
      el("h1", "", "企业本体"),
      el(
        "p",
        "live-lead",
        "从业务问题出发，将源系统的记录组织成有含义的对象与关系。",
      ),
    );
    if (!live.models.length)
      section.append(
        el(
          "p",
          "",
          "在下方告诉我希望理解的业务问题，我会读取已连接来源并提出定义。",
        ),
      );
    for (const model of live.models) {
      const block = el("article", "live-model");
      block.append(
        el("h2", "", model.title),
        el(
          "p",
          "source-meta",
          model.status === "adopted"
            ? "已采用 · 按需读取源系统"
            : "待确认 · 结构检查通过，业务含义仍需确认",
        ),
        el("p", "", model.content.rationale),
      );
      const browse = (type, relation, id) => {
        modal(relation || type.name, (dialog) => {
          const body = el("div");
          dialog.append(body);
          let loading = false;
          const load = async (offset) => {
            if (loading) return;
            loading = true;
            try {
              const result = await api("/api/live/query", {
                modelId: model.id,
                type: type.name,
                offset,
                limit: 20,
                ...(relation ? { relation, id } : {}),
              });
              if (!dialog.isConnected) return;
              body.replaceChildren(
                table(result.items),
                el(
                  "p",
                  "source-meta",
                  `读取时间：${result.reads.map((r) => r.readAt).join(" / ")} · ${result.coverage.complete ? "当前结果完整" : "仅当前页，不代表完整结果"}`,
                ),
              );
              const pages = el("div", "live-actions");
              if (offset > 0)
                pages.append(
                  button("上一页", () =>
                    action(() => load(Math.max(0, offset - 20))),
                  ),
                );
              if (
                result.coverage.total === null
                  ? result.items.length === 20
                  : offset + result.items.length < result.coverage.total
              )
                pages.append(
                  button("下一页", () => action(() => load(offset + 20))),
                );
              body.append(pages);
              if (!relation)
                for (const row of result.items)
                  for (const link of model.content.relations.filter(
                    (r) => r.from === type.name,
                  ))
                    body.append(
                      button(`${row.$id} → ${link.name}`, () =>
                        browse(type, link.name, String(row.$id)),
                      ),
                    );
            } finally {
              loading = false;
            }
          };
          void action(() => load(0));
        });
      };
      const readType = (value) =>
        browse(typeof value === "string" ? { name: value } : value);
      const openDefinition = (type) =>
        modal(type.name + " · 来源映射", (dialog) => {
          const source = live.connections.find((s) => s.id === type.sourceId);
          const cap = source?.content.capabilities.find(
            (c) => c.name === type.capability,
          );
          dialog.append(
            el("p", "", type.description),
            el(
              "p",
              "source-meta",
              `${source?.title || "来源不可用"} · ${type.capability} · 连接契约第 ${model.content.connections[type.sourceId]} 版`,
            ),
            table(
              Object.entries({
                $id: cap?.idField || "未知",
                ...type.fields,
              }).map(([field, column]) => ({
                业务属性: field,
                来源字段: column,
              })),
            ),
            el("p", "", model.content.rationale),
          );
        });
      const displayModel = {
        ...model,
        content: {
          ...model.content,
          sourceVersions: model.content.connections,
        },
      };
      block.append(
        renderDefinitionGraph(displayModel, {
          selection: { kind: "node", id: model.content.types[0].name },
          onSelectionChange: () => {},
          readOnly: true,
          renderEvidence: (refs) => {
            const list = el("div");
            for (const ref of refs)
              list.append(
                el(
                  "p",
                  "source-meta",
                  `${live.connections.find((s) => s.id === ref.sourceId)?.title || "来源不可用"} · 连接契约第 ${ref.version} 版`,
                ),
              );
            return list;
          },
          onOpenObjects: readType,
          onOpenType: openDefinition,
          onAdjust: () => {},
        }),
      );
      const actions = el("div", "live-actions");
      for (const type of model.content.types)
        actions.append(button(`查看${type.name}`, () => readType(type)));
      if (model.status === "candidate")
        actions.append(
          button("采用本体", () =>
            action(() =>
              change("adopt", { id: model.id, version: model.version }),
            ),
          ),
        );
      block.append(actions);
      section.append(block);
    }
  } else if (page === "consumption") {
    section.append(
      el("h1", "", "连接其他应用"),
      el(
        "p",
        "live-lead",
        "通过企业本体读取当前业务信息。每个应用有独立的只读范围。",
      ),
    );
    const model = live.models.find((m) => m.status === "adopted");
    if (!model)
      section.append(
        el("p", "", "采用本体后，可以为其他 Agent 创建访问范围。"),
      );
    else
      section.append(
        button("创建访问范围", () =>
          modal("为应用创建只读范围", (dialog) => {
            const form = el("form");
            const name = formField(form, "应用名称");
            const purpose = formField(form, "使用目的");
            const grants = [];
            for (const type of model.content.types) {
              const group = el("fieldset");
              group.append(el("legend", "", type.name));
              const fields = [];
              for (const field of ["$id", ...Object.keys(type.fields)]) {
                const row = el("label");
                const input = el("input");
                input.type = "checkbox";
                input.value = field;
                row.append(input, document.createTextNode(field));
                group.append(row);
                fields.push(input);
              }
              grants.push({ type: type.name, fields });
              form.append(group);
            }
            form.append(
              el(
                "p",
                "source-meta",
                "勾选类型时需要同时授予 $id（对象编号）。关系范围可通过对话提出。",
              ),
            );
            const submit = button("保存待启用范围", () => {});
            submit.type = "submit";
            form.append(submit);
            dialog.append(form);
            form.onsubmit = async (e) => {
              e.preventDefault();
              submit.disabled = true;
              try {
                const ok = await change("prepare", {
                  name: name.value,
                  purpose: purpose.value,
                  modelId: model.id,
                  grants: grants
                    .map((g) => ({
                      type: g.type,
                      fields: g.fields
                        .filter((f) => f.checked)
                        .map((f) => f.value),
                      relations: [],
                    }))
                    .filter((g) => g.fields.length),
                });
                if (ok) dialog.close();
              } finally {
                submit.disabled = false;
              }
            };
          }),
        ),
      );
    for (const consumer of live.consumers) {
      const card = el("article", "live-card");
      card.append(
        el("h2", "", consumer.title),
        el("p", "", consumer.content.purpose),
        el(
          "p",
          "source-meta",
          { draft: "待启用", active: "已启用", revoked: "已停用" }[
            consumer.status
          ],
        ),
      );
      for (const g of consumer.content.grants)
        card.append(
          el(
            "p",
            "",
            `${g.type}：${g.fields.join("、")}${g.relations.length ? "；关系：" + g.relations.join("、") : ""}`,
          ),
        );
      if (consumer.status === "draft")
        card.append(
          button("启用以上范围", () =>
            action(async () => {
              await mutate(
                "/api/live/activate",
                { id: consumer.id, version: consumer.version },
                (result) =>
                  showCredential({ apiKey: result.saved.key }, consumer.title),
              );
            }),
          ),
        );
      if (consumer.status === "active") {
        card.append(
          button("接入方式", () =>
            modal("接入企业记忆", (dialog) => {
              dialog.append(
                el(
                  "p",
                  "",
                  "HTTP：使用 Authorization: Bearer <此应用密钥> 调用以下只读接口。",
                ),
                el(
                  "pre",
                  "",
                  `${location.origin}/v2/schema\n${location.origin}/v2/objects?type=${encodeURIComponent(consumer.content.grants[0].type)}`,
                ),
                el(
                  "p",
                  "",
                  "MCP：在本机运行项目的 scripts/dataengine-mcp.ts，设置以下环境变量。",
                ),
                el(
                  "pre",
                  "",
                  `DATAENGINE_URL=${location.origin}\nDATAENGINE_CONSUMER_KEY=<此应用密钥>`,
                ),
                el(
                  "p",
                  "source-meta",
                  "每次查询读取源系统当前记录，返回读取时间；不保证跨系统快照。",
                ),
              );
            }),
          ),
          button("停用访问", () =>
            action(() =>
              change("revoke", { id: consumer.id, version: consumer.version }),
            ),
          ),
        );
      }
      section.append(card);
    }
    if (live.audit.length) {
      section.append(el("h2", "", "最近访问"));
      section.append(
        table(
          live.audit.map((a) => ({
            应用: a.title,
            接口: a.content.path,
            结果: a.content.status,
            时间: a.content.readAt,
          })),
        ),
      );
    }
  }
  return section;
}

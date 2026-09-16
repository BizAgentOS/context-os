import { openApiImport } from "./openapi-import.js";
import { openConnections } from "./connections.js";
import {renderConsumerMigrations} from "./consumer-migrations.js";
import {renderConsumerViews} from "./consumer-views.js";
import { renderMappingChanges } from "./mapping-changes.js";
import { renderCorrections } from "./relation-corrections.js";
import { renderLiveObjects } from "./live-objects.js";
import { renderFusionEvidence } from "./fusion.js";
import { renderMetricInspector } from "./metrics.js";
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
function knowledgeDialog(source, cap, api) {
  modal(source.title + " · 知识文档", (dialog) => {
    const form = el("form");
    const filter = formField(form, "精确过滤（JSON，可留空）", "{}", true);
    const search = button("查询目录", () => {});
    search.type = "submit";
    const result = el("div", "knowledge-results");
    result.setAttribute("aria-live", "polite");
    const excerpt = el("section", "foundation-excerpt");
    excerpt.setAttribute("aria-live", "polite");
    let offset = 0,
      where = {},
      sequence = 0;
    const next = button("下一页", () => load(offset + 5));
    next.hidden = true;
    const args = {
      sourceId: source.id,
      capability: cap.name,
      connectionVersion: source.version,
    };
    const load = async (position) => {
      const seq = ++sequence;
      search.disabled = true;
      next.disabled = true;
      excerpt.replaceChildren();
      result.replaceChildren(el("p", "source-meta", "正在查询目录…"));
      next.hidden = true;
      try {
        const page = await api("/api/live/knowledge/query", {
          ...args,
          where,
          offset: position,
          limit: 5,
        });
        if (seq !== sequence || !dialog.isConnected) return;
        offset = position;
        result.replaceChildren();
        result.append(
          el(
            "p",
            "source-meta",
            `已读目录 ${page.coverage.shown} 条 · ${page.coverage.complete ? "当前查询目录完整" : "部分目录，非全库覆盖"}`,
          ),
        );
        for (const item of page.items) {
          const row = el("article", "live-card");
          row.append(
            el("h3", "", item.title),
            el(
              "p",
              "source-meta",
              `文档 ${item.documentId} · 片段 ${item.segmentId} · 版本 ${item.revision}`,
            ),
          );
          const read = async (position = 0) => {
            const request = ++sequence;
            try {
              const part = await api("/api/live/knowledge/read", {
                ...args,
                segmentId: item.segmentId,
                revision: item.revision,
                offset: position,
                limit: 4000,
              });
              if (request !== sequence || !dialog.isConnected) return;
              excerpt.replaceChildren(
                el("h3", "", part.title),
                el(
                  "p",
                  "source-meta",
                  `版本 ${part.revision} · ${new Date(part.readAt).toLocaleString("zh-CN")} · ${part.coverage.complete ? "当前片段完整，不代表整份文档" : "当前片段部分正文"}`,
                ),
                el("pre", "", part.text),
              );
              if (part.coverage.nextOffset !== null)
                excerpt.append(
                  button("继续读取片段", () => read(part.coverage.nextOffset)),
                );
            } catch (error) {
              if (request === sequence)
                excerpt.replaceChildren(el("p", "", error.message));
            }
          };
          row.append(button("读取片段", () => read()));
          result.append(row);
        }
        next.hidden =
          page.coverage.total !== null
            ? offset + page.coverage.shown >= page.coverage.total
            : page.coverage.shown < 5;
      } catch (error) {
        if (seq === sequence) {
          result.replaceChildren(el("p", "", error.message));
          next.hidden = true;
        }
      } finally {
        search.disabled = false;
        next.disabled = false;
      }
    };
    form.append(
      search,
      el(
        "p",
        "source-meta",
        `可过滤字段：${Object.keys(cap.filters).join("、")}。预览不保存本体；告诉助手使用这些资料，可生成带依据的候选。`,
      ),
    );
    form.onsubmit = (event) => {
      event.preventDefault();
      try {
        where = JSON.parse(filter.value || "{}");
        void load(0);
      } catch {
        ++sequence;
        excerpt.replaceChildren();
        next.hidden = true;
        result.replaceChildren(el("p", "", "过滤条件需要有效 JSON"));
      }
    };
    dialog.append(form, result, next, excerpt);
    void load(0);
  });
}
export function renderLiveWorkspace(
  page,
  live,
  { api, mutate, showCredential, selections = new Map(), onSelectContext, onSaved, onImportSaved, onConnectionsChanged },
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
      el("h1", "", "企业数据"),
      el(
        "p",
        "live-lead",
        "查看接入了什么数据、来自哪里，以及当前可读取的范围。",
      ),
    );
    section.append(
      button("导入 Swagger / OpenAPI", () => openApiImport({ api, onSaved: onImportSaved })),
      button("接入服务", () =>
        openConnections(api, () => modal("连接企业系统", (dialog) => {
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
          const contentKind = el("select");
          contentKind.setAttribute("aria-label", "内容类型");
          for (const [value, title] of [
            ["records", "业务记录"],
            ["knowledge", "知识文档片段"],
            ["metrics", "BI 指标"],
          ]) {
            const option = el("option", "", title);
            option.value = value;
            contentKind.append(option);
          }
          form.append(contentKind);
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
          contentKind.onchange = () => {
            config.value = JSON.stringify(
              contentKind.value === "metrics"
                ? [
                    {
                      name: "metrics",
                      path: "/metrics",
                      contentKind: "metrics",
                      metricId: "resolution_rate",
                    },
                  ]
                : contentKind.value === "knowledge"
                  ? [
                      {
                        name: "documents",
                        path: "/documents",
                        contentKind: "knowledge",
                        fields: [
                          "id",
                          "documentId",
                          "title",
                          "revision",
                          "text",
                        ],
                        idField: "id",
                        filters: { id: "id", documentId: "documentId" },
                        itemsPath: "items",
                        totalPath: "total",
                      },
                    ]
                  : [
                      {
                        name: "list_records",
                        path: "/records",
                        contentKind: "records",
                        fields: ["id", "name"],
                        idField: "id",
                        filters: { id: "id" },
                        itemsPath: "items",
                        totalPath: "total",
                      },
                    ],
              null,
              2,
            );
          };
          form.append(
            el(
              "p",
              "source-meta",
              "知识源按片段提供 id、documentId、title、revision、text；每片段最多16000字符，过滤为精确匹配。BI 指标需声明 metricId，来源提供定义及按维度/期间查询的指标合同。此处编辑连接契约，企业定义仍由助手与您共同核对。",
            ),
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
              const capabilities = JSON.parse(config.value).map((cap) => ({
                ...cap,
                contentKind: contentKind.value,
              }));
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
        }), { onChanged: onConnectionsChanged }),
      ),
    );
    const account = el("div", "data-account");
    section.append(account);
    void api("/api/connectors/feishu").then(result => {
      if (!result.account) return;
      account.append(el("strong", "", "飞书"), el("span", "source-meta", "账号授权 · 官方 CLI"), el("p", "", `已保存连接 · ${result.account.label}`), el("p", "source-meta", "按文档链接读取；账号连接不代表文档已导入。"), button("查看连接与读取文档", () => openConnections(api, undefined, { service: "feishu", onChanged: onConnectionsChanged })));
    }).catch(() => { account.append(el("p", "source-meta", "账号连接状态暂不可用")); });
    const grid = el("div", "source-grid");
    for (const source of live.connections) {
      const card = el("article", "live-card");
      card.append(
        el("h2", "", source.title),
        el(
          "p",
          "source-meta",
          source.status === "ready"
            ? `${source.content.protocol === "mcp" ? "MCP" : "HTTP API"} · 已配置，按需读取`
            : "已停用",
        ),
      );
      card.append(el("p", "source-meta", `数据来源：${source.title}`));
      for (const cap of source.content.capabilities) {
        card.append(
          el(
            "p",
            "",
            `${cap.contentKind === "metrics" ? "BI 指标" : cap.contentKind === "knowledge" ? "知识文档" : "业务记录"} · ${cap.name} · ${cap.contentKind === "metrics" ? cap.metricId : cap.fields.join("、")}`,
          ),
        );
        if (source.status === "ready" && cap.contentKind === "metrics") {
          card.append(
            button("查看指标", () =>
              modal(source.title + " · BI 指标", (dialog) =>
                dialog.append(renderMetricInspector(source, cap, api)),
              ),
            ),
          );
          continue;
        }
        if (source.status === "ready" && cap.contentKind === "knowledge") {
          card.append(
            button("查询知识文档", () => knowledgeDialog(source, cap, api)),
          );
          continue;
        }
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
    const currentMapping = live.models.find(m => m.status === "adopted");
    if (currentMapping) section.append(renderMappingChanges(currentMapping, {api, live, onSaved}));
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
    const currentModel = live.models.find((model) => model.status === "adopted");
    for (const model of live.models) {
      const block = el("article", "live-model");
      block.append(
        el("h2", "", model.title),
        el(
          "p",
          "source-meta",
          `${model.status === "adopted"
            ? (model.id === currentModel?.id ? "当前采用映射" : "历史采用映射") + " · 按需读取源系统"
            : "待确认 · 结构检查通过，业务含义仍需确认"} · v${model.version} · ${model.id}`,
        ),
        el("p", "", `建模时的依据：${model.content.rationale}`),
      );
      const cite = async (target, scope, dialog) => {
        if (await onSelectContext?.(model, target, scope)) {
          dialog?.close();
          document.getElementById("message-input")?.focus();
        }
      };
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
                modelVersion: model.version,
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
              if (result.evidence)
                body.append(renderFusionEvidence(result.evidence));
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
              const scope = { where: {}, offset, limit: 20 };
              if (relation && onSelectContext)
                body.append(
                  button("讨论这条对象关系", () =>
                    cite(
                      {
                        kind: "relation",
                        type: type.name,
                        member: relation,
                        objectId: id,
                      },
                      scope,
                      dialog,
                    ),
                  ),
                );
              if (!relation)
                for (const row of result.items) {
                  const rowActions = el("div", "live-actions");
                  if (onSelectContext)
                    rowActions.append(
                      button(`讨论对象 ${row.$id}`, () =>
                        cite(
                          {
                            kind: "object",
                            type: type.name,
                            objectId: String(row.$id),
                          },
                          { where: {}, offset: 0, limit: 1 },
                          dialog,
                        ),
                      ),
                    );
                  for (const link of model.content.relations.filter(
                    (r) => r.from === type.name,
                  ))
                    rowActions.append(
                      button(`${row.$id} → ${link.name}`, () => {
                        dialog.close();
                        browse(type, link.name, String(row.$id));
                      }),
                    );
                  body.append(rowActions);
                }
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
          for (const extra of type.supplements || []) {
            dialog.append(
              el("h3", "", `附来源 ${extra.name}`),
              el(
                "p",
                "",
                `${extra.match.primaryField} → ${extra.match.sourceField} · ${extra.capability}`,
              ),
              table(
                Object.entries(extra.fields).map(([property, field]) => ({
                  业务属性: property,
                  附来源字段: field,
                })),
              ),
              el("p", "", extra.rationale),
            );
          }
        });
      const graphKey = `live:${model.id}:${model.version}`;
      if (!selections.has(graphKey))
        selections.set(graphKey, {
          kind: "node",
          id: model.content.types[0].name,
        });
      const displayModel = {
        ...model,
        content: {
          ...model.content,
          types: model.content.types.map((t) => ({
            ...t,
            fields: Object.assign(
              {},
              t.fields,
              ...(t.supplements || []).map((s) => s.fields),
            ),
          })),
          sourceVersions: model.content.connections,
        },
      };
      block.append(
        renderDefinitionGraph(displayModel, {
          selection: selections.get(graphKey),
          onSelectionChange: () => {},
          readOnly: !onSelectContext,
          adjustLabel: "讨论这类对象",
          onSelectProperty: onSelectContext
            ? (type, member) => cite({ kind: "property", type, member })
            : undefined,
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
          onOpenType: (type) =>
            openDefinition(
              model.content.types.find((t) => t.name === type.name),
            ),
          onAdjust: (_label, target) => cite(target),
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
      const objects = el("details", "live-object-entry");
      objects.append(el("summary", "", "探索在线对象与关系"));
      const openKey = `objects-open:${model.id}:${model.version}`;
      objects.open = Boolean(selections.get(openKey));
      let loaded = false;
      objects.addEventListener("toggle", () => {
        selections.set(openKey, objects.open);
        if (objects.open && !loaded) {
          loaded = true;
          objects.append(
            renderLiveObjects(model, {
              api,
              selections,
              select: (m, t, s, guard) =>
                onSelectContext?.(m, t, s, false, guard),
            }),
          );
        }
      });
      block.append(objects);
      if (model.status === "adopted")
        block.append(renderCorrections(model, { api }));
      section.append(block);
    }
  } else if (page === "consumption") {
    section.append(renderConsumerViews(live,{api,onSaved,showCredential}),renderConsumerMigrations({api,onSaved}));
    section.append(
      el("h2", "", "旧版 v2 访问范围"),
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
        button("创建旧版 v2 访问范围", () =>
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

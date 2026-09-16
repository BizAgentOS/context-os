const el = (tag, className = "", text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (text, action, cls = "quiet-button") => {
  const node = el("button", cls, text);
  node.type = "button";
  node.onclick = action;
  return node;
};
const field = (parent, text, value = "", type = "text") => {
  const label = el("label", "oi-field");
  label.append(el("span", "", text));
  const input = el(type === "textarea" ? "textarea" : "input");
  if (type !== "textarea") input.type = type;
  input.value = value;
  input.autocomplete = "off";
  input.spellcheck = false;
  label.append(input);
  parent.append(label);
  return input;
};
function sampleTable(result) {
  const section = el("section", "oi-sample");
  const sample = result.sample;
  section.append(
    el("h4", "", result.name),
    el(
      "p",
      "source-meta",
      `实际读取 ${sample.items.length} 条 · ${new Date(sample.readAt).toLocaleString("zh-CN")} · 样本不代表全部数据`,
    ),
  );
  section.append(
    el(
      "p",
      "source-meta",
      sample.coverage.total === null
        ? "总量未知 · 当前仅验证此页，不能推断全量覆盖。"
        : `来源报告总量 ${sample.coverage.total} 条 · ${sample.coverage.complete ? "当前查询已完整返回" : "仅覆盖当前样本页"}`,
    ),
  );
  const scroll = el("div", "oi-table-scroll"),
    table = el("table"),
    head = el("tr");
  result.fields.forEach((key) => head.append(el("th", "", key)));
  table.append(head);
  for (const item of sample.items) {
    const row = el("tr");
    result.fields.forEach((key) =>
      row.append(el("td", "", String(item[key] ?? "—"))),
    );
    table.append(row);
  }
  scroll.append(table);
  section.append(scroll);
  return section;
}

export function openApiImport({ api, onSaved, ask }) {
  const dialog = el("dialog", "live-dialog openapi-import");
  dialog.setAttribute("aria-label", "导入 Swagger / OpenAPI");
  const head = el("header", "data-map-dialog-head");
  const close = button("关闭", () => {
    if (!saving) dialog.close();
  });
  head.append(el("h2", "", "导入 Swagger / OpenAPI"), close);
  const steps = el("div", "oi-steps");
  const content = el("div", "oi-content");
  const status = el("p", "oi-status");
  status.setAttribute("role", "status");
  const footer = el("footer", "oi-footer");
  let generation = 0,
    saving = false,
    busy = false,
    catalog = null,
    receipt = null;
  dialog.append(
    head,
    el(
      "p",
      "source-meta",
      "用接口文档接入业务数据，测试通过后保存为企业来源。",
    ),
    steps,
    content,
    status,
    footer,
  );
  dialog.addEventListener("cancel", (event) => {
    if (saving) event.preventDefault();
  });
  dialog.addEventListener(
    "close",
    () => {
      generation++;
      content.replaceChildren();
      receipt = null;
      dialog.remove();
    },
    { once: true },
  );
  const setSteps = (active) =>
    steps.replaceChildren(
      ...["导入文档", "选择接口与认证", "测试并保存"].map((text, i) =>
        el("span", i + 1 === active ? "active" : "", `${i + 1}  ${text}`),
      ),
    );
  const message = (text, error = false) => {
    status.textContent = text;
    status.classList.toggle("error", error);
  };
  const run = async (task, done, loading) => {
    if (busy) return;
    busy = true;
    const seq = ++generation;
    message(loading);
    const controls = [
      ...dialog.querySelectorAll("input, select, textarea, button"),
    ].filter((node) => node !== close);
    const wasDisabled = controls.map((node) => node.disabled);
    controls.forEach((node) => {
      node.disabled = true;
    });
    try {
      const result = await task();
      if (seq === generation && dialog.open) {
        message("");
        done(result);
      }
    } catch (error) {
      if (seq === generation && dialog.open) message(error.message, true);
    } finally {
      busy = false;
      controls.forEach((node, i) => {
        node.disabled = wasDisabled[i];
      });
    }
  };

  function documentStep() {
    receipt = null;
    catalog = null;
    setSteps(1);
    message("");
    content.replaceChildren();
    footer.replaceChildren();
    const grid = el("div", "oi-grid"),
      inputPanel = el("section", "oi-panel"),
      help = el("aside", "oi-guide");
    const tabs = el("div", "oi-tabs"),
      inputs = el("div");
    inputPanel.append(el("h3", "", "提供接口文档"), tabs, inputs);
    let mode = "url",
      text = "",
      url = "";
    let input;
    const parse = button(
      "解析文档",
      () => {
        if (!input.value.trim()) {
          message("请先提供接口文档。", true);
          input.focus();
          return;
        }
        run(
          () =>
            api(
              "/api/live/openapi/parse",
              mode === "url"
                ? { url: input.value.trim() }
                : { text: input.value },
            ),
          (result) => {
            catalog = result;
            configureStep();
          },
          "正在解析接口文档…",
        );
      },
      "primary-button",
    );
    const tabButtons = [];
    const setMode = (next) => {
      if (input) {
        if (mode === "url") url = input.value;
        else text = input.value;
      }
      mode = next;
      inputs.replaceChildren();
      tabButtons.forEach(([key, node]) => {
        node.classList.toggle("active", key === mode);
        node.setAttribute("aria-pressed", String(key === mode));
      });
      if (mode === "url") {
        input = field(inputs, "文档 URL", url, "url");
        input.placeholder = "https://api.example.com/openapi.json";
        inputs.append(
          el(
            "p",
            "source-meta",
            "填写 JSON/YAML 文档地址；受保护的文档可下载后上传。",
          ),
        );
      } else {
        if (mode === "file") {
          const file = field(
            inputs,
            "上传 JSON / YAML 文件（最多 2 MB）",
            "",
            "file",
          );
          file.accept = ".json,.yaml,.yml";
          file.onchange = async () => {
            const selected = file.files?.[0];
            if (!selected) return;
            if (selected.size > 2_000_000) {
              message("文件最多 2 MB。", true);
              return;
            }
            const target = input;
            try {
              const data = await selected.text();
              if (file.isConnected && !busy) target.value = data;
            } catch {
              message("无法读取文件，请重试。", true);
            }
          };
        }
        input = field(
          inputs,
          mode === "file" ? "文档内容" : "JSON / YAML 内容",
          text,
          "textarea",
        );
        input.placeholder =
          'openapi: 3.0.3\ninfo:\n  title: 企业业务系统\n  version: "1.0"\npaths: …';
      }
    };
    for (const [key, title] of [
      ["url", "输入 URL"],
      ["text", "粘贴文档"],
      ["file", "上传文件"],
    ]) {
      const node = button(title, () => setMode(key));
      tabButtons.push([key, node]);
      tabs.append(node);
    }
    help.append(
      el("span", "oi-eyebrow", "连接流程"),
      el("h3", "", "从接口说明，到可用的数据来源"),
    );
    for (const [title, detail] of [
      ["识别可读接口", "解析接口、返回字段与分页规则。"],
      ["选择所需数据", "只选择这家企业需要接入的接口。"],
      ["验证真实样本", "每个接口最多读取 3 条，确认后保存。"],
    ]) {
      const row = el("div", "oi-guide-row");
      row.append(el("strong", "", title), el("p", "source-meta", detail));
      help.append(row);
    }
    help.append(
      el(
        "p",
        "source-meta",
        "支持 Swagger 2.0、OpenAPI 3.0 / 3.1；当前接入 GET 列表与 limit/offset 分页。",
      ),
    );
    grid.append(inputPanel, help);
    content.append(grid);
    footer.append(
      el("span", "source-meta", "解析文档不会读取业务数据。"),
      parse,
    );
    setMode("url");
  }

  function configureStep() {
    setSteps(2);
    content.replaceChildren();
    footer.replaceChildren();
    receipt = null;
    const summary = el("div", "oi-document-summary");
    summary.append(
      el("strong", "", catalog.title),
      el(
        "span",
        "source-meta",
        `${catalog.format} · ${catalog.version} · ${catalog.operations.length} 个接口`,
      ),
      button("重新导入", documentStep),
    );
    const grid = el("div", "oi-grid"),
      list = el("section", "oi-panel oi-operation-list"),
      config = el("section", "oi-panel");
    list.append(
      el("h3", "", "选择数据接口"),
      el("p", "source-meta", "最多选择 30 个接口，按需勾选。"),
    );
    const selected = new Map();
    const results = el("div", "oi-results");
    const test = button("测试所选接口", () => testSelected(), "primary-button");
    const save = button("确认导入", () => saveSelected(), "primary-button");
    save.hidden = true;
    const invalidate = () => {
      receipt = null;
      results.replaceChildren();
      save.hidden = true;
      test.hidden = false;
      setSteps(2);
      message("");
    };
    for (const operation of catalog.operations) {
      const row = el("article", "oi-operation");
      const label = el("label", "oi-operation-choice");
      const check = el("input");
      check.type = "checkbox";
      check.disabled = !operation.supported;
      const description = el("span");
      description.append(
        el("strong", "", operation.summary),
        el("code", "", `${operation.method} ${operation.path}`),
      );
      label.append(check, description);
      row.append(label);
      if (!operation.supported)
        row.append(el("p", "source-meta", operation.reason));
      else {
        const mapping = structuredClone(operation.defaults);
        const details = el("details");
        details.append(el("summary", "", "字段与读取规则"));
        const identityLabel = el("label", "oi-field"),
          identity = el("select");
        identityLabel.append(el("span", "", "唯一身份字段"), identity);
        Object.entries(operation.fieldTypes)
          .filter(([, type]) => ["string", "number"].includes(type))
          .forEach(([field]) => {
            const option = el("option", "", field);
            option.value = field;
            identity.append(option);
          });
        identity.value = mapping.idField;
        identity.onchange = () => {
          mapping.idField = identity.value;
          mapping.idType = operation.fieldTypes[identity.value];
          invalidate();
        };
        details.append(
          identityLabel,
          el(
            "p",
            "source-meta",
            `记录路径：${mapping.itemsPath || "根数组"} · 分页：${mapping.limitParam} / ${mapping.offsetParam}`,
          ),
        );
        for (const [key, declared, title] of [
          ["limitParam", operation.pagination?.limitDeclared, "每页条数参数"],
          [
            "offsetParam",
            operation.pagination?.offsetDeclared,
            "偏移量参数（从 0 开始）",
          ],
        ]) {
          if (!declared) {
            details.open = true;
            const parameter = field(
              details,
              title + " · 文档未声明，请确认",
              mapping[key],
            );
            parameter.oninput = () => {
              mapping[key] = parameter.value.trim();
              invalidate();
            };
          }
        }
        const fields = el("div", "oi-field-choices");
        for (const name of mapping.fields) {
          const item = el("label"),
            box = el("input");
          box.type = "checkbox";
          box.checked = true;
          box.onchange = () => {
            mapping.fields = [...fields.querySelectorAll("input:checked")].map(
              (node) => node.value,
            );
            invalidate();
          };
          box.value = name;
          item.append(box, document.createTextNode(name));
          fields.append(item);
        }
        details.append(
          el("span", "source-meta", "读取字段（身份字段必须保留）"),
          fields,
        );
        row.append(details);
        check.onchange = () => {
          if (check.checked) selected.set(operation.id, mapping);
          else selected.delete(operation.id);
          invalidate();
        };
      }
      list.append(row);
    }
    config.append(el("h3", "", "连接配置"));
    const name = field(config, "连接名称", catalog.title);
    const base = field(config, "Base URL", catalog.baseUrl, "url");
    base.placeholder = "https://api.example.com/v1";
    const authLabel = el("label", "oi-field"),
      authType = el("select");
    authLabel.append(el("span", "", "认证方式"), authType);
    for (const [type, title] of [
      ["none", "无认证"],
      ["bearer", "Bearer Token"],
      ["apiKey", "API Key（请求头）"],
      ["basic", "Basic（用户名 / 密码）"],
    ]) {
      const option = el("option", "", title);
      option.value = type;
      authType.append(option);
    }
    authType.value = catalog.authOptions[0]?.type || "none";
    const authFields = el("div"),
      authHint = el(
        "p",
        "source-meta",
        "凭据仅保存在本机来源凭据文件，不进入对话和本体。",
      );
    let header, secret, username;
    const renderAuth = () => {
      authFields.replaceChildren();
      header = secret = username = null;
      if (authType.value === "apiKey")
        header = field(
          authFields,
          "API Key 请求头",
          catalog.authOptions.find((a) => a.type === "apiKey")?.headerName ||
            "X-API-Key",
        );
      if (authType.value === "basic") username = field(authFields, "用户名");
      if (authType.value !== "none")
        secret = field(
          authFields,
          authType.value === "basic" ? "密码" : "密钥 / Token",
          "",
          "password",
        );
    };
    config.append(authLabel, authFields, authHint, results);
    renderAuth();
    config.addEventListener("input", invalidate);
    authType.onchange = () => {
      renderAuth();
      invalidate();
    };
    grid.append(list, config);
    content.append(summary, grid);
    footer.append(
      el(
        "span",
        "source-meta",
        "测试只读样本；导入后仍需在本体工作区配置业务映射。",
      ),
      test,
      save,
    );
    function testSelected() {
      if (!selected.size) {
        message("请先勾选至少一个可用接口。", true);
        return;
      }
      if (!name.value.trim() || !base.value.trim()) {
        message("请填写连接名称和 Base URL。", true);
        return;
      }
      let token = secret?.value;
      if (authType.value === "basic") {
        if (!username.value || username.value.includes(":")) {
          message("请填写有效用户名，不能包含冒号。", true);
          return;
        }
        token = btoa(
          String.fromCharCode(
            ...new TextEncoder().encode(`${username.value}:${token || ""}`),
          ),
        );
      }
      const auth = {
        type: authType.value,
        ...(header ? { headerName: header.value.trim() } : {}),
        ...(token ? { secret: token } : {}),
      };
      invalidate();
      run(
        () =>
          api("/api/live/openapi/preview", {
            draftId: catalog.draftId,
            name: name.value.trim(),
            baseUrl: base.value.trim(),
            auth,
            operations: [...selected].map(([id, mapping]) => ({
              id,
              ...mapping,
            })),
          }),
        (preview) => {
          receipt = preview.receiptId;
          setSteps(3);
          results.replaceChildren(
            el("h3", "", "样本测试通过"),
            ...preview.results.map(sampleTable),
          );
          test.hidden = true;
          save.hidden = false;
          message("所有所选接口测试通过，可以确认导入。测试回执保留 30 分钟。");
          results.scrollIntoView({ block: "nearest", behavior: "smooth" });
        },
        `正在测试 ${selected.size} 个接口，每个最多读取 3 条…`,
      );
    }
    function saveSelected() {
      if (!receipt || busy) return;
      saving = true;
      close.disabled = true;
      run(
        () => api("/api/live/openapi/commit", { receiptId: receipt }),
        (result) => {
          onSaved?.(result);
          setSteps(3);
          content.replaceChildren();
          footer.replaceChildren();
          receipt = null;
          const done = el("section", "oi-complete");
          done.append(
            el("span", "oi-complete-mark", "✓"),
            el("h3", "", "已接入 HTTP API"),
            el("p", "", result.saved.title),
            el(
              "p",
              "source-meta",
              `${result.saved.content.capabilities.length} 个只读接口已保存。业务数据按需读取；下一步可在本体工作区建立对象与字段映射。`,
            ),
          );
          content.append(done);
          footer.append(button("完成", () => dialog.close(), "primary-button"));
          if (ask)
            footer.prepend(
              button("让助手整理映射", () => {
                dialog.close();
                ask(
                  `请根据新接入的 HTTP API「${result.saved.title}」和现有企业本体，提出业务对象与字段的映射建议。`,
                );
              }),
            );
        },
        "正在保存已测试的来源…",
      ).finally(() => {
        saving = false;
        close.disabled = false;
      });
    }
  }
  document.body.append(dialog);
  documentStep();
  dialog.showModal();
  return dialog;
}

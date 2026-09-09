const el = (tag, text, className) => {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (className) e.className = className;
  return e;
};
const field = (label, type = "text") => {
  const wrap = el("label", label),
    input = el(type === "textarea" ? "textarea" : "input");
  if (type !== "textarea") input.type = type;
  wrap.append(input);
  return { wrap, input };
};
const action = (text, callback) => {
  const b = el("button", text, "quiet-button");
  b.type = "button";
  b.addEventListener("click", callback);
  return b;
};
export function createCapabilitiesPanel(api) {
  const button = action("能力", open);
  button.id = "open-capabilities";
  button.classList.add("capabilities-button");
  button.hidden = true;
  document.querySelector("#open-settings").before(button);
  const dialog = el("dialog", null, "settings-dialog capabilities-dialog");
  dialog.setAttribute("aria-label", "Agent 能力");
  const heading = el("div", null, "dialog-heading");
  heading.append(
    el("h2", "Agent 能力"),
    action("关闭", () => dialog.close()),
  );
  const status = el("p", null, "settings-status");
  status.setAttribute("role", "status");
  status.hidden = true;
  const content = el("div");
  dialog.append(heading, status, content);
  document.body.append(dialog);
  let busy = false;
  const message = (text) => {
    status.textContent = text;
    status.hidden = !text;
  };
  async function perform(path, body) {
    if (busy) return;
    busy = true;
    message("正在处理…");
    content.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      const state = await api(path, body);
      render(state);
      message("已保存，后续对话即可使用。");
    } catch (e) {
      message(e.message);
    } finally {
      busy = false;
      content.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  }
  async function open() {
    dialog.showModal();
    message("正在读取…");
    try {
      render(await api("/api/capabilities"));
      message("");
    } catch (e) {
      message(e.message);
    }
  }
  function section(title, description) {
    const s = el("section", null, "capability-section");
    s.append(el("h3", title));
    if (description) s.append(el("p", description, "muted"));
    content.append(s);
    return s;
  }
  function render(state) {
    content.replaceChildren();
    section(
      "搜索",
      "已启用 KodaX 网页搜索与网页读取。直接在对话中说明需要查找的公开信息。",
    );
    const skills = section(
      "Skill",
      "Agent 按任务发现并加载方法，再用已授权工具执行。",
    );
    for (const s of state.skills) {
      const row = el("div", null, "capability-row");
      row.append(el("strong", s.name), el("p", s.description));
      skills.append(row);
    }
    const add = el("details"),
      summary = el("summary", "加载 SKILL.md");
    add.append(summary);
    const sf = el("form"),
      name = field("名称"),
      body = field("SKILL.md 内容", "textarea");
    name.input.placeholder = "enterprise-analysis";
    body.input.rows = 6;
    const save = el("button", "加载", "primary-button");
    save.type = "submit";
    sf.append(
      name.wrap,
      body.wrap,
      el("p", "加载方法文本，不执行内嵌 shell、hooks 或 fork。", "muted"),
      save,
    );
    add.append(sf);
    skills.append(add);
    sf.addEventListener("submit", (e) => {
      e.preventDefault();
      void perform("/api/capabilities/skill/install", {
        name: name.input.value,
        content: body.input.value,
      });
    });
    const mcp = section(
      "MCP",
      "连接 Agent 可使用的外部工具、资源和提示词。只开放你勾选的能力；这不会自动把它发布给第三方。",
    );
    for (const server of state.servers) {
      const box = el("div", null, "capability-row");
      box.append(el("strong", server.name));
      const checks = [];
      for (const cap of server.capabilities) {
        const label = el("label", null, "capability-check");
        const check = el("input");
        check.type = "checkbox";
        check.checked = cap.allowed;
        checks.push({ check, id: cap.id });
        const text = el("span");
        text.append(
          el("strong", `${cap.name} · ${cap.kind}`),
          el("small", cap.summary || "服务未提供说明"),
        );
        label.append(check, text);
        box.append(label);
      }
      box.append(
        action("保存可用范围", () =>
          perform("/api/capabilities/mcp/grant", {
            name: server.name,
            revision: server.revision,
            ids: checks.filter((c) => c.check.checked).map((c) => c.id),
          }),
        ),
        action("撤销全部", () =>
          perform("/api/capabilities/mcp/grant", {
            name: server.name,
            revision: server.revision,
            ids: [],
          }),
        ),
      );
      box.append(
        action("重新发现（清空授权）", () =>
          perform("/api/capabilities/mcp/refresh", { name: server.name }),
        ),
        action("断开连接", () =>
          perform("/api/capabilities/mcp/disconnect", { name: server.name }),
        ),
      );
      mcp.append(box);
    }
    if (!state.servers.length) mcp.append(el("p", "尚未连接 MCP。", "muted"));
    const detail = el("details"),
      title = el("summary", "连接 MCP 服务");
    detail.append(title);
    const form = el("form"),
      serverName = field("连接名称"),
      url = field("服务地址", "url"),
      headers = field("请求头 JSON（可选，凭据仅保存在本机）", "textarea");
    headers.input.autocomplete = "off";
    headers.input.spellcheck = false;
    headers.input.rows = 2;
    headers.input.placeholder = "{}";
    url.input.placeholder = "https://example.com/mcp";
    serverName.input.placeholder = "enterprise-tools";
    const transport = el("label", "传输方式"),
      select = el("select");
    for (const [v, t] of [
      ["http", "Streamable HTTP"],
      ["sse", "SSE"],
    ]) {
      const o = el("option", t);
      o.value = v;
      select.append(o);
    }
    transport.append(select);
    const connect = el("button", "连接并发现能力", "primary-button");
    connect.type = "submit";
    form.append(serverName.wrap, url.wrap, transport, headers.wrap, connect);
    detail.append(form);
    mcp.append(detail);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      try {
        const parsed = JSON.parse(headers.input.value || "{}");
        const request = {
          name: serverName.input.value,
          url: url.input.value,
          type: select.value,
          headers: parsed,
        };
        headers.input.value = "";
        void perform("/api/capabilities/mcp/connect", request);
      } catch {
        message("请求头需要合法的 JSON 对象。");
      }
    });
    const sdk = section(
      "业务 SDK",
      "通过已注册的方法调用业务系统。新增企业 SDK 由开发者接入适配器。",
    );
    for (const method of state.sdks) {
      const row = el("details", null, "capability-row");
      row.append(
        el("summary", method.id),
        el("p", method.description),
        el("pre", JSON.stringify(method.inputSchema, null, 2)),
      );
      sdk.append(row);
    }
  }
  dialog.addEventListener("close", () => {
    content.querySelectorAll("textarea").forEach((e) => (e.value = ""));
  });
  return { button };
}

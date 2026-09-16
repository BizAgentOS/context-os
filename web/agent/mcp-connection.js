import { element as el, action, field, connectionDialog } from "./connection-ui.js";

export function openMcpConnection(api, options = {}) {
  const shell = connectionDialog("连接 MCP", "粘贴服务地址，发现能力后选择允许助手使用的范围。");
  let serverName = options.name, pending, exiting = false;
  const active = () => shell.dialog.isConnected && !exiting;
  const back = action("← 所有连接", async () => {
    await shell.close();
    if (!shell.dialog.open) options.onBack?.();
  });
  shell.body.before(back);
  shell.beforeClose = async () => {
    exiting = true;
    if (pending) {
      shell.message("正在完成当前操作，随后关闭…");
      await pending;
    }
  };
  shell.onClose = () => { exiting = true; };
  function freeze(value) {
    back.disabled = value;
    for (const root of [shell.body, shell.footer])
      root.querySelectorAll("input,select,textarea,button").forEach(node => node.disabled = value);
  }
  async function perform(path, request, targetUrl) {
    if (pending || !active()) return;
    freeze(true);
    shell.message(path === "connect" ? "正在连接并发现能力…" : path === "refresh" ? "正在重新发现能力…" : "正在保存…");
    pending = (async () => {
      try {
        const result = await api("/api/capabilities/mcp/" + path, request);
        if (targetUrl) serverName = result.servers.find(server => server.url === targetUrl)?.name;
        options.onChanged?.();
        if (!active()) return;
        if (path === "disconnect") {
          serverName = undefined;
          showForm();
          shell.message("已断开本地连接。");
        } else {
          showServer(result.servers.find(server => server.name === serverName));
          shell.message(path === "connect" ? "连接已保存。勾选并保存后，助手才能使用这些能力。" : path === "refresh" ? "能力已更新，旧授权已撤销。请重新选择可用范围。" : "已保存可用范围。");
        }
      } catch (error) {
        // Refresh revokes grants before network discovery, including on failure.
        if (path === "refresh" && active()) {
          try {
            const result = await api("/api/capabilities/mcp");
            if (active()) showServer(result.servers.find(server => server.name === serverName));
            options.onChanged?.();
          } catch { /* Keep the explicit failure; no success is inferred. */ }
        }
        if (active()) shell.message(error.message);
      } finally { pending = undefined; freeze(false); }
    })();
    await pending;
  }
  function showForm() {
    shell.body.replaceChildren();
    shell.footer.replaceChildren();
    const form = el("form");
    const url = field("MCP 服务地址", "url");
    url.input.placeholder = "https://example.com/mcp";
    url.input.required = true;
    url.input.maxLength = 2048;
    const auth = el("details", null, "connection-advanced");
    auth.append(el("summary", "身份验证（如服务需要）"));
    const authLabel = el("label", "认证方式", "connection-field");
    const authType = el("select");
    for (const [value, title] of [["none", "无需凭据"], ["bearer", "访问令牌（Bearer Token）"], ["header", "API Key / 自定义请求头"]]) {
      const option = el("option", title); option.value = value; authType.append(option);
    }
    authLabel.append(authType);
    const secret = field("访问令牌", "password"), header = field("请求头名称");
    secret.input.maxLength = 4000;
    header.input.placeholder = "X-API-Key";
    header.input.pattern = "[A-Za-z0-9-]+";
    auth.append(authLabel, header.label, secret.label, el("p", "凭据仅保存在本机，不会发进聊天。网页登录请从已支持的服务入口进入。", "connection-note"));
    const authChanged = () => {
      secret.label.hidden = authType.value === "none";
      header.label.hidden = authType.value !== "header";
      secret.input.required = authType.value !== "none";
      header.input.required = authType.value === "header";
    };
    authType.addEventListener("change", authChanged); authChanged();
    const advanced = el("details", null, "connection-advanced");
    advanced.append(el("summary", "高级设置"));
    const transportLabel = el("label", "传输方式", "connection-field"), transport = el("select");
    for (const [value, title] of [["http", "自动识别（推荐）"], ["sse", "旧版 SSE"]]) {
      const option = el("option", title); option.value = value; transport.append(option);
    }
    transportLabel.append(transport);
    const headersLabel = el("label", "其他请求头 JSON（可选）", "connection-field"), headers = el("textarea");
    headers.autocomplete = "off"; headers.spellcheck = false; headers.rows = 3; headers.placeholder = "{}";
    headersLabel.append(headers);
    advanced.append(transportLabel, headersLabel);
    const connect = el("button", "连接并发现能力", "primary-button"); connect.type = "submit";
    form.append(url.label, el("p", "名称自动生成，工具和参数自动发现。远程服务使用 HTTPS，本机开发可使用 HTTP。", "connection-note"), auth, advanced, connect);
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (pending) return;
      try {
        const parsed = JSON.parse(headers.value || "{}");
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.values(parsed).some(value => typeof value !== "string"))
          throw new Error("其他请求头需要是键和值均为文本的 JSON 对象。");
        const name = authType.value === "bearer" ? "Authorization" : header.input.value.trim();
        if (authType.value !== "none") {
          if (Object.keys(parsed).some(key => key.toLowerCase() === name.toLowerCase()))
            throw new Error("身份验证与其他请求头中存在同名请求头，请保留一处。");
          parsed[name] = authType.value === "bearer" ? `Bearer ${secret.input.value.trim()}` : secret.input.value.trim();
        }
        const targetUrl = new URL(url.input.value.trim()).href;
        const request = { url: targetUrl, type: transport.value, headers: parsed };
        secret.input.value = ""; headers.value = "";
        void perform("connect", request, targetUrl);
      } catch (error) { shell.message(error.message); }
    });
    shell.body.append(form);
  }
  function showServer(server) {
    shell.footer.replaceChildren();
    if (!server) { shell.body.replaceChildren(el("p", "连接已变化，请返回连接列表。")); return; }
    shell.body.replaceChildren();
    const summary = el("div", null, "connection-summary");
    summary.append(el("strong", server.name), el("p", server.url, "connection-note"));
    const selected = new Set(server.capabilities.filter(cap => cap.allowed).map(cap => cap.id));
    const count = el("p", null, "connection-count");
    const updateCount = () => { count.textContent = `${server.capabilities.length} 项能力 · 已选择 ${selected.size} 项`; };
    updateCount();
    const search = field("搜索能力"); search.input.placeholder = "按名称或用途搜索"; search.input.type = "search";
    const list = el("div", null, "connection-capabilities");
    let visible = server.capabilities;
    function renderList() {
      const query = search.input.value.trim().toLowerCase();
      visible = server.capabilities.filter(cap => `${cap.name} ${cap.title || ""} ${cap.summary || ""}`.toLowerCase().includes(query));
      list.replaceChildren();
      for (const cap of visible) {
        const row = el("label", null, "connection-capability");
        const check = el("input"); check.type = "checkbox"; check.checked = selected.has(cap.id);
        check.addEventListener("change", () => { check.checked ? selected.add(cap.id) : selected.delete(cap.id); updateCount(); });
        const copy = el("span");
        const kind = { tool: "工具", resource: "资源", prompt: "提示词" }[cap.kind] || cap.kind;
        const nature = cap.kind === "tool" ? (cap.annotations?.readOnlyHint === true ? " · 服务声明只读" : " · 请核对读写用途") : "";
        copy.append(el("strong", cap.title || cap.name), el("small", kind + nature), el("p", cap.summary || "服务未提供说明，请向提供方核对用途。"));
        row.append(check, copy); list.append(row);
      }
      if (!visible.length) list.append(el("p", query ? "没有匹配的能力。" : "服务未提供工具、资源或提示词。", "connection-note"));
    }
    search.input.addEventListener("input", renderList); renderList();
    const choices = el("div", null, "connection-actions");
    choices.append(action("选择当前结果", () => { visible.forEach(cap => selected.add(cap.id)); renderList(); updateCount(); }), action("清空选择", () => { selected.clear(); renderList(); updateCount(); }));
    const controls = el("div", null, "connection-actions");
    controls.append(action("保存可用范围", () => perform("grant", { name: server.name, revision: server.revision, ids: [...selected] }), "primary-button"));
    const maintenance = el("details", null, "connection-advanced");
    maintenance.append(el("summary", "连接管理"), el("p", "重新发现会清空已授权范围，需要重新选择。断开仅移除此处的连接。", "connection-note"), action("重新发现能力", () => perform("refresh", { name: server.name })), action("断开连接", () => perform("disconnect", { name: server.name })));
    shell.body.append(summary, count, search.label, choices, list, maintenance);
    shell.footer.append(controls);
  }
  async function load() {
    shell.message("正在读取连接…");
    try {
      const state = await api("/api/capabilities/mcp");
      if (active()) { showServer(state.servers.find(server => server.name === serverName)); shell.message(""); }
    } catch (error) {
      if (active()) { shell.message(error.message); shell.body.replaceChildren(action("重试", load)); }
    }
  }
  if (serverName) void load(); else showForm();
  return shell;
}

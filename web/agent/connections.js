import { openFeishuConnection } from "./feishu-connection.js";
import { openMcpConnection } from "./mcp-connection.js";
import { element as el, action, connectionDialog } from "./connection-ui.js";

export function openConnections(api, custom, options = {}) {
  const back = () => openConnections(api, custom, { onChanged: options.onChanged });
  const childOptions = { onChanged: options.onChanged, onBack: back };
  if (options.service === "feishu") return openFeishuConnection(api, childOptions);
  if (options.service === "custom" || options.name)
    return openMcpConnection(api, { ...childOptions, name: options.name });

  const shell = connectionDialog("MCP 与服务连接", "选择服务登录，或粘贴 MCP 地址。已有连接可直接管理和使用。");
  let loading = false;
  const navigate = callback => { shell.dialog.close(); callback(); };
  function entry(title, description, next, callback) {
    const row = action("", () => navigate(callback), "connection-entry");
    const copy = el("span");
    copy.append(el("strong", title), el("small", description));
    row.append(copy, el("span", next + " ↗", "connection-entry-action"));
    return row;
  }
  async function load() {
    if (loading) return;
    loading = true;
    shell.message("正在读取连接…");
    const [feishu, mcp] = await Promise.allSettled([
      api("/api/connectors/feishu"), api("/api/capabilities/mcp"),
    ]);
    loading = false;
    if (!shell.dialog.isConnected) return;
    shell.message("");
    shell.body.replaceChildren();
    const account = feishu.status === "fulfilled" ? feishu.value.account : null;
    const paths = el("div", null, "connection-paths");
    paths.append(
      entry("飞书文档", account ? `已有账号 · ${account.label}` : "在飞书官方页面授权，按链接读取文档", account ? "读取文档" : "登录连接", () => openFeishuConnection(api, childOptions)),
      entry("自定义 MCP", "粘贴服务地址，自动发现可用工具与资源", "添加连接", () => openMcpConnection(api, childOptions)),
    );
    shell.body.append(paths);
    const connected = el("section", null, "connection-saved");
    connected.append(el("h3", "已保存的 MCP"));
    if (mcp.status === "fulfilled") {
      for (const server of mcp.value.servers) {
        const allowed = server.capabilities.filter(item => item.allowed).length;
        connected.append(entry(server.name, `${allowed} / ${server.capabilities.length} 项能力已开放给助手`, "管理", () => openMcpConnection(api, { ...childOptions, name: server.name })));
      }
      if (!mcp.value.servers.length) connected.append(el("p", "连接后会显示在这里，下次无需重新配置。", "muted"));
    } else connected.append(el("p", "MCP 状态暂不可用，请重试。", "muted"));
    shell.body.append(connected);
    if (feishu.status === "rejected") shell.body.append(el("p", "飞书状态暂不可用，可进入服务重试。", "muted"));
    const footer = el("div", null, "connection-actions");
    footer.append(action("刷新连接", load));
    if (custom) footer.append(action("高级数据映射", () => navigate(custom)));
    shell.body.append(footer, el("p", "授权账号与可用工具会被保留；连接不会自动导入全部内容或采用本体映射。", "connection-note"));
  }
  void load();
  return shell;
}

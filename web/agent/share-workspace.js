import { el, table } from "./engine-ui.js";

/** Keep existing offline/demo files inspectable while the current product uses release versions. */
export function renderSharedAccess(state) {
  const root = el("section", null, "engine-workspace");
  root.append(el("h1", "发布与接入"), el("p", "这是已保存的演示记录。实际接入在完整产品的发布工作区管理。", "engine-muted"));
  if (!state.consumers.length) root.append(el("p", "此演示尚未创建外部接入。", "engine-empty"));
  else root.append(table(state.consumers, [["接入方", item => item.title], ["状态", item => ({ active: "已启用", revoked: "已停用", draft: "待启用" })[item.status] || item.status], ["读取范围", item => (item.content.grants || []).map(grant => grant.type).join("、")]]));
  if (state.accessLogs.length) root.append(el("h2", "已保存的调用记录"), table(state.accessLogs.slice(0, 10), [["时间", item => item.createdAt || item.timestamp], ["结果", item => item.status || item.outcome || "已记录"]]));
  return root;
}

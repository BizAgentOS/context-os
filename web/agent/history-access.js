import { el, action, ref, dialog, message, transact, table, downloadConfig } from "./engine-ui.js";

/** Historical access supports inspection and revocation only. */
export function renderHistoryAccess(state, { api, onChanged }) {
  const root = el("details", null, "engine-panel history-access");
  root.append(el("summary", "历史接入"));
  const body = el("div"); root.append(body);
  let loaded = false, disposed = false;
  root.dispose = () => { disposed = true; };
  async function configuration(item) {
    const d = dialog("历史接入配置", true), output = message(d.body);
    try {
      const path = item.kind === "ontology_dataset" ? "/api/datasets/connection" : item.kind === "consumer_view" ? "/api/live/views/connection" : item.kind === "consumer" ? "/api/consumers/connection" : null;
      if (!path) {
        const config = el("textarea", null, "engine-config"); config.readOnly = true;
        config.value = `${location.origin}/v2/schema\n${location.origin}/v2/objects?type=${encodeURIComponent(item.content.grants?.[0]?.type || "")}`;
        d.body.append(el("p", "使用已保存的 v2 接入密钥，以 Bearer 凭据读取以下地址。", "engine-muted"), config); return;
      }
      const result = await api(`${path}?id=${encodeURIComponent(item.id)}&version=${item.version}`);
      if (!d.isConnected) return;
      downloadConfig(d.body, result.mcp || result);
      d.body.append(el("p", "请使用原来保存的密钥。历史接入不再签发新密钥；新接入请通过发布版本创建接入方。", "engine-muted"));
    } catch (error) { output.textContent = error.message; }
  }
  function inspect(item) {
    const d = dialog(`${item.title} · 历史范围`, true), content = item.content;
    if (content.purpose) d.body.append(el("p", content.purpose, "engine-muted"));
    if (content.concepts) d.body.append(table(content.concepts, [["概念", c => c.name], ["说明", c => c.description]]));
    if (content.relations?.length) {
      const names = new Map((content.concepts || []).map(c => [c.id, c.name]));
      d.body.append(table(content.relations, [["关系", r => r.name], ["起点", r => names.get(r.from) || r.from], ["终点", r => names.get(r.to) || r.to], ["说明", r => r.description]]));
    }
    const grants = content.grants || content.business?.grants || [];
    d.body.append(table(grants, [["对象", g => g.type], ["字段", g => g.fields.map(f => f === "$id" ? "对象身份" : f).join("、")], ["关系", g => g.relations.join("、") || "未开放"], ["字段依据", g => g.evidence?.fields?.join("、") || "未开放"], ["关系依据", g => g.evidence?.relations?.join("、") || "未开放"]]));
    if (content.contextEvidence?.length) d.body.append(table(content.contextEvidence, [["背景依据", evidence => evidence.label || "已授权背景依据"], ["类型", evidence => evidence.kind === "document" ? "文档" : "指标"]]));
  }
  function revoke(item) {
    const d = dialog("撤销历史接入"), output = message(d.body);
    const path = item.kind === "ontology_dataset" ? "/api/datasets/revoke" : item.kind === "consumer_view" ? "/api/live/views/revoke" : item.kind === "live_consumer" ? "/api/live/revoke" : "/api/consumers/revoke";
    d.body.append(el("p", `撤销“${item.title}”后，原有密钥将无法继续读取。`, "engine-muted"), action("确认撤销", () => transact(d, output, async () => { await api(path, ref(item)); d.close(); onChanged?.(); await load(); }), "engine-primary"));
  }
  async function load() {
    body.replaceChildren(el("p", "正在读取历史接入…", "engine-muted"));
    try {
      const result = await api("/api/consumers/history");
      if (disposed) return;
      const items = result.items;
      body.replaceChildren(el("p", "旧版 v1 / v2 / v3 与 MCP 数据集已冻结，只能查看和撤销。请从发布版本创建新的接入方。", "engine-muted"));
      if (!items.length) body.append(el("p", "没有历史接入。", "engine-empty"));
      function appendItems(items) {
        for (const item of items) {
          const card = el("article", null, "engine-panel"), controls = el("div", null, "engine-actions");
          const contract = { consumer: "v1", live_consumer: "v2", consumer_view: "v3", ontology_dataset: "旧 MCP 数据集" }[item.kind];
          card.append(el("h3", item.title), el("p", `${contract} · ${{ active: "已启用", draft: "历史草稿（已冻结）", revoked: "已撤销" }[item.status] || "已冻结"}`, "engine-muted"));
          controls.append(action("查看范围", () => inspect(item)));
          if (item.status === "active") controls.append(action("接入配置", () => void configuration(item)), action("撤销接入", () => revoke(item)));
          card.append(controls); body.append(card);
        }
      }
      appendItems(items);
      let nextOffset = result.nextOffset;
      const more = action("加载更早接入", async () => {
        more.disabled = true;
        try {
          const next = await api(`/api/consumers/history?offset=${nextOffset}`);
          if (disposed) return;
          appendItems(next.items); nextOffset = next.nextOffset; more.hidden = nextOffset === null;
          body.append(more);
        } catch (error) { body.append(el("p", error.message, "engine-message")); }
        finally { if (!disposed) more.disabled = false; }
      });
      more.hidden = nextOffset === null; body.append(more);
    } catch (error) { if (!disposed) body.replaceChildren(el("p", error.message, "engine-message"), action("重试读取", () => void load())); }
  }
  root.addEventListener("toggle", () => { if (root.open && !loaded) { loaded = true; void load(); } });
  return root;
}

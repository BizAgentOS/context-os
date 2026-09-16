// Presentation only. Lines group data under the enterprise, not ontology relations.
export function renderEnterpriseProfile(state, actions) {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag); n.className = cls || "";
    if (text !== undefined) n.textContent = text; return n;
  };
  const popup = (title, build) => {
    const d = el("dialog", "live-dialog data-map-dialog");
    d.setAttribute("aria-label", title);
    const close = el("button", "quiet-button", "关闭"); close.onclick = () => d.close();
    const head = el("header", "data-map-dialog-head"); head.append(el("h2", "", title), close);
    d.append(head); build(d); document.body.append(d); d.showModal();
    d.addEventListener("close", () => d.remove(), {once:true}); return d;
  };
  const tile = (cls, symbol, title, description, callback) => {
    const b = el("button", `data-map-node ${cls}`); b.type = "button";
    b.append(el("span", "data-map-symbol", symbol), el("strong", "", title), el("span", "data-map-description", description), el("span", "data-map-open", "查看内容 ↗"));
    b.onclick = callback; return b;
  };
  const rows = state.profile?.content?.statements || [];
  const name = rows.find(r => /^(company\.name|company_name|companyName|name)$/.test(r.key) && r.origin !== "suggestion");
  const title = name?.text || state.foundation?.current?.content?.enterprise?.name || "企业主体";
  const business = rows.find(r => /^(company\.business|business|business_description|description)$/.test(r.key));
  const root = el("section", "setup-canvas enterprise-profile data-map");
  const heading = el("div", "data-map-heading");
  heading.append(el("h1", "", "企业与数据"), el("p", "", "企业主体与数据来源 · 点击模块查看内容"));
  root.append(heading);
  const diagram = el("div", "data-map-diagram");
  const company = tile("data-map-company", "◎", title, business ? `${business.text}${business.origin === "suggestion" ? " · 待核实" : ""}` : "企业信息", () => popup("企业主体信息", d => {
    for (const r of rows) {
      const item = el("section", "data-map-fact");
      item.append(el("span", "source-meta", `${actions.label(r.key)}${r.origin === "suggestion" ? " · 待核实" : ""}`), el("p", "", r.text)); d.append(item);
    }
    if (!rows.length) d.append(el("p", "", "尚未保存企业信息。"));
  }));
  company.id = "setup-company";
  diagram.append(company, el("div", "data-map-connectors"));
  const modules = el("div", "data-map-modules");
  const sources = el("section", "setup-sources"); sources.id = "setup-sources"; sources.hidden = true;
  const connections = state.live?.connections || [];
  const remote = tile("", "⇄", "接入数据", connections.length ? `${connections.length} 个数据源 · HTTP API / MCP` : "服务授权 · API · MCP", () => {
    const content = sources.querySelector(".live-canvas");
    popup("接入数据与服务", d => {
      if (content) {
        d.append(content);
        d.addEventListener("close", () => sources.prepend(content), {once:true});
      } else d.append(el("p", "", "此视图没有在线连接。"));
    });
  });
  const files = state.sources || [];
  const uploads = tile("", "▤", "上传数据", `${files.length} 份文件 · CSV / Markdown / TXT`, () => popup("上传数据", d => {
    if (!actions.readonly) {
      const upload = el("button", "quiet-button", "上传资料"); upload.onclick = () => { d.close(); actions.upload(); }; d.append(upload);
    }
    for (const source of files) {
      const file = el("button", "data-map-file");
      file.append(el("strong", "", source.title), el("span", "source-meta", `${source.content.format || "文档"} · 文件上传 · 第 ${source.version} 版`));
      file.onclick = () => popup(source.title, detail => {
        if (source.content.parseError) detail.append(el("p", "", "内容需要修正"));
        detail.append(el("pre", "data-map-content", source.content.raw || JSON.stringify(source.content.rows || source.content, null, 2)));
      });
      d.append(file);
    }
    if (!files.length) d.append(el("p", "", "尚未上传文件。"));
  }));
  modules.append(remote, uploads); diagram.append(modules); root.append(diagram, sources);
  const note = el("p", "data-map-note", "连线仅表示数据归属；账号已连接不代表内容已读取或完成本体融合。"); root.append(note);
  if (actions.api) void actions.api("/api/connectors/feishu").then(result => {
    if (result.account) remote.querySelector(".data-map-description").textContent = `飞书账号已连接${connections.length ? ` · ${connections.length} 个 API / MCP 数据源` : " · 按需读取"}`;
  }).catch(() => {});
  return {root, sources};
}

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
  const squares = (count, kind) => {
    const grid = el("span", `sheet-unit-grid ${kind}`);
    grid.setAttribute("aria-hidden", "true");
    for (let i = 0; i < Math.min(count, 24); i++) grid.append(el("i", ""));
    if (count > 24) grid.append(el("span", "", `+${count - 24}`));
    return grid;
  };

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
  remote.classList.add("sheet-remote-node"); uploads.classList.add("sheet-upload-node");
  remote.append(squares(connections.length, "remote-units")); uploads.append(squares(files.length, "upload-units"));
  modules.append(remote, uploads); diagram.append(modules);
  root.classList.add("enterprise-sheet");
  heading.replaceChildren();
  const identity = el("button", "sheet-identity"); identity.type = "button"; identity.onclick = () => company.click();
  identity.append(el("span", "sheet-eyebrow", "企业主体 / COMPANY"), el("h1", "", title));
  if (business) identity.append(el("p", "", `${business.text}${business.origin === "suggestion" ? " · 待核实" : ""}`));
  const stamp = el("div", "sheet-stamp"); stamp.append(el("span", "", "DATA ENGINE"), el("strong", "", "企业数据总览"), el("span", "", "01 / 来源与内容"));
  heading.append(identity, stamp);
  const layout = el("div", "sheet-layout");
  const plan = el("section", "sheet-plan");
  const label = (number, name, subtitle) => {
    const head = el("div", "sheet-section-head"); head.append(el("span", "sheet-number", number), el("h2", "", name));
    if (subtitle) head.append(el("span", "sheet-caption", subtitle)); return head;
  };
  plan.append(label("01", "数据构成", "企业与来源的归属视图"), diagram);
  const legend = el("div", "sheet-legend"); legend.append(el("span", "", "◎ 企业主体"), el("span", "", "实格：连接入口"), el("span", "", "空格：上传文件")); plan.append(legend);
  const aside = el("div", "sheet-registers");
  const register = (number, name, summary, callback) => {
    const section = el("section", "sheet-register");
    const head = label(number, name);
    const open = el("button", "sheet-open", "查看全部 ↗"); open.onclick = callback; head.append(open);
    section.append(head, el("p", "sheet-register-summary", summary)); aside.append(section); return section;
  };
  const remoteList = register("02", "接入目录", `${connections.length} 个 API / MCP 数据源`, () => remote.click());
  const item = (container, name, meta, callback) => {
    const b = el("button", "sheet-item"); b.type = "button"; b.append(el("strong", "", name), el("span", "", meta)); b.onclick = callback; container.append(b);
  };
  for (const source of connections.slice(0, 3)) item(remoteList, source.title, `${source.content.protocol === "mcp" ? "MCP" : "HTTP API"} · ${source.status === "ready" ? "按需读取" : "已停用"}`, () => remote.click());
  const fileList = register("03", "上传目录", `${files.length} 份已上传资料`, () => uploads.click());
  for (const source of files.slice(0, 3)) item(fileList, source.title, `${source.content.format || "文档"} · 第 ${source.version} 版${source.content.parseError ? " · 内容需修正" : ""}`, () => popup(source.title, d => {
    d.append(el("pre", "data-map-content", source.content.raw || JSON.stringify(source.content.rows || source.content, null, 2)));
  }));
  if (!files.length) item(fileList, "上传企业资料", "CSV / Markdown / TXT", () => uploads.click());
  if (files.length > 3) fileList.append(el("p", "sheet-caption", `展示前 3 份，其余 ${files.length - 3} 份在详情中查看`));
  if (connections.length > 3) remoteList.append(el("p", "sheet-caption", `展示前 3 个，其余 ${connections.length - 3} 个在详情中查看`));
  layout.append(plan, aside); root.append(layout, sources);
  const note = el("div", "sheet-footer");
  note.append(el("span", "", "连接状态与内容分别呈现 · 连线不表示本体融合"), el("span", "", "点击图示或目录查看详情 ↗")); root.append(note);
  if (actions.api) {
    const accountRow = el("div", "sheet-account"); remoteList.append(accountRow);
    void actions.api("/api/connectors/feishu").then(result => {
      if (result.account) {
        remoteList.querySelector(".sheet-register-summary").textContent = `1 个授权账号 · ${connections.length} 个 API / MCP 数据源`;
        remote.querySelector(".sheet-unit-grid")?.replaceWith(squares(connections.length + 1, "remote-units"));
        remote.querySelector(".data-map-description").textContent = `飞书账号已连接${connections.length ? ` · ${connections.length} 个数据源` : " · 按需读取"}`;
        item(accountRow, "飞书", "官方 CLI · 账号已连接，文档按需读取", () => remote.click());
      } else if (!connections.length) item(accountRow, "接入企业服务", "账号授权 / API / MCP", () => remote.click());
    }).catch(() => { item(accountRow, "查看服务连接", "账号状态暂不可用", () => remote.click()); });
  } else if (!connections.length) item(remoteList, "在线连接", "当前视图未提供连接状态", () => remote.click());
  return {root, sources};
}

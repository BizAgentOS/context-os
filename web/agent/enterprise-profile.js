import { openApiImport } from "./openapi-import.js";
import { openConnections } from "./connections.js";
import { technicalDetails } from "./ui-display.js";
// Presentation only: company facts, source accounts and imported files remain distinct.
export function renderEnterpriseProfile(state, actions) {
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    node.className = cls || "";
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = (name) => {
    const node = el("span", "ed-icon");
    node.setAttribute("aria-hidden", "true");
    // Only fixed, vendored library assets enter this HTML sink; never source content.
    node.innerHTML = enterpriseIcons[name];
    return node;
  };
  const button = (cls, text, callback, symbol) => {
    const node = el("button", cls); node.type = "button";
    node.append(el("span", "", text));
    if (symbol) node.append(icon(symbol));
    node.onclick = callback;
    return node;
  };
  const popup = (title, build) => {
    const dialog = el("dialog", "live-dialog data-map-dialog");
    dialog.setAttribute("aria-label", title);
    const head = el("header", "data-map-dialog-head");
    head.append(el("h2", "", title), button("quiet-button", "关闭", () => dialog.close()));
    dialog.append(head); build(dialog); document.body.append(dialog); dialog.showModal();
    dialog.addEventListener("close", () => dialog.remove(), {once: true});
    return dialog;
  };
  const rows = (state.profile?.content?.statements || []).filter(row => row.text?.trim());
  const name = rows.find(row => /^(company\.name|company_name|companyName|name)$/.test(row.key) && row.origin !== "suggestion");
  const title = name?.text || state.foundation?.current?.content?.enterprise?.name || "企业主体";
  const business = rows.find(row => /^(company\.business|business|business_description|description)$/.test(row.key));
  const files = (state.sources || []).filter(source => source.content.origin !== "feishu");
  const connections = state.live?.connections || [];
  const sources = el("section", "setup-sources"); sources.id = "setup-sources"; sources.hidden = true;
  const factLabel = row => `${actions.label(row.key)}${row.origin === "suggestion" ? " · 待核实" : ""}`;
  const format = source => {
    if (/\.md$/i.test(source.title)) return "Markdown";
    return {csv: "CSV", text: "TXT", markdown: "Markdown"}[source.content.format] || source.content.format || "文档";
  };
  const showCompany = () => popup("企业主体信息", dialog => {
    for (const row of rows) {
      const fact = el("section", "data-map-fact");
      fact.append(el("span", "source-meta", factLabel(row)), el("p", "", row.text));
      dialog.append(fact);
    }
    if (!rows.length) dialog.append(el("p", "", "可向下方助手介绍企业，或上传企业资料。"));
  });
  const showConnections = () => {
    const content = sources.querySelector(".live-canvas");
    popup("接入数据与服务", dialog => {
      if (content) {
        dialog.append(content);
        dialog.addEventListener("close", () => sources.prepend(content), {once: true});
      } else dialog.append(el("p", "", "此视图没有在线连接。"));
    });
  };
  const showConnectionMethods = () => popup("三种接入方式", dialog => {
    dialog.classList.add("enterprise-profile", "ed-methods-dialog");
    dialog.append(el("p", "ed-methods-intro", "手头有文件，直接上传；系统有接口，通过 API 接入；服务支持 MCP，连接后选择可用能力。"));
    const comparison = el("div", "ed-methods-comparison");
    for (const method of [
      { title: "文件上传", summary: "把已有资料带进来", details: [
        ["适合", "企业介绍、知识文档、导出的业务表格。"],
        ["接入", "上传 CSV、Markdown 或 TXT 文件。"],
        ["更新", "使用上传时的内容，资料变化后需重新上传。"],
      ] },
      { title: "HTTP API", summary: "按接口读取业务数据", details: [
        ["适合", "提供 HTTP 接口的业务系统或数据服务。"],
        ["接入", "导入 Swagger / OpenAPI，选择接口并配置认证。"],
        ["更新", "按需请求源系统，内容以接口实际返回为准。"],
      ] },
      { title: "MCP", summary: "使用服务开放的能力", details: [
        ["适合", "提供 MCP 服务的文档、知识库或业务系统。"],
        ["接入", "填写 MCP 服务地址，完成所需认证并选择开放给助手的能力。"],
        ["更新", "按需调用已授权能力，内容以服务实际返回为准。"],
      ] },
    ]) {
      const card = el("section", "ed-method-card");
      card.append(el("h3", "", method.title), el("p", "ed-method-summary", method.summary));
      const details = el("dl", "");
      for (const [label, text] of method.details) details.append(el("dt", "", label), el("dd", "", text));
      card.append(details); comparison.append(card);
    }
    dialog.append(comparison, el("p", "ed-methods-note", "三种方式可搭配使用。API 和 MCP 连接成功后，仍需按需读取内容；不会自动同步全部数据。"));
  });
  const fileMeta = source => {
    const time = new Date(source.createdAt);
    const savedAt = Number.isNaN(time.getTime()) ? "" : ` · ${time.toLocaleString("zh-CN")}`;
    return `${format(source)} · 文件上传${savedAt}${source.content.parseError ? " · 内容需修正" : ""}`;
  };
  const showFile = source => popup(source.title, dialog => {
    dialog.append(el("p", "source-meta", fileMeta(source)));
    if (source.content.parseError) dialog.append(el("p", "", "内容需要修正"));
    dialog.append(el("pre", "data-map-content", source.content.raw || (source.content.rows ? JSON.stringify(source.content.rows, null, 2) : source.content.text || "暂无可预览内容")), technicalDetails(source));
  });
  const showFiles = () => popup("上传资料", dialog => {
    if (!actions.readonly) dialog.append(button("quiet-button", "上传资料", () => { dialog.close(); actions.upload(); }));
    for (const source of files) {
      const file = button("data-map-file", source.title, () => showFile(source));
      file.append(el("span", "source-meta", fileMeta(source)));
      dialog.append(file);
    }
    if (!files.length) dialog.append(el("p", "", "可上传 CSV、Markdown 或 TXT 文件。"));
  });
  const panelHead = (title, action, callback) => {
    const head = el("header", "ed-panel-head");
    head.append(el("h2", "", title), button("ed-text-button", action, callback, "arrow-up-right"));
    return head;
  };

  const root = el("section", "setup-canvas enterprise-profile enterprise-dashboard");
  root.setAttribute("aria-label", "企业与数据总览");
  const board = el("div", "ed-board");
  const company = el("section", "ed-company"); company.id = "setup-company";
  const companyHead = el("header", "ed-company-head");
  const companyLabel = el("span", "ed-label"); companyLabel.append(icon("buildings"), el("span", "", "企业主体"));
  companyHead.append(companyLabel, button("ed-pill", "企业档案", showCompany, "arrow-up-right"));
  const identity = button("ed-identity", "", showCompany);
  identity.replaceChildren(el("h1", "ed-company-name", title));
  if (business) identity.append(el("p", "ed-business", `${business.text}${business.origin === "suggestion" ? " · 待核实" : ""}`));
  company.append(companyHead, identity);
  const otherFacts = rows.filter(row => row !== name && row !== business);
  if (otherFacts.length) {
    const facts = el("div", "ed-facts");
    for (const row of otherFacts.slice(0, 3)) {
      const fact = button("ed-fact", "", showCompany);
      fact.replaceChildren(el("span", "ed-fact-label", factLabel(row)), el("p", "", row.text)); facts.append(fact);
    }
    company.append(facts);
  } else if (!rows.length && !actions.readonly) {
    company.append(button("ed-start", "介绍你的企业", () => actions.ask("我想补充企业的基础信息。"), "arrow-up-right"));
  }

  const knowledge = el("section", "ed-knowledge");
  const openService = (options = {}) => actions.api
    ? openConnections(actions.api, undefined, { ...options, onChanged: refreshConnections, onPrepared: actions.onImportSaved }) : showConnections();
  knowledge.append(panelHead("MCP 接入", "添加 / 管理", () => openService()));
  const services = el("div", "ed-services");
  let feishuStatus;
  for (const serviceName of ["飞书文档 / 知识库", "腾讯文档", "语雀", "钉钉文档", "石墨文档", "金山文档", "WPS 云文档", "有道云笔记"]) {
    const isFeishu = serviceName.startsWith("飞书");
    const service = button(`ed-service${isFeishu ? " ed-service-featured" : ""}`, "", () => {
      if (isFeishu) openService({ service: "feishu" });
      else popup(serviceName, dialog => dialog.append(el("p", "", "该服务尚未接入 DataEngine，当前仅列入服务目录。")));
    });
    const mark = el("span", "ed-service-icon"); mark.append(icon(isFeishu ? "book-open" : "cloud"));
    const copy = el("span", "ed-service-copy");
    const status = el("small", "ed-service-status", isFeishu ? (actions.api ? "检查连接…" : "离线视图") : "待支持");
    copy.append(el("strong", "", serviceName), status);
    if (isFeishu) feishuStatus = status;
    service.replaceChildren(mark, copy, icon("caret-right"));
    services.append(service);
  }
  const mcpList = el("div", "ed-source-scroll");
  const savedMcps = el("div", "ed-saved-mcps");
  mcpList.append(savedMcps);
  for (const source of connections.filter(item => item.content.protocol === "mcp")) {
    mcpList.append(button("ed-connection", source.title + (source.status === "ready" ? " · 按需读取" : " · 已停用"), showConnections, "caret-right"));
  }
  const feishuDocuments = el("div", "ed-feishu-documents");
  mcpList.append(services, feishuDocuments);
  knowledge.append(mcpList);

  const uploads = el("section", "ed-uploads");
  uploads.append(panelHead("上传资料", `${files.length} 份资料`, showFiles));
  const fileList = el("div", "ed-file-list");
  for (const source of files) {
    const file = button("ed-file", "", () => showFile(source));
    const mark = el("span", "ed-file-icon"); mark.append(icon("files"));
    const copy = el("span", "ed-file-copy");
    copy.append(el("strong", "", source.title), el("small", "", fileMeta(source)));
    file.replaceChildren(mark, copy, icon("caret-right"));
    if (actions.api) {
      const row = el("div", "ed-upload-row");
      const remove = button("ed-upload-delete", "删除", async () => {
        remove.disabled = true;
        try {
          const snapshot = await actions.api("/api/canvas/upload/remove", { id: source.id, version: source.version });
          actions.onImportSaved(snapshot);
        } catch (error) { remove.disabled = false; remove.title = error.message; remove.textContent = "删除失败，重试"; }
      });
      remove.setAttribute("aria-label", `删除 ${source.title}`);
      row.append(file, remove); fileList.append(row);
    } else fileList.append(file);
  }
  if (!files.length) fileList.append(button("ed-upload-entry", actions.readonly ? "查看资料" : "上传企业资料", showFiles, "plus"));
  uploads.append(fileList);

  const apiPanel = el("section", "ed-api");
  const httpSources = connections.filter(item => item.content.protocol === "http");
  apiPanel.append(panelHead("HTTP API 接入", actions.api ? "添加接入" : "查看连接", actions.api
    ? () => openApiImport({ api: actions.api, onSaved: actions.onImportSaved, ask: actions.ask }) : showConnections));
  const apiList = el("div", "ed-file-list");
  for (const source of httpSources) {
    apiList.append(button("ed-file", source.title + (source.status === "ready" ? " · 按需读取" : " · 已停用"), showConnections, "caret-right"));
  }
  if (!httpSources.length) apiList.append(el("p", "source-meta", "通过 Swagger / OpenAPI 导入业务接口"));
  apiPanel.append(apiList);

  const methods = el("section", "ed-methods");
  methods.append(icon("plugs-connected"), el("h2", "", "多种来源，同一企业"), el("p", "", "从知识文档到业务数据，逐步构建企业的语义底座。"));
  const ways = el("p", "ed-method-types", "文件上传 / API / MCP");
  methods.append(ways, button("ed-method-action", "查看接入方式", showConnectionMethods, "arrow-up-right"));

  const data = el("section", "ed-data");
  data.setAttribute("aria-label", "企业数据接入统计");
  const dataHead = el("header", "ed-panel-head");
  dataHead.append(el("h2", "", "数据接入"));
  data.append(dataHead);
  const totals = el("div", "ed-data-totals");
  let mcpCounter;
  for (const [label, value] of [
    ["文件上传", files.length],
    ["HTTP API", connections.filter(item => item.content.protocol === "http").length],
    ["MCP", connections.filter(item => item.content.protocol === "mcp").length],
  ]) {
    const count = el("div", "ed-data-count");
    count.replaceChildren(el("span", "", label), el("strong", "", String(value)));
    count.title = label === "文件上传" ? "已上传资料数量" : "已配置来源数量（含停用），不代表内容已读取";
    if (label === "MCP") {
      mcpCounter = count.querySelector("strong");
      count.title = "已保存的 MCP 服务（不含 CLI 账号），连接不代表内容已读取";
    }
    totals.append(count);
  }
  data.append(totals);
  const companyInfo = el("div", "ed-company-info");
  companyInfo.append(...Array.from(company.children));
  company.append(companyInfo, data);
  const servicesColumn = el("div", "ed-services-column");
  servicesColumn.append(methods, knowledge);
  board.append(company, uploads, apiPanel, servicesColumn);
  const note = el("footer", "ed-footer");
  note.append(el("span", "", "账号授权不代表内容已读取 · 待支持服务仅供查看"), el("span", "", "点击模块查看详情"));
  root.append(board, note, sources);
  let connectionGeneration = 0;
  async function refreshConnections() {
    if (!actions.api) return;
    const request = ++connectionGeneration;
    const [feishu, mcp] = await Promise.allSettled([actions.api("/api/connectors/feishu"), actions.api("/api/capabilities/mcp")]);
    if (request !== connectionGeneration || !root.isConnected) return;
    if (feishu.status === "fulfilled") {
      feishuStatus.textContent = feishu.value.account ? `已授权 · 已读取 ${feishu.value.documents.length} 份资料` : `未连接 · 已保存 ${feishu.value.documents.length} 份资料`;
      feishuStatus.classList.toggle("is-connected", !!feishu.value.account);
      feishuDocuments.replaceChildren();
      for (const doc of feishu.value.documents || []) {
        const entry = button("ed-file", "", () => openService({ service: "feishu", sourceId: doc.sourceId }));
        const copy = el("span", "ed-file-copy");
        copy.append(el("strong", "", doc.title), el("small", "", `${doc.characters} 字符 · ${doc.usage.length ? "已有本体引用" : "尚未用于本体"}`));
        entry.replaceChildren(icon("files"), copy, icon("caret-right")); feishuDocuments.append(entry);
      }
    } else feishuStatus.textContent = "状态暂不可用";
    if (mcp.status === "fulfilled") {
      savedMcps.replaceChildren();
      const addresses = new Set(connections.filter(source => source.content.protocol === "mcp").map(source => source.content.url || source.id));
      for (const server of mcp.value.servers) {
        addresses.add(server.url || server.name);
        const allowed = server.capabilities.filter(cap => cap.allowed).length;
        const row = button("ed-connection", server.name, () => openService({ name: server.name }), "caret-right");
        row.title = `${allowed} / ${server.capabilities.length} 项能力已开放给助手`;
        row.append(el("small", "ed-service-status", `已授权 ${allowed} 项`));
        savedMcps.append(row);
      }
      mcpCounter.textContent = String(addresses.size);
    } else {
      mcpCounter.textContent = "—";
      savedMcps.replaceChildren(el("p", "source-meta", "MCP 连接状态暂不可用，可打开连接列表重试。"));
    }
  }
  void refreshConnections();
  return {root, sources};
}

/*! Phosphor Icons 2.1.1 · https://github.com/phosphor-icons/core
MIT License

Copyright (c) 2023 Phosphor Icons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
const enterpriseIcons = {
  "buildings": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M240,208H224V96a16,16,0,0,0-16-16H144V32a16,16,0,0,0-24.88-13.32L39.12,72A16,16,0,0,0,32,85.34V208H16a8,8,0,0,0,0,16H240a8,8,0,0,0,0-16ZM208,96V208H144V96ZM48,85.34,128,32V208H48ZM112,112v16a8,8,0,0,1-16,0V112a8,8,0,1,1,16,0Zm-32,0v16a8,8,0,0,1-16,0V112a8,8,0,1,1,16,0Zm0,56v16a8,8,0,0,1-16,0V168a8,8,0,0,1,16,0Zm32,0v16a8,8,0,0,1-16,0V168a8,8,0,0,1,16,0Z\"/></svg>",
  "files": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M213.66,66.34l-40-40A8,8,0,0,0,168,24H88A16,16,0,0,0,72,40V56H56A16,16,0,0,0,40,72V216a16,16,0,0,0,16,16H168a16,16,0,0,0,16-16V200h16a16,16,0,0,0,16-16V72A8,8,0,0,0,213.66,66.34ZM168,216H56V72h76.69L168,107.31v84.53c0,.06,0,.11,0,.16s0,.1,0,.16V216Zm32-32H184V104a8,8,0,0,0-2.34-5.66l-40-40A8,8,0,0,0,136,56H88V40h76.69L200,75.31Zm-56-32a8,8,0,0,1-8,8H88a8,8,0,0,1,0-16h48A8,8,0,0,1,144,152Zm0,32a8,8,0,0,1-8,8H88a8,8,0,0,1,0-16h48A8,8,0,0,1,144,184Z\"/></svg>",
  "cloud": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M160,40A88.09,88.09,0,0,0,81.29,88.67,64,64,0,1,0,72,216h88a88,88,0,0,0,0-176Zm0,160H72a48,48,0,0,1,0-96c1.1,0,2.2,0,3.29.11A88,88,0,0,0,72,128a8,8,0,0,0,16,0,72,72,0,1,1,72,72Z\"/></svg>",
  "plugs-connected": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M237.66,18.34a8,8,0,0,0-11.32,0l-52.4,52.41-5.37-5.38a32.05,32.05,0,0,0-45.26,0L100,88.69l-6.34-6.35A8,8,0,0,0,82.34,93.66L88.69,100,65.37,123.31a32,32,0,0,0,0,45.26l5.38,5.37-52.41,52.4a8,8,0,0,0,11.32,11.32l52.4-52.41,5.37,5.38a32,32,0,0,0,45.26,0L156,167.31l6.34,6.35a8,8,0,0,0,11.32-11.32L167.31,156l23.32-23.31a32,32,0,0,0,0-45.26l-5.38-5.37,52.41-52.4A8,8,0,0,0,237.66,18.34Zm-116.29,161a16,16,0,0,1-22.62,0L76.69,157.25a16,16,0,0,1,0-22.62L100,111.31,144.69,156Zm57.94-57.94L156,144.69,111.31,100l23.32-23.31a16,16,0,0,1,22.62,0l22.06,22A16,16,0,0,1,179.31,121.37ZM88.57,35A8,8,0,0,1,103.43,29l8,20A8,8,0,0,1,96.57,55ZM24.57,93A8,8,0,0,1,35,88.57l20,8A8,8,0,0,1,49,111.43l-20-8A8,8,0,0,1,24.57,93ZM231.43,163a8,8,0,0,1-10.4,4.46l-20-8A8,8,0,1,1,207,144.57l20,8A8,8,0,0,1,231.43,163Zm-64,58.06A8,8,0,0,1,152.57,227l-8-20A8,8,0,0,1,159.43,201Z\"/></svg>",
  "arrow-up-right": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M200,64V168a8,8,0,0,1-16,0V83.31L69.66,197.66a8,8,0,0,1-11.32-11.32L172.69,72H88a8,8,0,0,1,0-16H192A8,8,0,0,1,200,64Z\"/></svg>",
  "caret-right": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z\"/></svg>",
  "plus": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z\"/></svg>",
  "book-open": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M232,48H160a40,40,0,0,0-32,16A40,40,0,0,0,96,48H24a8,8,0,0,0-8,8V200a8,8,0,0,0,8,8H96a24,24,0,0,1,24,24,8,8,0,0,0,16,0,24,24,0,0,1,24-24h72a8,8,0,0,0,8-8V56A8,8,0,0,0,232,48ZM96,192H32V64H96a24,24,0,0,1,24,24V200A39.81,39.81,0,0,0,96,192Zm128,0H160a39.81,39.81,0,0,0-24,8V88a24,24,0,0,1,24-24h64Z\"/></svg>"
};

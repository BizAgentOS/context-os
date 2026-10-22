import { element as el, action, field, connectionDialog } from "./connection-ui.js";
import { technicalDetails } from "./ui-display.js";

const typeNames = { text: "文本", number: "数字", checkbox: "复选框", datetime: "日期时间", created_at: "创建时间", updated_at: "修改时间", auto_number: "自动编号", formula: "公式", lookup: "查找", select: "选项", user: "人员", group_chat: "群组", created_by: "创建人", updated_by: "修改人", link: "关联", attachment: "附件", location: "位置" };
const mappedNames = { string: "文本", number: "数字", boolean: "是 / 否" };

export function openFeishuTables(api, options = {}) {
  const shell = connectionDialog("接入飞书多维表格", "选择需要接入的数据表。每张表独立同步；仅接入你明确选择的表。");
  let state, listing, result, pending, busy = false, closing = false, url = "", selectionUrl = "", operationId = crypto.randomUUID();
  let selected = new Map(), descriptions = new Map();
  const alive = () => shell.dialog.isConnected && !closing;
  const back = action("← 飞书连接", async () => { await shell.close(); if (!shell.dialog.open) options.onBack?.(); });
  shell.body.before(back);
  shell.beforeClose = async () => { closing = true; if (pending) { shell.message("正在完成当前操作，随后关闭…"); await pending; } };
  async function perform(message, work) {
    if (busy || !alive()) return;
    busy = true; render(); shell.message(message);
    pending = (async () => {
      try { return await work(); }
      catch (error) { if (alive()) shell.message(error.message); }
      finally { busy = false; pending = undefined; if (alive()) render(); }
    })();
    return await pending;
  }
  async function browse(offset = 0, requestedUrl = url) {
    await perform("正在读取数据表目录…", async () => {
      const next = await api("/api/connectors/feishu/tables/browse", { url: requestedUrl.trim(), offset });
      if (next.base.url !== selectionUrl) { selected = new Map(); descriptions = new Map(); operationId = crypto.randomUUID(); }
      selectionUrl = next.base.url; url = selectionUrl; listing = next; result = undefined;
      shell.message("");
    });
  }
  async function describe(table) {
    await perform(`正在读取“${table.name}”的字段…`, async () => {
      descriptions.set(table.id, await api("/api/connectors/feishu/tables/describe", { url: selectionUrl, tableId: table.id }));
      shell.message("");
    });
  }
  function setSelected(table, checked) {
    if (busy) return;
    if (checked && !selected.has(table.id) && selected.size >= 20) { shell.message("一次最多选择 20 张表。可保存后继续接入其他表。"); render(); return; }
    if (checked) selected.set(table.id, table.name); else selected.delete(table.id);
    operationId = crypto.randomUUID(); result = undefined; shell.message(""); render();
    [...shell.body.querySelectorAll('input[type="checkbox"]')].find(input => input.getAttribute("aria-label") === `选择 ${table.name}`)?.focus();
  }
  function fieldPreview(table, description) {
    const preview = el("section", null, "connection-summary");
    preview.append(el("h4", `${table.name} · 字段只读预览`), el("p", "记录自身编号作为读取身份；业务对象的身份与关系在本体中治理。", "connection-note"));
    for (const item of description.fields) {
      const row = el("p", null, "connection-note");
      row.append(el("strong", item.name), document.createTextNode(` · ${typeNames[item.type] || "未知类型"} → ${item.supported ? item.encoding === "json" ? "JSON 文本" : mappedNames[item.mappedType] || "文本" : "暂不读取"}`));
      preview.append(row);
    }
    for (const warning of description.warnings) preview.append(el("p", warning, "connection-note"));
    preview.append(technicalDetails(description));
    return preview;
  }
  function render() {
    shell.body.replaceChildren(); shell.footer.replaceChildren(); back.disabled = busy;
    shell.dialog.querySelector(".dialog-heading button").disabled = busy;
    if (!state) { shell.body.append(action("重新读取账号状态", refresh)); }
    else if (!state.account?.tablesAuthorized) {
      shell.body.append(el("h3", state.account ? "尚未授权表格读取" : "尚未连接飞书账号"),
        el("p", "请返回飞书连接，使用本产品账号完成官方只读授权后，再选择多维表格。", "connection-note"),
        action("返回飞书连接", async () => { await shell.close(); if (!shell.dialog.open) options.onBack?.(); }, "primary-button"));
    } else if (result) {
      shell.body.append(el("h3", `已接入 ${result.sources.length} 张数据表`));
      for (const source of result.sources) shell.body.append(el("p", source.title));
      for (const warning of result.warnings || []) shell.body.append(el("p", warning, "connection-note"));
      shell.body.append(el("p", "接入配置已保存。前往数据页查看同步进度；尚未同步时可手动同步，成功后再查看字段、样本与构建结果。", "connection-note"));
      shell.footer.append(action("前往数据页", async () => {
        const snapshot = await perform("正在打开数据页…", () => api("/api/canvas/navigate", { page: "setup" }));
        if (snapshot && alive()) { options.onPrepared?.(snapshot); await shell.close(); }
      }, "primary-button"), action("继续选择表", () => { result = undefined; operationId = crypto.randomUUID(); shell.message(""); render(); }));
    } else {
      shell.body.append(el("p", `当前账号：${state.account.label} · 表格只读权限已保存，读取时再次核验。`, "connection-note"));
      const form = el("form"), link = field("飞书多维表格链接", "url"), submit = el("button", "查看数据表", "primary-button");
      link.input.required = true; link.input.maxLength = 2048; link.input.placeholder = "https://企业.feishu.cn/base/…"; link.input.value = url;
      link.input.addEventListener("input", () => { url = link.input.value; }); submit.type = "submit";
      form.append(link.label, el("p", "按整张表读取。请使用多维表格链接，视图筛选链接暂不支持。", "connection-note"), submit);
      form.addEventListener("submit", event => { event.preventDefault(); void browse(); }); shell.body.append(form);
      if (listing) {
        const coverage = listing.coverage, count = el("p", `目录共 ${coverage.total} 张表 · 本页 ${coverage.shown} 张 · 已选 ${selected.size} 张`, "connection-count"), rows = el("div", null, "connection-capabilities");
        for (const table of listing.tables) {
          const row = el("section"), choice = el("label", null, "connection-capability"), check = el("input"), copy = el("span");
          check.type = "checkbox"; check.checked = selected.has(table.id); check.setAttribute("aria-label", `选择 ${table.name}`);
          check.addEventListener("change", () => setSelected(table, check.checked)); copy.append(el("strong", table.name)); choice.append(check, copy);
          row.append(choice, action(descriptions.has(table.id) ? "刷新字段预览" : "预览字段类型", () => describe(table)));
          if (descriptions.has(table.id)) row.append(fieldPreview(table, descriptions.get(table.id)));
          rows.append(row);
        }
        if (!listing.tables.length) rows.append(el("p", "此多维表格没有可读取的数据表，请在飞书检查共享权限。", "connection-note"));
        const pages = el("div", null, "connection-actions");
        if (coverage.offset > 0) pages.append(action("上一页", () => browse(Math.max(0, coverage.offset - 50), selectionUrl)));
        if (coverage.nextOffset !== null) pages.append(action("下一页", () => browse(coverage.nextOffset, selectionUrl)));
        shell.body.append(count, rows, pages);
        if (selected.size) {
          const selection = el("section", null, "connection-summary"); selection.append(el("h3", `已选 ${selected.size} 张表（包含其他页）`));
          for (const [id, name] of selected) selection.append(action(`移除 ${name}`, () => setSelected({ id, name }, false)));
          shell.body.append(selection);
        }
        const save = action("保存所选数据表", () => void perform("正在核验读取权限并保存所选数据表…", async () => {
          if (!selected.size) return;
          result = await api("/api/connectors/feishu/tables/select", { url: selectionUrl, tableIds: [...selected.keys()].sort(), operationId });
          options.onChanged?.(); shell.message("接入配置已保存。");
        }), "primary-button");
        save.disabled = !selected.size;
        shell.footer.append(save);
      }
    }
    if (busy) shell.dialog.querySelectorAll("input,button").forEach(node => { node.disabled = true; });
  }
  async function refresh() {
    await perform("正在核验飞书账号状态…", async () => { state = await api("/api/connectors/feishu"); shell.message(""); });
  }
  void refresh();
  return shell;
}

import { element as el, action, field, connectionDialog } from "./connection-ui.js";

export function showDatabaseConnection(actions, options = {}) {
  const api = typeof actions === "function" ? actions : actions.api;
  const shell = connectionDialog("连接数据库", "使用 MySQL 或 PostgreSQL 只读账号，选择需要接入的表。每张表会同步为独立数据快照。");
  let pending, config, connection = options.id ? { id: options.id } : null;
  const alive = () => shell.dialog.isConnected;
  const back = action("← 所有连接", async () => { await shell.close(); if (!shell.dialog.open) options.onBack?.(); });
  shell.body.before(back);
  shell.beforeClose = async () => { if (pending) { shell.message("正在完成当前操作，随后关闭…"); await pending; } config = undefined; };
  shell.onClose = () => { config = undefined; };
  async function perform(message, work) {
    if (pending || !alive()) return;
    const disable = value => shell.dialog.querySelectorAll("input,select,button").forEach(node => node.disabled = value);
    disable(true); shell.message(message);
    pending = (async () => {
      try { await work(); } catch (error) { if (alive()) shell.message(error.message); }
      finally { pending = undefined; if (alive()) disable(false); }
    })();
    await pending;
  }
  function showForm() {
    const form = el("form"), kindLabel = el("label", "数据库类型", "connection-field"), kind = el("select");
    for (const [value, label] of [["postgres", "PostgreSQL"], ["mysql", "MySQL"]]) { const option = el("option", label); option.value = value; kind.append(option); }
    kindLabel.append(kind);
    const name = field("连接名称"), host = field("主机"), port = field("端口", "number"), database = field("数据库名"), user = field("只读账号"), password = field("密码", "password");
    host.input.placeholder = "db.example.com"; port.input.value = "5432"; port.input.min = "1"; port.input.max = "65535";
    for (const value of [name, host, port, database, user]) value.input.required = true;
    for (const value of [name, host, database, user]) value.input.maxLength = 200;
    password.input.maxLength = 4000;
    kind.addEventListener("change", () => { port.input.value = kind.value === "postgres" ? "5432" : "3306"; });
    const sslLabel = el("label", "传输加密", "connection-field"), ssl = el("select");
    for (const [value, label] of [["prefer", "优先使用 TLS"], ["require", "必须使用 TLS"], ["verify-full", "TLS 并验证服务器身份"]]) { const option = el("option", label); option.value = value; ssl.append(option); }
    sslLabel.append(ssl);
    const submit = el("button", "测试连接并选择表", "primary-button"); submit.type = "submit";
    form.append(kindLabel, name.label, host.label, port.label, database.label, user.label, password.label, sslLabel,
      el("p", "密码只保存在本机私有凭据文件，不进入聊天或本体。连接器只执行读取；请为账号授予所选表的 SELECT 权限。", "connection-note"), submit);
    form.addEventListener("submit", event => {
      event.preventDefault();
      void perform("正在测试只读连接…", async () => {
        const input = { name: name.input.value.trim(), kind: kind.value, host: host.input.value.trim(), port: Number(port.input.value), database: database.input.value.trim(), user: user.input.value.trim(), password: password.input.value, sslMode: ssl.value };
        const result = await api("/api/databases/test", input);
        config = input; password.input.value = "";
        if (alive()) { showTables(result.tables); shell.message("连接测试通过。请选择表及唯一身份列。"); }
      });
    });
    shell.body.replaceChildren(form); shell.footer.replaceChildren();
  }
  function showTables(tables, existing = []) {
    shell.body.replaceChildren(); shell.footer.replaceChildren();
    const selected = new Map((existing || []).map(item => [JSON.stringify([item.schema, item.table]), item.idField]));
    const count = el("p", null, "connection-count"), search = field("查找表", "search"), list = el("div", null, "connection-capabilities");
    const updateCount = () => { count.textContent = `${tables.length} 张可读表 · 已选择 ${selected.size} 张`; };
    function render() {
      list.replaceChildren();
      const query = search.input.value.trim().toLowerCase();
      for (const table of tables.filter(table => `${table.schema}.${table.table}`.toLowerCase().includes(query))) {
        const key = JSON.stringify([table.schema, table.table]), row = el("div", null, "connection-capability"), check = el("input");
        check.type = "checkbox"; check.checked = selected.has(key); check.setAttribute("aria-label", `选择 ${table.schema}.${table.table}`);
        const copy = el("span"), identity = el("select"), label = el("label", "唯一身份列", "connection-field");
        const placeholder = el("option", "请选择唯一且非空的列"); placeholder.value = ""; identity.append(placeholder);
        for (const column of table.columns) { const option = el("option", `${column.name} · ${column.type}`); option.value = column.name; identity.append(option); }
        identity.value = selected.get(key) || (table.primaryKey.length === 1 ? table.primaryKey[0] : "");
        identity.setAttribute("aria-label", `${table.schema}.${table.table} 唯一身份列`); label.append(identity);
        copy.append(el("strong", `${table.schema}.${table.table}`), el("p", table.estimatedRows === null ? "行数估计暂不可用" : `约 ${table.estimatedRows.toLocaleString()} 行（数据库估计）`, "connection-note"), label);
        check.addEventListener("change", () => { if (check.checked) selected.set(key, identity.value); else selected.delete(key); updateCount(); });
        identity.addEventListener("change", () => { if (check.checked) selected.set(key, identity.value); });
        row.append(check, copy); list.append(row);
      }
      if (!list.children.length) list.append(el("p", tables.length ? "没有匹配的表。" : "没有可读表，请核对数据库与账号 SELECT 权限。", "connection-note"));
    }
    search.input.addEventListener("input", render); render(); updateCount();
    shell.body.append(count, search.label, list, el("p", "超过单次快照行数上限会明确显示不完整。数据仍由来源决定，接入不证明业务身份或关系正确。", "connection-note"));
    shell.footer.append(action("保存所选表并同步", () => {
      if (!selected.size) { shell.message("请至少选择一张表。"); return; }
      if ([...selected.values()].some(id => !id)) { shell.message("请为每张所选表指定唯一身份列。"); return; }
      void perform("正在保存所选表…", async () => {
        if (!connection) { connection = await api("/api/databases/connect", config); config = undefined; }
        const result = await api("/api/databases/select", { id: connection.id, version: connection.version,
          tables: [...selected].map(([key, idField]) => { const [schema, table] = JSON.parse(key); return { schema, table, idField }; }) });
        connection = result; options.onChanged?.();
        if (alive()) { shell.message("表已保存，后台将同步数据并检查结构。可关闭窗口后在数据页查看进度。"); shell.footer.replaceChildren(action("完成", () => shell.close(), "primary-button")); }
      });
    }, "primary-button"));
  }
  if (connection) void perform("正在读取数据库表…", async () => { const result = await api(`/api/databases/tables?id=${encodeURIComponent(connection.id)}`); connection = result; if (alive()) { showTables(result.tables, result.selected); shell.message(""); } });
  else showForm();
  return shell;
}

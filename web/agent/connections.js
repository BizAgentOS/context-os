const el = (tag, text, cls = "") => {
  const e = document.createElement(tag); e.className = cls;
  if (text) e.textContent = text;
  return e;
};
export function openConnections(api, custom) {
  const dialog = el("dialog", null, "settings-dialog service-connections");
  dialog.setAttribute("aria-label", "接入服务");
  const heading = el("div", null, "dialog-heading");
  const button = (text, callback, cls = "quiet-button") => {
    const b = el("button", text, cls); b.type = "button"; b.addEventListener("click", callback); return b;
  };
  let state, timer, busy = false, generation = 0;
  const content = el("div");
  const status = el("p", null, "settings-status"); status.setAttribute("role", "status");
  const active = () => state?.job && !["connected", "cancelled", "failed"].includes(state.job.phase);
  async function close() {
    if (busy) return;
    if (active()) {
      busy = true;
      try { await api("/api/connectors/feishu/cancel", { id: state.job.id }); }
      catch { status.textContent = "尚未确认取消，请重试关闭。"; return; }
      finally { busy = false; }
    }
    dialog.close();
  }
  heading.append(el("h2", "接入服务"), button("关闭", close));
  dialog.append(heading, el("p", "选择服务，在官方页面登录后回到这里。", "muted"), status, content);
  document.body.append(dialog); dialog.showModal();
  dialog.addEventListener("cancel", e => { e.preventDefault(); void close(); });
  dialog.addEventListener("close", () => { generation++; clearTimeout(timer); dialog.remove(); });
  async function perform(path, body) {
    if (busy) return;
    const request = ++generation;
    clearTimeout(timer);
    busy = true; status.textContent = "正在处理…";
    content.querySelectorAll("button").forEach(b => b.disabled = true);
    try {
      const next = await api(path, body);
      if (!dialog.isConnected || request !== generation) return;
      state = next; status.textContent = ""; render(); schedule();
    } catch (error) { if (dialog.isConnected) status.textContent = error.message; }
    finally { busy = false; content.querySelectorAll("button").forEach(b => b.disabled = false); }
  }
  function schedule() {
    clearTimeout(timer);
    if (!active() || !dialog.isConnected) return;
    timer = setTimeout(async () => {
      const request = ++generation;
      try {
        const next = await api("/api/connectors/feishu");
        if (!dialog.isConnected || request !== generation) return;
        if (JSON.stringify(next) !== JSON.stringify(state)) { state = next; render(); }
        schedule();
      } catch { status.textContent = "连接状态读取失败，请刷新状态。"; }
    }, 1200);
  }
  function render() {
    content.replaceChildren();
    const card = el("section", null, "service-card");
    card.append(el("h3", "飞书"), el("p", "连接你的飞书账号，按文档链接读取企业资料。", "muted"));
    if (state.account) {
      card.append(el("p", `已保存连接 · ${state.account.label}`), el("p", `上次验证：${state.account.verifiedAt}。每次读取会重新核对账号与文档只读权限。`, "muted"));
      const form = el("form"), label = el("label", "飞书文档链接"), input = el("input");
      input.type = "url"; input.required = true; input.placeholder = "https://企业.feishu.cn/docx/…"; label.append(input);
      const read = el("button", "读取文档", "primary-button"); read.type = "submit";
      const result = el("div"); result.setAttribute("aria-live", "polite");
      form.append(label, read, result);
      form.addEventListener("submit", async e => {
        e.preventDefault(); if (busy) return; busy = true; read.disabled = true; result.textContent = "正在读取…";
        try {
          const doc = await api("/api/connectors/feishu/read", { url: input.value.trim() });
          if (!dialog.isConnected) return;
          result.replaceChildren(el("p", `已读取 · 版本 ${doc.revision} · ${doc.readAt}`), el("pre", doc.content, "service-document"));
        } catch (error) { result.textContent = error.message; }
        finally { busy = false; read.disabled = false; }
      });
      card.append(form, button("断开本地连接", () => perform("/api/connectors/feishu/disconnect", {})), el("p", "断开后 DataEngine 不再调用此账号；飞书侧应用授权可在飞书中管理。", "muted"));
    } else if (active()) {
      const labels = { preparing: "正在准备飞书连接组件…", waiting_app: "第一步：在飞书官方页面申请 CLI 应用", waiting_authorization: "第二步：登录并授权文档只读权限", verifying: "正在验证应用与账号…" };
      card.append(el("p", labels[state.job.phase]), el("p", "完成网页操作后，这里会自动更新。", "muted"));
      if (state.job.authorizationUrl) {
        const link = el("a", "打开飞书授权页面 ↗", "primary-button");
        link.href = state.job.authorizationUrl; link.target = "_blank"; link.rel = "noopener noreferrer"; card.append(link);
      }
      card.append(button("取消连接", () => perform("/api/connectors/feishu/cancel", { id: state.job.id })));
    } else {
      if (state.job?.error) card.append(el("p", state.job.error));
      if (state.job?.phase === "cancelled") card.append(el("p", "已取消，可以重新连接。", "muted"));
      card.append(el("ol"));
      const steps = card.lastChild;
      for (const text of ["准备官方飞书 CLI 组件", "前往飞书网页申请应用并登录", "验证账号后按需读取文档"]) steps.append(el("li", text));
      card.append(button("登录并连接飞书", () => perform("/api/connectors/feishu/start", {}), "primary-button"), el("p", `首次连接会下载并校验官方 lark-cli ${state.version}。仅申请文档只读权限；企业可能需要管理员批准。`, "muted"));
    }
    content.append(card, button("刷新状态", refresh));
    if (custom) content.append(button("高级：自定义 API / MCP →", () => { if (!busy && !active()) { dialog.close(); custom(); } }));
  }
  async function refresh() {
    if (busy) return;
    const request = ++generation;
    try { const next = await api("/api/connectors/feishu"); if (!dialog.isConnected || request !== generation) return; state = next; status.textContent = ""; render(); schedule(); }
    catch (error) { status.textContent = error.message; content.replaceChildren(button("重试", refresh)); }
  }
  void refresh();
}

import { element as el, action, field, connectionDialog } from "./connection-ui.js";

export function openFeishuConnection(api, options = {}) {
  const shell = connectionDialog("连接飞书", "在飞书官方页面授权；已有账号可直接按链接读取文档。");
  shell.dialog.classList.add("service-connections");
  let state, timer, pending, reading = false, exiting = false, generation = 0;
  let documentUrl = "", documentResult;
  const active = () => state?.job && !["connected", "cancelled", "failed"].includes(state.job.phase);
  const alive = () => shell.dialog.isConnected && !exiting;
  const back = action("← 所有连接", async () => {
    await shell.close();
    if (!shell.dialog.open) options.onBack?.();
  });
  shell.body.before(back);
  shell.beforeClose = async () => {
    exiting = true; generation++; clearTimeout(timer);
    try {
      if (pending) { shell.message("正在结束连接操作…"); await pending; }
      if (active()) {
        shell.message("正在取消未完成的授权…");
        state = await api("/api/connectors/feishu/cancel", { id: state.job.id });
      }
    } catch {
      exiting = false; schedule();
      throw new Error("尚未确认取消，请重试关闭。");
    }
  };
  shell.onClose = () => { exiting = true; generation++; clearTimeout(timer); };
  function update(next) {
    const changed = JSON.stringify(state?.account) !== JSON.stringify(next.account);
    state = next;
    if (changed) options.onChanged?.();
  }
  function freeze(value) {
    back.disabled = value;
    shell.body.querySelectorAll("button,input").forEach(node => node.disabled = value);
  }
  async function perform(path, body) {
    if (pending || reading || !alive()) return;
    generation++; clearTimeout(timer); freeze(true); shell.message("正在处理…");
    pending = (async () => {
      try {
        update(await api(path, body));
        if (!alive()) return;
        shell.message(""); render(); schedule();
      } catch (error) { if (alive()) shell.message(error.message); }
      finally { pending = undefined; freeze(false); }
    })();
    await pending;
  }
  function schedule() {
    clearTimeout(timer);
    if (!active() || !alive()) return;
    timer = setTimeout(() => void refresh(), 1200);
  }
  function showDocument(target) {
    if (!documentResult) return;
    target.replaceChildren(el("p", `已读取 · 版本 ${documentResult.revision} · ${new Date(documentResult.readAt).toLocaleString("zh-CN")}`), el("pre", documentResult.content, "service-document"));
  }
  function render() {
    shell.body.replaceChildren();
    if (state.account) {
      const account = el("section", null, "connection-summary");
      account.append(el("strong", state.account.label), el("p", "已保存飞书账号 · 文档只读", "connection-note"));
      const form = el("form"), url = field("飞书文档链接", "url");
      url.input.required = true; url.input.placeholder = "https://企业.feishu.cn/docx/…"; url.input.value = documentUrl;
      url.input.addEventListener("input", () => { documentUrl = url.input.value; });
      const read = el("button", "读取文档", "primary-button"); read.type = "submit";
      const result = el("div"); result.setAttribute("aria-live", "polite"); showDocument(result);
      form.append(url.label, read, result);
      form.addEventListener("submit", async event => {
        event.preventDefault();
        if (pending || reading || !alive()) return;
        reading = true; freeze(true); documentResult = undefined; result.textContent = "正在读取…";
        try {
          const doc = await api("/api/connectors/feishu/read", { url: url.input.value.trim() });
          if (!alive()) return;
          documentResult = doc; showDocument(result);
        } catch (error) { if (alive()) result.textContent = error.message; }
        finally { reading = false; freeze(false); }
      });
      const manage = el("details", null, "connection-advanced");
      manage.append(el("summary", "账号管理"), el("p", `上次核验：${new Date(state.account.verifiedAt).toLocaleString("zh-CN")}。读取时会再次验证账号和权限。`, "connection-note"), action("断开本地连接", () => {
        documentResult = undefined;
        return perform("/api/connectors/feishu/disconnect", {});
      }), el("p", "飞书侧应用授权需在飞书中管理。", "connection-note"));
      shell.body.append(account, form, el("p", "当前支持 docx 文档链接；知识库目录暂未接入。读取内容不会自动保存为上传资料。", "connection-note"), manage);
    } else if (active()) {
      const steps = [["preparing", "准备组件"], ["waiting_app", "创建应用"], ["waiting_authorization", "授权文档"], ["verifying", "验证账号"]];
      const progress = el("ol", null, "connection-progress");
      const current = steps.findIndex(([phase]) => phase === state.job.phase);
      steps.forEach(([, title], index) => {
        const item = el("li", `${index + 1}. ${title}`, index === current ? "active" : "");
        if (index === current) item.setAttribute("aria-current", "step"); progress.append(item);
      });
      const labels = { preparing: "正在准备官方连接组件…", waiting_app: "请在飞书页面完成应用创建", waiting_authorization: "应用已创建，请继续授权文档读取", verifying: "正在验证应用与账号…" };
      shell.body.append(progress, el("h3", labels[state.job.phase]), el("p", state.job.phase === "waiting_app" ? "网页显示“创建成功”后回到这里，继续下一步文档授权。" : "完成官方网页操作后，连接状态会自动更新。", "connection-note"));
      if (state.job.authorizationUrl) {
        const link = el("a", state.job.phase === "waiting_app" ? "前往飞书创建应用 ↗" : "前往飞书授权文档 ↗", "primary-button");
        link.href = state.job.authorizationUrl; link.target = "_blank"; link.rel = "noopener noreferrer";
        shell.body.append(link, el("p", new URL(link.href).hostname, "connection-note"));
      }
      shell.body.append(action("取消连接", () => perform("/api/connectors/feishu/cancel", { id: state.job.id })));
    } else {
      const card = el("section", null, "connection-summary");
      card.append(el("h3", "登录一次，按需读取"), el("p", "首次连接需创建飞书应用，再授权文档只读权限。已有授权会在下次直接复用。", "connection-note"));
      if (state.job?.error) shell.body.append(el("p", state.job.error));
      if (state.job?.phase === "cancelled") shell.body.append(el("p", "已取消，可以重新连接。", "connection-note"));
      shell.body.append(card, action("登录并连接飞书", () => perform("/api/connectors/feishu/start", {}), "primary-button"), el("p", `首次使用会准备官方 lark-cli ${state.version}；企业可能需要管理员批准。`, "connection-note"));
    }
    shell.body.append(action("刷新状态", refresh));
  }
  async function refresh() {
    if (pending || reading || !alive()) return;
    const request = ++generation;
    try {
      const next = await api("/api/connectors/feishu");
      if (!alive() || request !== generation) return;
      if (JSON.stringify(next) !== JSON.stringify(state)) { update(next); render(); }
      shell.message(""); schedule();
    } catch (error) {
      if (!alive() || request !== generation) return;
      shell.message(error.message);
      if (!state) shell.body.replaceChildren(action("重试", refresh));
      else schedule();
    }
  }
  shell.message("正在读取飞书连接…");
  void refresh();
  return shell;
}

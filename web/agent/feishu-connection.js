import { technicalDetails } from "./ui-display.js";
import { element as el, action, field, connectionDialog } from "./connection-ui.js";
import { renderFeishuDirectory } from "./feishu-directory.js";

export function openFeishuConnection(api, options = {}) {
  const shell = connectionDialog("飞书资料", "按链接读取正文，保存资料后自动构建有原文依据的本体。");
  shell.dialog.classList.add("service-connections");
  let state, timer, pending, reading = false, exiting = false, generation = 0;
  let documentUrl = "", documentResult, selectedId = options.sourceId, detailRequest = 0, adding = false;
  let directoryListing, directorySelection = new Set(), directoryResults = new Map();
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
    state = { ...state, ...next };
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
      finally { pending = undefined; freeze(false); if (alive()) render(); }
    })();
    await pending;
  }
  function schedule() {
    clearTimeout(timer);
    if (!active() || !alive()) return;
    timer = setTimeout(() => void refresh(), 1200);
  }
  async function browseDirectory(url, parent = false, pageToken) {
    if (pending || reading || !alive()) return;
    reading = true; generation++; detailRequest++; freeze(true); shell.message("正在查看目录，不读取文件正文…");
    try {
      const listing = await api("/api/connectors/feishu/directory", { url, parent, ...(pageToken ? { pageToken } : {}) });
      if (!alive()) return;
      directoryListing = listing;
      directorySelection = new Set(listing.items.filter(item => item.readable).map(item => item.url));
      directoryResults = new Map(); shell.message("");
      render(); shell.body.scrollTop = 0;
    } catch (error) { if (alive()) shell.message(error.message); }
    finally { reading = false; freeze(false); if (alive()) render(); }
  }
  async function readDirectorySelection() {
    if (pending || reading || !alive() || !directoryListing) return;
    const files = directoryListing.items.filter(item => item.readable && directorySelection.has(item.url));
    if (!files.length) return;
    reading = true; generation++; detailRequest++; freeze(true);
    let saved = 0, failed = 0;
    try {
      for (const [index, file] of files.entries()) {
        if (!alive()) break;
        shell.message(`正在读取 ${index + 1} / ${files.length}：${file.title}`);
        try {
          const doc = await api("/api/connectors/feishu/read", { url: file.url });
          directoryResults.set(file.url, { ok: true, sourceId: doc.sourceId, characters: doc.characters }); saved++;
          documentResult = doc; selectedId = doc.sourceId;
        } catch (error) { directoryResults.set(file.url, { ok: false, error: error.message }); failed++; }
        if (alive()) { render(); freeze(true); }
      }
      if (!alive()) return;
      update(await api("/api/connectors/feishu")); options.onChanged?.();
      shell.message(`本次读取完成：${saved} 份已保存${failed ? `，${failed} 份失败，请查看各文件原因` : ""}。`);
    } catch (error) { if (alive()) shell.message(`读取结果已逐项保留，刷新目录状态失败：${error.message}`); }
    finally { reading = false; freeze(false); if (alive()) { render(); shell.body.scrollTop = 0; } }
  }
  async function selectDocument(id) {
    if (pending || reading || !alive()) return;
    directoryListing = undefined;
    selectedId = id;
    const request = ++detailRequest;
    shell.message("正在打开已保存正文…");
    try {
      const doc = await api(`/api/connectors/feishu/document?${new URLSearchParams({ sourceId: id })}`);
      if (!alive() || request !== detailRequest) return;
      documentResult = doc; shell.message(""); render(); shell.body.scrollTop = 0;
    } catch (error) { if (alive() && request === detailRequest) shell.message(error.message); }
  }
  function showDocument(target) {
    if (!documentResult) return;
    const doc = documentResult;
    const version = doc.revision == null ? "附件文本" : "在线文档";
    const summary = el("div", null, "feishu-document-meta");
    for (const [label, value] of [["读取内容", `${doc.characters} 字符`], ["来源类型", version], ["快照读取时间", new Date(doc.readAt).toLocaleString("zh-CN")], ["保存结果", "已保存本地快照"]]) {
      const item = el("div"); item.append(el("small", label), el("strong", value)); summary.append(item);
    }
    const status = el("div", null, "feishu-document-progress");
    status.append(el("span", "✓ 正文已读取"), el("span", "✓ 资料已保存"), el("span", doc.usage.length ? "已有本体引用 ↓" : "已进入自动构建流程"));
    target.append(technicalDetails({sourceVersion:doc.sourceVersion,revision:doc.revision}));
    const heading = el("h3", doc.title);
    const preview = el("pre", doc.content || "这份文档没有可读取的正文。", "service-document");
    const link = el("a", "在飞书打开原文 ↗", "connection-note"); link.href = doc.url; link.target = "_blank"; link.rel = "noopener noreferrer";
    const uses = el("div", null, "feishu-document-uses");
    for (const usage of doc.usage) {
      const item = el("section", null, "connection-summary");
      item.append(el("strong", `${usage.status === "adopted" ? "已采用引用" : "候选引用 · 待核对"}`),
        el("p", `${usage.concepts.length} 个概念 · ${usage.relations.length} 个关系`),
        el("p", [...usage.concepts, ...usage.relations].map(x => x.name).join(" / ") || "用于企业说明或待核实项", "connection-note"));
      if (!usage.sourceVersions.includes(doc.sourceVersion)) item.append(el("p", "此本体仍引用旧快照，当前正文尚未用于该版本。", "connection-note"));
      item.append(action("前往本体工作区", async () => {
        if (pending || reading) return;
        reading = true; freeze(true);
        try {
          const snapshot = await api("/api/canvas/navigate", { page: "ontology" });
          if (!alive()) return;
          options.onPrepared?.(snapshot); await shell.close();
        } catch (error) { if (alive()) shell.message(error.message); }
        finally { reading = false; freeze(false); if (alive()) render(); }
      }), el("p", `在工作区的版本菜单中查看当前本体，核对定义和原文依据。`, "connection-note"));
      uses.append(item);
    }
    const actions = el("div", null, "connection-actions");
    const prepare = action("查看本体构建", async () => {
      if (pending || reading) return;
      reading = true; freeze(true); shell.message("正在打开本体工作区…");
      try {
        const snapshot = await api("/api/canvas/navigate", { page: "ontology" });
        if (!alive()) return;
        options.onPrepared?.(snapshot); options.onChanged?.();
        await shell.close();
      } catch (error) { if (alive()) shell.message(error.message); }
      finally { reading = false; freeze(false); if (alive()) render(); }
    }, "primary-button");
    actions.append(prepare);
    if (state.account) actions.append(action("重新读取原文", () => { documentUrl = doc.url; adding = true; render(); shell.body.querySelector("form").requestSubmit(); }));
    if (state.account && new URL(doc.url).pathname.startsWith("/wiki/")) actions.append(action("查看所在目录", () => browseDirectory(doc.url, true)));
    target.replaceChildren(heading, status, summary, actions,
      el("p", state.modelConfigured ? "资料保存后会自动提取概念、关系和原文依据，并直接生效。可前往本体工作区查看进度和结果。" : "正文已保存并加入队列。连接模型后会自动构建本体，无需再次提交。", "connection-note"), link, preview, uses);
  }
  function documentLibrary() {
    const docs = state.documents || [];
    const library = el("section", null, "feishu-library");
    library.append(el("h3", `已读取资料 · ${docs.length} 份`));
    if (!docs.length) library.append(el("p", "还没有保存的正文。粘贴具体文档链接并读取后，会在这里看到内容和本体引用。", "connection-note"));
    const list = el("div", null, "feishu-document-list");
    for (const doc of docs) {
      const button = action("", () => selectDocument(doc.sourceId), "feishu-document-entry");
      button.setAttribute("aria-pressed", String(doc.sourceId === selectedId));
      button.append(el("strong", doc.title), el("small", `${doc.characters} 字符 · ${doc.usage.length ? "已有本体引用" : "已进入自动构建流程"}`));
      list.append(button);
    }
    library.append(list);
    const detail = el("section", null, "feishu-document-detail"); showDocument(detail); library.append(detail);
    return library;
  }
  function render() {
    shell.body.replaceChildren();
    if (directoryListing) shell.body.append(renderFeishuDirectory(directoryListing, directorySelection, directoryResults, {
      back: () => { directoryListing = undefined; render(); }, browse: browseDirectory, read: readDirectorySelection, open: selectDocument,
    }));
    else if (state.documents?.length) shell.body.append(documentLibrary());
    if (state.account) {
      const account = el("section", null, "connection-summary");
      account.append(el("strong", state.account.label), el("p", "已保存飞书账号 · 文档只读", "connection-note"));
      const form = el("form"), url = field("飞书文档或目录链接", "url");
      url.input.required = true; url.input.placeholder = "https://企业.feishu.cn/wiki/… 或 /docx/…"; url.input.value = documentUrl;
      url.input.addEventListener("input", () => { documentUrl = url.input.value; });
      const read = el("button", "只读取当前文档", "primary-button"); read.type = "submit";
      const result = el("div"); result.setAttribute("aria-live", "polite");
      const formActions = el("div", null, "connection-actions");
      formActions.append(read, action("查看目录中的文件", () => { if (url.input.reportValidity()) void browseDirectory(url.input.value.trim()); }));
      form.append(url.label, formActions, result);
      form.addEventListener("submit", async event => {
        event.preventDefault();
        if (pending || reading || !alive()) return;
        reading = true; generation++; detailRequest++; freeze(true); result.textContent = "正在读取并保存正文…";
        try {
          const doc = await api("/api/connectors/feishu/read", { url: url.input.value.trim() });
          if (!alive()) return;
          documentResult = doc; selectedId = doc.sourceId; adding = false; directoryListing = undefined;
          update(await api("/api/connectors/feishu"));
          if (!alive()) return;
          render(); shell.body.scrollTop = 0; options.onChanged?.();
          shell.message(doc.changed ? "正文已读取并保存，可在下方查看。" : "已重新读取，内容未变，继续使用已有快照。");
        } catch (error) { if (alive()) shell.message(error.message); }
        finally { reading = false; freeze(false); if (alive()) render(); }
      });
      const manage = el("details", null, "connection-advanced");
      manage.append(el("summary", "账号管理"), el("p", `上次核验：${new Date(state.account.verifiedAt).toLocaleString("zh-CN")}。读取时会再次验证账号和权限。`, "connection-note"), action("断开本地连接", () => {
        return perform("/api/connectors/feishu/disconnect", {});
      }), el("p", "飞书侧应用授权需在飞书中管理。", "connection-note"));
      const readPanel = el("details", null, "connection-advanced feishu-read-panel");
      readPanel.open = adding || !state.documents?.length;
      readPanel.addEventListener("toggle", () => { if (readPanel.isConnected) adding = readPanel.open; });
      readPanel.append(el("summary", "读取其他文档 · 管理账号"), account, form,
        el("p", "单个文档只读取自身正文；wiki 目录请先查看文件列表，再勾选读取。支持 docx、Markdown、TXT、CSV；附件限 250 KB、60000 字符（UTF-8）。", "connection-note"), manage);
      shell.body.append(readPanel);
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
    if (!state.documents?.length && !directoryListing) shell.body.append(documentLibrary());
    shell.body.append(action("刷新状态", refresh));
  }
  async function refresh() {
    if (pending || reading || !alive()) return;
    const request = ++generation;
    try {
      const next = await api("/api/connectors/feishu");
      if (!alive() || request !== generation) return;
      if (JSON.stringify(next) !== JSON.stringify(state)) {
        update(next);
        if (documentResult) {
          const summary = state.documents?.find(doc => doc.sourceId === documentResult.sourceId);
          if (summary?.sourceVersion === documentResult.sourceVersion) documentResult = { ...documentResult, ...summary };
          else documentResult = undefined;
        }
        render();
        const selected = state.documents?.find(doc => doc.sourceId === selectedId) || state.documents?.[0];
        if (selected && !documentResult) void selectDocument(selected.sourceId);
      }
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

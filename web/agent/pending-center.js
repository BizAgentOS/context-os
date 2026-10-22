import { el, action, field, transact, table } from "./engine-ui.js";
import { showChange } from "./changes-workspace.js";
import { showGap } from "./gap-detail.js";
import { showSyncIssue } from "./sync-issue.js";

const categories = { structure: "结构变更", naming: "命名", adjudication: "待裁决", gap: "问题缺口", data_issue: "数据问题" };
const origins = { program: "程序发现", human: "人工提议", agent: "助手提议", qa: "问答反馈" };
const statuses = { proposed: "待复验", verified: "已复验", failed: "复验未通过" };
export function requestPending(reference = {}) { window.dispatchEvent(new CustomEvent("context-os:pending", { detail: reference })); }

/** The shell and all legacy details navigate to this one decision surface. */
export function createPendingCenter(actions) {
  let panel, list, detail, feedback, filter, sourceFilter, objectFilter, filterBar, batchBar, request = 0, reference, lastFocus, offset = 0;
  const selectedItems = new Map(), batchOperations = new Map();
  let summarySignature = "";
  const escape = event => { if (event.key === "Escape" && panel?.isConnected) { event.stopPropagation(); close(); } };
  const close = () => { document.removeEventListener("keydown", escape, true); request++; panel?.remove(); panel = null; lastFocus?.focus(); };
  async function refresh() {
    const generation = ++request;
    const params = new URLSearchParams({ offset: String(offset) });
    if (filter.value) params.set("category", filter.value);
    if (sourceFilter.value) params.set("source", sourceFilter.value);
    if (objectFilter.value) params.set("object", objectFilter.value);
    if (reference?.ownerId) params.set("owner", reference.ownerId);
    const response = await actions.api(`/api/pending?${params}`);
    if (!panel?.isConnected || generation !== request) return;
    panel.querySelector("h2").textContent = `待处理（${response.total}）`;
    for (const [control, values, label] of [[sourceFilter, response.facets?.sources || [], "全部来源"], [objectFilter, response.facets?.objects || [], "全部对象"]]) {
      const saved = control.value; control.replaceChildren();
      for (const item of [{id:"", label}, ...values]) { const option = el("option", item.label); option.value = item.id; control.append(option); }
      control.value = saved;
    }
    for (const [id, item] of selectedItems) { const current = response.items.find(value => value.id === id); if (!current || current.version !== item.version) selectedItems.delete(id); }
    list.replaceChildren();
    for (const item of response.items) {
      const row = el("article", null, "pending-item"), title = action(item.title, () => select(item));
      title.className = "pending-item-title";
      if (item.actions.reject && item.category!=='gap' && item.detailRef?.kind!=='sync_issue') {
        const label = el("label", null, "pending-select"), selected = el("input"); selected.type = "checkbox"; selected.checked = selectedItems.has(item.id);
        selected.setAttribute("aria-label", `选择${item.title}`);
        selected.onchange = () => { if (selected.checked) selectedItems.set(item.id, item); else selectedItems.delete(item.id); renderBatch(); };
        label.append(selected, el("span", "选择")); row.append(label);
      }
      row.append(title, el("p", `${categories[item.category]} · ${origins[item.origin] || "需核对"} · ${statuses[item.status] || "待处理"}`, "engine-muted"));
      if (item.evidence) row.append(el("p", item.evidence, "pending-evidence"));
      if (item.stale) row.append(el("p", "工作版已有变化，需重新核对本项依据。", "engine-muted"));
      const controls = el("div", null, "engine-actions");
      controls.append(action("查看并处理", () => select(item)), action("让助手分析", () => { actions.analyze?.(item); close(); }));
      row.append(controls); list.append(row);
    }
    if (!response.items.length) list.append(el("p", response.total ? "当前筛选没有待处理项。" : "当前没有待处理事项。", "engine-muted"));
    const pagination = el("div", null, "engine-actions");
    if (offset) pagination.append(action("上一页", () => { offset = Math.max(0, offset - 40); void reload(); }));
    if (response.nextOffset != null) pagination.append(action("下一页", () => { offset = response.nextOffset; void reload(); }));
    list.append(pagination); renderBatch();
    if (reference?.id) { const selected = reference; reference = null; select(selected); }
    else if (reference?.ownerId && response.items.length === 1) { reference = null; select(response.items[0]); }
  }
  async function reload() { try { await refresh(); } catch (error) { if (feedback?.isConnected) feedback.textContent = error.message; } }
  async function select(item) {
    if (!item.category) {
      try { item = (await actions.api(`/api/pending/read?id=${encodeURIComponent(item.id)}`)).item; }
      catch (error) { feedback.textContent = error.message; return; }
    }
    if (!panel?.isConnected) return;
    detail.replaceChildren(); detail.hidden = false;
    detail.append(action("返回队列", () => { detail.hidden = true; list.hidden = false; filterBar.hidden = false; batchBar.hidden = false; void reload(); }));
    list.hidden = true; filterBar.hidden = true; batchBar.hidden = true;
    const body = el("div"); detail.append(body);
    if(item.detailRef?.kind==='sync_issue')void showSyncIssue(item,actions,refresh,body);
    else if(item.category==='gap')void showGap(item,actions,refresh,body);
    else if (item.status === "awaiting_choice" && item.detailRef) void adjudicate(item, body);
    else showChange(item, actions, refresh, body);
    body.setAttribute("tabindex", "-1"); body.focus();
  }
  function renderBatch() {
    batchBar.replaceChildren();
    const items = [...selectedItems.values()]; if (!items.length) return;
    batchBar.append(el("p", `已选择 ${items.length} 项。批量操作仅支持同一类别；相互冲突的变更不会部分生效。`));
    const reviewLabel = el("label", null, "engine-check"), review = el("input"); review.type = "checkbox";
    reviewLabel.append(review, el("span", "我已核对所选事项中的待审内容"));
    if (items.some(item => item.verification?.result === "review")) batchBar.append(reviewLabel);
    const reason = field(batchBar, "批量拒绝理由", "", true);
    const decide = method => transact(panel, feedback, async () => {
      if (new Set(items.map(item => item.category)).size !== 1) throw new Error("请选择同一类别的事项。");
      if (method === "adopt" && items.some(item => !item.actions.adopt)) throw new Error("请先逐项复验，只有已核对且基线未变化的事项可批量采用。");
      if (method === "reject" && !reason.value.trim()) throw new Error("请填写拒绝理由。");
      const args = { items: items.map(({id,version}) => ({id,version})), ...(method === "reject" ? {reason:reason.value.trim()} : {acknowledgeReview:review.checked}) };
      const key = JSON.stringify([method,args]); if (!batchOperations.has(key)) batchOperations.set(key,crypto.randomUUID());
      const result = await actions.api(`/api/changes/batch-${method}`, {...args, operationId:batchOperations.get(key)});
      selectedItems.clear(); await actions.refresh(); await refresh(); feedback.textContent = `已${method === "adopt" ? "采用" : "拒绝"} ${result.changes.length} 项。`;
    });
    batchBar.append(action("批量采用", () => decide("adopt"), "engine-primary"), action("批量拒绝", () => decide("reject")));
  }
  async function adjudicate(item, body) {
    const output = el("p", "正在读取依据…", "engine-message"); output.setAttribute("role", "status"); body.append(output);
    try {
      const { foundationRef, issue } = item.detailRef;
      const query = new URLSearchParams({ id: foundationRef.id, version: foundationRef.version, kind: issue.kind, issueId: issue.id });
      const record = await actions.api(`/api/foundation/adjudication/read?${query}`);
      if (!body.isConnected) return;
      body.append(el("h3", item.title), el("p", item.impact));
      if (record.issue.retained) body.append(el("h4", "已保留的含义"), el("p", `${record.issue.retained.name || ""}：${record.issue.retained.description || ""}`));
      if (record.issue.proposed) body.append(el("h4", "资料提出的含义"), el("p", `${record.issue.proposed.name || ""}：${record.issue.proposed.description || ""}`));
      body.append(table(record.evidence, [["资料", e => e.title || "依据"], ["原文", e => e.quote]]));
      const label = el("label", "处理方式", "engine-field"), choice = el("select");
      const options = issue.kind === "conflict" ? [["choose_retained", "选择已保留含义"], ["choose_proposed", "选择资料中的含义"], ["retain_disagreement", "保留双方分歧"], ["explain", "补充说明"], ["close", "关闭此项"]] : [["explain", "补充说明"], ["close", "关闭此项"]];
      const blank = el("option", "请选择处理方式"); blank.value = ""; choice.append(blank);
      for (const [value, text] of options) { const option = el("option", text); option.value = value; choice.append(option); }
      label.append(choice); body.append(label);
      const reason = field(body, "决定理由", "", true), explanation = field(body, "补充说明（选择补充说明时填写）", "", true);
      let operationId;
      body.append(action("形成裁决提议", () => transact(body, output, async () => {
        if (!choice.value || !reason.value.trim()) throw new Error("请选择处理方式并填写决定理由。");
        const proposal = { ...item.detailRef, action: choice.value, reason: reason.value.trim(), ...(explanation.value.trim() ? { explanation: explanation.value.trim() } : {}) };
        const key = JSON.stringify(proposal); if (operationId?.key !== key) operationId = { key, value: crypto.randomUUID() };
        const response = await actions.api("/api/foundation/adjudication/propose", { ...proposal, operationId: operationId.value });
        await actions.refresh(); await refresh();
        if (body.isConnected) body.addEventListener("transactionend", () => { if (body.isConnected) { body.replaceChildren(); showChange(response.change, actions, refresh, body); } }, { once: true });
      }), "engine-primary"));
      output.textContent = "选择已有含义、保留分歧或关闭均会保留原问题和依据。";
    } catch (error) { if (output.isConnected) output.textContent = error.message; }
  }
  function open(target = {}) {
    reference = target; offset = 0; selectedItems.clear();
    if (!panel) {
      lastFocus = document.activeElement;
      panel = el("aside", null, "pending-drawer"); panel.setAttribute("role", "region"); panel.setAttribute("aria-label", "待处理中心");
      const header = el("header"); header.append(el("h2", "待处理"), action("关闭待处理", close));
      filter = el("select"); filter.setAttribute("aria-label", "待处理类别");
      for (const [value, label] of [["", "全部类别"], ...Object.entries(categories)]) { const option = el("option", label); option.value = value; filter.append(option); }
      sourceFilter = el("select"); sourceFilter.setAttribute("aria-label", "待处理来源");
      objectFilter = el("select"); objectFilter.setAttribute("aria-label", "涉及对象");
      filterBar = el("div", null, "pending-filters"); filterBar.append(filter, sourceFilter, objectFilter);
      for (const control of [filter, sourceFilter, objectFilter]) control.addEventListener("change", () => { reference = null; offset = 0; selectedItems.clear(); void reload(); });
      batchBar = el("div", null, "pending-batch");
      list = el("div", null, "pending-list"); detail = el("div", null, "pending-detail"); detail.hidden = true;
      feedback = el("p", null, "engine-message"); feedback.setAttribute("role", "status");
      panel.append(header, filterBar, feedback, batchBar, list, detail);
      panel.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); close(); } });
      document.body.append(panel); document.addEventListener("keydown", escape, true); header.querySelector("button").focus();
    } else { detail.hidden = true; list.hidden = false; filterBar.hidden = false; batchBar.hidden = false; }
    filter.value = target.category || "";
    void reload();
  }
  return { open, close, sync(summary) { const signature = JSON.stringify(summary); if (signature === summarySignature) return; summarySignature = signature; if (panel?.isConnected) void reload(); }, refresh: () => panel?.isConnected ? reload() : Promise.resolve() };
}

export function renderPendingCenter(state, { node, button }) {
  if (!state.pendingSummary?.total) return null;
  const section = node("aside", "attention-list"); section.setAttribute("aria-label", "待处理事项");
  section.append(button(`待处理（${state.pendingSummary.total}）`, "attention-item", () => requestPending()));
  return section;
}

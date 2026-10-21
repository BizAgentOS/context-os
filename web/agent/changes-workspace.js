import { el, action, ref, when, dialog, message, transact, table, field, check } from "./engine-ui.js";
import { technicalDetails } from "./ui-display.js";

const states = { proposed: "待复验", verified: "已复验", failed: "复验未通过", adopted: "已采用", rejected: "已拒绝", deprecated: "已弃用", superseded: "已替代" };
const kinds = { entity: "实体", property: "属性", relation: "关系", binding: "数据对应", naming: "命名", description: "说明", local_correction: "局部纠正", identity_rule: "身份规则", identity_decision: "身份决定", deprecation: "弃用", restore: "恢复工作版", data_issue: "数据问题" };
const origins = { program: "程序发现", human: "人工提议", agent: "助手提议", qa: "问答反馈" };
const results = { passed: "通过", review: "需要核对", failed: "未通过" };
const metricNames = { matchRate: "匹配率", matched: "匹配记录", total: "检查记录", targetUnique: "目标唯一", targetExists: "目标存在", nameUnique: "名称唯一", complete: "覆盖完整", valid: "检查通过", rows: "记录数", changes: "变更数", snapshots: "快照数", maxDepth: "最大层级", acyclic: "无环", typeCompatible: "类型相容", sourceNonNullRate: "起点非空率", cardinalityValid: "符合关系数量约束", cycleDetected: "存在循环", withinMaxDepth: "未超过层级上限", leftRecords: "起点记录", rightRecords: "目标记录", ambiguous: "目标不唯一的记录", reverseAmbiguous: "补充来源不唯一的对象", multipleSourceTargets: "对应多个来源记录的目标", empty: "匹配字段为空", botRecords: "疑似机器人记录", leftExists: "起点记录存在", rightExists: "指定目标记录存在", explicitExclusion: "明确排除", records: "记录数", hasTime: "存在有效时间字段" };
const undecided = change => ["proposed", "verified", "failed"].includes(change.status);
const changeTitle = change => {
  const type = change.content?.type || change.type;
  const subject = change.content?.subject || change.subject || {};
  if (type === "relation" && subject.from?.column && subject.to?.column) return `建立关系：${subject.from.column} → ${subject.to.column}`;
  if (type === "identity_rule") return subject.kind === "belongs_to" ? "确认账号等对象的归属对应" : "确认同一身份的来源对应";
  if (type === "identity_decision") return subject.decision === "no_match" ? "排除记录的身份对应" : "确认记录的身份对应";
  if (type === "data_issue" && subject.classification === "activity") return "确认为活动记录";
  if (type === "deprecation" && subject.path) return "弃用可由两跳路径替代的关系";
  return change.title === `变更 · ${type}` ? kinds[type] || "本体变更" : change.title;
};

/** A concrete change record, shared by the history and build entry points. Full pending-center navigation belongs to 044. */
export function showChange(reference, actions, onChanged = () => {}) {
  const d = dialog("变更详情", true), output = message(d.body), host = el("div", null, "change-detail");
  d.body.append(host);
  let current, scopeArtifact, scopeVersion, datasets = [], request = 0;
  const operations = new Map();
  async function scope(change) {
    const subject = change.content.subject || {}, target = subject.candidateRef || subject.ownerRef;
    const workspace = subject.workspaceVersionRef ? await actions.api(`/api/artifacts/${encodeURIComponent(subject.workspaceVersionRef.id)}?version=${subject.workspaceVersionRef.version}`) : null;
    const governed = ["identity_rule", "identity_decision", "data_issue"].includes(change.content.type) || change.content.type === "deprecation" && subject.path;
    const definition = workspace?.content.composition.semantic || target || (governed ? change.content.baseline?.modelRef : null);
    const artifact = definition ? await actions.api(`/api/artifacts/${encodeURIComponent(definition.id)}?version=${definition.version}`) : null;
    const data = subject.from?.datasetId || governed ? await actions.api("/api/data") : null;
    if (artifact?.content.layered && ["identity_rule", "identity_decision"].includes(change.content.type)) {
      const ids = [...new Set([subject.left, subject.right].filter(Boolean).map(end => artifact.content.layered.bindings.entities.find(item => item.id === end.bindingId)?.dataset.sourceId).filter(Boolean))];
      const connections = await Promise.all(ids.map(id => actions.api(`/api/artifacts/${encodeURIComponent(id)}`)));
      for (const dataset of data?.datasets || []) dataset.bindingSourceIds = connections.filter(connection => connection.id === dataset.content.sourceId || connection.content.localSource?.id === dataset.content.sourceId).map(connection => connection.id);
    }
    return { artifact, workspace, datasets: data?.datasets || [] };
  }
  async function load() {
    const generation = ++request;
    const { change } = await actions.api(`/api/changes/read?id=${encodeURIComponent(reference.id)}`);
    const detail = await scope(change);
    if (!d.isConnected || generation !== request) return;
    current = change; scopeArtifact = detail.artifact; scopeVersion = detail.workspace; datasets = detail.datasets; render();
  }
  async function decide(method, extra = {}) {
    const args = { ...ref(current), ...extra }, key = JSON.stringify([method, args]);
    if (!operations.has(key)) operations.set(key, crypto.randomUUID());
    const response = await actions.api(`/api/changes/${method}`, { ...args, operationId: operations.get(key) });
    if (!d.isConnected) return;
    current = response.change;
    const detail = await scope(current);
    if (!d.isConnected) return;
    scopeArtifact = detail.artifact; scopeVersion = detail.workspace; datasets = detail.datasets;
    // Keep the current controls disabled until refreshing finishes; freshly rendered controls must not
    // accept a click while transact is still busy and would discard that next action.
    try { await actions.refresh(); await onChanged(); }
    finally {
      if (d.isConnected) {
        render();
        output.textContent = method === "verify" ? `复验${results[current.content.verification?.result] || "已完成"}。` : method === "adopt" ? "已采用，工作版已更新。已有发布保持原有内容。" : "已记录拒绝理由。";
      }
    }
  }
  function render() {
    host.replaceChildren();
    const content = current.content, verification = content.verification;
    host.append(el("h3", changeTitle(current)), el("p", `${kinds[content.type] || content.type} · ${origins[content.origin] || "已登记"} · ${states[current.status] || current.status}`, "engine-muted"));
    if (content.evidence) host.append(el("h4", "依据"), el("p", content.evidence, "change-evidence"));
    if (content.subject?.name) host.append(el("p", `建议名称：${content.subject.name}`));
    if (content.subject?.description) host.append(el("p", `建议说明：${content.subject.description}`));
    renderScope(host, current, scopeArtifact, datasets, scopeVersion);
    if (verification) {
      host.append(el("h4", `复验结果：${results[verification.result] || "尚未复验"}`));
      const metrics = Object.entries(verification.metrics || {}).filter(([key]) => metricNames[key]);
      if (metrics.length) host.append(table(metrics, [["检查", ([key]) => metricNames[key]], ["结果", ([key, value]) => typeof value === "boolean" ? value ? "是" : "否" : key.endsWith("Rate") && typeof value === "number" ? `${Math.round(value * 10000) / 100}%` : value]]));
      for (const note of verification.notes || []) host.append(el("p", note, "engine-muted"));
      host.append(el("p", `检查时间：${when(verification.checkedAt)}`, "engine-muted"));
    }
    if (content.closedReason || content.reason || content.decision?.reason) host.append(el("p", `决定理由：${content.closedReason || content.reason || content.decision.reason}`));
    if (content.closedAt || content.decision?.at) host.append(el("p", `决定时间：${when(content.closedAt || content.decision.at)}`, "engine-muted"));
    const controls = el("div", null, "engine-actions");
    controls.append(action("重新读取", () => transact(d, output, async () => { await load(); output.textContent = "已读取最新记录。"; })));
    if (undecided(current)) {
      controls.append(action("复验变更", () => transact(d, output, () => decide("verify"))));
      let acknowledgement;
      if (current.status === "verified" && verification?.result === "review") acknowledgement = check(host, "我已核对上述待审内容", "采用会更新当前工作版。", false);
      const adopt = action("采用此变更", () => transact(d, output, () => decide("adopt", { acknowledgeReview: acknowledgement?.checked === true })), "engine-primary");
      adopt.disabled = current.status !== "verified" || (acknowledgement && !acknowledgement.checked);
      acknowledgement?.addEventListener("change", () => { adopt.disabled = !acknowledgement.checked; });
      controls.append(adopt); host.append(controls);
      const reason = field(host, "拒绝理由", "", true);
      reason.maxLength = 2000;
      host.append(action("拒绝此变更", () => {
        if (!reason.value.trim()) { output.textContent = "请填写拒绝理由。"; reason.focus(); return; }
        return transact(d, output, () => decide("reject", { reason: reason.value.trim() }));
      }));
    } else host.append(controls);
    host.append(technicalDetails(current));
  }
  void transact(d, output, async () => { await load(); output.textContent = ""; });
  return d;
}

function renderScope(host, change, artifact, datasets, workspace) {
  const subject = change.content.subject || {}, content = artifact?.content || {};
  const selection = subject.selection;
  const layered = content.layered;
  const datasetName = id => datasets.find(item => item.id === id)?.content.name || "数据集";
  const endpoint = end => `${datasetName(end.datasetId)} · ${end.column}`;
  if (layered && ["identity_rule", "identity_decision"].includes(change.content.type)) {
    const bindingLabel = end => {
      const binding = layered.bindings.entities.find(item => item.id === end?.bindingId);
      const entity = layered.semantic.entityTypes.find(item => item.id === binding?.entityTypeId);
      const dataset = datasets.find(item => (item.content.sourceId === binding?.dataset.sourceId || item.content.connectionId === binding?.dataset.sourceId || item.bindingSourceIds?.includes(binding?.dataset.sourceId)) && item.content.capability === binding?.dataset.capability);
      return `${entity?.name || "对象"} · ${dataset?.content.name || binding?.name || "来源"}`;
    };
    host.append(el("h4", "本次变更范围"));
    if (change.content.type === "identity_rule") {
      host.append(el("p", subject.kind === "belongs_to" ? "归属对应：保留两侧对象，通过关系查询归属。" : "同一身份：将左侧来源补充到右侧对象，保留原来源对象与关系。"));
      host.append(table([subject.left, subject.right], [["来源", bindingLabel], ["匹配字段", end => end.columns.join("、")]]));
      host.append(el("p", `匹配方式：${({ none: "原值精确匹配", lowercase: "统一小写后匹配", uppercase: "统一大写后匹配", trim: "去除首尾空格后匹配" })[subject.transform?.op || "none"] || "按明确指定的字段转换匹配"}`));
    } else {
      const items = [subject.left, subject.right].filter(Boolean);
      host.append(table(items, [["来源", bindingLabel], ["记录", end => end.recordId]]));
      host.append(el("p", subject.decision === "match" ? "采用后：以上两条记录明确对应，优先于字段匹配规则。" : subject.right ? "采用后：排除这两条记录的对应，其他匹配继续按规则检查。" : "采用后：排除此起点记录的全部规则匹配。"));
    }
    host.append(el("p", `理由：${subject.reason}`), el("p", `记录依据：${subject.evidence}`));
    return;
  }
  if (subject.classification === "activity") {
    const entity = layered?.semantic.entityTypes.find(item => item.id === subject.entityTypeId);
    host.append(el("h4", "本次变更范围"), el("p", `${entity?.name || "对象"} · ${datasetName(subject.datasetId)}`), el("p", "采用后确认为活动记录，保留实体标识、原始数据和对象查询。"));
    return;
  }
  if (subject.path) {
    const relation = layered?.semantic.relationTypes.find(item => item.id === subject.relationId);
    host.append(el("h4", "本次变更范围"), el("p", `拟弃用：${relation?.name || "直接关系"}（${endpoint(subject.from)} → ${endpoint(subject.to)}）`), el("p", `替代路径：${endpoint(subject.path[0])} → ${endpoint(subject.path[1])}；${endpoint(subject.path[2])} → ${endpoint(subject.path[3])}`), el("p", "只有全量记录均可经已采用的替代路径到达相同目标时，才能弃用直接关系。"));
    return;
  }
  if (workspace) {
    const composition = workspace.content.composition;
    host.append(el("h4", `恢复目标：工作版 v${workspace.content.number}`), el("p", `${composition.snapshots.length} 个固定快照 · ${composition.corrections.length} 项局部纠正 · ${composition.identityDecisions.length} 项身份决定`, "engine-muted"));
  }
  if (artifact) {
    host.append(el("h4", "本次变更范围"));
    const concepts = content.concepts || [], relations = content.relations || content.modelRelations || [];
    const names = new Map(concepts.map(item => [item.id, item.name]));
    const selectedConcepts = selection ? concepts.filter(item => selection.entities?.includes(item.id)) : concepts;
    const selectedRelations = selection ? relations.filter(item => selection.relations?.includes(item.id || item.relationId)) : relations;
    if (selectedConcepts.length) host.append(table(selectedConcepts, [[workspace ? "恢复后实体" : "涉及实体", item => item.name], ["说明", item => item.description]]));
    if (selectedRelations.length) host.append(table(selectedRelations, [["关系", item => item.name], ["起点", item => names.get(item.from) || item.from], ["终点", item => names.get(item.to) || item.to]]));
    for (const value of selection?.merges || []) host.append(el("p", `合并来源：${value}`));
    for (const value of selection?.retired || []) host.append(el("p", `退出工作版：${names.get(value) || value}`));
    if (!selection && content.types?.length) host.append(table(content.types, [["对象", item => item.name], ["字段对应", item => Object.entries(item.fields || {}).map(([property, column]) => `${property} ← ${column}`).join("；")]]));
    if (content.draft?.patch) host.append(table(Object.entries(content.draft.patch), [["修改内容", ([key]) => ({ type: "对象", fields: "属性对应", supplements: "补充来源", relations: "关系", description: "说明" })[key] || key], ["建议值", ([, value]) => value]]));
    if (content.target) host.append(el("p", `对象：${content.target.type} · ${content.target.objectId}；关系：${content.target.relation}`), el("p", `采用后的关联对象：${content.targetIds?.join("、") || "无"}`));
    if (selection && !(selection.entities?.length || selection.relations?.length || selection.merges?.length || selection.retired?.length)) host.append(el("p", "刷新既有定义与数据对应，不增加结构。", "engine-muted"));
  } else if (subject.from?.datasetId && subject.to?.datasetId) {
    host.append(el("p", `${endpoint(subject.from)} → ${endpoint(subject.to)}`));
    if (subject.acyclic) host.append(el("p", `声明为无环层级，最多 ${subject.maxDepth || 10} 层。`));
  }
}

export function showChanges(actions, onChanged = () => {}) {
  const d = dialog("变更记录", true), output = message(d.body), controls = el("div", null, "engine-actions"), host = el("div");
  const label = el("label", "状态 "), status = el("select"); status.setAttribute("aria-label", "变更状态");
  for (const [value, title] of [["", "全部状态"], ...Object.entries(states)]) { const option = el("option", title); option.value = value; status.append(option); }
  label.append(status); controls.append(label, action("刷新记录", () => void transact(d, output, load)));
  d.body.append(controls, host);
  let offset = 0, generation = 0; const limit = 20;
  async function load() {
    const request = ++generation;
    const response = await actions.api(`/api/changes?limit=${limit}&offset=${offset}${status.value ? `&status=${encodeURIComponent(status.value)}` : ""}`);
    if (!d.isConnected || request !== generation) return;
    host.replaceChildren();
    host.append(el("p", `共 ${response.total} 项变更。复验通过后，采用具体变更才会更新工作版。`, "engine-muted"));
    for (const entry of response.changes) {
      const row = el("article", null, "engine-panel change-record");
      row.append(el("h3", changeTitle(entry)), el("p", `${kinds[entry.type] || entry.type} · ${states[entry.status] || entry.status} · ${when(entry.createdAt)}`, "engine-muted"), action("查看与处理", () => showChange(entry, actions, async () => { await load(); await onChanged(); })));
      host.append(row);
    }
    if (!response.total) host.append(el("p", "当前范围没有变更记录。", "engine-muted"));
    const paging = el("div", null, "engine-actions");
    const prev = action("上一页", () => { offset = Math.max(0, offset - limit); void transact(d, output, load); }); prev.disabled = offset === 0;
    const next = action("下一页", () => { offset += limit; void transact(d, output, load); }); next.disabled = offset + limit >= response.total;
    paging.append(prev, el("span", `第 ${Math.floor(offset / limit) + 1} 页`), next); host.append(paging); output.textContent = "";
  }
  status.addEventListener("change", () => { offset = 0; void transact(d, output, load); });
  void transact(d, output, load); return d;
}

export function showWorkspaceHistory(actions) {
  const d = dialog("工作版历史", true), output = message(d.body), host = el("div");
  d.body.append(el("p", "查看当时固定的定义与数据组合。恢复会先提出变更，复验并采用后形成新的工作版。", "engine-muted"), action("查看变更记录", () => showChanges(actions, load)), host);
  let generation = 0;
  async function load() {
    const request = ++generation, response = await actions.api("/api/workspace-versions");
    if (!d.isConnected || request !== generation) return;
    host.replaceChildren();
    for (const version of response.versions) {
      const row = el("article", null, "engine-panel change-record");
      row.append(el("h3", `工作版 v${version.number}`), el("p", when(version.createdAt), "engine-muted"), action("查看此工作版", () => showVersion(version))); host.append(row);
    }
    if (!response.versions.length) host.append(el("p", "采用第一份本体后将记录工作版。", "engine-muted"));
    output.textContent = "";
  }
  function showVersion(selected) {
    const view = dialog(`工作版 v${selected.number} · 历史内容`, true), notice = message(view.body);
    let restoreRequest, proposed;
    void transact(view, notice, async () => {
      const { version } = await actions.api(`/api/workspace-versions/read?number=${selected.number}`);
      const composition = version.content.composition;
      const foundation = composition.semantic ? await actions.api(`/api/artifacts/${encodeURIComponent(composition.semantic.id)}?version=${composition.semantic.version}`) : null;
      if (!view.isConnected) return;
      const definition = foundation?.content || {};
      view.body.append(el("p", `记录于 ${when(version.createdAt)} · ${composition.snapshots?.length || 0} 个固定快照 · ${composition.corrections?.length || 0} 项局部纠正 · ${composition.identityDecisions?.length || 0} 项身份决定`, "engine-muted"));
      view.body.append(table(definition.concepts || [], [["实体", item => item.name], ["说明", item => item.description]]));
      const names = new Map((definition.concepts || []).map(item => [item.id, item.name]));
      view.body.append(table(definition.relations || [], [["关系", item => item.name], ["起点", item => names.get(item.from) || item.from], ["终点", item => names.get(item.to) || item.to]]));
      view.body.append(action("提出恢复此工作版", () => transact(view, notice, async () => {
        if (proposed) { showChange(proposed, actions, load); notice.textContent = "已打开这份恢复变更。"; return; }
        if (!restoreRequest) {
          const { baseline } = await actions.api("/api/changes?limit=1");
          restoreRequest = { operationId: crypto.randomUUID(), origin: "human", type: "restore", baseline, subject: { workspaceVersionRef: ref(version) }, evidence: `用户选择恢复工作版 v${selected.number}` };
        }
        let response;
        try { response = await actions.api("/api/changes/propose", restoreRequest); }
        catch (error) { if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) restoreRequest = undefined; throw error; }
        proposed = response.change;
        notice.textContent = "恢复变更已提出，复验并采用后才会更新工作版。";
        showChange(proposed, actions, load);
      })));
      view.body.append(technicalDetails(version)); notice.textContent = "";
    });
  }
  void transact(d, output, load); return d;
}

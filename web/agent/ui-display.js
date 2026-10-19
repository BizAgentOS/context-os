const key = "ade.developer-view";
export function developerView() {
  try { return localStorage.getItem(key) === "true"; } catch { return false; }
}
export function setDeveloperView(enabled) {
  try { localStorage.setItem(key, String(enabled)); } catch {}
  document.documentElement.dataset.developerView = String(enabled);
}
const labels = {
  evidenceRefs: "依据", bindings: "数据对应", sourceHash: "内容校验", records: "业务记录",
  mappingStatus: "对应状态", origin: "依据类型", sourceId: "来源", capability: "数据范围",
  fields: "属性", supplements: "补充数据", fromField: "起点属性", toField: "终点属性",
  readAt: "读取时间", snapshotId: "数据版本", connectionVersion: "来源版本", coverage: "覆盖范围",
  complete: "完整", total: "总数", shown: "本次显示", offset: "起始位置", limit: "条数",
  count: "条数", partial: "局部结果", items: "结果", results: "查询结果", type: "对象类型",
  conceptId: "实体", modelId: "本体", modelVersion: "本体版本", foundationId: "本体", foundationVersion: "本体版本",
  readMode: "读取方式", versions: "版本", sources: "数据来源", dataAsOf: "数据截至",
};
export const fieldLabel = key => labels[key] || key;
const references = new Map();
const alias = value => { if (!references.has(value)) references.set(value, `记录 ${references.size + 1}`); return references.get(value); };
export function safeText(value) {
  const text = String(value ?? "");
  if (developerView()) return text;
  return text.replace(/(`{3,})json\s*\n([\s\S]*?)\n\1/gi, (_match, _fence, payload) => {
    try { return displayValue(JSON.parse(payload)); } catch { return "结果较长，请打开对应记录查看完整内容。"; }
  }).replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, alias)
    .replace(/\b(?:source|foundation|artifact|dataset|model|interpretation|program|consumer|mapping|read|evidence)_[A-Za-z0-9_-]{6,}\b/g, "对应内容")
    .replace(/\b(active_snapshot_with_live|release_pinned_with_live|active_snapshot|release_pinned|snapshotId|on_demand_not_atomic)\b/g, name => ({active_snapshot_with_live:"已采用快照与实时来源",release_pinned_with_live:"发布快照与实时来源",active_snapshot:"已采用快照",release_pinned:"发布快照",snapshotId:"数据版本",on_demand_not_atomic:"各来源读取时间不同"})[name])
    .replace(/\b(?:KodaX|SKILL\.md)\b/g, "助手方法")
    .replace(/\b(evidenceRefs|bindings|sourceHash|records|mappingStatus|origin)\b/g, name => labels[name]);
}
export function displayValue(value, depth = 0) {
  if (value === null || value === undefined) return "未提供";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value !== "object") return safeText(value);
  if (depth > 3) return "查看详细内容";
  if (Array.isArray(value)) return value.map(v => displayValue(v, depth + 1)).join("；") || "无";
  return Object.entries(value).filter(([name]) => !["id", "sourceId", "sourceHash", "snapshotId", "evidenceRefs", "bindings"].includes(name))
    .map(([name, v]) => `${fieldLabel(name)}：${displayValue(v, depth + 1)}`).join("；") || "已保存";
}
/** The payload remains available only through an explicit developer setting. */
export function technicalDetails(value) {
  const details = document.createElement("details");
  details.className = "technical-information";
  const summary = document.createElement("summary"); summary.textContent = "技术信息";
  const pre = document.createElement("pre"); pre.textContent = JSON.stringify(value, null, 2);
  details.append(summary, pre);
  return details;
}
if (typeof document !== "undefined") document.documentElement.dataset.developerView = String(developerView());

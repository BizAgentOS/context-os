import { element as el, action } from "./connection-ui.js";
export { el, action };
export const ref = value => ({id:value.id, version:value.version});
export const when = value => value ? new Date(value).toLocaleString("zh-CN", {hour12:false}) : "尚未读取";
export const statusLabels = {queued:"等待执行", running:"正在执行", completed:"已完成", failed:"失败", cancelled:"已取消", interrupted:"执行中断", candidate:"待检查", checked:"已检查", adopted:"已采用", ready:"通过", blocked:"需修复", active:"已启用", revoked:"已撤销", stopped:"已停止"};
export function dialog(title, wide=false) {
  const root=el("dialog",null,`engine-dialog live-dialog ${wide?"engine-dialog-wide":""}`);
  root.setAttribute("aria-label",title);
  const close=action("关闭",()=>{if(root.dataset.busy!=="true")root.close();});
  const head=el("header",null,"engine-dialog-head");head.append(el("h2",title),close);
  const body=el("div",null,"engine-dialog-body");root.append(head,body);root.body=body;
  root.addEventListener("cancel",event=>{if(root.dataset.busy==="true")event.preventDefault();});
  root.addEventListener("close",()=>root.remove(),{once:true});
  document.body.append(root);root.showModal();return root;
}
export function message(parent) {const n=el("p",null,"engine-message");n.setAttribute("role","status");parent.append(n);return n;}
export async function transact(root, output, task) {
  if(root.dataset.busy==="true")return;
  root.dataset.busy="true";root.setAttribute("aria-busy","true");
  const controls=[...root.querySelectorAll("button,input,textarea,select")];const states=controls.map(c=>c.disabled);controls.forEach(c=>c.disabled=true);
  output.textContent="正在处理…";
  try {await task();}catch(error){if(root.isConnected)output.textContent=error.message;}
  finally {root.dataset.busy="false";root.setAttribute("aria-busy","false");controls.forEach((c,i)=>c.disabled=states[i]);root.dispatchEvent(new Event("transactionend"));}
}
export function field(parent,title,value="",multiline=false) {
  const row=el("label",null,"engine-field"), input=el(multiline?"textarea":"input");
  input.value=value;input.autocomplete="off";row.append(el("span",title),input);parent.append(row);return input;
}
export function check(parent,title,description="",checked=false) {
  const row=el("label",null,"engine-check"),input=el("input");input.type="checkbox";input.checked=checked;
  const copy=el("span");copy.append(el("strong",title));if(description)copy.append(el("small",description));row.append(input,copy);parent.append(row);return input;
}
export function table(rows, columns) {
  const wrap=el("div",null,"engine-table"),t=el("table"),head=el("thead"),hr=el("tr");
  for(const [label] of columns)hr.append(el("th",label));head.append(hr);t.append(head);
  const body=el("tbody");for(const item of rows){const row=el("tr");for(const [,read] of columns){const value=read(item);row.append(el("td",value==null?"—":typeof value==="object"?JSON.stringify(value):String(value)));}body.append(row);}t.append(body);wrap.append(t);
  if(!rows.length)wrap.append(el("p","当前范围没有记录","engine-muted"));return wrap;
}
export function issues(parent,items=[],ask) {
  const list=el("div",null,"engine-issues");
  for(const item of items){const row=el("article",null,`engine-issue engine-issue-${item.severity||"warning"}`);row.append(el("span",item.severity==="error"?"需处理":item.severity==="info"?"说明":"需核对","engine-badge"),el("p",item.message));if(item.sourceId)row.append(el("small",`来源 ${item.sourceId}${item.capability?` · ${item.capability}`:""}`,"engine-muted"));if(ask)row.append(action("让助手分析",()=>{for(const d of document.querySelectorAll("dialog[open]"))d.close();ask(`请分析并协助修复这个问题：${item.message}${item.sourceId?`\n来源：${item.sourceId}`:""}`);}));list.append(row);}parent.append(list);return list;
}
export function diffTable(items=[],afterLabel="工作版本",names={}) {
  const labels={concepts:"概念",relations:"关系",sourceAccess:"来源存取策略",sourcePolicies:"来源范围",accessPolicy:"读取约定",enterprise:"企业信息",model:"执行映射",types:"对象类型",fields:"字段",name:"名称",description:"定义",sourceId:"数据来源",strategy:"存取方式",on_demand:"按需读取",uploaded_snapshot:"上传快照",facts:"业务数据",per_source_strategy:"按来源策略读取",consistency:"一致性",not_atomic:"不同来源分别读取",historicalReplay:"历史重放",snapshots:"数据快照",snapshot:"快照",pinned:"锁定快照版本",none:"未锁定",pinned_snapshot:"全部来源锁定快照",snapshot_and_on_demand:"快照与按需读取",snapshotId:"快照版本",datasetId:"数据集",fingerprint:"内容指纹",rows:"行数",syncedAt:"同步时间",capability:"能力",purpose:"用途",connections:"执行来源"};
  // Internal ids and hashes stay in the full change record; the table shows names, counts and times.
  const hidden=new Set(["datasetId","snapshotId","fingerprint","uploadRef","inputHash"]),time=v=>/^\d{4}-\d\d-\d\dT/.test(v)?new Date(v).toLocaleString("zh-CN",{hour12:false}):null;
  Object.assign(labels,{coverage:"来源覆盖",total:"来源总行数",complete:"覆盖完整"});
  const value=(v,key)=>v==null?"—":Array.isArray(v)?v.length?v.map(x=>value(x)).join("；"):"无":typeof v==="object"?v.name?`${v.name}${v.description?`：${v.description}`:""}`:Object.entries(v).filter(([k])=>!hidden.has(k)).map(([k,x])=>`${names[k]||labels[k]||k}：${value(x,k)}`).join("；"):typeof v==="boolean"?key==="complete"?(v?"是":"否"):v?"支持":"不支持":names[v]||labels[v]||time(String(v))||String(v);
  const wrap=el("div");wrap.append(table(items.filter(i=>!hidden.has(i.path.split("/").filter(Boolean).at(-1))),[["内容",i=>i.path.split("/").filter(Boolean).map(p=>names[p]||labels[p]||p).join(" / ")],["变化",i=>({added:"新增",removed:"删除",changed:"修改"}[i.kind]||i.kind)],["原版本",i=>value(i.before,i.path.split("/").at(-1))],[afterLabel,i=>value(i.after,i.path.split("/").at(-1))]]));
  if(items.length){const raw=el("details");raw.append(el("summary","完整变更记录"),el("pre",JSON.stringify(items,null,2),"engine-raw-diff"));wrap.append(raw);}return wrap;
}
export const statusOf = {added:"新增",removed:"删除",changed:"有变化",unchanged:"未变化",unavailable:"无法比较"};
/** Row-level data changes per pinned dataset, compared by source identity. */
export function dataDiffTable(datasets=[]) {
  const wrap=el("div");
  wrap.append(table(datasets,[["数据集",d=>d.name],["状态",d=>statusOf[d.status]||d.status],["原行数",d=>d.rowsBefore],["新行数",d=>d.rowsAfter],["新增",d=>d.added],["删除",d=>d.removed],["变更",d=>d.changed],
    ["示例编号",d=>(d.samples||[]).map(x=>`${statusOf[x.kind]||x.kind} ${x.k}`).join("、")||d.message||""]]));
  return wrap;
}
/** Full-snapshot check results: identity, fields, supplements, relations and merges. */
export function snapshotReport(parent,report) {
  if(!report?.checks?.length)return;
  const rows=[...report.checks].sort((a,b)=>Number(a.passed)-Number(b.passed)||(a.severity==="warning"?-1:1));
  parent.append(el("h3",report.coverage?.complete===true?"全量快照检查":"快照检查（仅可用范围）"),table(rows,[["检查",c=>c.name],["结果",c=>!c.passed?"未通过":c.severity==="warning"?"需留意":"通过"],["说明",c=>c.detail]]));
}
export function downloadConfig(parent,config,key="") {
  const area=el("textarea",null,"engine-config");area.readOnly=true;area.spellcheck=false;area.setAttribute("aria-label","接入配置");area.value=typeof config==="string"?config:JSON.stringify(config,null,2);parent.append(area);
  const notice=message(parent);parent.append(action("复制配置",async()=>{try{await navigator.clipboard.writeText(area.value);notice.textContent="已复制配置。";}catch{area.focus();area.select();notice.textContent="请复制已选中的配置。";}}));return area;
}

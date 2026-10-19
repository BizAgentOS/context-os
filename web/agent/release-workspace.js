import { updateRegion } from "./page-region.js";
import { renderHistoryAccess } from "./history-access.js";
import { el, action, ref, when, dialog, message, transact, field, check, table, issues, diffTable, downloadConfig, dataDiffTable } from "./engine-ui.js";

export function renderReleaseWorkspace(state, actions) {
  const root=el("section",null,"engine-workspace release-workspace");root.setAttribute("aria-label","发布与接入");
  let data,disposed=false,generation=0,historyAccess;root.dispose=()=>{disposed=true;generation++;historyAccess?.dispose();unsubscribe?.();};
  const refresh=()=>{if(disposed)actions.onChanged?.();else void load();};
  const rows=n=>n==null?"—":Number(n).toLocaleString("zh-CN");
  const snapshotTable=definition=>table(definition.snapshots||[],[["数据集",s=>data?.names?.[s.datasetId]||(s.capability==="records"?s.sourceId:`${s.sourceId} · ${s.capability}`)],["行数",s=>rows(s.rows)],["来源覆盖",s=>s.coverage?.complete===true?"完整":s.coverage?`不完整：${rows(s.coverage.rows)} / ${rows(s.coverage.total)} 行`:"未记录"],["同步时间",s=>when(s.syncedAt)]]);
  /** Loads row-level data changes into a container; query is the /api/releases/data-diff parameters. */
  async function showDataDiff(container,query=""){
    container.replaceChildren(el("p","正在比较数据快照…","engine-muted"));
    try{const result=await actions.api(`/api/releases/data-diff${query}`);if(!container.isConnected)return;
      const changed=result.datasets.filter(d=>d.status!=="unchanged");
      container.replaceChildren(el("p",result.from?`与 ${result.from.name} 相比：${changed.length?`${changed.length} 个数据集有变化`:"数据没有变化"}`:"首次发布：以下为锁定的数据快照。","engine-muted"),dataDiffTable(result.datasets));
    }catch(error){if(container.isConnected)container.replaceChildren(el("p",error.message,"engine-message"));}
  }
  function releaseName(release){return release?`${release.content.name||release.title} · #${release.content.sequence}`:"尚未发布";}
  function detail(release){const d=dialog(releaseName(release),true),c=release.content;d.body.append(el("p",`发布于 ${when(c.publishedAt)} · 本体 v${c.foundationRef.version}${c.modelRef?` · 映射 v${c.modelRef.version}`:""}`,"engine-muted"));if(c.notes)d.body.append(el("p",c.notes,"engine-release-notes"));d.body.append(el("h3","本次变更"),diffTable(c.diff||[],"本版本",data?.names),el("h3","已冻结定义"),table(c.definition.concepts||[],[["概念",i=>i.name],["业务定义",i=>i.description]]));
    if(c.definition.snapshots?.length)d.body.append(el("h3","锁定的数据快照"),snapshotTable(c.definition),el("p",c.definition.accessPolicy?.historicalReplay?"此版本的全部业务数据来自锁定快照，接入方读取结果不随来源更新而变化。":"部分来源设为实时读取，这部分数据按需读取，其余来自锁定快照。","engine-muted"));
    else d.body.append(el("p","此版本固定定义、映射及访问策略，未锁定数据快照；来源业务值按声明策略读取。","engine-muted"));}
  function publish(){
    const d=dialog("检查并发布工作版本",true);const storageKey=`ade-release-draft:${state.workspaceId}`;let draft={};try{draft=JSON.parse(localStorage.getItem(storageKey)||"{}");}catch{}
    const form=el("form"),name=field(form,"版本名称",draft.name||`v1.${data.releases.length}`),notes=field(form,"版本说明",draft.notes||"",true);name.required=true;name.maxLength=160;notes.maxLength=4000;
    const keep=()=>{try{localStorage.setItem(storageKey,JSON.stringify({name:name.value,notes:notes.value}));}catch{}};form.oninput=keep;
    const dataChanges=el("div");
    d.body.append(el("p","先检查当前工作版本。检查通过后，发布这份定义、映射和当前数据快照；已有接入方继续读取原版本锁定的数据。","engine-muted"),el("h3","定义变化"),diffTable(data.working.diff,"工作版本",data.names),el("h3","数据变化"),dataChanges,form);void showDataDiff(dataChanges);
    const checked=el("div"),output=message(d.body);d.body.append(checked);let receipt=null,operationId=crypto.randomUUID(),fingerprint="";
    const runCheck=action("检查发布条件",()=>transact(d,output,async()=>{receipt=null;receipt=await actions.api("/api/releases/check",{inputHash:data.working.inputHash});if(!d.isConnected)return;checked.replaceChildren();issues(checked,receipt.content.issues,actions.ask);output.textContent=receipt.status==="ready"?"检查通过，可发布当前工作版本。":"当前存在阻塞问题，请修复后重新检查。";submit.disabled=receipt.status!=="ready";}));
    const submit=action("发布新版本",()=>{if(!form.reportValidity())return;void transact(d,output,async()=>{const next=JSON.stringify([receipt?.id,receipt?.version,name.value,notes.value]);if(next!==fingerprint){operationId=crypto.randomUUID();fingerprint=next;}const result=await actions.api("/api/releases/publish",{operationId,checkRef:ref(receipt),name:name.value,notes:notes.value});try{localStorage.removeItem(storageKey);}catch{}d.close();refresh();detail(result.release);});},"engine-primary");submit.disabled=true;d.addEventListener("transactionend",()=>submit.disabled=receipt?.status!=="ready");
    const row=el("div",null,"engine-actions");row.append(runCheck,submit);d.body.append(row);form.onsubmit=e=>e.preventDefault();
  }
  async function configuration(connection,initialKey="") {
    const d=dialog("接入配置",true),output=message(d.body);d.addEventListener("close",()=>{initialKey="";for(const input of d.querySelectorAll("input,textarea"))input.value="";});
    const key=field(d.body,initialKey?"新接入密钥 · 仅本次显示，请保存":"接入密钥 · 填入签发时保存的密钥",initialKey);key.type="password";initialKey="";key.spellcheck=false;
    const keyControls=el("div",null,"engine-actions");keyControls.append(action("显示 / 隐藏密钥",()=>key.type=key.type==="password"?"text":"password"),action("复制密钥",async()=>{if(!key.value)return;try{await navigator.clipboard.writeText(key.value);output.textContent="已复制密钥。";}catch{key.type="text";key.focus();key.select();output.textContent="请复制已选中的密钥。";}}));d.body.append(keyControls);
    async function loadConfig(){
      try{const result=await actions.api(`/api/releases/connection?id=${encodeURIComponent(connection.id)}&version=${connection.version}`);if(!d.isConnected)return;
        d.body.append(el("p",`${connection.title} → ${releaseName(result.release)} · ${result.localOnly?"本机接入":"服务接入"}`,"engine-muted"));
        const placeholder=result.mcp;const box=el("div"),area=downloadConfig(box,placeholder);d.body.append(box);
        const materialize=()=>{const config=structuredClone(placeholder);for(const entry of Object.values(config.mcpServers||{})){if(entry.env)entry.env.DATAENGINE_CONSUMER_KEY=key.value.trim();}return config;};
        const full=action("填入密钥生成完整配置",()=>{if(!key.value.trim()){output.textContent="请先填写接入密钥。";key.focus();return;}area.value=JSON.stringify(materialize(),null,2);output.textContent="配置已包含密钥，请仅提供给获准的接入方。";});d.body.append(full);
        d.body.append(el("h3","开放能力"),el("p",(result.tools||[]).map(t=>typeof t==="string"?t:t.name).join(" · "),"engine-muted"),el("p",connection.content.agentEnabled?"允许委托 ADE 助手执行授权范围内的只读任务。":"仅开放确定性的本体与数据读取。","engine-muted"),el("p","ADE 服务需要持续运行。密钥不在浏览器持久保存；升级会撤销旧密钥并签发新密钥。","engine-muted"));
        if(result.dataset){const test=action("测试本机 MCP",()=>transact(d,output,async()=>{if(!key.value.trim())throw Error("请先填写接入密钥。");const checked=await actions.api("/api/datasets/test",{id:result.dataset.id,key:key.value.trim()});output.textContent=`本机 MCP 测试通过 · ${when(checked.checkedAt)}。这不代表其他 Agent 已完成配置。`;}));d.body.append(test);}
      }catch(e){output.textContent=e.message;d.body.append(action("重新读取配置",()=>void loadConfig()));}
    }void loadConfig();
  }
  function connect(release){
    const d=dialog("创建接入方",true),def=release.content.definition,form=el("form");d.body.append(el("p",`绑定 ${releaseName(release)}，明确选择此接入方可使用的范围。`,"engine-muted"),form);
    const name=field(form,"接入方名称");name.required=true;name.maxLength=160;name.placeholder="例如：投研助手";
    const concepts=new Map(),relations=new Map(),grants=[];form.append(el("h3","开放的本体范围"));
    for(const c of def.concepts||[])concepts.set(c.id,check(form,c.name,c.description));
    const names=new Map((def.concepts||[]).map(c=>[c.id,c.name]));if(def.relations?.length)form.append(el("h3","开放的关系"));
    for(const r of def.relations||[])relations.set(r.id,check(form,r.name,`${names.get(r.from)} → ${names.get(r.to)}`));
    for(const type of def.model?.types||[]){const group=el("details",null,"engine-panel");group.append(el("summary",`${type.name} · 业务数据范围`));const enabled=check(group,`开放 ${type.name} 记录`);const fields=["$id",...new Set([Object.keys(type.fields||{}),...(type.supplements||[]).map(s=>Object.keys(s.fields||{}))].flat().filter(f=>f!=="$id"))].map(n=>({name:n,input:check(group,n==="$id"?"对象身份（必选）":n,"",n==="$id"),evidence:n==="$id"?null:check(group,`开放 ${n} 的来源依据`)}));const rels=(def.model.relations||[]).filter(r=>r.from===type.name).map(r=>({name:r.name,input:check(group,`对象关系 · ${r.name}`)}));grants.push({type,enabled,fields,relations:rels});form.append(group);}
    form.append(el("h3","Agent 委托"));const agent=check(form,"允许委托 ADE 助手","第三方可提交只读分析任务、查询进度与结果。任务受此接入方范围约束。");
    const output=message(d.body),submit=action("创建接入并签发密钥",()=>{if(!form.reportValidity())return;void transact(d,output,async()=>{
      const selectedGrants=grants.filter(g=>g.enabled.checked).map(g=>({type:g.type.name,fields:g.fields.filter(f=>f.input.checked).map(f=>f.name),relations:g.relations.filter(r=>r.input.checked).map(r=>r.name),evidence:{fields:g.fields.filter(f=>f.evidence?.checked).map(f=>f.name),relations:[]}}));
      const body={name:name.value,releaseRef:ref(release),conceptIds:[...concepts].filter(([,i])=>i.checked).map(([id])=>id),relationIds:[...relations].filter(([,i])=>i.checked).map(([id])=>id),...(selectedGrants.length?{business:{grants:selectedGrants}}:{}),agentEnabled:agent.checked};const next=JSON.stringify(body);if(next!==fingerprint){operationId=crypto.randomUUID();fingerprint=next;}
      const result=await actions.api("/api/releases/connect",{operationId,...body});d.close();refresh();void configuration(result.connection,result.key||"");
    });},"engine-primary");let operationId=crypto.randomUUID(),fingerprint="";
    function update(){const chosen=[...concepts].filter(([,i])=>i.checked).map(([id])=>id);for(const r of def.relations||[]){const input=relations.get(r.id);input.disabled=!chosen.includes(r.from)||!chosen.includes(r.to);if(input.disabled)input.checked=false;}for(const g of grants){g.enabled.disabled=!chosen.includes(g.type.conceptId);if(g.enabled.disabled)g.enabled.checked=false;for(const f of g.fields){f.input.disabled=!g.enabled.checked||f.name==="$id";if(f.evidence){f.evidence.disabled=!g.enabled.checked||!f.input.checked;if(f.evidence.disabled)f.evidence.checked=false;}}for(const r of g.relations){r.input.disabled=!g.enabled.checked;if(r.input.disabled)r.input.checked=false;}}submit.disabled=!chosen.length;}form.onchange=update;form.onsubmit=e=>e.preventDefault();update();d.body.append(submit);
  }
  function upgrade(connection){
    const choices=data.releases.filter(r=>r.id!==connection.content.releaseRef.id);if(!choices.length)return;
    const d=dialog("升级接入版本",true),select=el("select");select.setAttribute("aria-label","目标发布版本");
    for(const r of choices){const option=el("option",releaseName(r));option.value=r.id;select.append(option);}
    d.body.append(el("p","保留此接入方原有授权范围。目标版本缺少原有内容时，服务会阻止升级；成功后旧密钥立即失效，需向接入方更新配置。","engine-muted"),select);
    const preview=el("div"),output=message(d.body);d.body.append(preview);
    let operationId=crypto.randomUUID(),targetId=select.value,comparison=0,comparedTarget=null;
    const submit=action("升级并签发新密钥",()=>transact(d,output,async()=>{
      if(comparedTarget!==select.value)throw Error("请等待当前版本差异读取完成。");
      if(targetId!==select.value){operationId=crypto.randomUUID();targetId=select.value;}
      const result=await actions.api("/api/releases/upgrade",{operationId,connectionRef:ref(connection),releaseRef:ref(choices.find(r=>r.id===select.value))});
      d.close();refresh();void configuration(result.connection,result.key||"");
    }),"engine-primary");d.body.append(submit);
    const show=async()=>{
      const request=++comparison,target=choices.find(r=>r.id===select.value),from=connection.content.releaseRef;
      comparedTarget=null;submit.disabled=true;preview.replaceChildren(el("p","正在比较当前绑定版本与目标版本…","engine-muted"));
      try {
        const result=await actions.api(`/api/releases/compare?fromId=${encodeURIComponent(from.id)}&fromVersion=${from.version}&toId=${encodeURIComponent(target.id)}&toVersion=${target.version}`);
        if(!d.isConnected||request!==comparison)return;
        const dataChanges=el("div");preview.replaceChildren(el("p",`${result.from.name} → ${result.to.name}`,"engine-muted"),diffTable(result.diff,"目标版本",result.names),el("h3","数据变化"),dataChanges);comparedTarget=target.id;submit.disabled=false;
        void showDataDiff(dataChanges,`?fromId=${encodeURIComponent(from.id)}&fromVersion=${from.version}&toId=${encodeURIComponent(target.id)}&toVersion=${target.version}`);
      }catch(error){if(d.isConnected&&request===comparison)preview.replaceChildren(el("p",error.message,"engine-message"),action("重新读取差异",()=>void show()));}
    };
    select.onchange=()=>void show();d.addEventListener("close",()=>comparison++);void show();
  }
  function revoke(connection){const d=dialog("撤销接入"),output=message(d.body),operationId=crypto.randomUUID();d.body.append(el("p",`撤销“${connection.title}”后，此接入方无法继续读取或委托任务。发布版本与本体保留。`,"engine-muted"),action("撤销此接入",()=>transact(d,output,async()=>{await actions.api("/api/releases/revoke",{operationId,connectionRef:ref(connection)});d.close();refresh();}),"engine-primary"));}
  function render(){
    const view=el("section",null,root.className);view.setAttribute("aria-label",root.getAttribute("aria-label"));const head=el("header",null,"engine-page-head"),copy=el("div");copy.append(el("h1","发布与接入"),el("p","将检查好的数据底座发布成版本，让外部 Agent 稳定接入。","engine-lead"));head.append(copy,action("返回本体修订",actions.ontology));view.append(head);
    if(!data){view.append(el("p","正在读取工作版本和发布记录…","engine-muted"));updateRegion(root,view);return;}
    const grid=el("div",null,"release-overview"),current=el("section",null,"engine-panel"),working=el("section",null,"engine-panel");
    current.append(el("p","当前发布","engine-eyebrow"),el("h2",releaseName(data.currentRelease)));
    if(data.currentRelease){const c=data.currentRelease.content;current.append(el("p",`${c.definition.concepts.length} 个概念 · ${c.definition.relations.length} 条关系 · ${when(c.publishedAt)}`,"engine-muted"),el("p",c.notes||(c.definition.snapshots?.length?`此版本锁定了 ${c.definition.snapshots.length} 个数据快照，接入方读取结果稳定。`:"此版本固定本体定义和映射，业务值按策略读取。"),"engine-release-notes"));const row=el("div",null,"engine-actions");row.append(action("查看版本",()=>detail(data.currentRelease)),action("＋ 创建接入方",()=>connect(data.currentRelease),"engine-primary"));current.append(row);}else current.append(el("p","完成本体构建和修订后，检查并发布第一个版本。没有发布版本时，第三方无法通过新的发布入口接入。","engine-muted"),action(data.working.foundationRef?"检查并发布":"前往本体",data.working.foundationRef?publish:actions.ontology,data.working.foundationRef?"engine-primary":""));
    const w=data.working;working.append(el("p","工作版本","engine-eyebrow"),el("h2",w.foundationRef?`${w.diff.length} 项待发布变更`:"尚无可发布本体"),el("p",`${w.summary.concepts} 个概念 · ${w.summary.relations} 条关系 · ${w.summary.types} 项映射 · ${state.sourceSummary?.total ?? 0} 个已接入来源（${w.summary.sources} 个参与工作版）${w.summary.snapshots?` · ${w.summary.snapshots} 个数据快照（${rows(w.summary.rows)} 行）`:""}`,"engine-muted"));
    if(w.pending.length)working.append(el("p",`${w.pending.length} 项候选或治理事项待处理`,"engine-badge"));issues(working,w.issues.slice(0,3),actions.ask);const row=el("div",null,"engine-actions");row.append(action("查看全部差异",()=>{const d=dialog("工作版本与当前发布的差异",true),dataChanges=el("div");d.body.append(el("h3","定义变化"),diffTable(w.diff,"工作版本",data.names),el("h3","数据变化"),dataChanges);void showDataDiff(dataChanges);issues(d.body,w.issues,actions.ask);if(w.pending.length)d.body.append(table(w.pending,[["待处理项",i=>i.title],["状态",i=>i.status]]));}),action("检查并发布",publish,"engine-primary"));working.append(row);grid.append(current,working);view.append(grid);
    const connections=el("section",null,"release-connections");connections.append(el("h2",`接入方 · ${data.connections.length}`));if(!data.connections.length)connections.append(el("p","发布版本后，为每个接入方选择范围并生成独立配置。","engine-empty"));
    for(const c of data.connections){const card=el("article",null,"engine-panel release-connection"),bound=data.releases.find(r=>r.id===c.content.releaseRef.id),top=el("header");top.append(el("h3",c.title),el("span",(c.effectiveStatus||c.status)==="active"?"已启用":"已撤销","engine-badge"));card.append(top,el("p",`绑定 ${releaseName(bound)} · ${c.content.conceptIds.length} 个概念 · ${c.content.agentEnabled?"允许 Agent 委托":"只读查询"}`,"engine-muted"));const controls=el("div",null,"engine-actions");if((c.effectiveStatus||c.status)==="active"){controls.append(action("接入配置",()=>void configuration(c),"engine-primary"));if(data.releases.some(r=>r.id!==c.content.releaseRef.id))controls.append(action("切换版本",()=>upgrade(c)));controls.append(action("撤销接入",()=>revoke(c)));}card.append(controls);connections.append(card);}view.append(connections);
    const history=el("section",null,"release-history");history.append(el("h2",`版本历史 · ${data.releases.length}`));for(const r of data.releases){const entry=el("div",null,"release-history-row");entry.append(el("strong",releaseName(r)),el("span",when(r.content.publishedAt),"engine-muted"),action("查看差异与定义",()=>detail(r)));history.append(entry);}if(!data.releases.length)history.append(el("p","尚无发布记录。","engine-muted"));view.append(history);
    const footer=el("footer",null,"engine-page-footer");footer.append(action("刷新状态",()=>void load()));view.append(footer);historyAccess?.dispose();historyAccess=renderHistoryAccess(state,{api:actions.api,onChanged:refresh});historyAccess.dataset.regionKey=`history-${generation}`;view.append(historyAccess);

    updateRegion(root,view);
}
  async function load(){const request=++generation;try{const next=await actions.api("/api/releases");if(disposed||request!==generation)return;data=next;render();}catch(error){if(!disposed&&request===generation){root.replaceChildren(el("h1","发布与接入"),el("p",error.message,"engine-message"),action("重试读取",()=>void load()));}}}
  const unsubscribe=actions.events?.subscribe("release",()=>void load());
  root.updateWorkspace=()=>true;
  render();void load();return root;
}

import { showDatabaseConnection } from "./database-connection.js";
import { showSyncSettings } from "./sync-settings.js";
import { updateRegion } from "./page-region.js";
import { el, action, ref, when, statusLabels, dialog, message, transact, table, issues, snapshotReport } from "./engine-ui.js";
import { openApiImport } from "./openapi-import.js";
import { openConnections } from "./connections.js";
import { showChanges } from "./changes-workspace.js";
import { technicalDetails } from "./ui-display.js";

export function openSource(kind, actions) {
  if(kind==="file")actions.upload();
  else if(kind==="database")showDatabaseConnection(actions,{onChanged:actions.refresh});
  else if(kind==="api")openApiImport({api:actions.api,onSaved:actions.apply,ask:actions.ask});
  else openConnections(actions.api,undefined,{service:"custom",onChanged:actions.refresh,onPrepared:actions.apply});
}
export function sourceChooser(actions) {
  const d=dialog("接入数据来源");
  d.body.append(el("p","选择接入方式，在数据页配置读取范围。助手可以协助理解文档与处理接入问题。","engine-muted"));
  const list=el("div",null,"engine-source-choices");
  for(const [id,title,description] of [["database","数据库","连接 MySQL / PostgreSQL 只读账号，选择需要同步的表"],["mcp","MCP 服务","连接已有服务，发现并选择允许读取的能力"],["api","HTTP API","导入 OpenAPI 文档，配置认证并测试样本"],["file","上传文件","CSV / Excel 表格或 Markdown / TXT 资料"]]){
    const b=action(title,()=>{d.close();openSource(id,actions);},"engine-choice");b.append(el("small",description));list.append(b);
  }d.body.append(list);
}
function datasetDetails(dataset) {
  const c=dataset.content,d=dialog(`${c.name||dataset.title} · 字段与样本`,true);
  d.body.append(el("p",`${c.strategy==="uploaded_snapshot"?"上传文件快照":"来源按需读取"} · ${when(c.readAt)} · 已检查 ${c.sampleCount??0} 条${c.complete?" · 当前读取完整":" · 有界样本，不能代表全部记录"}`,"engine-muted"));
  d.body.append(table(c.fields||[],[["字段",f=>f.name],["类型",f=>f.type],["不同值",f=>f.distinct],["空值",f=>f.nulls],["样本中唯一",f=>f.unique?"是":"否"]]));
  if(c.sample?.length){d.body.append(el("h3","实际读取的样本"),table(c.sample,Object.keys(c.sample[0]).map(key=>[key,row=>row[key]])));}
}
const rows = n => n==null?"—":Number(n).toLocaleString("zh-CN");
/** One synced dataset: profile, versions, read policy and a pending schema change waiting for the user. */
function snapshotDetails(dataset, actions, changed) {
  const c=dataset.content,d=dialog(`${c.name} · 数据快照`,true),output=message(d.body);
  const live=c.materialization==="live";
  d.body.append(el("p",live?"实时读取：不生成新快照，查询时读取来源。保留的历史快照仍可查看。":`已同步 ${rows(c.profile?.rows)} 行 · ${when(c.lastSync)} · 保留 ${c.versions.length} 个版本${c.coverage?.complete!==true?` · 来源覆盖不完整，来源总量 ${rows(c.coverage?.total)} 行`:""}`,"engine-muted"));
  if(c.pendingVersion){
    const quality=(c.pendingReasons||[]).some(reason=>reason.code!=='schema_drift');
    const panel=el("section",null,"engine-panel");panel.append(el("h3",quality?"新数据需要核对":"字段结构有变化，待确认"),el("p","确认前，本体构建和已发布接入继续使用当前版本；待确认数据不会自动替换当前快照。","engine-muted"));if(c.pendingChanges?.length)panel.append(table(c.pendingChanges,[["字段",x=>x.column],["变化",x=>x.before==null?"新增":x.after==null?"删除":"类型变化"],["当前版本",x=>x.before??"—"],["新版本",x=>x.after??"—"]]));
    if(quality)for(const reason of c.pendingReasons||[])panel.append(el('p',reason.message));
    const preview=action("预览新版本",()=>transact(d,output,async()=>{const r=await actions.api(`/api/data/preview?datasetId=${encodeURIComponent(dataset.id)}&snapshotId=${encodeURIComponent(c.pendingVersion)}&limit=20`);if(!d.isConnected)return;panel.append(table(r.rows,r.rows.length?Object.keys(r.rows[0]).map(k=>[k,row=>row[k]]):[]));output.textContent=`新版本共 ${rows(r.total)} 行。`;}));
    const accept=quality?action('处理数据问题',()=>{d.close();requestPending({category:'data_issue'});}):action("确认并使用新结构",()=>transact(d,output,async()=>{await actions.api("/api/data/accept",{...ref(dataset),operationId:crypto.randomUUID()});d.close();changed();}),"engine-primary");
    const row=el("div",null,"engine-actions");row.append(preview,accept);panel.append(row);d.body.append(panel);
  }
  d.body.append(el("h3",c.coverage?.complete===true?"字段画像（全量）":"字段画像（已保存范围）"),table(c.profile?.columns||[],[["字段",f=>f.name],["类型",f=>f.type],["不同值",f=>rows(f.distinct)],["空值",f=>rows(f.nulls)],["唯一非空",f=>f.primaryKey?"是":"否"],["可能敏感",f=>f.sensitive?"是":""]]));
  const controls=el("div",null,"engine-actions");
  if(c.activeVersion)controls.append(action("预览当前数据",()=>transact(d,output,async()=>{const r=await actions.api(`/api/data/preview?datasetId=${encodeURIComponent(dataset.id)}&limit=20`);if(!d.isConnected)return;d.body.append(el("h3",`当前版本前 ${r.rows.length} 行`),table(r.rows,r.rows.length?Object.keys(r.rows[0]).map(k=>[k,row=>row[k]]):[]));output.textContent=`当前版本共 ${rows(r.total)} 行。`;})));
  const policy=el("div",null,"engine-actions");policy.append(action(live?"改为同步快照":"改为实时读取",()=>transact(d,output,async()=>{await actions.api("/api/data/policy",{...ref(dataset),materialization:live?"snapshot":"live"});d.close();changed();})));
  d.body.append(controls,el("h3","读取设置"),policy,el("p","快照是同步时的不可变数据版本，发布会锁定当时的版本；被发布引用的版本不会被清理。","engine-muted"));
}
export function renderEngineWorkspace(state, actions) {
  const root=el("section",null,"engine-workspace");root.setAttribute("aria-label","数据工作区");let disposed=false,data=state.engine||null,snap=state.data||null,request=0;
  const snapshotsOf=sourceId=>(snap?.datasets||[]).filter(d=>d.content.sourceId===sourceId);
  async function sync(sourceId) {
    const d=dialog("同步数据快照");d.body.append(el("p",sourceId?"读取此来源并保存快照；达到容量上限时标明不完整。内容和覆盖范围均未变时不新增版本；字段结构变化会等待你确认。":"读取全部结构化来源并保存快照；达到容量上限时标明不完整。已发布的接入继续使用它们锁定的版本。","engine-muted"));
    const output=message(d.body),id=crypto.randomUUID();
    d.body.append(action("开始同步",()=>transact(d,output,async()=>{await actions.api("/api/data/sync",{operationId:id,...(sourceId?{sourceIds:[sourceId]}:{})});d.close();await load();}),"engine-primary"));
  }
  root.dispose=()=>{disposed=true;request++;unsubscribe?.();};
  const sourceActions={...actions,refresh:()=>actions.refresh()};
  async function build(sourceId) {
    const d=dialog(sourceId?"读取来源并检查":"构建本体");d.body.append(el("p",sourceId?"先同步此来源的快照，再在已保存范围识别身份、合并与关联，形成本体候选。覆盖不完整时会提示；现有定义和映射保持可核对。":"先同步全部结构化来源的快照，再在已保存范围识别身份、跨来源合并与关联，生成本体候选。覆盖不完整时会提示；已有人工修订会保留。","engine-muted"));
    const output=message(d.body),id=crypto.randomUUID();
    const run=action("同步并构建",()=>transact(d,output,async()=>{await actions.api("/api/engine/build",{operationId:id,...(sourceId?{sourceIds:[sourceId]}:{})});d.close();await actions.refresh();actions.ontology();}),"engine-primary");d.body.append(run);
  }
  function sourceDetail(source,isFile,summary) {
    const d=dialog(summary.connectionTitle ? `${summary.connectionTitle} · ${summary.title}` : source.title,true),c=source.content,sets=(data?.datasets||[]).filter(s=>s.content.sourceId===source.id);
    const snapshots=snapshotsOf(source.id).filter(set=>!summary.capability||set.content.capability===summary.capability);
    d.body.append(el("p",`${c.origin==="feishu"?"飞书文档":isFile?"上传文件":c.adapter==="database"?({postgres:"PostgreSQL",mysql:"MySQL"}[c.protocol]||"数据库"):c.protocol==="mcp"?"MCP":"HTTP API"} · ${source.status==="ready"?"可读取":source.status} · ${summary.category!=="table"?"按许可读取资料内容":snapshots.length?`${snapshots.length} 个数据集已同步快照`:"尚未同步快照"}`,"engine-muted"));
    if(c.parseError)d.body.append(el("p",c.parseError,"engine-message"));
    if(summary.problems?.length){const problems=el('section',null,'engine-panel');problems.append(el('h3','需要处理的问题'));for(const issue of summary.problems)problems.append(el('p',issue.reasons.map(reason=>reason.message).join('；')),action('处理这个数据问题',()=>{d.close();requestPending(issue);}));d.body.append(problems);}
    const sample=el('section',null,'engine-panel'),sampleOutput=message(sample);sample.append(el('h3','字段与样本'));d.body.append(sample);
    const sampleQuery=snapshots.find(set=>set.content.activeVersion);
    if(summary.category==='table'&&(sampleQuery||isFile)){
      const path=sampleQuery?`/api/data/preview?datasetId=${encodeURIComponent(sampleQuery.id)}&limit=3`:`/api/sources/rows?id=${encodeURIComponent(source.id)}&version=${source.version}&offset=0&limit=3`;
      void actions.api(path).then(result=>{if(!d.isConnected)return;const records=result.rows||result.content?.rows||result.items||[];sampleOutput.textContent=`${sampleQuery?'当前已采用快照':'已保存文件'} · 显示 ${records.length} 条样本，共 ${result.total??result.content?.total??'未知'} 条`;sample.append(table(records,records.length?Object.keys(records[0]).map(key=>[key,row=>row[key]]):[]));}).catch(error=>{if(sampleOutput.isConnected)sampleOutput.textContent=error.message;});
    }else if(summary.category!=='table')sample.remove();else sampleOutput.textContent='尚无已同步快照；可在下方读取来源样本。';
    if(isFile && actions.fileDetails)d.body.append(action("查看内容与解析参数",()=>{d.close();actions.fileDetails(source);}));
    if(isFile)d.body.append(el("p","文件内容保存在 ADE。上传新版本后重新检查结构；Markdown / TXT 的业务含义可由助手辅助提取。","engine-muted"));
    else d.body.append(el("p","记录能力同步为 ADE 内的不可变快照，本体构建与发布基于已保存范围；来源覆盖不完整时会提示。知识片段和指标仍按需读取。","engine-muted"));
    if(snapshots.length){d.body.append(el("h3","数据快照"));for(const set of snapshots){const c2=set.content;d.body.append(action(`${c2.name} · ${c2.materialization==="live"?"实时读取":`${rows(c2.profile?.rows)} 行 · ${when(c2.lastSync)}`}${c2.pendingVersion?" · 结构变化待确认":""}`,()=>{d.close();snapshotDetails(set,actions,()=>void load());},"engine-dataset-link"));}}
    if(c.adapter==="database")d.body.append(action("选择接入的表",()=>{d.close();showDatabaseConnection(actions,{id:source.id,onChanged:actions.refresh});}));
    for(const cap of (c.capabilities||[]).filter(cap=>!summary.capability||cap.name===summary.capability)){
      const panel=el("section",null,"engine-panel");panel.append(el("h3",cap.name),el("p",cap.fields?.join(" · ")||cap.metricId||cap.contentKind||"可用能力","engine-muted"));
      if(source.status==="ready"&&cap.contentKind!=="knowledge"&&cap.contentKind!=="metrics"){
        const output=message(panel);panel.append(action("读取 3 条样本",()=>transact(panel,output,async()=>{
          const result=await actions.api("/api/live/read",{sourceId:source.id,capability:cap.name,limit:3});
          if(!d.isConnected)return;
          const sample=dialog(`${cap.name} · 当前来源样本`,true);sample.body.append(el("p",`读取于 ${(result.reads||[]).map(r=>when(r.readAt)).join(" / ")||when(result.provenance?.readAt)} · 显示 ${result.coverage?.shown??result.items.length} 条${result.coverage?.complete?" · 当前结果完整":" · 仅本次样本"}`,"engine-muted"),table(result.items,result.items.length?Object.keys(result.items[0]).map(key=>[key,row=>row[key]]):[]));output.textContent="已读取样本。";
        })));
      }d.body.append(panel);
    }
    if(sets.length){d.body.append(el("h3","最近一次构建读取"));for(const set of sets)d.body.append(action(`${set.content.name||set.title} · ${set.content.fields.length} 个字段 · ${when(set.content.readAt)}`,()=>datasetDetails(set),"engine-dataset-link"));}
    else if(!snapshots.length)d.body.append(el("p",summary.category==="document"?"资料已保存，可用于补充实体说明与依据。":summary.category==="metric"?"指标按许可范围读取定义与观测值。":"尚未同步或构建。连接成功不代表数据已被检查。","engine-muted"));
    const controls=el("div",null,"engine-actions");if(source.status==="ready"&&(isFile?c.format==="csv":c.capabilities?.some(cap=>!cap.contentKind||cap.contentKind==="records"))){controls.append(action("同步快照",()=>{d.close();void sync(source.id);}),action("同步并构建",()=>{d.close();void build(source.id);},"engine-primary"));}
    if(summary.category==='table')controls.append(action('同步与质量设置',()=>{d.close();void showSyncSettings(source,actions);}));
    controls.append(action("让助手协助",()=>{d.close();actions.ask(`请协助检查来源“${source.title}”（${source.id}）的接入、字段与读取问题。`);}));d.body.append(controls,technicalDetails({sourceId:source.id,sourceVersion:source.version}));
  }
  function render() {
    const view=el("section",null,root.className);view.setAttribute("aria-label",root.getAttribute("aria-label"));
    if (actions.initialize) view.append(action("继续初始化", actions.initialize, "ob-reopen"));
    const head=el("header",null,"engine-page-head"),copy=el("div");copy.append(el("h1","数据"),el("p","接入来源，检查可用内容，为本体准备可信的数据。","engine-lead"));
    const controls=el("div",null,"engine-actions");controls.append(action("＋ 接入来源",()=>sourceChooser(sourceActions),"engine-primary"),action("同步数据",()=>void sync()),action("前往本体 →",actions.ontology));head.append(copy,controls);view.append(head);
    const sources=(state.sourceSummary?.sources||[]).map(summary=>({s:[...(state.sources||[]),...(state.live?.connections||[])].find(s=>s.id===(summary.sourceId??summary.id)),file:summary.file,summary})).filter(item=>item.s);
    const stats=el("div",null,"engine-stats");const pending=(snap?.datasets||[]).filter(d=>d.content.pendingVersion).length,running=[...(data?.jobs||[]),...(snap?.jobs||[])].filter(j=>["queued","running"].includes(j.status)).length;
    for(const [count,label] of [[state.sourceSummary?.total ?? 0,"已接入来源"],[(snap?.datasets||[]).length,"已同步数据集"],[pending,"结构变化待确认"],[running,"进行中任务"]]){const item=el("div");item.append(el("strong",String(count)),el("span",label));stats.append(item);}view.append(stats);
    const section=el("section",null,"engine-source-list");section.append(el("h2","已接入来源"));
    if(!sources.length){const empty=el("div",null,"engine-empty");empty.append(el("h2","从第一份数据开始"),el("p","接入 MCP、API 或文件，随后检查字段、样本与读取状态。","engine-muted"),action("选择接入方式",()=>sourceChooser(sourceActions),"engine-primary"),action("让助手帮助接入",()=>actions.ask("请协助我确定数据接入方式，并指导我配置来源。")));section.append(empty);}
    const list=el("div",null,"engine-source-groups"),groups=new Map();
    for(const [category,label]of [['table','表格数据'],['document','文档资料'],['metric','指标']]){const group=el('section'),grid=el('div',null,'engine-source-grid');group.append(el('h3',label),grid);list.append(group);groups.set(category,{group,grid});}
    for(const {s,file,summary} of sources){const sets=(data?.datasets||[]).filter(set=>set.content.sourceId===s.id),card=el("article",null,"engine-panel engine-source-card"),top=el("header");top.append(el("span",({table:"表格",document:"文档",metric:"指标"})[summary.category],"engine-eyebrow"),el("span",summary.status!=='ready'?'需要处理':summary.entityRefs?.length?'已进入本体':'可用',"engine-badge"));const snaps=snapshotsOf(s.id).filter(set=>!summary.capability||set.content.capability===summary.capability),total=snaps.reduce((n,x)=>n+(x.content.profile?.rows||0),0),drift=snaps.some(x=>x.content.pendingVersion);
      if(drift)top.append(el("span","结构变化待确认","engine-badge"));
      card.append(top,el("h3",summary.connectionTitle ? `${summary.connectionTitle} · ${summary.title}` : s.title),el("p",`${summary.size.value==null?"规模尚未读取":`${rows(summary.size.value)} ${summary.size.unit}`} · ${{active_snapshot:"已同步快照",uploaded_file:"已保存文件",live:"实时读取",on_demand:"按需读取",not_synced:"尚未同步"}[summary.readMode]} · 数据截至 ${when(summary.dataAsOf)}`,"engine-muted"));const capabilities=(s.content.capabilities||[]).filter(cap=>!summary.capability||cap.name===summary.capability),fields=capabilities.reduce((sum,c)=>sum+(c.fields?.length||0),0);card.append(el("p",summary.category==="document"?"已保存资料 · 可补充本体说明与依据":summary.category==="metric"?"按许可读取指标定义与观测":snaps.length?`${capabilities.length||1} 项能力 · ${snaps.filter(x=>x.content.materialization==="live").length?"含实时读取数据集":"全部同步为快照"}`:sets.length?`${sets.length} 项数据检查 · 最近 ${when(sets[0].content.readAt)}`:file?`已保存文件 · ${s.content.parseError?"内容需修正":"同步后可构建本体"}`:`${capabilities.length} 项能力${fields?` · ${fields} 个声明字段`:""} · 同步后可构建本体`,"engine-source-state"));if(summary.entityRefs?.length)card.append(el('p',`对应实体：${summary.entityRefs.map(entity=>entity.name).join('、')}`,'engine-muted'));
      const detail=action('查看字段与样本',()=>sourceDetail(s,file,summary),'quiet-button');card.querySelector('h3').append(detail);
      const label=summary.status!=='ready'?'查看问题':summary.category!=='table'?'查看资料':summary.entityRefs?.length?'立即同步':'接入并构建';
      card.append(action(label,()=>summary.status!=='ready'||summary.category!=='table'?sourceDetail(s,file,summary):summary.entityRefs?.length?void sync(s.id):void build(s.id),'engine-primary'));
      groups.get(summary.category).grid.append(card);
    }
    for(const {group,grid}of groups.values())if(!grid.children.length)group.remove();section.append(list);view.append(section);
    const syncJob=snap?.jobs?.[0];if(syncJob){const row=el("div",null,"engine-task-summary");row.append(el("div",`最近同步 · ${statusLabels[syncJob.status]||syncJob.status}${syncJob.content.issues?.length?` · ${syncJob.content.issues.length} 项提示`:""}`));if(syncJob.content.issues?.length)row.append(action("查看提示",()=>{const d=dialog("同步提示",true);issues(d.body,syncJob.content.issues,actions.ask);}));view.append(row);}
    if(data?.jobs?.length){const latest=data.jobs[0],row=el("div",null,"engine-task-summary");row.append(el("div",`最近构建 · ${statusLabels[latest.status]||latest.status}`),action("查看任务与结果",()=>showEngineBuilds(state,{...actions,initial:data})));view.append(row);}
    const footer=el("footer",null,"engine-page-footer");footer.append(action("管理已有连接与企业资料",actions.advanced),action("刷新状态",()=>void load()),el("span","结构化记录同步为不可变快照；设为实时读取的数据集按需读取","engine-muted"));view.append(footer);

    updateRegion(root,view);
}
  async function load(){const id=++request;try{const [next,snapshots,summary]=await Promise.all([actions.api("/api/engine"),actions.api("/api/data"),actions.api("/api/sources/summary")]);if(disposed||id!==request)return;data=next;snap=snapshots;state.sourceSummary=summary;render();
    }catch(e){if(!disposed){const output=message(root);output.textContent=`数据状态不可用：${e.message}`;}}}
  root.updateWorkspace = next => { data=next.engine||data; snap=next.data||snap; render(); return true; };
  const unsubscribe=actions.events?.subscribe("data",()=>root.updateWorkspace(state));
  render();if(!data||!snap)void load();return root;
}

export function showEngineBuilds(state, actions) {
  const d=dialog("本体构建与修订",true);let generation=0,data=actions.initial||state.engine,closed=false,buildId=crypto.randomUUID();
  d.addEventListener("close",()=>{closed=true;generation++;unsubscribe?.();});
  const output=message(d.body),host=el("div");d.body.append(host);
  async function load(){const id=++generation;try{const next=await actions.api("/api/engine");if(closed||id!==generation)return;data=next;render();}catch(e){if(!closed)output.textContent=e.message;}}
  async function change(path,input){const result=await actions.api(`/api/engine/${path}`,input);await load();await actions.refresh();return result;}
  function render(){
    host.replaceChildren();const controls=el("div",null,"engine-actions");const start=action("从数据构建本体",()=>transact(d,output,async()=>{await change("build",{operationId:buildId});buildId=crypto.randomUUID();output.textContent="任务已保存，可以关闭窗口或切换页面。";}),"engine-primary");start.disabled=data?.jobs?.some(j=>["queued","running"].includes(j.status));controls.append(start,action("变更记录",()=>showChanges(actions)),action("刷新状态",()=>void load()));if(actions.management)controls.append(action("查看定义与映射",()=>{d.close();actions.management();}));host.append(el("p","程序同步快照，在已保存范围识别身份、跨来源合并与关联，生成候选并检查。来源覆盖不完整时会提示；已保存的定义与修订继续保留，检查通过后才可采用。","engine-muted"),controls);
    const candidate=data?.candidate;
    if(candidate){const c=candidate.content,panel=el("section",null,"engine-panel");panel.append(el("h3",`本体候选 · ${statusLabels[candidate.status]||candidate.status}`),el("p",`${c.concepts?.length||0} 个概念 · ${c.relations?.length||0} 条关系 · ${c.types?.length||0} 项执行映射`,"engine-muted"));
      const changeCounts=Object.entries(c.diff||{}).map(([k,v])=>`${({addedConcepts:"新增概念",preservedConcepts:"保留概念",addedMappings:"新增映射",preservedMappings:"保留映射",addedSupplements:"新增合并来源",addedRelations:"新增关系"})[k]||k} ${Array.isArray(v)?v.length:v}`).join(" · ");panel.append(el("p",changeCounts,"engine-muted"));
      const found=c.discovery;
      if(found){
        panel.append(el("p",found.summary,"engine-release-notes"));
        const names=new Map((found.entities||[]).map(e=>[e.id,e.name]));
        const merged=el("details");merged.open=true;merged.append(el("summary","识别出的实体与关联"),
          table(found.entities||[],[["实体",e=>e.name],["身份字段",e=>e.key],["记录数",e=>rows(e.rows)],["主来源",e=>e.members[0]?.datasetName],["合并来源",e=>e.members.slice(1).map(m=>`${m.datasetName}（${rows(m.matched)}/${rows(m.rows)} 匹配，按 ${m.via?.column}）`).join("；")||"—"],["类型",e=>e.kind==="activity"?"事件流":"记录"]]),
          table(found.links||[],[["关联",l=>`${names.get(l.from)} → ${names.get(l.to)}`],["名称",l=>l.name],["字段",l=>`${l.fromColumn} → ${l.toColumn}`],["匹配",l=>`${rows(l.matchedRows)}/${rows(l.totalRows)}`],["依据",l=>({declared:"来源声明",name:"字段名",values:"值重合"})[l.evidence]||l.evidence]]));
        if(found.notes?.length)merged.append(el("ul",null,"engine-notes"));for(const n of found.notes||[])merged.lastChild.append(el("li",n.text));
        panel.append(merged);
      }
      const details=el("details");details.append(el("summary","查看候选定义与数据覆盖"),table(c.concepts||[],[["概念",i=>i.name],["定义",i=>i.description]]),table(c.coverage||[],[["来源",i=>i.sourceId],["能力",i=>i.capability],["读取行",i=>rows(i.sampledRows)],["来源总行数",i=>rows(i.totalRows)],["覆盖",i=>i.snapshotId?(i.complete?"完整快照":"快照达到行数上限"):i.complete?"本次完整":"有界样本"],["读取时间",i=>when(i.readAt)]]));panel.append(details);issues(panel,c.issues,actions.ask);
      if(c.checks?.description){const result=el("p",`${c.checks.valid?"检查通过":"尚未通过检查"}：${c.checks.description}`,c.checks.valid?"engine-muted":"engine-message");result.setAttribute("role","status");panel.append(result);snapshotReport(panel,c.checks.snapshot);if(!c.checks.valid)panel.append(action("让助手协助修复",()=>{d.close();actions.ask(`请协助修复本体候选 ${candidate.id} v${candidate.version} 的检查问题：${c.checks.description}`);}));}
      const row=el("div",null,"engine-actions");if(candidate.status!=="adopted"){
        row.append(action("检查候选",()=>transact(d,output,async()=>{const checked=await change("check",ref(candidate));output.textContent=checked.content.checks?.valid?"候选检查通过，可以采用到工作版本。":`候选检查未通过：${checked.content.checks?.description||"请查看候选问题。"}`;})));
        row.append(action("到待处理核对候选",()=>{d.close();requestPending({ownerId:candidate.id});},"engine-primary"));
      }else row.append(el("span","已进入工作版本，可继续修订并检查发布。","engine-muted"));panel.append(row,technicalDetails(candidate));host.append(panel);
    }
    const jobs=data?.jobs||[];host.append(el("h3","持久构建记录"));if(!jobs.length)host.append(el("p","尚无构建任务。没有来源时会如实返回待接入，不生成占位本体。","engine-muted"));
    for(const job of jobs){const c=job.content,details=el("details",null,"engine-job");details.open=["running","queued","failed","interrupted"].includes(job.status);details.append(el("summary",`${job.title||"程序构建"} · ${statusLabels[job.status]||job.status} · ${when(c.startedAt||job.createdAt)}`));for(const step of c.steps||[]){const row=el("div",null,"engine-step");row.append(el("strong",step.label),el("span",statusLabels[step.status]||step.status),el("small",step.message||""));details.append(row);}issues(details,c.issues,actions.ask);if(c.outcome==="empty")details.append(el("p","没有可构建的结构化数据，请先接入来源。","engine-muted"));if(["queued","running"].includes(job.status))details.append(action("取消任务",()=>transact(d,output,()=>change("cancel",ref(job)))));host.append(details);}
  }
  const unsubscribe=actions.events?.subscribe("data",()=>{data=state.engine;render();});
  if(data)render();void load();return d;
}
import { requestPending } from "./pending-center.js";

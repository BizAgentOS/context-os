import { technicalDetails } from "./ui-display.js";
import { updateRegion } from "./page-region.js";
import { requestPending } from "./pending-center.js";
import { renderHistoryAccess } from "./history-access.js";
import { el, action, ref, when, dialog, message, transact, field, check, table, issues, downloadConfig } from "./engine-ui.js";

export function renderReleaseWorkspace(state, actions) {
  const root=el("section",null,"engine-workspace release-workspace");root.setAttribute("aria-label","发布与接入");
  let data,disposed=false,generation=0,historyAccess;root.dispose=()=>{disposed=true;generation++;historyAccess?.dispose();unsubscribe?.();};
  const refresh=()=>{if(disposed)actions.onChanged?.();else void load();};
  const mayManage=()=>!!state.demo||state.actor?.role==='admin';
  const managementAction=(title,callback,style)=>{const control=action(title,callback,style);control.hidden=!mayManage();control.disabled=!mayManage();return control;};
  const rows=n=>n==null?"—":Number(n).toLocaleString("zh-CN");
  const snapshotTable=definition=>table(definition.snapshots||[],[["数据集",s=>data?.names?.[s.datasetId]||(s.capability==="records"?s.sourceId:`${s.sourceId} · ${s.capability}`)],["行数",s=>rows(s.rows)],["来源覆盖",s=>s.coverage?.complete===true?"完整":s.coverage?`不完整：${rows(s.coverage.rows)} / ${rows(s.coverage.total)} 行`:"未记录"],["同步时间",s=>when(s.syncedAt)]]);
  const valueText=value=>value==null?"—":Array.isArray(value)?value.map(valueText).join("、"):typeof value==="object"?JSON.stringify(value):String(value);
  function objectChanges(items){
    const container=el("div");if(!items?.length){container.append(el("p","本体对象没有变化。","engine-muted"));return container;}
    const definitions=[data?.working?.definition,...(data?.releases||[]).map(item=>item.content.definition)].filter(Boolean),semanticNames=new Map(definitions.flatMap(definition=>[...(definition.concepts||[]),...(definition.properties||[]),...(definition.relations||[]),...(definition.model?.layered?.semantic?.properties||[])]).map(item=>[item.id,item.name]));
    const labels={from:"起点",to:"终点",identityKeys:"身份属性",dataset:"数据来源",transform:"转换",targetIds:"目标记录",fromColumns:"起点字段",toColumns:"目标字段",name:"名称",aliases:"别名",description:"说明",kind:"对象种类",valueType:"值类型",unit:"单位",enumValues:"枚举范围",isIdentity:"身份属性",cardinality:"数量约束",allowSelf:"允许自关联",column:"来源字段",value:"纠正值",decision:"身份决定",reason:"原因",definition:"指标口径",dimensions:"维度对应",access:"来源能力"};
    const display=(value,key)=>{if(value==null)return "—";if(["from","to"].includes(key))return semanticNames.get(value)||"原定义中的对象";if(key==="identityKeys")return value.map(id=>semanticNames.get(id)||"原定义中的属性").join("、");if(key==="dataset")return `${data?.names?.[value.sourceId]||"数据来源"} · ${value.capability||"记录"}`;
      if(key==='definition'){const aggregation=value.aggregation;return `口径 ${value.revision}；${value.description}；单位 ${value.unit}；${value.grain==='month'?'每月':'每日'}；时区 ${value.timeZone}；${({sum:'求和',ratio:'比率',average:'平均',distinct_count:'去重计数',snapshot:'时点存量'})[aggregation.kind]}；${aggregation.timeAdditive?'可跨期间加总':'不可跨期间直接加总'}；可加总维度：${aggregation.additiveDimensions.map(name=>value.dimensions.find(item=>item.name===name)?.label||name).join('、')||'无'}`;}
      if(key==='dimensions')return value.map(item=>`${item.dimension} → ${semanticNames.get(item.propertyId)||'原定义中的属性'}`).join('；')||'无';
      if(key==='access')return({query:'查询观测',historical_observations:'历史观测',definition_only:'仅定义'})[value]||'未记录';return valueText(value);};
    for(const item of items){const entry=el("details",null,"engine-panel");entry.append(el("summary",`${{added:"新增",modified:"修改",deprecated:"弃用"}[item.change]||"变化"} · ${item.name} · ${item.summary}`));
      const fields=Object.keys(labels).filter(key=>item.before?.[key]!==undefined||item.after?.[key]!==undefined);
      entry.append(table(fields,[["内容",key=>labels[key]],["之前",key=>display(item.before?.[key],key)],["之后",key=>display(item.after?.[key],key)]]),technicalDetails(item));container.append(entry);
    }return container;
  }
  function dataChanges(datasets){
    const container=el("div");if(!datasets.length)container.append(el("p","没有可比较的托管快照；实时来源不声称有历史行差异。","engine-muted"));
    for(const dataset of datasets){const detail=el("details",null,"engine-panel");detail.append(el("summary",`${dataset.name} · ${rows(dataset.rowsBefore)} → ${rows(dataset.rowsAfter)} 行 · ${{added:"新增来源",removed:"移除来源",unchanged:"无变化",changed:"数据有变化",unavailable:"暂无法比较"}[dataset.status]||dataset.status}`));
      if(dataset.message)detail.append(el("p",dataset.message,"engine-message"));
      if(dataset.added!=null)detail.append(el("p",`新增 ${rows(dataset.added)} · 删除 ${rows(dataset.removed)} · 修改 ${rows(dataset.changed)}`,"engine-muted"));
      for(const row of dataset.samples||[]){const record=el("details");record.append(el("summary",`${{added:"新增",removed:"删除",changed:"修改"}[row.kind]} · ${row.k}`));const columns=[...new Set([...Object.keys(row.before||{}),...Object.keys(row.after||{})])];record.append(table(columns,[["字段",key=>key],["之前",key=>valueText(row.before?.[key])],["之后",key=>valueText(row.after?.[key])]]));detail.append(record);}
      if(dataset.samples?.length)detail.append(el("p","每类最多展示 5 条实际记录；上方数量来自完整快照比较。","engine-muted"));detail.append(technicalDetails(dataset));container.append(detail);
    }return container;
  }
  async function showDataDiff(container,query="",expectedHash){
    const request=Symbol();container.releaseRequest=request;container.replaceChildren(el("p","正在比较数据快照…","engine-muted"));
    try{const result=await actions.api(`/api/releases/data-diff${query}`);if(!container.isConnected||container.releaseRequest!==request)return;
      if(expectedHash&&result.toInputHash!==expectedHash)throw Error("工作版本已变化，请关闭并重新查看差异。");
      const changed=result.datasets.filter(d=>d.status!=="unchanged");container.replaceChildren(el("p",result.from?`与 ${result.from.name} 相比：${changed.length?`${changed.length} 个数据集有变化`:"数据没有变化"}`:"首次发布：以下为锁定的数据快照。","engine-muted"),dataChanges(result.datasets));
    }catch(error){if(container.isConnected&&container.releaseRequest===request)container.replaceChildren(el("p",error.message,"engine-message"));}
  }
  function releaseName(release){return release?`${release.content.name||release.title}`:"尚未发布";}
  function detail(release){const d=dialog(releaseName(release),true),c=release.content;d.body.append(el("p",`发布于 ${when(c.publishedAt)}`,"engine-muted"));d.body.append(technicalDetails({foundationRef:c.foundationRef,modelRef:c.modelRef,workspaceVersion:c.workspaceVersion}));if(c.notes)d.body.append(el("p",c.notes,"engine-release-notes"));d.body.append(el("h3","本次变更"),objectChanges(c.objectDiff||[]),el("h3","已冻结定义"),table(c.definition.concepts||[],[["概念",i=>i.name],["业务定义",i=>i.description]]));
    if(c.definition.snapshots?.length)d.body.append(el("h3","锁定的数据快照"),snapshotTable(c.definition),el("p",c.definition.accessPolicy?.historicalReplay?"此版本的全部业务数据来自锁定快照，接入方读取结果不随来源更新而变化。":"部分来源设为实时读取，这部分数据按需读取，其余来自锁定快照。","engine-muted"));
    else d.body.append(el("p","此版本固定定义、映射及访问策略，未锁定数据快照；来源业务值按声明策略读取。","engine-muted"));}
  function publish(){
    if(!mayManage())return;
    const working=structuredClone(data.working);
    const d=dialog("检查并发布工作版本",true);const storageKey=`ade-release-draft:${state.workspaceId}`;let draft={};try{draft=JSON.parse(localStorage.getItem(storageKey)||"{}");}catch{}
    const form=el("form"),name=field(form,"版本名称",draft.name||`v1.${data.releases.length}`),notes=field(form,"版本说明",draft.notes||"",true);name.required=true;name.maxLength=160;notes.maxLength=4000;
    const keep=()=>{try{localStorage.setItem(storageKey,JSON.stringify({name:name.value,notes:notes.value}));}catch{}};form.oninput=keep;
    const notices=el("section",null,"engine-panel");
    if(working.pending.length){
      notices.append(el("h3","本次不包含的待采用事项"),el("p",`以下 ${working.pending.length} 项尚未采用，不包含在此次发布中，也不会单独阻止发布。此次只发布打开弹窗时已采用的工作版本。`,"engine-muted"),table(working.pending,[["事项",item=>item.title],["状态",item=>({proposed:"待复验",verified:"已复验，待采用",failed:"复验未通过",candidate:"待确认",checked:"已检查，待采用",queued:"排队中",running:"执行中"}[item.status]||"尚未采用")]]));
    }
    if(working.dataIssues?.length){
      notices.append(el("h3","发布前必须处理的数据问题"),el("p","这些来源的数据问题尚未确认，会阻止发布。请在统一待处理中选择接受新数据，或说明继续使用旧快照的理由；处理后重新打开发布检查。","engine-muted"));
      for(const item of working.dataIssues)notices.append(action(`处理：${item.title}`,()=>{keep();d.close();requestPending({id:item.id,version:item.version});}));
    }
    if(working.unresolvedSemantic?.length)notices.append(el("h3","发布说明将保留的未决事项"),el("p","这些已采用定义中的未知或冲突仍未裁决。发布时会自动写入版本说明，提醒接入方核对业务含义。","engine-muted"),table(working.unresolvedSemantic,[["类别",item=>item.kind==="conflict"?"未裁决冲突":"待确认定义"],["说明",item=>item.description||"尚未确认"]]));
    if(notices.childNodes.length)d.body.append(notices);
    const dataChanges=el("div");
    d.body.append(el("p","先检查当前工作版本。检查通过后，发布这份定义、映射和当前数据快照；已有接入方继续读取原版本锁定的数据。","engine-muted"),el("h3","定义变化"),objectChanges(working.objectDiff),el("h3","数据变化"),dataChanges,form);void showDataDiff(dataChanges,"",working.inputHash);
    form.append(action("请 Agent 起草版本说明",()=>{keep();d.close();actions.askBuild?.(`请根据已采用工作版起草发布说明，说明变更、限制和未决事项，等待我审阅。对象变化：${working.objectDiff.map(item=>`${item.name}：${item.summary}`).join("；")||"无本体对象变化"}。`);}));
    const checked=el("div"),output=message(d.body);d.body.append(checked);let receipt=null,operationId=crypto.randomUUID(),fingerprint="";
    const runCheck=action("检查发布条件",()=>transact(d,output,async()=>{receipt=null;receipt=await actions.api("/api/releases/check",{inputHash:working.inputHash});if(!d.isConnected)return;checked.replaceChildren();issues(checked,receipt.content.issues,actions.askBuild);output.textContent=receipt.status==="ready"?"检查通过，可发布当前工作版本。":"当前存在阻塞问题，请修复后重新检查。";submit.disabled=receipt.status!=="ready";}));
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
        d.body.append(el("h3","HTTP 接入"),el("p",`地址：${result.http?.baseUrl||""} · 使用 Bearer 密钥认证；查询参数遵循下列合同。`,"engine-muted"),table(result.http?.endpoints||[],[["方法",item=>item.method],["接口",item=>item.path],["用途",item=>item.description]]),technicalDetails(result.http||{}));
        const placeholder=result.mcp;const box=el("div"),area=downloadConfig(box,placeholder);d.body.append(box);
        const materialize=()=>{const config=structuredClone(placeholder);for(const entry of Object.values(config.mcpServers||{})){if(entry.env)entry.env.DATAENGINE_CONSUMER_KEY=key.value.trim();}return config;};
        const full=action("填入密钥生成完整配置",()=>{if(!key.value.trim()){output.textContent="请先填写接入密钥。";key.focus();return;}area.value=JSON.stringify(materialize(),null,2);output.textContent="配置已包含密钥，请仅提供给获准的接入方。";});d.body.append(full);
        d.body.append(el("h3","开放能力"),el("p",(result.tools||[]).map(t=>typeof t==="string"?t:t.name).join(" · "),"engine-muted"),el("p",connection.content.agentEnabled?"允许委托 ADE 助手执行授权范围内的只读任务。":"仅开放确定性的本体与数据读取。","engine-muted"),el("p","ADE 服务需要持续运行。密钥不在浏览器持久保存；升级会撤销旧密钥并签发新密钥。","engine-muted"));
        if(result.dataset){const test=action("测试本机 MCP",()=>transact(d,output,async()=>{if(!key.value.trim())throw Error("请先填写接入密钥。");const checked=await actions.api("/api/datasets/test",{id:result.dataset.id,key:key.value.trim()});output.textContent=`本机 MCP 测试通过 · ${when(checked.checkedAt)}。${checked.query?`已实际读取「${checked.query.type}」${checked.query.rows} 条记录。`:"此接入未授权业务记录，仅测试本体目录。"} ${checked.scope}`;}));d.body.append(test);}
      }catch(e){output.textContent=e.message;d.body.append(action("重新读取配置",()=>void loadConfig()));}
    }void loadConfig();
  }
  function connect(initialRelease){
    if(!mayManage())return;
    const releases=structuredClone(data.releases),d=dialog("新建接入方",true),form=el("form"),progress=el("p",null,"engine-muted");d.body.append(progress,form);
    const panels=Array.from({length:4},()=>el("section"));form.append(...panels);let step=0,release=releases.find(item=>item.id===initialRelease.id)||releases[0];
    const name=field(panels[0],"接入方名称"),purpose=field(panels[0],"用途","",true);name.required=true;name.maxLength=160;purpose.required=true;purpose.maxLength=1000;name.placeholder="例如：投研助手";
    panels[1].append(el("p","固定选择一个已经发布的版本；后续升级需要重新检查影响。","engine-muted"));const choice=el("select");choice.setAttribute("aria-label","接入发布版本");for(const item of releases){const option=el("option",`${releaseName(item)} · ${when(item.content.publishedAt)}`);option.value=item.id;choice.append(option);}choice.value=release.id;panels[1].append(choice);
    let concepts,relations,grants,metrics;
    const buildScope=()=>{panels[2].replaceChildren();concepts=new Map();relations=new Map();metrics=new Map();grants=[];const def=release.content.definition;
      panels[2].append(el("p","勾选开放的实体。所选业务对象的属性默认全选，可逐项取消；来源依据单独授权。","engine-muted"));
      for(const entity of def.concepts||[]){const group=el("section",null,"engine-panel"),selected=check(group,entity.name,entity.description);concepts.set(entity.id,selected);const type=(def.model?.types||[]).find(item=>item.conceptId===entity.id);
        if(type){const enabled=check(group,`开放 ${entity.name} 业务记录`,"关闭后只提供本体知识",true),fields=["$id",...new Set([Object.keys(type.fields||{}),...(type.supplements||[]).map(item=>Object.keys(item.fields||{}))].flat().filter(value=>value!=="$id"))].map(value=>({name:value,input:check(group,value==="$id"?"对象身份（必选）":value,"",true),evidence:value==="$id"?null:check(group,`开放 ${value} 的来源依据`)}));grants.push({type,enabled,fields});}
        for(const metric of(def.metricReferences||[]).filter(item=>item.entityTypeId===entity.id)){const dimensionNames=metric.dimensions.map(mapping=>(def.properties||[]).find(item=>item.id===mapping.propertyId)?.name||(def.model?.layered?.semantic?.properties||[]).find(item=>item.id===mapping.propertyId)?.name||mapping.propertyId),input=check(group,`开放指标：${metric.name}`,`独立开放指标定义与观测，不开放对象记录。包括维度：${dimensionNames.join('、')||'无'}；口径 ${metric.definition.revision}，${metric.definition.unit}。`);metrics.set(metric.id,{input,entityTypeId:entity.id});}
        panels[2].append(group);
      }
      if(def.relations?.length)panels[2].append(el("h3","关系与关系依据"));
      for(const relation of def.relations||[]){const from=def.concepts.find(item=>item.id===relation.from),to=def.concepts.find(item=>item.id===relation.to),input=check(panels[2],relation.name,`${from?.name} → ${to?.name}；两端实体和关联字段需要同时开放`),evidence=check(panels[2],`开放 ${relation.name} 的来源依据`);relations.set(relation.id,{definition:relation,input,evidence});}
      updateScope();
    };
    function updateScope(){const selected=new Set([...concepts].filter(([,input])=>input.checked).map(([id])=>id));
      for(const metric of metrics.values()){metric.input.disabled=!selected.has(metric.entityTypeId);if(metric.input.disabled)metric.input.checked=false;}
      for(const grant of grants){grant.enabled.disabled=!selected.has(grant.type.conceptId);for(const field of grant.fields){field.input.disabled=grant.enabled.disabled||!grant.enabled.checked||field.name==="$id";if(field.evidence){field.evidence.disabled=grant.enabled.disabled||!grant.enabled.checked||!field.input.checked;if(field.evidence.disabled)field.evidence.checked=false;}}}
      for(const row of relations.values()){const relation=row.definition,mapped=release.content.definition.model?.relations?.find(item=>item.relationId===relation.id),from=grants.find(item=>item.type.conceptId===relation.from),to=grants.find(item=>item.type.conceptId===relation.to),business=from&&!from.enabled.disabled&&from.enabled.checked;
        const fieldsReady=!business||mapped&&to&&!to.enabled.disabled&&to.enabled.checked&&from.fields.some(item=>item.name===mapped.fromField&&item.input.checked)&&to.fields.some(item=>item.name===mapped.toField&&item.input.checked);
        row.input.disabled=!selected.has(relation.from)||!selected.has(relation.to)||!fieldsReady;if(row.input.disabled)row.input.checked=false;row.evidence.disabled=!row.input.checked||!business;if(row.evidence.disabled)row.evidence.checked=false;
      }
    }
    panels[3].append(el("h3","是否开放只读 Agent 委托"));const agent=check(panels[3],"允许委托 ADE 助手","第三方可以提交本接入范围内的只读分析任务。默认关闭。");
    const output=message(d.body),controls=el("div",null,"engine-actions"),back=action("上一步",()=>show(step-1)),next=action("下一步",()=>{if(step===0&&(!name.reportValidity()||!purpose.reportValidity()))return;if(step===2&&![...concepts.values()].some(input=>input.checked)){output.textContent="请至少开放一个实体。";return;}show(step+1);}),submit=action("创建并签发密钥",()=>{void transact(d,output,async()=>{
      const selectedGrants=grants.filter(grant=>concepts.get(grant.type.conceptId)?.checked&&grant.enabled.checked).map(grant=>{const selectedRelations=[...relations.values()].filter(row=>row.input.checked&&row.definition.from===grant.type.conceptId);return{type:grant.type.name,fields:grant.fields.filter(field=>field.input.checked).map(field=>field.name),relations:selectedRelations.map(row=>row.definition.name),evidence:{fields:grant.fields.filter(field=>field.evidence?.checked).map(field=>field.name),relations:selectedRelations.filter(row=>row.evidence.checked).map(row=>row.definition.name)}};});
      const body={name:name.value,purpose:purpose.value,releaseRef:ref(release),conceptIds:[...concepts].filter(([,input])=>input.checked).map(([id])=>id),relationIds:[...relations].filter(([,row])=>row.input.checked).map(([id])=>id),metricIds:[...metrics].filter(([,row])=>row.input.checked).map(([id])=>id),...(selectedGrants.length?{business:{grants:selectedGrants}}:{}),agentEnabled:agent.checked};const signature=JSON.stringify(body);if(signature!==fingerprint){operationId=crypto.randomUUID();fingerprint=signature;}const result=await actions.api("/api/releases/connect",{operationId,...body});d.close();refresh();void configuration(result.connection,result.key||"");
    });},"engine-primary");let operationId=crypto.randomUUID(),fingerprint="";
    controls.append(back,next,submit);d.body.append(controls);function show(value){step=value;panels.forEach((panel,index)=>panel.hidden=index!==step);progress.textContent=`${step+1} / 4 · ${["名称和用途","发布版本","开放范围","委托与确认"][step]}`;back.hidden=step===0;next.hidden=step===3;submit.hidden=step!==3;output.textContent="";}
    choice.onchange=()=>{release=releases.find(item=>item.id===choice.value);buildScope();};panels[2].onchange=updateScope;form.onsubmit=event=>event.preventDefault();buildScope();show(0);
  }
  function upgrade(connection){
    if(!mayManage())return;
    const choices=data.releases.filter(r=>r.id!==connection.content.releaseRef.id);if(!choices.length)return;
    const d=dialog("升级接入版本",true),select=el("select");select.setAttribute("aria-label","目标发布版本");
    for(const r of choices){const option=el("option",releaseName(r));option.value=r.id;select.append(option);}
    d.body.append(el("p","保留此接入方原有授权范围。目标版本缺少原有内容时，服务会阻止升级；成功后旧密钥立即失效，需向接入方更新配置。","engine-muted"),select);
    const preview=el("div"),output=message(d.body);d.body.append(preview);
    let operationId=crypto.randomUUID(),targetId=select.value,comparison=0,comparedTarget=null,compatible=false;
    const submit=action("升级并签发新密钥",()=>transact(d,output,async()=>{
      if(!compatible||comparedTarget!==select.value)throw Error("请等待当前版本差异读取完成。");
      if(targetId!==select.value){operationId=crypto.randomUUID();targetId=select.value;}
      const result=await actions.api("/api/releases/upgrade",{operationId,connectionRef:ref(connection),releaseRef:ref(choices.find(r=>r.id===select.value))});
      d.close();refresh();void configuration(result.connection,result.key||"");
    }),"engine-primary");d.body.append(submit);
    const show=async()=>{
      const request=++comparison,target=choices.find(r=>r.id===select.value),from=connection.content.releaseRef;
      comparedTarget=null;compatible=false;submit.disabled=true;preview.replaceChildren(el("p","正在比较当前绑定版本与目标版本…","engine-muted"));
      try {
        const result=await actions.api(`/api/releases/upgrade-preview?connectionId=${encodeURIComponent(connection.id)}&connectionVersion=${connection.version}&releaseId=${encodeURIComponent(target.id)}&releaseVersion=${target.version}`);
        if(!d.isConnected||request!==comparison)return;
        const dataChanges=el("div");preview.replaceChildren(el("p",`${result.from.name} → ${result.to.name}`,"engine-muted"),el("h3","原授权范围受到的影响"),objectChanges(result.affected),el("h3","数据变化"),dataChanges);comparedTarget=target.id;compatible=result.compatible;submit.disabled=!compatible;for(const blocker of result.blockers||[])preview.append(el("p",blocker,"engine-message"));
        void showDataDiff(dataChanges,`?fromId=${encodeURIComponent(from.id)}&fromVersion=${from.version}&toId=${encodeURIComponent(target.id)}&toVersion=${target.version}`);
      }catch(error){if(d.isConnected&&request===comparison)preview.replaceChildren(el("p",error.message,"engine-message"),action("重新读取差异",()=>void show()));}
    };
    select.onchange=()=>void show();d.addEventListener("transactionend",()=>submit.disabled=!compatible||comparedTarget!==select.value);d.addEventListener("close",()=>comparison++);void show();
  }
  async function connectionDetail(connection){
    const d=dialog(connection.title,true),output=message(d.body);
    try{const result=await actions.api(`/api/releases/connection-detail?id=${encodeURIComponent(connection.id)}&version=${connection.version}`);if(!d.isConnected)return;
      const c=result.connection,scope=result.scope,names=new Map(scope.entities.map(item=>[item.id,item.name])),active=c.effectiveStatus==="active";
      d.body.append(el("p",`${releaseName(result.release)} · ${active?"已启用":"已撤销"}`,"engine-muted"),el("p",c.content.purpose||"未记录用途"),el("h3","开放范围"),table(scope.entities,[["实体",item=>item.name],["业务记录",item=>scope.grants.some(grant=>grant.entityTypeId===item.id)?"开放":"仅本体知识"]]),table(scope.properties,[["属性",item=>`${names.get(item.entityTypeId)} · ${item.name}`],["来源依据",item=>scope.evidence.some(grant=>grant.propertyIds.includes(item.id))?"开放":"未开放"]]),table(scope.relations,[["关系",item=>item.name],["两端",item=>`${names.get(item.from)} → ${names.get(item.to)}`],["关系依据",item=>scope.evidence.some(grant=>grant.relationIds.includes(item.id))?"开放":"未开放"]]));
      if(scope.metrics?.length)d.body.append(el('h3','开放指标'),table(scope.metrics,[['指标',item=>item.name],['口径版本',item=>item.definition.revision],['维度',item=>item.dimensions.map(mapping=>scope.properties.find(property=>property.id===mapping.propertyId)?.name||mapping.propertyId).join('、')||'无'],['能力',item=>({query:'查询观测',historical_observations:'历史观测',definition_only:'仅定义'})[item.access]]]),el('p','指标及其维度独立授权；这不开放对象记录，也不承诺旧口径可重算。','engine-muted'));
      const usage=result.usage;d.body.append(el("h3","当前接入版本调用"),el("p",`${usage.calls} 次调用 · 成功 ${usage.succeeded} · 失败 ${usage.failed} · 最近读取 ${when(usage.lastReadAt)}`,"engine-muted"));
      if(usage.recentErrors.length)d.body.append(el("h3","最近错误"),table(usage.recentErrors,[["时间",item=>when(item.at)],["接口",item=>item.path],["错误",item=>item.message]]));else d.body.append(el("p","没有记录到错误。","engine-muted"));
      d.body.append(technicalDetails(result));if(active){const row=el("div",null,"engine-actions");row.append(action("以此接入方试问",()=>{d.close();actions.askConsumer?.({releaseRef:ref(result.release),connectionRef:ref(c),title:c.title});},"engine-primary"),action("接入配置",()=>{d.close();void configuration(c);}));if(data.releases.some(item=>item.id!==c.content.releaseRef.id))row.append(managementAction("升级版本",()=>{d.close();upgrade(c);}));row.append(managementAction("撤销接入",()=>{d.close();revoke(c);}));d.body.append(row);}
      if(active&&state.actor?.role==='admin'){
        const policy=await actions.api('/api/releases/gap-feedback?'+new URLSearchParams({id:c.id,version:String(c.version)}));if(!d.isConnected)return;
        const feedback=el('section',null,'engine-panel');feedback.append(el('h3','外部问题缺口回传'),el('p','默认关闭。启用后仅保存原查询、缺口原因及覆盖/版本等元数据；不保存返回记录、依据正文或模型自由观察。','engine-muted'));
        const enabled=check(feedback,'允许此接入方回传缺口','原查询可能包含调用方提交的对象编号和过滤条件。',policy.enabled);let operationId=crypto.randomUUID();enabled.onchange=()=>{operationId=crypto.randomUUID();};
        feedback.append(action('保存缺口回传设置',()=>transact(d,output,async()=>{const saved=await actions.api('/api/releases/gap-feedback',{connectionRef:ref(c),enabled:enabled.checked,operationId});enabled.checked=saved.enabled;output.textContent=saved.enabled?'已启用元数据缺口回传。':'缺口回传已关闭。';})));d.body.append(feedback);
      }
    }catch(error){output.textContent=error.message;}
  }
  function revoke(connection){if(!mayManage())return;const d=dialog("撤销接入"),output=message(d.body),operationId=crypto.randomUUID();d.body.append(el("p",`撤销“${connection.title}”后，此接入方无法继续读取或委托任务。发布版本与本体保留。`,"engine-muted"),action("撤销此接入",()=>transact(d,output,async()=>{await actions.api("/api/releases/revoke",{operationId,connectionRef:ref(connection)});d.close();refresh();}),"engine-primary"));}
  function render(){
    const view=el("section",null,root.className);view.setAttribute("aria-label",root.getAttribute("aria-label"));const head=el("header",null,"engine-page-head"),copy=el("div");copy.append(el("h1","发布与接入"),el("p","将检查好的数据底座发布成版本，让外部 Agent 稳定接入。","engine-lead"));head.append(copy,action("返回本体修订",actions.ontology));view.append(head);
    if(!data){view.append(el("p","正在读取工作版本和发布记录…","engine-muted"));updateRegion(root,view);return;}
    const grid=el("div",null,"release-overview"),current=el("section",null,"engine-panel"),working=el("section",null,"engine-panel");
    current.append(el("p","当前发布","engine-eyebrow"),el("h2",releaseName(data.currentRelease)));
    if(data.currentRelease){const c=data.currentRelease.content;current.append(el("p",`${c.definition.concepts.length} 个概念 · ${c.definition.relations.length} 条关系 · ${when(c.publishedAt)}`,"engine-muted"),el("p",c.notes||(c.definition.snapshots?.length?`此版本锁定了 ${c.definition.snapshots.length} 个数据快照，接入方读取结果稳定。`:"此版本固定本体定义和映射，业务值按策略读取。"),"engine-release-notes"));const row=el("div",null,"engine-actions");row.append(action("查看版本",()=>detail(data.currentRelease)),managementAction("＋ 创建接入方",()=>connect(data.currentRelease),"engine-primary"));current.append(row);}else current.append(el("p","完成本体构建和修订后，检查并发布第一个版本。没有发布版本时，第三方无法通过新的发布入口接入。","engine-muted"),(data.working.foundationRef?managementAction:action)(data.working.foundationRef?"检查并发布":"前往本体",data.working.foundationRef?publish:actions.ontology,data.working.foundationRef?"engine-primary":""));
    const w=data.working;working.append(el("p","工作版本","engine-eyebrow"),el("h2",w.foundationRef?`${w.objectDiff.length} 项本体变化${w.diff.length&&!w.objectDiff.length?" · 数据或策略有变化":""}`:"尚无可发布本体"),el("p",`${w.summary.concepts} 个概念 · ${w.summary.relations} 条关系 · ${w.summary.types} 项映射 · ${state.sourceSummary?.total ?? 0} 个已接入来源（${w.summary.sources} 个参与工作版）${w.summary.snapshots?` · ${w.summary.snapshots} 个数据快照（${rows(w.summary.rows)} 行）`:""}`,"engine-muted"));
    if(w.pending.length)working.append(el("p",`${w.pending.length} 项候选或治理事项待处理`,"engine-badge"));issues(working,w.issues.slice(0,3),actions.askBuild);const row=el("div",null,"engine-actions");row.append(action("查看全部差异",()=>{const d=dialog("工作版本与当前发布的差异",true),dataChanges=el("div");d.body.append(el("h3","定义变化"),objectChanges(w.objectDiff),el("h3","数据变化"),dataChanges);void showDataDiff(dataChanges,"",w.inputHash);issues(d.body,w.issues,actions.askBuild);if(w.pending.length)d.body.append(table(w.pending,[["待处理项",i=>i.title],["状态",i=>i.status]]));}),(w.diff.length||!data.currentRelease?managementAction:action)(w.diff.length||!data.currentRelease?"检查并发布":"查看当前发布",w.diff.length||!data.currentRelease?publish:()=>detail(data.currentRelease),"engine-primary"));working.append(row);grid.append(current,working);view.append(grid);
    const connections=el("section",null,"release-connections");connections.append(el("h2",`接入方 · ${data.connections.length}`));if(!data.connections.length)connections.append(el("p","发布版本后，为每个接入方选择范围并生成独立配置。","engine-empty"));
    for(const c of data.connections){const card=el("article",null,"engine-panel release-connection"),bound=data.releases.find(r=>r.id===c.content.releaseRef.id),top=el("header");top.append(el("h3",c.title),el("span",(c.effectiveStatus||c.status)==="active"?"已启用":"已撤销","engine-badge"));card.append(top,el("p",`绑定 ${releaseName(bound)} · ${c.content.conceptIds.length} 个概念 · ${c.content.agentEnabled?"允许 Agent 委托":"只读查询"}`,"engine-muted"));const controls=el("div",null,"engine-actions");controls.append(action("范围与使用情况",()=>void connectionDetail(c)));if((c.effectiveStatus||c.status)==="active"){controls.append(action("接入配置",()=>void configuration(c),"engine-primary"));if(data.releases.some(r=>r.id!==c.content.releaseRef.id))controls.append(managementAction("切换版本",()=>upgrade(c)));controls.append(managementAction("撤销接入",()=>revoke(c)));}card.append(controls);connections.append(card);}view.append(connections);
    const history=el("section",null,"release-history");history.append(el("h2",`版本历史 · ${data.releases.length}`));for(const r of data.releases){const entry=el("div",null,"release-history-row");entry.append(el("strong",releaseName(r)),el("span",when(r.content.publishedAt),"engine-muted"),action("查看差异与定义",()=>detail(r)));history.append(entry);}if(!data.releases.length)history.append(el("p","尚无发布记录。","engine-muted"));view.append(history);
    const footer=el("footer",null,"engine-page-footer");footer.append(action("刷新状态",()=>void load()));view.append(footer);historyAccess?.dispose();historyAccess=renderHistoryAccess(state,{api:actions.api,onChanged:refresh});historyAccess.dataset.regionKey=`history-${generation}`;view.append(historyAccess);

    updateRegion(root,view);
}
  async function load(){const request=++generation;try{const next=await actions.api("/api/releases");if(disposed||request!==generation)return;data=next;render();}catch(error){if(!disposed&&request===generation){root.replaceChildren(el("h1","发布与接入"),el("p",error.message,"engine-message"),action("重试读取",()=>void load()));}}}
  const unsubscribe=actions.events?.subscribe("release",()=>void load());
  root.updateWorkspace=()=>true;
  render();void load();return root;
}

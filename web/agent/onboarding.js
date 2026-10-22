import { element as el, action } from "./connection-ui.js";
import { openConnections } from "./connections.js";
import { openApiImport } from "./openapi-import.js";
import {safeText} from './ui-display.js';
import { readBrowserValue } from "./browser-storage.js";

const engineTitles = ["连接模型", "添加第一个来源", "查看构建进度", "确认业务命名", "看看你的本体", "提出第一个问题"];
const engineDescriptions = ["先连接模型，让 Context OS 助手帮助你理解本体和回答问题。", "上传表格、连接数据库或接口。企业资料可以之后在设置中补充。", "按真实读取、发现和构建回执展示进度；关闭引导不会中止后台工作。", "核对助手提出的名称与说明，也可以稍后在待处理中完成。", "已采用的实体与关系可用于查询，待核对的发现继续保留在待处理中心。", "下面的问题来自当前可查询本体，点击后由问答助手读取实际数据并回答。"];
const titles = ["连接模型", "认识你的企业", "选择行业本体", "连接资料与系统", "准备开始"];
const descriptions = [
  "连接一个模型，让助手帮你理解企业、整理资料与建立本体。",
  "从企业名称和行业开始，也可以让助手补充公开信息。",
  "从行业的常见业务对象出发，选出与你的企业有关的部分。",
  "让基础定义连接真实信息。先接入最有用的来源，其余可以稍后添加。",
  "查看已建立的基础，以及接下来可以继续完善的内容。",
];
const drafts = new Map();
function inputField(parent, title, value = "", type = "text") {
  const label = el("label", null, "ob-field");
  label.append(el("span",title));
  const input = el(type === "textarea" ? "textarea" : "input");
  if (type !== "textarea") input.type = type;
  input.value = value; input.autocomplete = "off";
  label.append(input); parent.append(label); return input;
}
function selectField(parent, title, values, value) {
  const label = el("label", null, "ob-field"), select = el("select");
  label.append(el("span",title),select); parent.append(label);
  for (const [key,name] of values) { const option=el("option",name);option.value=key;select.append(option); }
  select.value=value; return select;
}
export function renderOnboarding(initial, actions) {
  let state=initial, working=false, rendered="", packSelection=null, researchId=null, refreshStep=()=>{};
  const root=el("section",null,"onboarding"); root.setAttribute("aria-label","Context OS 初始化");
  const draftKey=initial.workspaceId;
  let draft=drafts.get(draftKey);
  if (!draft) {
    try { draft=JSON.parse(readBrowserValue(localStorage, `context-os:onboarding:${draftKey}`, [`de-onboarding:${draftKey}`])||"null"); } catch {}
    draft ||= {company:{...initial.onboarding.company},profileVersion:initial.onboarding.currentProfileVersion};
    drafts.set(draftKey,draft);
  }
  const keep=()=>{ try { localStorage.setItem(`context-os:onboarding:${draftKey}`,JSON.stringify(draft)); } catch {} };
  const status=el("p",null,"ob-status");status.setAttribute("role","status");status.hidden=true;
  const show=message=>{status.textContent=message;status.hidden=!message;};
  const fresh=async()=>{const snapshot=await actions.api("/api/canvas?page=setup");actions.apply(snapshot);state=snapshot;return snapshot;};
  async function run(callback) {
    if (working) return;
    working=true;show("");
    try { const pending=callback();lock();await pending; }
    catch(error) { show(error.message); }
    finally { working=false;lock(); }
  }
  function lock() {
    const blocked=working||(state.onboarding.flow!=="engine"&&state.busy);
    root.setAttribute("aria-busy",String(blocked));
    for(const button of root.querySelectorAll("button,input,select,textarea")) button.disabled=blocked||button.dataset.unavailable==="true";
    const stop=root.querySelector("[data-stop]");if(stop)stop.disabled=working;
  }
  async function save(path,body={}) {
    const snapshot=await actions.api(`/api/onboarding/${path}`,{expectedVersion:state.onboarding.version,page:actions.page?.()||'setup',...body});
    actions.apply(snapshot);state=snapshot;return snapshot;
  }
  const step=number=>run(()=>save("step",{step:number}));
  function footer(back, next, callback, secondary) {
    const row=el("footer",null,"ob-footer");
    row.append(back ? action("← 上一步",()=>step(back),"ob-back") : el("span","配置会保留，下次无需重填。","ob-muted"));
    const right=el("div",null,"ob-footer-actions");
    if(secondary)right.append(secondary);
    if(next)right.append(action(next,()=>run(callback),"primary-button ob-next"));
    row.append(right);root.append(row);
  }
  function model(body) {
    const form=el("form",null,"ob-form");
    const values=draft.model||state.model;
    let dirty=!!draft.model;
    const providers=[...document.querySelectorAll("#provider-input option")].map(option=>[option.value,option.textContent]);
    const provider=selectField(form,"模型服务",providers,values.provider||"deepseek");
    const name=inputField(form,"模型 ID",values.model||"");name.required=true;name.maxLength=120;
    const custom=el("div",null,"ob-custom");form.append(custom);
    const protocol=selectField(custom,"接口协议",[["openai","OpenAI 兼容"],["anthropic","Anthropic 兼容"]],values.protocol||"openai");
    const url=inputField(custom,"API Base URL",values.baseUrl||"","url");
    const key=inputField(form,"API Key","","password");key.placeholder=state.model.configured?"已配置，留空继续使用":"填写该服务的 API Key";
    key.maxLength=16000;
    form.append(el("p","密钥保存在本机服务端，除非主动删除，不会因刷新或重启而清除。","ob-muted"));
    const customChanged=()=>{custom.hidden=provider.value!=="custom";url.required=!custom.hidden;};customChanged();
    provider.onchange=()=>{customChanged();key.value="";key.placeholder="填写该服务的密钥";name.value=provider.value===state.model.provider?state.model.model:"";};
    for(const control of [protocol,url])control.addEventListener("input",()=>{key.value="";key.placeholder="填写该接口的密钥";});
    const remember=()=>{dirty=true;draft.model={provider:provider.value,model:name.value,protocol:protocol.value,baseUrl:url.value};keep();};
    form.addEventListener("input",event=>{dirty=true;if(event.target!==key)remember();});form.addEventListener("change",remember);
    const configured=el("div",null,"ob-model-state");body.append(configured,form);
    const submit=async(test)=>{
      if(!form.reportValidity())return false;
      const request={provider:provider.value,model:name.value.trim(),apiKey:key.value,testConnection:test,
        ...(provider.value==="custom"?{baseUrl:url.value.trim(),protocol:protocol.value}:{})};
      try { const result=await actions.api("/api/settings",request);key.value="";dirty=false;delete draft.model;keep();await fresh();show(test?`连接检查成功 · ${result.connection?.message||"模型已响应"}`:"模型设置已保存。");return true; }
      catch(error){key.value="";await fresh();throw error;}
    };
    const controls=el("div",null,"ob-inline-actions");
    controls.append(action("保存并测试连接",()=>run(()=>submit(true)),"ob-outline"),action("保存设置",()=>run(()=>submit(false)),"quiet-button"));
    const remove=action("删除当前密钥",()=>run(async()=>{await actions.api("/api/settings/key/delete",{});key.value="";await fresh();show("当前模型密钥已删除。");}),"ob-delete");controls.append(remove);
    refreshStep=()=>{
      if(!dirty){provider.value=state.model.provider||"deepseek";name.value=state.model.model||"";protocol.value=state.model.protocol||"openai";url.value=state.model.baseUrl||"";customChanged();}
      configured.textContent=state.model.configured?`${state.model.keySaved?"已保存":"已配置"} · ${state.model.model}`:"尚未连接模型";
      remove.hidden=!state.model.configured;
      const sameConnection=provider.value===state.model.provider&&(provider.value!=="custom"||(url.value.trim()===state.model.baseUrl&&protocol.value===state.model.protocol));
      key.placeholder=state.model.configured&&sameConnection?"已配置，留空继续使用":"填写该服务的 API Key";
    };
    form.append(controls);form.onsubmit=event=>{event.preventDefault();void run(()=>submit(true));};
    footer(null,"继续 →",async()=>{
      const changed=provider.value!==state.model.provider||name.value.trim()!==state.model.model||key.value.trim()||
        (provider.value==="custom"&&(url.value.trim()!==state.model.baseUrl||protocol.value!==state.model.protocol));
      if(changed||!state.model.configured){if(!await submit(true)||!state.model.configured)return;}
      await save("step",{step:2});
    });
  }
  function engineSources(body) {
    const list=el("div",null,"engine-source-choices");body.append(list);
    let selected=draft.sourceKind||state.onboarding.sourceKind||"file";
    for(const [id,title,description] of [["file","上传表格","一次选择多份 CSV、TSV 或 Excel，整批完成后构建"],["database","连接数据库","只读接入 MySQL 或 PostgreSQL，选择业务表"],["api","HTTP API","导入接口文档、配置认证并测试数据"],["mcp","MCP 服务","连接已有工具服务，选择可读取的能力"]]){
      const choice=action(title,()=>{selected=id;draft.sourceKind=id;keep();for(const b of list.children)b.setAttribute("aria-pressed",String(b.dataset.kind===id));},"engine-choice");
      choice.dataset.kind=id;choice.setAttribute("aria-pressed",String(selected===id));choice.append(el("small",description));list.append(choice);
    }
    footer(1,"接入并查看构建 →",async()=>{await save("step",{step:3,sourceKind:selected});actions.connect?.(selected);},action("稍后接入",()=>run(()=>save("complete",{sourceKind:"later"})),"quiet-button"));
  }
  function engineBuild(body){
    const progress=el('div'),controls=el('div',null,'ob-inline-actions');body.append(progress,controls);
    const next=action('查看命名建议 →',()=>step(4),'primary-button ob-next');
    controls.append(action('重新选择来源',()=>step(2),'quiet-button'),next);
    refreshStep=()=>{
      const first=state.onboarding.firstUse,build=first?.build,ontology=first?.ontology;if(!build)return;
      const labels={waiting_source:'等待添加结构化来源',waiting_build:'来源已接入，等待程序构建',running:'正在同步和构建',ready:'本体已生成',needs_attention:'有内容需要处理'};
      progress.replaceChildren(el('h2',labels[build.status]||'等待构建'),el('p',`已读取 ${build.sourcesRead} 张表 → 已采用 ${ontology.entities} 个实体 → 已采用 ${ontology.relations} 条关系`,'ob-pack-summary'));
      if(ontology.pendingRelations)progress.append(el('p',`另发现 ${ontology.pendingRelations} 项待核对关系，尚未采用。`,'ob-note'));
      for(const item of build.steps||[])progress.append(el('p',`${item.label} · ${{queued:'等待中',running:'进行中',completed:'已完成',failed:'未完成'}[item.status]||item.status}`,'ob-muted'));
      for(const issue of build.issues||[])progress.append(el('p',safeText(issue.message),'ob-note'));
      for(const batch of first.uploads||[])progress.append(el('p',`有一批表格尚未提交，已接收 ${batch.received} 张表。`,'ob-note'),action('提交已接收表格',()=>run(async()=>{await actions.api('/api/canvas/upload/table-batch/finalize',{batchId:batch.ref.id});await fresh();}),'ob-outline'));
      if(!build.hasStructuredSource)progress.append(el('p','文档可以补充说明和依据；生成本体结构需要接入表格、数据库或业务接口。','ob-muted'));
      next.dataset.unavailable=String(!ontology.modelRef);lock();
    };
  }
  function engineNaming(body){
    const content=el('div');body.append(content);
    refreshStep=()=>{
      const naming=state.onboarding.firstUse?.naming;if(!naming)return;
      content.replaceChildren();
      if(naming.changeRef)content.append(el('p','业务名称建议已准备好，打开待处理项可逐项编辑、复验并采用。','ob-note'),action('核对整批命名',()=>actions.openPending?.(naming.changeRef),'ob-outline'));
      else content.append(el('p',({waiting_model:'连接模型后可生成业务名称建议。',queued:'命名任务已排队，可继续查看本体。',running:'助手正在读取实际字段与样本，整理业务名称。',completed:'命名处理结果已保存。',failed:'本次命名未完成，之后可重试。',stopped:'命名已停止，已保存结果保留。',idle:'目前没有待核对的命名批次。'})[naming.status]||'命名状态已更新。','ob-note'));
      if(naming.error)content.append(el('p',safeText(naming.error),'ob-note'));
      if(['failed','stopped'].includes(naming.status))content.append(action('重试业务命名',()=>run(async()=>{const snapshot=await actions.api('/api/naming/retry',{page:actions.page?.()||'setup'});actions.apply(snapshot);state=snapshot;refreshStep();}),'ob-outline'));
    };
    footer(3,'查看本体 →',()=>save('step',{step:5}),action('跳过命名，之后处理',()=>run(()=>save('step',{step:5,skipNaming:true})),'quiet-button'));
  }
  function engineOntology(body){
    const content=el('div');body.append(content);
    refreshStep=()=>{const ontology=state.onboarding.firstUse?.ontology;if(!ontology)return;content.replaceChildren(el('h2',`${ontology.entities} 个实体 · ${ontology.relations} 条已采用关系`),el('p',ontology.pending?`有 ${ontology.pending} 项待处理。查看图谱时可打开待处理中心逐项核对。`:'当前没有未处理的变更。','ob-note'));};
    footer(4,'进入本体并试问 →',async()=>{await save('step',{step:6});actions.showOntology?.();});
  }
  function engineQuestions(body){
    const content=el('div'),receipt=el('div');body.append(content,receipt);let request=0,lastWorkspace='',loading=false;
    const load=async()=>{const current=++request;loading=true;content.replaceChildren(el('p','正在根据当前本体准备示例问题…','ob-muted'));
      try{const result=await actions.api('/api/onboarding/examples');if(current!==request||!body.isConnected)return;
        content.replaceChildren(el('p',result.message||'点击一个问题，开始实际查询。','ob-muted'));
        for(const item of result.questions||[])content.append(action(safeText(item.question),()=>run(async()=>{await save('complete');await actions.askExample?.(item.question);}),'engine-choice'));
      }catch(error){if(current===request){content.replaceChildren(el('p',error.message,'ob-note'),action('重新准备示例',()=>void load(),'ob-outline'));}}
      finally{loading=false;lock();}
    };
    refreshStep=()=>{const key=JSON.stringify(state.workspaceVersion??null);if(key!==lastWorkspace&&!loading){lastWorkspace=key;void load();}const answer=state.onboarding.firstUse?.firstAnswer;receipt.replaceChildren();if(answer)receipt.append(el('p','已完成一次有实际读取依据的问答。','ob-success'));};
    footer(5,'稍后提问，完成引导',async()=>{await save('complete');actions.finish?.();});
  }
  function company(body) {
    const form=el("form",null,"ob-form");body.append(form);
    let profileVersion=state.onboarding.currentProfileVersion;
    if(draft.profileVersion!==profileVersion){
      if(!draft.previousCompany && draft.company && Object.keys(state.onboarding.company).some(key=>(draft.company[key]||"")!==(state.onboarding.company[key]||"")))draft.previousCompany={...draft.company};
      draft.company={...state.onboarding.company};draft.profileVersion=profileVersion;keep();
    }
    const value={...state.onboarding.company,...draft.company};
    const name=inputField(form,"企业名称",value.name);name.required=true;name.minLength=2;name.maxLength=200;name.placeholder="填写完整名称，便于确认企业身份";
    const industry=selectField(form,"所属行业",[["","请选择行业"],...state.onboarding.packs.map(p=>[p.id,p.name])],value.industry);industry.required=true;
    const row=el("div",null,"ob-fields-row");form.append(row);
    const region=inputField(row,"所在地区 · 可选",value.region);region.maxLength=200;region.placeholder="帮助区分同名企业";
    const website=inputField(row,"官方网站 · 可选",value.website,"url");website.placeholder="https://";website.maxLength=2000;
    const business=inputField(form,"主营业务 · 可选",value.business,"textarea");business.maxLength=1500;business.rows=2;
    const goal=inputField(form,"最想先解决什么 · 可选",value.goal);goal.maxLength=1500;goal.placeholder="例如：统一客户、合同与账户信息";
    const values=()=>({name:name.value.trim(),industry:industry.value,region:region.value.trim(),website:website.value.trim(),business:business.value.trim(),goal:goal.value.trim()});
    form.oninput=()=>{draft.company=values();keep();};form.onchange=form.oninput;
    if(draft.previousCompany){
      const prior=el("details",null,"ob-note");prior.append(el("summary","企业档案已更新 · 查看上次未保存的草稿"),el("p",Object.values(draft.previousCompany).filter(Boolean).join(" · ")));
      prior.append(action("恢复这份草稿供核对",()=>{
        const old=draft.previousCompany;
        for(const [field,input] of Object.entries({name,industry,region,website,business,goal}))input.value=old[field]||"";
        delete draft.previousCompany;draft.company=values();keep();prior.remove();
      },"quiet-button"));form.append(prior);
    }
    const commit=async(stay=false)=>{if(!form.reportValidity())return false;draft.company=values();keep();await save("company",{...values(),stay,profileVersion});profileVersion=state.onboarding.currentProfileVersion;draft.profileVersion=profileVersion;keep();return true;};
    const research=action("搜索企业与行业公开信息 ↗",()=>run(async()=>{
      if(!await commit(true))return;
      researchId ||= crypto.randomUUID();
      draft.researchMessageId=researchId;draft.researchCompany=name.value.trim();keep();
      const snapshot=await actions.api("/api/onboarding/research",{messageId:researchId});actions.apply(snapshot);state=snapshot;researchId=null;
      show("助手正在核对公开信息，你可以在下方查看结果。");
    }),"ob-outline");
    form.append(research,el("p","搜索前以此处名称和地区确认研究主体。公开结果保留出处与待核实状态。","ob-muted"));
    const results=el("section",null,"ob-research");results.setAttribute("aria-label","公开研究结果");body.append(results);
    footer(1,"保存并继续 →",()=>commit(false));form.onsubmit=event=>{event.preventDefault();void run(()=>commit(false));};
  }
  function packages(body) {
    const packs=state.onboarding.packs;
    const initialId=draft.packId||state.onboarding.packId||state.onboarding.company.industry;
    let selectedPack=packs.find(p=>p.id===initialId)||packs[0];
    const picker=selectField(body,"行业术语参考",packs.map(p=>[p.id,`${p.name}${p.id===state.onboarding.company.industry?" · 推荐":""}`]),selectedPack.id);
    const preview=el("section",null,"ob-pack-preview");body.append(preview);
    const renderPack=()=>{
      const chosen=draft.packId===selectedPack.id&&draft.concepts?draft.concepts:selectedPack.concepts;
      packSelection=new Map(chosen.map(c=>[c.id,{...c}]));
      preview.replaceChildren(el("p",selectedPack.summary,"ob-pack-summary"));
      const heading=el("div",null,"ob-section-heading");heading.append(el("h2","名称与说明参考"),el("span",`${selectedPack.concepts.length} 个可选术语 · v${selectedPack.version}`,"ob-muted"));preview.append(heading);
      const list=el("div",null,"ob-concepts");preview.append(list);
      const relations=el("div",null,"ob-relations");
      const sync=()=>{
        draft.packId=selectedPack.id;draft.concepts=[...packSelection.values()];keep();
        const included=selectedPack.relations.filter(r=>packSelection.has(r.from)&&packSelection.has(r.to));
        relations.replaceChildren(el("h3",`关系预览 · ${included.length}`));
        for(const relation of included)relations.append(el("p",`${packSelection.get(relation.from).name}  →  ${relation.name}  →  ${packSelection.get(relation.to).name}`));
        if(!included.length)relations.append(el("p","当前选择没有预设关系，之后可从资料补充。","ob-muted"));
      };
      for(const concept of selectedPack.concepts){
        const current=packSelection.get(concept.id)||concept;
        const row=el("div",null,"ob-concept");
        const label=el("label",null,"ob-check");const checkbox=el("input");checkbox.type="checkbox";checkbox.checked=packSelection.has(concept.id);checkbox.setAttribute("aria-label",`包含${concept.name}`);label.append(checkbox,el("strong",concept.name));
        const details=el("details");details.append(el("summary","调整名称与定义"));
        const name=inputField(details,`${concept.name}的名称`,current.name);name.maxLength=100;
        const description=inputField(details,`${concept.name}的定义`,current.description,"textarea");description.maxLength=1000;description.rows=2;
        row.append(label,el("p",current.description),details);list.append(row);
        const update=()=>{if(checkbox.checked)packSelection.set(concept.id,{id:concept.id,name:name.value,description:description.value});else packSelection.delete(concept.id);sync();};
        checkbox.onchange=update;name.oninput=update;description.oninput=update;
      }
      preview.append(relations,el("p","保存后仅作为名称和说明参考。本体中的对象与关系由接入数据按规则构建，助手可以参照这些术语修正已有定义。","ob-note"));sync();
    };
    picker.onchange=()=>{selectedPack=packs.find(p=>p.id===picker.value);draft.packId=selectedPack.id;delete draft.concepts;renderPack();};renderPack();
    const current=state.foundation?.current;
    if(current)body.prepend(el("p",`当前已有 ${current.content.concepts.length} 个概念。保存术语参考不会新增或修改这些定义。`,"ob-note"));
    footer(2,"保存术语参考 →",async()=>{
      const concepts=[...packSelection.values()];
      const payload={packId:selectedPack.id,concepts,baseVersion:state.foundation?.current?.version||0};
      const fingerprint=JSON.stringify(payload);
      if(draft.pendingPack?.fingerprint!==fingerprint)draft.pendingPack={fingerprint,operationId:crypto.randomUUID()};keep();
      await save("pack",{...payload,operationId:draft.pendingPack.operationId});delete draft.pendingPack;keep();
    }, state.foundation?.adopted ? action("继续使用已有本体",()=>step(4),"quiet-button") : null);
  }
  function connections(body) {
    const pack=state.onboarding.packs.find(p=>p.id===(state.onboarding.packId||state.onboarding.company.industry));
    body.append(el("p",`根据${pack?.name||"企业"}的业务对象，建议从这些来源开始。`,"ob-pack-summary"));
    const list=el("div",null,"ob-connectors");body.append(list);
    const onChanged=()=>void run(fresh);
    const methods={file:"上传资料",mcp:"连接 MCP",api:"连接 API",feishu:"登录 / 使用已有账号"};
    for(const source of pack?.sources||[]){
      const row=el("article",null,"ob-connector");const copy=el("div");
      copy.append(el("h2",source.title),el("p",source.description));
      row.append(copy,action(methods[source.method],()=>{
        if(source.method==="file")actions.upload();
        else if(source.method==="api")openApiImport({api:actions.api,onSaved:async snapshot=>{actions.apply(snapshot);await fresh();}});
        else openConnections(actions.api,null,{service:source.method==="feishu"?"feishu":"custom",onChanged,onPrepared:actions.apply});
      },"ob-outline"));list.append(row);
    }
    const manual=el("div",null,"ob-inline-actions");manual.append(action("所有服务与已有连接",()=>openConnections(actions.api,null,{onChanged}),"quiet-button"));body.append(manual);
    body.append(el("p","只有已支持的服务提供登录；其他知识库或数据库可使用已有 MCP 服务或只读 API 接入。","ob-muted"));
    const counts=el("div",null,"ob-live-counts");body.append(counts);
    footer(3,"查看构建结果 →",()=>save("step",{step:5}),action("稍后接入",()=>step(5),"quiet-button"));
  }
  function summary(body) {
    const contents=el("div",null,"ob-result");body.append(contents);
    footer(4,"进入企业与数据 →",async()=>{await save("complete");drafts.delete(draftKey);try{localStorage.removeItem(`context-os:onboarding:${draftKey}`);}catch{}});
  }
  function live() {
    refreshStep();
    const result=root.querySelector(".ob-result"), counts=root.querySelector(".ob-live-counts");
    const sourceCount=state.sources.filter(s=>s.status==="ready").length;
    const liveCount=state.live?.connections?.length||0;
    const foundation=state.foundation?.adopted;
    const concepts=foundation?.content.concepts||[];
    const mapped=concepts.filter(c=>c.mappingStatus==="bound").length;
    if(counts)counts.textContent=`已读取资料 ${sourceCount} 份 · 已配置数据来源 ${liveCount} 个 · 已映射概念 ${mapped} 个`;
    if(result){
      result.replaceChildren(el("div",concepts.length ? "企业基础已建立" : "初始化信息已保存","ob-success"),el("h2",state.onboarding.company.name));
      if(state.onboarding.foundationMessage)result.append(el("p",state.onboarding.foundationMessage,"ob-note"));
      const grid=el("div",null,"ob-result-grid");
      for(const [number,title] of [[concepts.length,"基础概念"],[foundation?.content.relations.length||0,"定义关系"],[sourceCount,"已读取资料"],[mapped,"已映射概念"]]){
        const card=el("div");card.append(el("strong",String(number)),el("span",title));grid.append(card);
      }
      result.append(grid,el("p",`${state.model.keySaved?"模型密钥已保存":"模型已配置"} · ${state.model.model}`,"ob-muted"));
      if(concepts.length>mapped)result.append(el("p",`${concepts.length-mapped} 个概念尚未连接真实业务数据。可以先使用基础定义，稍后继续接入与映射。`,"ob-note"));
      if(!sourceCount&&!liveCount)result.append(el("p","还未接入企业来源。行业参考已保存；接入结构化数据后再构建本体。","ob-muted"));
      for(const progress of [state.automaticBuild,state.automaticApiBuild].filter(Boolean)){
        if(progress.pending)result.append(el("p",`仍有 ${progress.pending} 项来源正在等待或进行本体构建。`,"ob-note"));
        for(const error of progress.errors||[])result.append(el("p",`${error.title}：${error.message}`,"ob-note"));
      }
    }
    const research=root.querySelector(".ob-research");
    if(research){
      const index=state.messages.findIndex(m=>m.id===draft.researchMessageId);
      const messages=index>=0?state.messages.slice(index+1):[];
      const last=messages.filter(m=>m.role==="assistant").at(-1);
      const researching=index>=0&&state.busy;
      const text=(researching?state.streaming:"")||last?.content||"";
      if(research.dataset.text!==text||research.dataset.busy!==String(researching)){
        research.replaceChildren();research.dataset.text=text;research.dataset.busy=String(researching);
        if(researching)research.append(el("p","正在搜索和整理…","ob-muted"));
        if(text){const details=el("details");details.open=true;details.append(el("summary",`${draft.researchCompany||"企业"} · 助手的研究与说明`),el("div",text,"ob-research-text"));research.append(details);}
        if(researching){const stop=action("停止研究",()=>run(async()=>{const snapshot=await actions.api("/api/canvas/stop",{page:"setup"});actions.apply(snapshot);}),"quiet-button");stop.dataset.stop="true";research.append(stop);}
      }
    }
  }
  function render() {
    const setup=state.onboarding;
    const engine=setup.flow==="engine", activeTitles=engine?engineTitles:titles, activeDescriptions=engine?engineDescriptions:descriptions;
    // Ordinary polling preserves edits. A changed enterprise profile must be reconciled
    // against its new version; company() keeps the prior draft available for review.
    const profileRevision=!engine&&setup.step===2?setup.currentProfileVersion:"";
    const key=`${setup.flow}:${setup.step}:${profileRevision}`;
    if(rendered!==key){
      const previous=rendered;rendered=key;refreshStep=()=>{};
      root.replaceChildren();
      const progress=el("div",null,"ob-progress");
      progress.append(el("span",`第 ${setup.step} / ${activeTitles.length} 步`,"ob-progress-label"));
      const dots=el("span",null,"ob-progress-dots");dots.setAttribute("aria-hidden","true");
      activeTitles.forEach((_,i)=>{const dot=el("span",null,"ob-progress-dot");dot.dataset.state=i+1<setup.step?"complete":i+1===setup.step?"current":"upcoming";dots.append(dot);});
      progress.append(dots);root.append(progress);
      const heading=el("header",null,"ob-heading");const h1=el("h1",activeTitles[setup.step-1]);h1.tabIndex=-1;
      heading.append(h1,el("p",activeDescriptions[setup.step-1]));root.append(heading,status);
      const body=el("div",null,"ob-body");root.append(body);
      (engine?[model,engineSources,engineBuild,engineNaming,engineOntology,engineQuestions]:[model,company,packages,connections,summary])[setup.step-1](body);
      if(previous)queueMicrotask(()=>{if(root.isConnected){h1.focus({preventScroll:true});root.closest(".onboarding-dialog")?.scrollTo({top:0});}});
    }
    live();lock();
  }
  root.showError=show;
  root.isWorking=()=>working;
  root.update=snapshot=>{state=snapshot;render();};render();return root;
}

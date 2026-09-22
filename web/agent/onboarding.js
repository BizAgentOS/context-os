import { element as el, action } from "./connection-ui.js";
import { openConnections } from "./connections.js";
import { openApiImport } from "./openapi-import.js";

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
  let state=initial, working=false, rendered="", renderedStep=null, packSelection=null, researchId=null;
  const root=el("section",null,"onboarding"); root.setAttribute("aria-label","企业初始化");
  const draftKey=initial.workspaceId;
  let draft=drafts.get(draftKey);
  if (!draft) {
    try { draft=JSON.parse(localStorage.getItem(`de-onboarding:${draftKey}`)||"null"); } catch {}
    draft ||= {company:{...initial.onboarding.company},profileVersion:initial.onboarding.currentProfileVersion};
    drafts.set(draftKey,draft);
  }
  const keep=()=>{ try { localStorage.setItem(`de-onboarding:${draftKey}`,JSON.stringify(draft)); } catch {} };
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
    root.setAttribute("aria-busy",String(working||state.busy));
    for(const button of root.querySelectorAll("button,input,select,textarea")) button.disabled=working||state.busy||button.dataset.unavailable==="true";
    const stop=root.querySelector("[data-stop]");if(stop)stop.disabled=working;
  }
  async function save(path,body={}) {
    const snapshot=await actions.api(`/api/onboarding/${path}`,{expectedVersion:state.onboarding.version,...body});
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
    const providers=[...document.querySelectorAll("#provider-input option")].map(option=>[option.value,option.textContent]);
    const provider=selectField(form,"模型服务",providers,state.model.provider||"deepseek");
    const name=inputField(form,"模型 ID",state.model.model||"");name.required=true;name.maxLength=120;
    const custom=el("div",null,"ob-custom");form.append(custom);
    const protocol=selectField(custom,"接口协议",[["openai","OpenAI 兼容"],["anthropic","Anthropic 兼容"]],state.model.protocol||"openai");
    const url=inputField(custom,"API Base URL",state.model.baseUrl||"","url");
    const key=inputField(form,"API Key","","password");key.placeholder=state.model.configured?"已配置，留空继续使用":"填写该服务的 API Key";
    key.maxLength=16000;
    form.append(el("p","密钥保存在本机服务端，除非主动删除，不会因刷新或重启而清除。","ob-muted"));
    const customChanged=()=>{custom.hidden=provider.value!=="custom";url.required=!custom.hidden;};customChanged();
    provider.onchange=()=>{customChanged();key.value="";key.placeholder="填写该服务的密钥";name.value=provider.value===state.model.provider?state.model.model:"";};
    for(const control of [protocol,url])control.addEventListener("input",()=>{key.value="";key.placeholder="填写该接口的密钥";});
    const configured=el("div",state.model.configured?`${state.model.keySaved?"已保存":"已配置"} · ${state.model.model}`:"尚未连接模型","ob-model-state");body.append(configured,form);
    const submit=async(test)=>{
      if(!form.reportValidity())return false;
      const request={provider:provider.value,model:name.value.trim(),apiKey:key.value,testConnection:test,
        ...(provider.value==="custom"?{baseUrl:url.value.trim(),protocol:protocol.value}:{})};
      try { const result=await actions.api("/api/settings",request);key.value="";await fresh();show(test?`连接检查成功 · ${result.connection?.message||"模型已响应"}`:"模型设置已保存。");return true; }
      catch(error){key.value="";await fresh();throw error;}
    };
    const controls=el("div",null,"ob-inline-actions");
    controls.append(action("保存并测试连接",()=>run(()=>submit(true)),"ob-outline"),action("保存设置",()=>run(()=>submit(false)),"quiet-button"));
    if(state.model.configured)controls.append(action("删除当前密钥",()=>run(async()=>{await actions.api("/api/settings/key/delete",{});key.value="";await fresh();show("当前模型密钥已删除。");}),"ob-delete"));
    form.append(controls);form.onsubmit=event=>{event.preventDefault();void run(()=>submit(true));};
    footer(null,"继续 →",async()=>{
      const changed=provider.value!==state.model.provider||name.value.trim()!==state.model.model||key.value.trim()||
        (provider.value==="custom"&&(url.value.trim()!==state.model.baseUrl||protocol.value!==state.model.protocol));
      if(changed||!state.model.configured){if(!await submit(true)||!state.model.configured)return;}
      await save("step",{step:2});
    });
  }
  function company(body) {
    const form=el("form",null,"ob-form");body.append(form);
    const profileVersion=state.onboarding.currentProfileVersion;
    if(draft.profileVersion!==profileVersion){
      if(draft.company && Object.keys(state.onboarding.company).some(key=>(draft.company[key]||"")!==(state.onboarding.company[key]||"")))draft.previousCompany=draft.company;
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
    const commit=async(stay=false)=>{if(!form.reportValidity())return false;draft.company=values();keep();await save("company",{...values(),stay,profileVersion});return true;};
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
    const picker=selectField(body,"行业本体包",packs.map(p=>[p.id,`${p.name}${p.id===state.onboarding.company.industry?" · 推荐":""}`]),selectedPack.id);
    const preview=el("section",null,"ob-pack-preview");body.append(preview);
    const renderPack=()=>{
      const chosen=draft.packId===selectedPack.id&&draft.concepts?draft.concepts:selectedPack.concepts;
      packSelection=new Map(chosen.map(c=>[c.id,{...c}]));
      preview.replaceChildren(el("p",selectedPack.summary,"ob-pack-summary"));
      const heading=el("div",null,"ob-section-heading");heading.append(el("h2","初始业务对象"),el("span",`${selectedPack.concepts.length} 个可选概念 · v${selectedPack.version}`,"ob-muted"));preview.append(heading);
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
      preview.append(relations,el("p","这是可调整的起步模板。采用后建立概念与关系，实际对象、业务适用性和来源映射会在接入数据后补充。","ob-note"));sync();
    };
    picker.onchange=()=>{selectedPack=packs.find(p=>p.id===picker.value);draft.packId=selectedPack.id;delete draft.concepts;renderPack();};renderPack();
    const current=state.foundation?.current;
    if(current)body.prepend(el("p",`当前已有 ${current.content.concepts.length} 个概念。添加模板会保留现有定义，同名概念沿用原定义。`,"ob-note"));
    footer(2,"采用所选定义 →",async()=>{
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
    footer(4,"进入企业与数据 →",async()=>{await save("complete");drafts.delete(draftKey);try{localStorage.removeItem(`de-onboarding:${draftKey}`);}catch{}});
  }
  function live() {
    const result=root.querySelector(".ob-result"), counts=root.querySelector(".ob-live-counts");
    const sourceCount=state.sources.filter(s=>s.status==="ready").length;
    const liveCount=state.live?.connections?.length||0;
    const foundation=state.foundation?.adopted;
    const concepts=foundation?.content.concepts||[];
    const mapped=concepts.filter(c=>c.mappingStatus==="bound").length;
    if(counts)counts.textContent=`已读取资料 ${sourceCount} 份 · 已配置数据来源 ${liveCount} 个 · 已映射概念 ${mapped} 个`;
    if(result){
      result.replaceChildren(el("div","企业基础已建立","ob-success"),el("h2",state.onboarding.company.name));
      const grid=el("div",null,"ob-result-grid");
      for(const [number,title] of [[concepts.length,"基础概念"],[foundation?.content.relations.length||0,"定义关系"],[sourceCount,"已读取资料"],[mapped,"已映射概念"]]){
        const card=el("div");card.append(el("strong",String(number)),el("span",title));grid.append(card);
      }
      result.append(grid,el("p",`${state.model.keySaved?"模型密钥已保存":"模型已配置"} · ${state.model.model}`,"ob-muted"));
      if(concepts.length>mapped)result.append(el("p",`${concepts.length-mapped} 个概念尚未连接真实业务数据。可以先使用基础定义，稍后继续接入与映射。`,"ob-note"));
      if(!sourceCount&&!liveCount)result.append(el("p","还未接入企业来源，当前结果来自选定模板或已有定义。","ob-muted"));
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
    const key=`${setup.version}:${setup.currentProfileVersion}:${setup.step}:${JSON.stringify(state.model)}`;
    if(rendered!==key){
      const previous=rendered, stepChanged=renderedStep!==setup.step;rendered=key;renderedStep=setup.step;
      root.replaceChildren();
      const nav=el("nav",null,"ob-progress");nav.setAttribute("aria-label","初始化步骤");
      titles.forEach((title,i)=>{
        const button=action(`${i+1}  ${title}`,()=>step(i+1));
        if(i+1===setup.step)button.setAttribute("aria-current","step");
        if(i+1>setup.step)button.dataset.unavailable="true";
        nav.append(button);
      });root.append(nav);
      const heading=el("header",null,"ob-heading");const h1=el("h1",titles[setup.step-1]);h1.tabIndex=-1;
      heading.append(h1,el("p",descriptions[setup.step-1]));root.append(heading,status);
      const body=el("div",null,"ob-body");root.append(body);
      [model,company,packages,connections,summary][setup.step-1](body);
      if(previous)queueMicrotask(()=>{if(root.isConnected){h1.focus({preventScroll:true});if(stepChanged)root.closest(".canvas")?.scrollTo({top:0});}});
    }
    live();lock();
  }
  root.showError=show;
  root.update=snapshot=>{state=snapshot;render();};render();return root;
}

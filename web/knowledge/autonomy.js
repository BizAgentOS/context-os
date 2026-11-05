/** Connection and decision UI uses the same authenticated domain APIs as other callers. */
export function createAutonomyWorkspace({api,node,button,notice,refresh,getState,openOntology}) {
  const $=s=>document.querySelector(s);let current;
  async function open(id){
    current=await api(`/api/decision-packages/${id}`);
    const root=$('#decision-package-detail'),s=current.summary;
    root.replaceChildren(node('h3',`${s.definition.name} · ${current.state}`),node('p',s.note));
    root.append(node('p',current.retention+(current.pendingDays>=30?' 已等待超过30天，请复核来源和适用范围。':'')));
    if(current.superseded_by)root.append(node('p',`本批已被 ${current.superseded_by} 取代。`));
    root.append(node('p',`本体事项 ${s.ontologyIssues.length} 项；身份对应 ${s.identities.length} 组；构建事件 ${s.events.length} 项。`));
    for(const type of s.definition.types){root.append(node('h4',`${type.name}（${type.id}）`),node('p',type.description||''));for(const p of type.properties)root.append(node('p',`${p.name}：${p.valueType}${p.required?'，必填':''}${p.multiple?'，多值':''}`));}
    for(const link of s.definition.links)root.append(node('p',`${link.name}：${link.from} → ${link.to}`));
    for(const issue of s.ontologyIssues)root.append(node('p',`本体决定：${issue.question}`));
    root.append(button('先修改本体定义（将使当前计划失效）',()=>openOntology(current.ontology_id)));
    const choose=node('select');
    for(const [value,label]of [['','请选择本批身份决定'],['same','分别批准下方各组内部的对应'],['separate','本批各来源保持独立']]){const o=node('option',label);o.value=value;choose.append(o);}
    if(s.identities.length)root.append(choose);
    const overrides=new Map();
    for(const g of s.identities){
      const card=node('details');card.append(node('summary',`${g.typeId} · ${g.value} · ${g.participants.length} 个来源`));
      for(const p of g.participants)card.append(node('p',`${p.title} · ${p.sourceVersionId}`));
      const select=node('select');
      for(const [value,label]of [['','沿用本批选择'],['same','本组同一对象'],['separate','本组保持独立']]){const o=node('option',label);o.value=value;select.append(o);}
      select.value=g.decision==='pending'?'':g.decision;overrides.set(g.key,select);card.append(select);
      const evidence=node('details');evidence.append(node('summary','查看本组证据'),node('pre',JSON.stringify(g.participants,null,2)));card.append(evidence);root.append(card);
    }
    for(const e of s.events){const d=node('details');d.append(node('summary',e.summary),node('pre',JSON.stringify(e.details,null,2)));root.append(d);}
    for(const error of s.systemErrors)root.append(node('p',`系统阻断：${error}`));
    const reason=node('textarea');reason.rows=3;reason.placeholder='本次业务范围、身份对应及重大事件的决定依据';root.append(reason);
    const accept=node('input');accept.type='checkbox';
    const label=node('label','确认保留当前列出的重大构建事件及其证据，不自动选出冲突赢家');label.append(accept);if(s.events.length)root.append(label);
    const receipts=node('details');receipts.append(node('summary','查看分步执行回执'),node('pre',JSON.stringify(current.receipts,null,2)));root.append(receipts);
    if(!['built','archived','superseded'].includes(current.state)){
      root.append(button('刷新本轮事项',async()=>{await api(`/api/decision-packages/${current.id}/refresh`,{expectedRevision:current.revision});await open(current.id);}));
      if(getState()?.actor.role!=='viewer')root.append(button('归档本批（保留证据与历史）',async()=>{if(!reason.value.trim())throw new Error('归档请填写理由');await api(`/api/decision-packages/${current.id}/archive`,{expectedRevision:current.revision,candidateHash:s.candidateHash,reason:reason.value});await refresh();await open(current.id);}));
      if(getState()?.actor.role!=='viewer')root.append(button('统一提交决定并继续',async()=>{
        if(s.identities.some(g=>g.decision==='pending')&&!choose.value)throw new Error('请明确本批身份决定；可展开设置单组例外');
        if(s.events.length&&!accept.checked)throw new Error('请明确是否保留本轮重大事件，或先在计划中修正');
        const selected=Object.fromEntries([...overrides].filter(([,el])=>el.value).map(([key,el])=>[key,{decision:el.value}]));
        const result=await api(`/api/decision-packages/${current.id}/submit`,{expectedRevision:current.revision,candidateHash:s.candidateHash,reason:reason.value,...(choose.value?{identityDecision:choose.value,overrides:selected}:{}),...(accept.checked?{eventHash:s.eventHash}:{})});
        await refresh();await open(result.id);notice(result.state==='built'?'本轮决定与构建已完成。':'已保存当前有效决定，请处理新增或失效事项；不会重复调用模型。');
      }));
    }
    $('#decision-packages').scrollIntoView({block:'start'});
  }
  function update(state){
    const list=$('#connection-list');list.replaceChildren();
    list.append(node('p','首次原生多表构建会逐表分析、统一协调并逐表生成映射，可能包含多次模型调用；已批准且结构兼容的映射可本地复用，所有新计划仍重新预检并集中处理重大事项。'));
    for(const c of state.connections??[]){
      const row=node('div');row.append(node('strong',`${c.name} · ${c.enabled?'已启用':'已停用'} · r${c.revision}`));
      row.append(button('查看可见目录',async()=>{$('#connection-directory').textContent=JSON.stringify(await api(`/api/connections/${c.id}/catalog`),null,2);}));
      if(c.enabled&&state.actor.role!=='viewer'){
        for(const [construct,text]of [[false,'采集来源（不调用模型）'],[true,'采集并推进构建（必要时使用模型）']])row.append(button(text,async()=>{await api(`/api/connections/${c.id}/sync`,{operationId:crypto.randomUUID(),construct});await refresh();notice('后台来源任务已入队；失败不会隐式重试模型。');}));
        if(state.actor.role==='admin')row.append(button('停用后续采集',async()=>{await api(`/api/connections/${c.id}/revoke`,{expectedRevision:c.revision});await refresh();}));
      }
      list.append(row);
    }
    const packs=$('#decision-package-list');packs.replaceChildren();
    for(const p of state.decisionPackages??[])packs.append(button(`${p.state} · ${p.id.slice(0,8)}`,()=>open(p.id)));
  }
  $('#connect-mysql').addEventListener('submit',event=>{
    event.preventDefault();const form=new FormData(event.target),password=String(form.get('password'));event.target.elements.password.value='';
    const url=`mysql://${encodeURIComponent(String(form.get('user')))}:${encodeURIComponent(password)}@${form.get('host')}:${Number(form.get('port'))}/${encodeURIComponent(String(form.get('database')))}`;
    const input={operationId:crypto.randomUUID(),name:form.get('name'),config:{url,tls:form.get('tls')},tables:String(form.get('tables')||'').split(',').map(s=>s.trim()).filter(Boolean)};
    void (async()=>{try{const c=await api('/api/connections',input);await api(`/api/connections/${c.id}/sync`,{operationId:crypto.randomUUID(),construct:form.get('construct')==='on'});await refresh();notice('连接已保存，后台开始采集；本体和身份事项会集中呈现。');}catch(e){notice(e.message,true);}})();
  });
  return {open,update};
}

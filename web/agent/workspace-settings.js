const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);if(className)node.className=className;return node;};
const button=(text,run)=>{const node=el('button',text,'quiet-button');node.type='button';node.onclick=run;return node;};
const field=(label,type='text')=>{const root=el('label',label),input=el('input');input.type=type;root.append(input);return{root,input};};

export function createWorkspaceSettings({api,state,label,model,capabilities,ask,actor=()=>state().actor,login,logout}){
 const dialog=el('dialog',undefined,'settings-dialog workspace-settings');dialog.setAttribute('aria-label','设置');
 const head=el('div',undefined,'dialog-heading'),content=el('div'),status=el('p',undefined,'settings-status');status.setAttribute('role','status');
 head.append(el('h2','设置'),button('关闭',()=>dialog.close()));dialog.append(head,status,content);document.body.append(dialog);
 let busy=false,generation=0;
 function message(text){status.textContent=text;status.hidden=!text;}
 async function perform(run){if(busy)return;busy=true;message('正在处理…');const controls=[...dialog.querySelectorAll('input,button,select,textarea')].map(node=>[node,node.disabled]);controls.forEach(([node])=>node.disabled=true);try{await run();}catch(error){message(error.message);}finally{busy=false;for(const [node,disabled]of controls)if(node.isConnected)node.disabled=disabled;}}
 function section(title){const root=el('section',undefined,'capability-section');root.append(el('h3',title));content.append(root);return root;}
 const roleName=role=>({admin:'管理员',maintainer:'维护者',viewer:'查看者'})[role]||'未知角色';
 const amount=value=>typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('zh-CN',{maximumFractionDigits:12}):'未知';
 const usd=value=>typeof value==='number'&&Number.isFinite(value)?`$${amount(value)}`:'未知';
 function identity(){
  const current=actor(),root=section('当前身份');root.append(el('strong',current?.name||'尚未登录'),el('p',roleName(current?.role)));
  if(login)root.append(button('切换登录',()=>{dialog.close();login();}));
  if(logout)root.append(button('退出登录',()=>void perform(async()=>{await logout();dialog.close();})));
 }
 function usageSection(usage,admin){
  const root=section('模型用量与成本');
  if(!usage?.policy){root.append(el('p','用量暂不可读取，未将未知用量记为零。'));return;}
  const pending=usage.runs?.some(run=>run.status==='running'||run.content?.accounting==='pending');
  for(const [title,summary]of [['本日',usage.today],['本月',usage.month]]){
   const row=el('div',undefined,'capability-row');row.append(el('strong',title));
   if(!summary){row.append(el('p','用量未知'));root.append(row);continue;}
   const incomplete=summary.unknownRuns>0||pending,tokenText=incomplete&&summary.tokens===0?'token 用量尚未确认':`已记录 ${amount(summary.tokens)} token`,costText=incomplete&&summary.costUsd===0?'尚未确认':usd(summary.costUsd);
   row.append(el('p',`${tokenText}；${summary.estimatedCost?'估算费用':'费用'}：${costText}（美元）`));
   row.append(el('small',`运行 ${amount(summary.runs)} 次${summary.unknownRuns?`，其中 ${amount(summary.unknownRuns)} 次用量未确认；以上 token 仅为已知部分，费用总额未知`:''}`));
   if(summary.costUsd===null&&typeof summary.knownCostUsd==='number')row.append(el('p',`已确认的费用部分：${usd(summary.knownCostUsd)}，不能代替总费用。`));
   root.append(row);
  }
  if(pending)root.append(el('p','仍有运行尚未返回完整用量；上方只展示已收到的记录。'));
  root.append(el('p',usage.limitsNote||'未收到的用量保持未知。'));
  const policy=usage.policy,limit=value=>value===null?'未设上限':amount(value);
  root.append(el('p',`统计时区：${policy.timeZone}；每轮：${limit(policy.perRun.tokens)} token / ${policy.perRun.usd===null?'未设费用上限':usd(policy.perRun.usd)}；每日：${limit(policy.daily.tokens)} token / ${policy.daily.usd===null?'未设费用上限':usd(policy.daily.usd)}。`));
  const recent=el('details');recent.append(el('summary','最近运行的实际用量'));
  for(const run of (usage.runs||[]).slice(0,20)){
   const value=run.content||{},reading=value.usage,row=el('div',undefined,'capability-row'),statusName=({running:'运行中',completed:'已完成',stopped:'已停止',failed:'失败',interrupted:'中断'})[run.status]||'状态未知';
   row.append(el('strong',run.title||'助手运行'),el('p',`${value.provider||'未知提供方'} / ${value.model||'未知模型'} · ${statusName}`));
   row.append(el('p',reading?`已记录 ${amount(reading.totalTokens)} token；${reading.estimatedCost?'估算费用':'费用'} ${usd(reading.costUsd)}`:'尚无可核对用量，费用未知'));
   if(value.accounting==='unknown')row.append(el('p','本轮用量未完全确认，已记录部分不代表总用量。'));
   if(value.error)row.append(el('p',value.error));recent.append(row);
  }
  if(!usage.runs?.length)recent.append(el('p','尚无运行用量记录。'));root.append(recent);
  if(!admin)return;
  const editor=el('details');editor.append(el('summary','设置用量上限与自定义费率'));const form=el('form'),zone=field('统计时区');zone.input.value=policy.timeZone;zone.input.required=true;
  const cap=(label,value,integer)=>{const item=field(label,'number');item.input.min='0';item.input.step=integer?'1':'any';item.input.max=integer?'1000000000':'1000000';item.input.placeholder='留空表示不设上限';item.input.value=value===null?'':String(value);return item;};
  const runTokens=cap('每轮 token 上限',policy.perRun.tokens,true),runUsd=cap('每轮美元上限',policy.perRun.usd,false),dayTokens=cap('每日 token 上限',policy.daily.tokens,true),dayUsd=cap('每日美元上限',policy.daily.usd,false);
  form.append(zone.root,runTokens.root,runUsd.root,dayTokens.root,dayUsd.root,el('p','达到上限后停止后续调用；已经发出的请求仍可能产生费用。留空不设上限，填写 0 会阻止新调用。'));
  const rateRows=[],rates=el('div');form.append(el('h4','自定义费率（美元 / 百万 token）'),el('p','未配置时使用模型已知费率；没有可核对费率时费用显示未知，不按文本长度推算。'),rates);
  function addRate(value={}){
   const row=el('fieldset'),provider=field('提供方'),name=field('模型'),input=field('输入费率','number'),output=field('输出费率','number'),cacheRead=field('缓存读取费率（可选）','number'),cacheWrite=field('缓存写入费率（可选）','number');
   row.append(el('legend','模型费率'));provider.input.value=value.provider||'';provider.input.required=true;provider.input.maxLength=100;name.input.value=value.model||'';name.input.required=true;name.input.maxLength=200;
   for(const [control,key,required]of [[input,'inputPer1M',true],[output,'outputPer1M',true],[cacheRead,'cacheReadPer1M',false],[cacheWrite,'cacheWritePer1M',false]]){control.input.min='0';control.input.step='any';control.input.required=required;control.input.value=value[key]===undefined?'':String(value[key]);}
   const item={row,provider,name,input,output,cacheRead,cacheWrite};rateRows.push(item);row.append(provider.root,name.root,input.root,output.root,cacheRead.root,cacheWrite.root,button('移除此费率',()=>{rateRows.splice(rateRows.indexOf(item),1);row.remove();}));rates.append(row);
  }
  for(const rate of policy.rates||[])addRate(rate);
  form.append(button('添加模型费率',()=>{if(rateRows.length>=100){message('最多设置 100 个模型费率。');return;}addRate();}));
  const save=el('button','保存用量策略','primary-button');save.type='submit';form.append(save);
  const optional=item=>item.input.value.trim()===''?null:Number(item.input.value);
  form.onsubmit=event=>{event.preventDefault();if(!form.reportValidity())return;const request={operationId:crypto.randomUUID(),timeZone:zone.input.value.trim(),perRun:{tokens:optional(runTokens),usd:optional(runUsd)},daily:{tokens:optional(dayTokens),usd:optional(dayUsd)},rates:rateRows.map(item=>({provider:item.provider.input.value.trim(),model:item.name.input.value.trim(),inputPer1M:Number(item.input.input.value),outputPer1M:Number(item.output.input.value),...(item.cacheRead.input.value.trim()?{cacheReadPer1M:Number(item.cacheRead.input.value)}:{}),...(item.cacheWrite.input.value.trim()?{cacheWritePer1M:Number(item.cacheWrite.input.value)}:{})}))};void perform(async()=>{await api('/api/usage/policy',request);await open();message('用量策略已保存。');});};editor.append(form);root.append(editor);
 }
 function usersSection(users){
  const root=section('本地用户与角色');root.append(el('p','管理员管理全部设置；维护者接入来源、构建并采用变更；查看者只浏览和问答。修改账号后，该账号已有登录会失效。'));
  if(!Array.isArray(users)){root.append(el('p','用户列表暂不可读取。'));return;}
  function roleSelect(value){const label=el('label','角色'),input=el('select');for(const role of ['viewer','maintainer','admin']){const option=el('option',roleName(role));option.value=role;input.append(option);}input.value=value;label.append(input);return{root:label,input};}
  for(const user of users){
   const row=el('details');row.append(el('summary',`${user.name} · ${user.username} · ${roleName(user.role)} · ${user.enabled?'启用':'停用'}`));
   const form=el('form'),name=field('显示名称'),role=roleSelect(user.role),enabled=field('启用账号','checkbox'),password=field('设置新密码（留空保留）','password');
   name.input.value=user.name;name.input.required=true;name.input.maxLength=100;enabled.input.checked=user.enabled;password.input.autocomplete='new-password';password.input.minLength=10;password.input.maxLength=200;
   const save=el('button','保存用户修改','primary-button');save.type='submit';form.append(name.root,role.root,enabled.root,password.root,save);row.append(form);root.append(row);
   form.onsubmit=event=>{event.preventDefault();if(!form.reportValidity())return;const request={id:user.id,version:user.version,operationId:crypto.randomUUID(),name:name.input.value.trim(),role:role.input.value,enabled:enabled.input.checked,...(password.input.value?{password:password.input.value}:{})};void perform(async()=>{try{await api('/api/users/update',request);password.input.value='';if(user.id===actor()?.id){message('当前账号已修改，原登录已失效，请重新登录。');return;}await open();message('用户已更新；原登录会话已失效。');}finally{password.input.value='';if(request.password)request.password='';}});};
  }
  if(!users.length)root.append(el('p','尚未创建本地账号。'));
  const add=el('details');add.append(el('summary','创建本地账号'));const form=el('form'),username=field('用户名'),name=field('显示名称'),password=field('初始密码（至少 10 位）','password'),role=roleSelect('viewer');
  username.input.required=true;username.input.pattern=String.raw`[a-zA-Z0-9][a-zA-Z0-9_.@\-]{1,79}`;username.input.minLength=2;username.input.maxLength=80;username.input.autocomplete='off';username.input.autocapitalize='none';name.input.required=true;name.input.maxLength=100;password.input.required=true;password.input.minLength=10;password.input.maxLength=200;password.input.autocomplete='new-password';
  const create=el('button','创建账号','primary-button');create.type='submit';form.append(username.root,name.root,password.root,role.root,create);add.append(form);root.append(add);
  form.onsubmit=event=>{event.preventDefault();if(!form.reportValidity())return;const request={operationId:crypto.randomUUID(),username:username.input.value.trim(),name:name.input.value.trim(),password:password.input.value,role:role.input.value};void perform(async()=>{try{await api('/api/users/create',request);await open();message('账号已创建，可使用用户名和密码登录。');}finally{password.input.value='';request.password='';}});};
 }
 function render(settings,credentials,usage,users){
  content.replaceChildren();identity();const role=actor()?.role,admin=role==='admin';usageSection(usage,admin);
  if(role==='viewer'||!role)return;
  if(admin)usersSection(users);
  if(admin){
  const connections=section('模型与能力');connections.append(button('连接模型',()=>{dialog.close();model();}),button('管理 Agent 能力',()=>{dialog.close();capabilities();}));}
  const enterprise=section('企业资料'),profile=state().profile;
  for(const statement of profile?.content?.statements||[]){if(!statement.text)continue;const item=el('div',undefined,'capability-row');item.append(el('strong',label(statement.key)),el('p',statement.text),el('small',statement.origin==='suggestion'?'待核实建议':statement.userEdited?'已由人工确认':'按保存的资料记录'));enterprise.append(item);}
  if(!profile?.content?.statements?.length)enterprise.append(el('p','尚未保存企业资料。可向构建助手介绍企业，或接入相关文档。'));
  enterprise.append(button('让助手更新企业资料',()=>{dialog.close();ask('请核对当前企业资料和真实依据，提出需要补充或修正的陈述，预览后交给我采用。');}));
  if(!admin)return;
  if(!settings||!credentials){section('凭据与数据保留').append(el('p','设置暂不可读取，请重新打开设置。'));return;}
  const security=section('凭据与数据保留');security.append(el('p',({ready:'凭据已加密保存。',empty:'尚无已保存凭据。',locked:'凭据库已锁定，需要恢复本机密钥或解锁系统钥匙串。'})[credentials.status]||'凭据状态未知。'));
  if(credentials.provider)security.append(el('p',credentials.provider==='keychain'?'加密密钥由系统钥匙串管理。':'加密密钥保存在工作区外的本机私有目录。'));
  security.append(el('p','被发布或工作版本引用的快照和已引用的文档正文会保留。上传原件过期后清理，已保存的数据快照继续可查。'));
  const form=el('form'),raw=field('上传原文保留天数','number'),versions=field('每来源保留的最近快照版本数','number');raw.input.value=settings.rawDays;raw.input.min='1';raw.input.max='36500';versions.input.value=settings.snapshotVersions;versions.input.min='1';versions.input.max='100';
  const save=el('button','保存保留策略','primary-button');save.type='submit';form.append(raw.root,versions.root,save);form.onsubmit=event=>{event.preventDefault();void perform(async()=>{await api('/api/settings/retention',{rawDays:Number(raw.input.value),snapshotVersions:Number(versions.input.value)});message('保留策略已保存；每日自动清理一次。');});};security.append(form);
  const cleanup=el('div');security.append(button('查看可清理内容',()=>void perform(async()=>{const plan=await api('/api/settings/retention/preview');cleanup.replaceChildren(el('p',`可清理 ${plan.originals.length} 个来源版本的过期原文或原件、${plan.snapshots.length} 个未被引用的旧快照；${plan.protectedTextVersions} 个正文版本受到引用保护。`));if(plan.originals.length||plan.snapshots.length){const operationId=crypto.randomUUID();cleanup.append(button('确认清理这些过期内容',()=>void perform(async()=>{await api('/api/settings/retention/run',{operationId});cleanup.replaceChildren(el('p','清理已完成。'));message('过期内容已清理。');})));}message('');})),cleanup);
  const backup=section('备份与恢复');backup.append(el('p','备份包含工作区数据库、受管快照、原件和配置，并校验文件完整性。凭据与机器密钥不包含在内。'));
  const destination=field('备份保存到目录');destination.input.placeholder='/绝对路径/备份';let backupId=crypto.randomUUID();destination.input.oninput=()=>{backupId=crypto.randomUUID();};backup.append(destination.root,button('创建工作区备份',()=>void perform(async()=>{if(!destination.input.value.startsWith('/'))throw new Error('请填写工作区之外的绝对目录路径。');const result=await api('/api/backup',{destination:destination.input.value,operationId:backupId});message(`备份已完成：${result.path}（${result.manifest.files.length} 个文件，未包含凭据）。`);})));
  const exportPath=field('配置导出到新文件');exportPath.input.placeholder='/绝对路径/配置.json';backup.append(exportPath.root,button('导出无凭据配置',()=>void perform(async()=>{if(!exportPath.input.value.startsWith('/'))throw new Error('请填写新的绝对文件路径。');const result=await api('/api/backup/config',{destination:exportPath.input.value});message(`配置已导出：${result.path}。`);})));
  const restore=el('details');restore.append(el('summary','从备份恢复到新工作区'));const source=field('备份包目录'),target=field('全新的恢复目录');source.input.placeholder='/绝对路径/ade-backup-…';target.input.placeholder='/绝对路径/新工作区';restore.append(source.root,target.root,el('p','恢复会创建新目录，不会替换当前工作区。恢复后上游来源、模型和 MCP 需要重新配置凭据；已有消费授权不会自动轮换。'),button('校验并恢复到新目录',()=>void perform(async()=>{if(!source.input.value.startsWith('/')||!target.input.value.startsWith('/'))throw new Error('备份和恢复目录都需要绝对路径。');const result=await api('/api/restore',{backup:source.input.value,destination:target.input.value});message(`新工作区已恢复到 ${result.directory}。可使用该目录启动 ADE；当前工作区仍在运行。上游连接需要重新授权。`);})));backup.append(restore);
 }
 async function open(){
  const request=++generation;if(!dialog.open)dialog.showModal();content.replaceChildren();message('正在读取设置…');
  const admin=actor()?.role==='admin',jobs=[['usage',()=>api('/api/usage')],...(admin?[['retention',()=>api('/api/settings/retention')],['users',()=>api('/api/users')]]:[])];
  const results=await Promise.allSettled(jobs.map(([,run])=>run()));if(request!==generation||!dialog.open)return;
  const values={},errors=[];results.forEach((result,index)=>{if(result.status==='fulfilled')values[jobs[index][0]]=result.value;else errors.push(result.reason?.message||'部分设置读取失败');});
  render(values.retention?.settings,values.retention?.credentials,values.usage,values.users?.users);message(errors.join('；'));
 }
 dialog.oncancel=event=>{if(busy)event.preventDefault();};dialog.onclose=()=>{generation++;content.replaceChildren();};
 return{open};
}

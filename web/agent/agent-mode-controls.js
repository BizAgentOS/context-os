const el=(tag,text)=>{const element=document.createElement(tag);if(text)element.textContent=text;return element;};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

/** These controls bind the next message; a running message retains its saved mode and view. */
export function createAgentModeControls({ui,api,onChange,disabled}){
 const root=el('div');root.className='agent-mode-slot';
 const modeLabel=el('label','助手模式'),mode=el('select');mode.setAttribute('aria-label','助手模式');
 for(const [value,text]of [['build','构建助手'],['qa','问答助手']]){const option=el('option',text);option.value=value;mode.append(option);}modeLabel.append(mode);
 const viewLabel=el('label','数据视图'),view=el('select');view.setAttribute('aria-label','问答数据视图');viewLabel.append(view);
 const status=el('span');status.className='engine-muted';status.setAttribute('role','status');root.append(modeLabel,viewLabel,status);
 let options=[{value:{kind:'working'},label:'工作版'}],loading=false,loaded=false;
 const save=()=>{ui.preferCurrentRelease=false;ui.pendingReference=null;ui.continuationRunId=null;onChange();};
 mode.onchange=()=>{ui.agentMode=mode.value;if(mode.value==='build')ui.dataView={kind:'working'};save();render();};
 view.onchange=()=>{const selected=options[Number(view.value)];if(!selected)return;ui.dataView=structuredClone(selected.value);save();};
 async function load(){
  if(loading||disabled())return;loading=true;status.textContent='正在核对可用视图…';
  try{const data=await api('/api/qa/views');options=[{value:{kind:'working'},label:'工作版'},...data.releases.map(item=>({value:{kind:'release',releaseRef:item.ref},label:`发布 · ${item.title}`})),...data.connections.map(item=>({value:{kind:'consumer',releaseRef:item.releaseRef,connectionRef:item.ref},label:`接入方 · ${item.title}`}))];if(ui.preferCurrentRelease&&ui.page==='consumption'&&ui.agentMode==='qa'){ui.preferCurrentRelease=false;if(data.currentReleaseRef)ui.dataView={kind:'release',releaseRef:data.currentReleaseRef};onChange();}loaded=true;status.textContent='';render();}
  catch(error){status.textContent=error.message;}finally{loading=false;}
 }
 mode.addEventListener('focus',()=>void load());view.addEventListener('focus',()=>void load());
 function render(){
  root.hidden=disabled();mode.value=ui.agentMode||'build';viewLabel.hidden=mode.value!=='qa';
  view.replaceChildren();for(const [index,item]of options.entries()){const option=el('option',item.label);option.value=String(index);view.append(option);}
  let selected=options.findIndex(item=>equal(item.value,ui.dataView||{kind:'working'}));
  if(selected<0){const option=el('option','此前选择的视图（发送时重新核对权限）');option.value=String(options.length);view.append(option);selected=options.length;}
  view.value=String(selected);if((!loaded||ui.preferCurrentRelease)&&mode.value==='qa')void load();
 }
 return{root,render,refresh:load};
}

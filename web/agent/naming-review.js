import {el,action,field,transact} from './engine-ui.js';

/** Edits change the reviewed candidate; only the shared change controls can adopt the whole batch. */
export function renderNamingReview(candidate,{api,reload,output,container,editable}){
 const root=el('section',null,'naming-review');root.append(el('h4','逐项核对业务名称'),el('p',editable?'编辑后需要重新复验；整批采用前，当前名称保持不变。':'此批次已处理，以下保留当时的审阅内容。','engine-muted'));
 for(const item of candidate.content.items||[]){
  const row=el('section',null,'engine-panel'),proposed=item.proposed||{},before=item.before||{};
  row.append(el('h5',`${({concept:'实体',property:'属性',relation:'关系',pending_relation:'待采用关系'})[item.target]||'业务对象'} · ${before.name||item.name}`));
  if(item.fromLabel||item.toLabel)row.append(el('p',`${item.fromLabel} → ${proposed.name||item.name} → ${item.toLabel}`));
  if(item.deferred)row.append(el('p','这里只确认待采用关系的文字；关系结构仍需另行复验与采用。','engine-muted'));
  row.append(el('p',`原名称：${before.name||item.name}；原说明：${before.description||'暂无'}`),el('p',`建议名称：${proposed.name||item.name}；别名：${(proposed.aliases||[]).join('、')||'无'}`),el('p',proposed.description||'暂无说明'),el('p',proposed.evidence||'','engine-muted'));
  if(item.protected)row.append(el('p','名称已由人工确认，继续保留。','engine-muted'));
  if(editable&&candidate.status==='candidate')row.append(action('编辑此项',()=>{
   const editor=el('div');row.replaceChildren(el('h5',`编辑：${before.name||item.name}`),editor);
   const name=field(editor,'名称',proposed.name||item.name),aliases=field(editor,'别名（每行一个）',(proposed.aliases||[]).join('\n'),true),description=field(editor,'说明',proposed.description||'',true);
   name.disabled=item.protected===true;
   editor.append(action('保存此项',()=>transact(container,output,async()=>{
    await api('/api/naming/batches/edit',{id:candidate.id,version:candidate.version,items:[{key:item.key,name:name.value,aliases:aliases.value.split('\n').map(value=>value.trim()).filter(Boolean),description:description.value}]});
    await reload(true);
   }),'engine-primary'),action('取消编辑',()=>reload()));
  }));
  root.append(row);
 }
 return root;
}

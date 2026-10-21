import {safeText,displayValue} from './ui-display.js';

const node=(tag,text,className)=>{const item=document.createElement(tag);if(text!==undefined)item.textContent=safeText(text);if(className)item.className=className;return item;};
const button=(text,handler)=>{const item=node('button',text);item.type='button';item.onclick=handler;return item;};
const svgNode=(tag,attributes={})=>{const item=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value]of Object.entries(attributes))item.setAttribute(key,String(value));return item;};
const unique=values=>[...new Set(values.filter(Boolean))];
const traces=entry=>(entry.paths||[]).flatMap(result=>(result.traces||[]).map(trace=>({...trace,coverage:result.coverage})));

/** Only the immutable answer receipt supplies objects, paths and labels. This module never fetches data. */
export function answerHighlights(entry,trace){
 const selected=trace?[trace]:traces(entry),relations=entry.relations||[],query=entry.query||{},entityIds=[query.target?.entityTypeId];
 let current=query.target?.entityTypeId;
 for(const step of query.traverse||[]){const relation=relations.find(item=>item.id===step.relationTypeId);if(!relation)break;current=step.direction==='in'?relation.from:relation.to;entityIds.push(current);}
 return {readId:entry.readId,targetEntityTypeId:current,entityTypeIds:unique([...entityIds,...selected.flatMap(item=>item.entityTypeIds||[])]),relationTypeIds:unique(selected.length?selected.flatMap(item=>item.relationTypeIds||[]):(query.traverse||[]).map(step=>step.relationTypeId).filter(id=>relations.some(item=>item.id===id))),
   objects:selected.length?selected.flatMap(item=>item.objectIds.map((id,index)=>({entityTypeId:item.entityTypeIds[index],id}))):(query.aggregate?(entry.groupMembers||[]).flatMap(group=>group.items||[]):entry.resultSet||[]).map(item=>({entityTypeId:current,id:item.$id})),paths:selected,missing:entry.missing?{...entry.missing,from:entry.missing.from||current}:null};
}

export function renderAnswerVisualization(answer,{onHighlight=()=>{},onExit=()=>{}}={}){
 const entries=structuredClone(answer.visualization||[]),root=node('section',undefined,'answer-visualization');root.setAttribute('aria-label','本轮回答的数据与路径');
 const style=node('style');style.textContent='.answer-visualization{display:grid;gap:14px;min-width:0;padding:16px;border:1px solid #36536a;border-radius:16px;background:#102330;color:#e6edf2}.answer-visualization h3,.answer-visualization h4,.answer-visualization p{margin:0}.answer-visualization header,.answer-visualization nav{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.answer-visualization header h3{flex:1}.answer-visualization button{color:inherit;background:#1b3546;border:1px solid #57758a;border-radius:8px;padding:7px 10px;cursor:pointer}.answer-visualization button[aria-pressed=true]{background:#315878;border-color:#9bd4f7}.answer-visualization .av-output{display:grid;gap:14px}.answer-visualization .av-scroll{max-width:100%;overflow:auto}.answer-visualization table{width:100%;border-collapse:collapse;text-align:left}.answer-visualization th,.answer-visualization td{padding:8px;border-bottom:1px solid #36536a;vertical-align:top;overflow-wrap:anywhere}.answer-visualization .av-muted{font-size:.85rem;color:#b7cad7}.answer-visualization .av-warning{border-left:3px solid #edb66c;padding:8px;color:#ffe1b6}.answer-visualization .av-path{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px;background:#0b1c28;border-radius:10px}.answer-visualization .av-path span{font-size:.85rem;color:#b7cad7}.answer-visualization .av-missing{width:100%;min-width:300px;height:150px}.answer-visualization .av-group{display:grid;gap:8px;padding:10px;background:#0b1c28;border-radius:10px}@media(max-width:700px){.answer-visualization{padding:10px}.answer-visualization button{min-height:40px}.answer-visualization th,.answer-visualization td{padding:6px}}';root.append(style);
 const header=node('header'),title=node('h3','本轮答案'),tabs=node('nav'),output=node('div',undefined,'av-output');tabs.setAttribute('aria-label','选择实际读取结果');
 let disposed=false;
 const exit=()=>{if(disposed)return;disposed=true;onHighlight(null);onExit();};header.append(title,button('返回普通浏览',exit));root.append(header,tabs,output);
 const label=(entry,id,fallback='未命名')=>entry.labels?.[id]||entry.entities?.find(item=>item.id===id)?.name||entry.relations?.find(item=>item.id===id)?.name||fallback;
 const coverage=(parent,value,prefix='结果')=>parent.append(node('p',value?`${prefix}：本轮显示 ${value.shown??'未知'} 条${value.total==null?'':`，共 ${value.total} 条`}；${value.complete?'当前范围完整':'仅当前已读范围，未覆盖部分未展示'}。`:`${prefix}覆盖范围未报告。`,'av-muted'));
 function resultTable(entry,items,parent,{members=false,onGroup}={}){
  const keys=unique(items.flatMap(item=>Object.keys(item.values||{}))),wrap=node('div',undefined,'av-scroll'),table=node('table'),head=node('thead'),tr=node('tr');
  tr.append(node('th',members?'对象':'记录'));for(const key of keys)tr.append(node('th',label(entry,key,key)));head.append(tr);table.append(head);
  const body=node('tbody');for(const item of items){const row=node('tr'),first=node('td');
   if(onGroup)first.append(button('查看分组明细',()=>onGroup(item)));else first.textContent=safeText(item.$id);
   row.append(first);for(const key of keys){const state=item.status?.[key],cell=node('td',displayValue(item.values?.[key]));if(state&&state!=='resolved')cell.append(node('small',` · ${{conflict:'来源冲突',uncertain:'尚未确定',missing:'无可用值'}[state]||'待核对'}`));row.append(cell);}body.append(row);
  }table.append(body);wrap.append(table);parent.append(wrap);if(!items.length)parent.append(node('p','本轮没有返回记录。'));
 }
 function missing(entry){
  const highlight=answerHighlights(entry),box=node('section'),svg=svgNode('svg',{viewBox:'0 0 460 150',class:'av-missing',role:'img','aria-label':'当前回答缺失的关系'});
  svg.append(svgNode('line',{x1:100,y1:65,x2:360,y2:65,stroke:'#ff8e91','stroke-width':3,'stroke-dasharray':'8 7'}));
  for(const [x,text]of [[90,label(entry,highlight.missing?.from,'问题起点')],[370,'待确定的对应']]){svg.append(svgNode('circle',{cx:x,cy:65,r:30,fill:'#143044',stroke:'#ff8e91'}));const caption=svgNode('text',{x,y:120,fill:'#e6edf2','text-anchor':'middle'});caption.textContent=safeText(text);svg.append(caption);}
  const caption=svgNode('text',{x:230,y:40,fill:'#ffb6b9','text-anchor':'middle'});caption.textContent='缺少可验证的连接';svg.append(caption);box.append(svg);
  box.append(node('p',({missing_relation:'本体尚无所需关系，需要建模后复问。',unbound:'对象或关系已定义，尚无可读取的数据绑定。',unmatched:'关系已绑定，本次读取没有匹配到目标。',identity_unresolved:'身份对应尚未确定，不能选择任意目标。'})[entry.missing.reason]||'当前读取不能确认此连接。','av-warning'));output.append(box);
 }
 function select(index){
  if(disposed)return;const entry=entries[index];output.replaceChildren();for(const [i,tab]of [...tabs.children].entries())tab.setAttribute('aria-pressed',String(i===index));
  onHighlight(answerHighlights(entry));output.append(node('p','展示本轮实际回执；浏览时不会重新读取数据。','av-muted'));
  const query=entry.query||{},conditions=(query.filters||[]).map(item=>`${label(entry,item.propertyId)} ${{eq:'等于',ne:'不等于',gt:'大于',gte:'不小于',lt:'小于',lte:'不大于',contains:'包含',is_null:'为空',not_null:'不为空'}[item.op]}${item.value===undefined?'':` ${displayValue(item.value)}`}`);
  if(conditions.length)output.append(node('p',`查询条件：${conditions.join('；')}`));
  if(query.sort?.length)output.append(node('p',`排序：${query.sort.map(item=>`${label(entry,item.propertyId)} ${item.direction==='desc'?'降序':'升序'}`).join('；')}`));
  if(entry.missing)missing(entry);
  const actualPaths=traces(entry);if(actualPaths.length){output.append(node('h4','逐跳路径'));
   for(const path of actualPaths){const line=node('div',undefined,'av-path');line.append(button('高亮此路径',()=>onHighlight(answerHighlights(entry,path))));
    path.objectIds.forEach((id,i)=>{if(i){const relation=entry.relations?.find(item=>item.id===path.relationTypeIds[i-1]),reverse=relation&&relation.from!==path.entityTypeIds[i-1];line.append(node('span',`${reverse?'←':'→'} ${label(entry,path.relationTypeIds[i-1],'相连')} ${reverse?'←':'→'}`));}line.append(node('strong',`${label(entry,path.entityTypeIds[i],'对象')} · ${id}`));});output.append(line);
   }
   if((entry.paths||[]).some(path=>path.coverage?.complete===false))output.append(node('p','每个结果最多展示 20 条实际路径，更多路径未展开。','av-warning'));
  }
  const groups=node('div',undefined,'av-group');
  resultTable(entry,entry.resultSet||[],output,{onGroup:query.aggregate?item=>{
   groups.replaceChildren(node('h4','当前分组'));for(const id of query.aggregate.groupBy||[])groups.append(node('p',`${label(entry,id)}：${displayValue(item.values?.[id])}`));
   const retained=entry.groupMembers?.find(group=>group.groupId===item.$id);
   if(retained){resultTable(entry,retained.items,groups,{members:true});coverage(groups,retained.coverage,'分组成员');}else groups.append(node('p','本轮回执未包含成员明细。'));
   onHighlight({...answerHighlights(entry),objects:(retained?.items||[]).map(member=>({entityTypeId:answerHighlights(entry).targetEntityTypeId,id:member.$id}))});
  }:undefined});if(query.aggregate)output.append(groups);coverage(output,entry.coverage);
  if(entry.status==='partial')output.append(node('p','当前覆盖不足，不能用本轮结果代表完整范围。','av-warning'));
 }
 entries.forEach((entry,index)=>tabs.append(button(`${index+1} · ${entry.query?.aggregate?'聚合':entry.query?.traverse?.length?'关系路径':'对象列表'}`,()=>select(index))));
 if(entries.length)select(0);else output.append(node('p','本轮没有可供联动的对象回执。'));
 root.exit=exit;root.dispose=()=>{disposed=true;};return root;
}

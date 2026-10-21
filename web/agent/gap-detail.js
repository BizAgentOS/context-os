import {el,action,field,message,transact,ref,when} from './engine-ui.js';
import {technicalDetails,displayValue} from './ui-display.js';
import {renderResultTable} from './message-markdown.js';
const states={open:'待修复',in_fix:'正在修复',fixed:'修复已采用，待你复问',confirmed:'已复问确认',reopened:'复问仍有缺口',dismissed:'已忽略'};
export async function showGap(reference,actions,onChanged,container){
 const output=message(container);let gap;const operations=new Map();
 const operation=(method,body)=>{const key=JSON.stringify([method,body]);if(!operations.has(key))operations.set(key,crypto.randomUUID());return operations.get(key);};
 async function load(){const result=await actions.api(`/api/gaps/read?id=${encodeURIComponent(reference.id)}`);if(!container.isConnected)return;gap=result.gap;render();}
 async function decide(method,extra={}){
  const body={...ref(gap),...extra};const result=await actions.api(`/api/gaps/${method}`,{...body,operationId:operation(method,body)});
  await actions.refresh();await onChanged();if(!container.isConnected)return;gap=result.gap;render();
  if(method==='handoff')actions.handoffGap?.(result);
  if(method==='reask'){output.textContent=result.gap.status==='confirmed'?'原查询复问成功，缺口已确认解决。':'复问仍未得到可用结果，缺口已重新打开。';actions.reaskedGap?.(result);}
 }
 const host=el('div');container.append(host);
 function replayResult(reading){
  const result=reading.result||{},receipt=reading.receipt||{},box=el('section',null,'gap-reask-result');
  box.append(el('h3','原查询的实际复问结果'),el('p',gap.content.question||gap.title));
  box.append(el('p',reading.status==='available'?'已取得可用结果':reading.status==='partial'?'读取覆盖不足':'当前仍不能回答'));
  if(reading.message)box.append(el('p',reading.message));
  box.append(el('p',`实际读取：${when(receipt.readAt||gap.content.reaskedAt)} · ${receipt.dataView?.kind==='working'?`工作版 ${receipt.workspaceVersion??'未报告'}`:'固定发布视图'}`));
  const labels=Object.fromEntries((result.columns||[]).map(column=>[column.id,column.name]));
  const rows=(result.items||[]).map(item=>item.values?{'记录':item.$id,...Object.fromEntries(Object.entries(item.values).map(([id,value])=>[labels[id]||id,value]))}:item);
  box.append(renderResultTable({title:'本次返回的对象与数值',rows,coverage:result.coverage}));
  if(result.coverage)box.append(el('p',`已返回 ${result.coverage.shown??rows.length} 条 · 匹配总数 ${result.coverage.total??'未知'}${result.coverage.uncertainFilterRows?` · ${result.coverage.uncertainFilterRows} 条记录的过滤条件仍不确定`:''}`));
  for(const source of result.sources||[])box.append(el('p',`${source.name||'来源'} · ${source.readMode==='live'?`实时读取 ${when(source.readAt||source.dataAsOf)}`:`固定快照，数据截至 ${when(source.dataAsOf)}`} · ${source.coverage?.complete===true?'来源范围完整':'来源覆盖不足或未报告'}`));
  const evidence=el('section');evidence.append(el('h4','实际依据'));
  let count=0;
  for(const record of result.evidence||[])for(const [id,property]of Object.entries(record.properties||{})){
   count++;const item=el('div');item.append(el('p',`${record.objectId} · ${labels[id]||id}：${displayValue(property.value)} · ${{resolved:'已确定',missing:'无值',uncertain:'待核对',conflict:'有冲突'}[property.status]||'状态未报告'}`));
   for(const source of property.evidence||[])item.append(el('p',`${source.sourceTitle||'来源'} · 记录 ${displayValue(source.recordId)} · 字段 ${source.field||'未报告'} · ${when(source.readAt)}`));
   for(const binding of property.bindings||[]){const source=(result.sources||[]).find(source=>source.snapshotId===binding.snapshotId);item.append(el('p',`${source?.name||'固定来源'} · 字段 ${binding.column||'未报告'}${source?.dataAsOf?` · 数据截至 ${when(source.dataAsOf)}`:''}`));}
   if(property.correction)item.append(el('p',`已采用的属性纠正：${property.correction.reason||'未报告理由'}；依据：${property.correction.evidence||'未报告'}`));
   evidence.append(item);
  }
  for(const group of result.aggregateEvidence||[])for(const [name,measure]of Object.entries(group.measures||{})){count++;evidence.append(el('p',`${name} · 未确定 ${measure.uncertain??0} 条 · 空值 ${measure.missing??0} 条`));}
  for(const path of result.paths||[])for(const trace of path.traces||[]){count++;evidence.append(el('p',`实际关联路径：${trace.objectIds.join(' → ')}`));}
  if(!count)evidence.append(el('p','本次没有逐属性或路径依据；来源和实际覆盖以本页读取回执为准。'));
  box.append(evidence);host.append(box);
 }
 function render(){
  host.replaceChildren(el('h3',gap.title),el('p',states[gap.status]||gap.status),el('p',gap.content.observation||''));
  const reason=({missing_relation:'缺少关系定义',unbound:'数据尚未绑定',unmatched:'关系没有匹配到目标',identity_unresolved:'身份对应尚未确定'})[gap.content.reason];if(reason)host.append(el('p',`原因：${reason}`));
  const controls=el('div',null,'engine-actions');
  if(['open','reopened'].includes(gap.status)){
   controls.append(action('转到构建模式修复',()=>transact(container,output,()=>decide('handoff')),'engine-primary'));
   const reason=field(host,'忽略理由','',true);controls.append(action('忽略这个缺口',()=>transact(container,output,async()=>{if(!reason.value.trim())throw new Error('请填写忽略理由。');await decide('dismiss',{reason:reason.value.trim()});})));
  }
  if(gap.status==='in_fix')controls.append(action('继续构建修复',()=>actions.continueGap?.(gap)));
  if(gap.status==='fixed')controls.append(action('复问原查询并确认',()=>transact(container,output,()=>decide('reask')),'engine-primary'));
  for(const change of gap.content.changes||[])controls.append(action('查看修复变更',()=>window.dispatchEvent(new CustomEvent('dataengine:pending',{detail:change}))));
  controls.append(action('重新读取',()=>transact(container,output,load)));host.append(controls);
  if(gap.content.reaskReceipt)replayResult(gap.content.reaskReceipt);
  host.append(technicalDetails(gap));
 }
 try{await load();}catch(error){if(output.isConnected)output.textContent=error.message;}
}

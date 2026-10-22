import {renderMarkdown,renderResultTable} from './message-markdown.js';
import {safeText,displayValue,technicalDetails} from './ui-display.js';
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=safeText(text);if(className)node.className=className;return node;};
const time=value=>value&&!Number.isNaN(Date.parse(value))?new Date(value).toLocaleString('zh-CN'):'未报告';
export function renderAnswerCard(answer,{showAnswer,openPending}={}){
 const card=el('section',undefined,'agent-answer-card');card.setAttribute('aria-label','问答回答');
 card.append(el('h4','回答'),renderMarkdown(answer.conclusion||'本轮没有形成结论。'));
 const receipt=answer.receipt||{},view=receipt.dataView||{kind:'working'};
 card.append(el('p',view.kind==='working'?`工作版 v${receipt.workspaceVersion??'未知'}`:view.kind==='consumer'?'固定发布 · 接入方授权范围':'固定发布','answer-view'));
 const evidence=el('details');evidence.append(el('summary',`依据与回执 · ${answer.evidence?.length||0} 次读取`));
 for(const item of answer.evidence||[]){
  const box=el('section');box.append(el('h5',item.status==='available'?'实际读取结果':item.status==='partial'?'覆盖不足':'当前不能回答'));
  const result=item.result||{},labels=item.labels||{},metric=result.metricReference,definition=result.definition;
  if(metric&&definition){const aggregation=definition.aggregation||{},kind=({sum:'总量',ratio:'比率',average:'平均值',distinct_count:'去重计数',snapshot:'时点存量'})[aggregation.kind]||'按来源口径';box.append(el('h5',metric.name),el('p',`${definition.description} · 口径 ${definition.revision} · 单位 ${definition.unit} · ${definition.grain==='month'?'按月':'按日'} · 时区 ${definition.timeZone}`),el('p',`${kind}；${aggregation.timeAdditive?'来源声明可跨期加总':'不可跨期直接加总'}。固定定义，观测为本次实际读取。`));if(item.reason==='definition_only'||item.reason==='metric_definition_changed'||item.reason==='metric_unavailable')box.append(el('p',({definition_only:'来源仅开放定义，没有读取或推算指标数值。',metric_definition_changed:'来源口径已变化，旧发布不能按新口径重算；需要重新核对并采用。',metric_unavailable:'来源未返回可用观测，缺失没有记为零。'})[item.reason]));}
  const rows=(result.items||[]).map(record=>metric?{...Object.fromEntries(Object.entries(record.dimensions||{}).map(([id,value])=>[labels[id]||id,value])),'期间':`${record.periodStart}—${record.periodEnd}`,'指标值':record.value??'缺失','状态':record.status==='missing'?'缺失':record.status==='observed'?'已观测':record.status==='available'?'可用':'状态未说明','缺失说明':record.missingReason||''}:record.values?{'记录':record.$id,...Object.fromEntries(Object.entries(record.values).map(([id,value])=>[labels[id]||id,value]))}:record);
  if(rows.length||result.items)box.append(renderResultTable({title:'依据记录',rows,coverage:result.coverage,truncated:result.coverage?.sourceComplete===false}));
  for(const source of result.sources||[])box.append(el('p',`${source.name||'来源'} · 数据截至 ${time(source.dataAsOf)} · ${source.readMode==='live'?'实时读取':'固定快照'}`));
  const reading=(receipt.readings||[]).find(read=>read.readId===item.readId);if(reading)box.append(el('p',`实际读取：${time(reading.readAt)}`));
  if(item.reason)box.append(el('p',({unbound:'尚未建立可读取的数据绑定',missing_relation:'当前本体没有所需关系',unmatched:'关系尚未匹配到目标',identity_unresolved:'对象身份尚未确定',incomplete:'当前数据覆盖不足',empty:'当前完整范围没有匹配记录',out_of_scope:'对象超出当前范围'})[item.reason]||'读取范围受限'));
  if(result.evidence?.length)for(const record of result.evidence){const properties=record.properties||{};for(const [id,value]of Object.entries(properties))box.append(el('p',`${record.objectId} · ${labels[id]||id}：${displayValue(value)}`));}
  evidence.append(box);
 }
 evidence.append(technicalDetails(receipt));card.append(evidence);
 if(answer.limits?.length){card.append(el('h5','限制'));const list=el('ul');for(const limit of answer.limits)list.append(el('li',limit));card.append(list);}
 if(showAnswer&&answer.visualization?.length){const button=el('button','在图中查看');button.type='button';button.onclick=()=>showAnswer(answer);card.append(button);}
 if(openPending&&answer.gaps?.length)for(const gap of answer.gaps){const button=el('button',`查看问题缺口 · ${gap.title}`);button.type='button';button.onclick=()=>openPending(gap);card.append(button);}
 return card;
}

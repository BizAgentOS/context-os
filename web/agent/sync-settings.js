import {dialog,el,field,action,message,transact,when} from './engine-ui.js';
export async function showSyncSettings(source,actions){
 const d=dialog(`${source.title} · 同步设置`),output=message(d.body);
 try{
  const policy=await actions.api(`/api/data/sync-policy?sourceId=${encodeURIComponent(source.id)}`);if(!d.isConnected)return;
  const label=el('label','同步频率'),mode=el('select');for(const [value,title]of [['manual','手动'],['hourly','每小时'],['daily','每天'],['weekly','每周']]){const option=el('option',title);option.value=value;mode.append(option);}mode.value=policy.schedule.mode;label.append(mode);d.body.append(label);
  const time=field(d.body,'执行时间',policy.schedule.time||'02:00');time.type='time';
  const weekdayLabel=el('label','每周执行日'),weekday=el('select');for(const [value,title]of ['周日','周一','周二','周三','周四','周五','周六'].entries()){const option=el('option',title);option.value=String(value);weekday.append(option);}weekday.value=String(policy.schedule.weekday??1);weekdayLabel.append(weekday);d.body.append(weekdayLabel);
  const scheduleChanged=()=>{time.closest('label').hidden=!['daily','weekly'].includes(mode.value);weekdayLabel.hidden=mode.value!=='weekly';};mode.onchange=scheduleChanged;scheduleChanged();
  const incremental=field(d.body,'增量时间字段（可选）',policy.incrementalField||''),critical=field(d.body,'关键字段（逗号分隔）',policy.qualityThresholds.criticalFields.join('，'));
  d.body.append(el('p','未配置增量字段时完整同步；增量更新仍保留不可变快照。','engine-muted'));
  const drop=field(d.body,'记录数下降阈值（0—1）',String(policy.qualityThresholds.rowDropRatio)),nulls=field(d.body,'关键字段空值率增加阈值（0—1）',String(policy.qualityThresholds.criticalNullIncrease));for(const input of [drop,nulls]){input.type='number';input.min='0';input.max='1';input.step='0.05';}
  d.body.append(el('p',`下一次执行：${when(policy.nextRunAt)}。0行、身份键异常与超过阈值的新数据会进入待处理，确认前继续使用上一版。`));
  const operationId=crypto.randomUUID();
  d.body.append(action('保存同步设置',()=>transact(d,output,async()=>{
   const schedule={mode:mode.value,...(['daily','weekly'].includes(mode.value)?{time:time.value}:{}),...(mode.value==='weekly'?{weekday:Number(weekday.value)}:{})};
   await actions.api('/api/data/sync-policy',{sourceId:source.id,version:policy.version,schedule,incrementalField:incremental.value.trim()||null,qualityThresholds:{...policy.qualityThresholds,rowDropRatio:Number(drop.value),criticalNullIncrease:Number(nulls.value),criticalFields:critical.value.split(/[,，]/).map(value=>value.trim()).filter(Boolean)}});
   d.close();await actions.refresh();
  }),'engine-primary'));
 }catch(error){if(output.isConnected)output.textContent=error.message;}
}

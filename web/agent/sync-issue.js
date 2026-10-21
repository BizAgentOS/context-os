import {el,action,message,field,table,transact,ref} from './engine-ui.js';
export async function showSyncIssue(reference,actions,onChanged,container){
 const output=message(container);try{
  const {issue}=await actions.api(`/api/data/issues/read?id=${encodeURIComponent(reference.id)}`);if(!container.isConnected)return;
  container.append(el('h3',issue.title),el('p','新数据尚未生效；已有发布与当前对象继续使用原快照。'));
  container.append(table(issue.content.reasons||[],[['需要核对',item=>item.message]]));
  const dataset=issue.content.datasetRef;
  if(dataset&&issue.content.snapshotId){
   const before=el('section'),after=el('section');before.append(el('h4','当前采用的数据'));after.append(el('h4','等待确认的新数据'));container.append(before,after);
   const show=async(parent,snapshotId)=>{try{const result=await actions.api(`/api/data/preview?${new URLSearchParams({datasetId:dataset.id,...(snapshotId?{snapshotId}:{}),limit:'3'})}`);if(!container.isConnected)return;parent.append(el('p',`显示 ${result.rows.length} 条样本，共 ${result.total} 条`),table(result.rows,result.rows.length?Object.keys(result.rows[0]).map(key=>[key,row=>row[key]]):[]));}catch(error){if(container.isConnected)parent.append(el('p',error.message));}};
   void show(before);void show(after,issue.content.snapshotId);
  }
  const reason=field(container,'决定理由','',true),operations=new Map();
  for(const [decision,title]of [['retain','保留当前数据'],['accept','确认并使用新数据']]){
   if(decision==='accept'&&!issue.content.snapshotId)continue;
   container.append(action(title,()=>transact(container,output,async()=>{
    if(!reason.value.trim())throw new Error('请填写决定理由。');const body={...ref(issue),decision,reason:reason.value.trim()},key=JSON.stringify(body);if(!operations.has(key))operations.set(key,crypto.randomUUID());
    await actions.api('/api/data/issues/resolve',{...body,operationId:operations.get(key)});await actions.refresh();await onChanged();output.textContent=decision==='accept'?'新快照已采用。':'已保留原快照。';
   }),decision==='accept'?'engine-primary':''));
  }
 }catch(error){if(output.isConnected)output.textContent=error.message;}
}

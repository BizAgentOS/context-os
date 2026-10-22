/** Protocol-only naming driver: exercises the real bounded tools; never represents model quality acceptance. */
import assert from 'node:assert/strict';
import type {RunRequest,RunOutcome} from '../../src/agent/runtime.ts';
export async function runNamingProtocol(request:RunRequest):Promise<RunOutcome>{
 assert.deepEqual(request.tools.map(tool=>tool.name),['naming_context_read','naming_batch_propose']);
 let offset=0;
 for(;;){
  const page=await request.onTool('naming_context_read',{offset,limit:30}) as any;
  assert(page.items.length>0,'each naming page contains items');
  const final=page.nextOffset===null;
  const saved=await request.onTool('naming_batch_propose',{items:page.items.map((item:any)=>({key:item.key,name:item.name,aliases:item.aliases??[],description:item.description||'依据既有字段与快照样本的测试说明',evidence:'本轮真实字段与快照样本；仅协议夹具，不评估模型命名质量'})),finalize:final}) as any;
  if(final){assert.equal(saved.change.status,'proposed');return{text:'命名候选已提交，等待人工核对。',runId:'naming-protocol',sessionId:'naming-protocol'};}
  assert(Number.isInteger(page.nextOffset)&&page.nextOffset>offset);offset=page.nextOffset;
 }
}

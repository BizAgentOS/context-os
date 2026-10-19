import { countTokens } from '@kodax-ai/kodax/agent';
import type { Data } from './contracts.ts';
import type { MemoryStore, Message } from './memory.ts';

/** Initial-turn budget uses the installed KodaX multilingual token estimator. */
export const conversationTokenLimit = 8000;

function extractSummary(previous: {text:string;throughMessageId:string}|undefined, older:Message[]) {
  const priorIndex=older.findIndex(message=>message.id===previous?.throughMessageId);
  const addition=older.slice(priorIndex+1).map(message=>`${message.role==='user'?'用户':'助手'}：${message.content.replace(/\s+/g,' ').slice(0,220)}`).join('\n');
  return [priorIndex>=0?previous?.text:'',addition].filter(Boolean).join('\n').slice(-5000);
}

export function conversationContext(memory:MemoryStore,taskId:string,system:string,envelope:Data) {
  const session=memory.sessionForTask(taskId);
  const history=session?memory.sessionHistory(session.id):memory.messages(taskId);
  const recent:Message[]=[];
  let chars=0;
  for(const message of history.slice().reverse()) {
    if(recent.length>=12||chars+message.content.length>12000)break;
    recent.unshift(message);chars+=message.content.length;
  }
  let older=history.slice(0,history.length-recent.length);
  let summary=extractSummary(session?.summary,older);
  const context:Data={...envelope,sessionSummary:summary,recentMessages:recent.map(({id,role,content})=>({id,role,content}))};
  const render=()=>JSON.stringify(context);
  let input=render();
  // Shorten summary first. If the recent window alone is too large, its oldest
  // entries join the extractive summary instead of disappearing from context.
  while(countTokens(system+input)>conversationTokenLimit&&String(context.sessionSummary).length>500) {
    context.sessionSummary=String(context.sessionSummary).slice(400);input=render();
  }
  const messages=context.recentMessages as Data[];
  while(countTokens(system+input)>conversationTokenLimit&&messages.length>1) {
    messages.shift();
    older=history.slice(0,history.length-messages.length);
    summary=extractSummary(session?.summary,older);
    context.sessionSummary=summary.slice(-500);input=render();
  }
  while(countTokens(system+input)>conversationTokenLimit&&String(context.sessionSummary).length) {
    context.sessionSummary=String(context.sessionSummary).slice(100);input=render();
  }
  if(countTokens(system+input)>conversationTokenLimit)throw new Error('本轮引用或消息超过上下文预算，请缩小范围后继续；原始消息已保存');
  if(session&&older.length&&session.summary?.throughMessageId!==older.at(-1)!.id) {
    memory.saveSessionSummary(session.id,{text:summary,throughMessageId:older.at(-1)!.id,count:older.length});
  }
  return {input,estimatedTokens:countTokens(system+input),limit:conversationTokenLimit,summaryCharacters:String(context.sessionSummary).length,recentCount:messages.length};
}

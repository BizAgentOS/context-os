import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/agent/memory.ts';

test('sessions preserve complete history, reject foreign cursors, and survive restart', () => {
  const directory=mkdtempSync(join(tmpdir(),'context-os-sessions-'));
  let memory=new MemoryStore(directory);
  try {
    const first=memory.createSession();
    const second=memory.createSession('客户核查');
    for(let i=0;i<51;i++) memory.addMessage(first.taskId,'user','消息 '+i,'session-first-'+i);
    memory.addMessage(second.taskId,'user','独立会话','session-second');
    const recent=memory.sessionMessages(first.id,{limit:10});
    assert.equal(recent.messages[0].content,'消息 41');
    assert.equal(recent.nextBefore,'session-first-41');
    assert.equal(memory.sessionMessages(first.id,{before:recent.nextBefore!,limit:10}).messages[0].content,'消息 31');
    assert.throws(()=>memory.sessionMessages(second.id,{before:recent.nextBefore!}),/其他会话/);
    memory.updateSession(first.id,{title:'供应链核查'});
    memory.updateSession(first.id,{archived:true});
    memory.close();memory=new MemoryStore(directory);
    assert.equal(memory.getSession(first.id).title,'供应链核查');
    assert.equal(memory.getSession(first.id).archived,true);
    assert.equal(memory.sessionMessages(first.id,{limit:100}).messages.length,51);
    assert.equal(memory.listSessions().length,1);
    assert.equal(memory.listSessions(true).length,2);
  } finally {memory.close();rmSync(directory,{recursive:true,force:true});}
});

test('bounded conversation context summarizes older history without injecting the whole workspace', async () => {
  const {AgentApplication}=await import('../../src/agent/app.ts');
  const directory=mkdtempSync(join(tmpdir(),'context-os-context-budget-'));
  let request:any;
  const app=new AgentApplication(directory,{async run(input){request=input;await input.onTool('session_title',{title:'项目责任核查'});return {text:'已读取当前工作摘要。',sessionId:'bounded',runId:'bounded'};},async stop(){},async close(){}},new Set(),false);
  try {
    const session=app.memory.createSession();
    for(let i=0;i<30;i++) app.memory.addMessage(session.taskId,i%2?'assistant':'user','旧对话 '+i+'：'+ '需要保留的业务依据。'.repeat(100));
    app.memory.putArtifact({kind:'profile',title:'企业档案',status:'active',content:{statements:[{key:'company.name',text:'星桥软件',origin:'user'},{key:'all_details',text:'不应整份注入'.repeat(10000),origin:'user'}]}});
    await app.canvasMessage({page:'ontology',sessionId:session.id,text:'请核查项目责任。',messageId:'bounded-latest'});
    await app.idle();
    const input=JSON.parse(request.input);
    assert.equal(app.memory.getSession(session.id).title,'项目责任核查');
    assert.equal(input.workSummary.enterpriseName,'星桥软件');
    assert.equal(input.recentMessages.at(-1).content,'请核查项目责任。');
    assert(input.recentMessages.length<=12);
    assert(input.sessionSummary.length>0);
    assert(!request.input.includes('不应整份注入'));
    const {countTokens}=await import('@kodax-ai/kodax/agent');
    assert(countTokens(request.system+request.input)<=8000);
    assert.equal(app.memory.sessionHistory(session.id).length,32);
  } finally {await app.close();rmSync(directory,{recursive:true,force:true});}
});

test('independent sessions can run while a queued document runs in the background; stopping one leaves the others live', async () => {
  const {AgentApplication}=await import('../../src/agent/app.ts');
  const {seedFoundation}=await import('./program-foundation-fixture.ts');
  const directory=mkdtempSync(join(tmpdir(),'context-os-pools-'));
  const pending=new Map<string,()=>void>();
  const scopes:string[]=[];
  let markBackground!:()=>void;const backgroundStarted=new Promise<void>(resolve=>markBackground=resolve);
  const driver=(scope:string):any=>({
    fork(next:string){scopes.push(next);return driver(next);},
    async run(request:any){
      const content=JSON.parse(request.input);
      if(scope==='background')await new Promise<void>(resolve=>{pending.set('background',resolve);markBackground();});
      else if(content.recentMessages?.at(-1)?.content==='等我停止')await new Promise<void>(resolve=>pending.set(scope,resolve));
      return {text:'完成当前会话',sessionId:scope,runId:scope};
    },
    async stop(){pending.get(scope)?.();},async close(){}
  });
  const app=new AgentApplication(directory,driver('root'),new Set(),false);
  try {
    seedFoundation(app.memory,app.foundation,{enterprise:'星桥软件',concepts:[{id:'project',name:'项目',description:'程序已有项目定义'}],relations:[]});
    const first=app.memory.createSession(),second=app.memory.createSession();
    await app.canvasMessage({page:'ontology',sessionId:first.id,text:'等我停止'});
    await app.canvasUpload({page:'setup',sessionId:second.id,name:'项目说明.txt',content:'项目根据客户目标组织交付。'});
    await new Promise(resolve=>setImmediate(resolve));
    await backgroundStarted;
    assert.equal(app.pools().interactive.length,1);
    assert(app.pools().background.active);
    await app.canvasMessage({page:'ontology',sessionId:second.id,text:'读取企业摘要'});
    await new Promise(resolve=>setImmediate(resolve));
    assert(app.memory.sessionHistory(second.id).some(message=>message.role==='assistant'));
    assert.equal(app.memory.getTask(first.taskId).status,'running');
    assert(app.pools().background.active);
    await app.stop(first.taskId);
    assert.equal(app.memory.getTask(first.taskId).status,'paused');
    assert(app.pools().background.active);
    pending.get('background')?.();await app.idle();
    assert(scopes.includes('background'));
    assert.equal(app.memory.sessionHistory(first.id).filter(message=>message.role==='user').length,1);
  } finally {for(const resolve of pending.values())resolve();await app.close();rmSync(directory,{recursive:true,force:true});}
});

test('session HTTP APIs keep tabs separate and navigation never changes another tab or persisted page', async () => {
  const {createServer}=await import('../../src/agent/server.ts');
  const directory=mkdtempSync(join(tmpdir(),'context-os-session-http-'));
  const service=await createServer({directory,automaticApi:false,driver:{async run(request){await request.onTool('session_title',{title:'模型生成的项目会话'});return {text:'当前会话已处理',sessionId:'http',runId:'http'};},async stop(){},async close(){}}});
  try {
    await new Promise<void>(resolve=>service.server.listen(0,'127.0.0.1',resolve));
    const address=service.server.address() as import('node:net').AddressInfo;
    const base=`http://127.0.0.1:${address.port}`,headers={'x-contextos-token':service.adminToken,'content-type':'application/json'};
    const call=async(path:string,body?:unknown,method=body?'POST':'GET')=>{const response=await fetch(base+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});assert(response.ok,await response.clone().text());return response.json() as any;};
    const first=(await call('/api/sessions',{})).session,second=(await call('/api/sessions',{title:'人工会话'})).session;
    await Promise.all([call('/api/canvas/message',{sessionId:first.id,page:'setup',text:'星桥项目',messageId:'http-first'}),call('/api/canvas/message',{sessionId:second.id,page:'ontology',text:'独立责任核查',messageId:'http-second'})]);
    await service.app.idle();
    assert.equal((await call('/api/sessions/'+first.id)).session.title,'模型生成的项目会话');
    assert.equal((await call('/api/sessions/'+second.id)).session.title,'人工会话');
    const a=await call('/api/canvas?page=ontology&sessionId='+first.id),b=await call('/api/canvas?page=setup&sessionId='+second.id);
    assert.equal(a.currentPage,'ontology');assert.equal(b.currentPage,'setup');
    assert(a.messages.some((message:any)=>message.content==='星桥项目'));
    assert(!a.messages.some((message:any)=>message.content==='独立责任核查'));
    await call('/api/canvas/navigate',{page:'consumption',sessionId:second.id});
    assert.equal((await call('/api/canvas?page=ontology&sessionId='+first.id)).currentPage,'ontology');
    assert.equal(service.app.memory.getCanvas()!.currentPage,'setup');
    await call('/api/sessions/'+first.id,{title:'人工核定标题'},'PATCH');
    await call('/api/sessions/'+first.id,{archived:true},'PATCH');
    assert(!(await call('/api/sessions')).sessions.some((session:any)=>session.id===first.id));
    assert((await call('/api/sessions/'+first.id+'/messages')).messages.length===2);
  } finally {await service.close();rmSync(directory,{recursive:true,force:true});}
});

test('concurrent session writes retain optimistic artifact versions and cannot overwrite the winner', () => {
  const directory=mkdtempSync(join(tmpdir(),'context-os-session-versions-')),memory=new MemoryStore(directory);
  try {
    const first=memory.createSession(),second=memory.createSession();
    const artifact=memory.putArtifact({kind:'report',title:'共同结果',status:'draft',content:{value:'原始'}});
    const a=memory.beginExecution(first.taskId),b=memory.beginExecution(second.taskId);
    memory.putArtifact({...artifact,expectedVersion:artifact.version,content:{value:'第一会话结果'}},a);
    assert.throws(()=>memory.putArtifact({...artifact,expectedVersion:artifact.version,content:{value:'第二会话结果'}},b),/版本已变化/);
    assert.equal(memory.getArtifact(artifact.id).content.value,'第一会话结果');
    memory.endExecution(a);memory.endExecution(b);
  } finally {memory.close();rmSync(directory,{recursive:true,force:true});}
});

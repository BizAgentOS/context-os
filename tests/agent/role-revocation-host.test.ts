import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from '../../src/agent/server.ts';
import type {AgentDriver} from '../../src/agent/runtime.ts';

for(const action of ['logout','disable'] as const)test(`HTTP ${action} prevents a late model tool and durably finalizes its run card`,{timeout:10000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'context-os-revoked-host-'));let release!:()=>void,started!:()=>void,lateRead=false,stops=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
  const driver:AgentDriver={async run(request){started();await gate;
    request.onEvent('run.usage',{sampleId:'late-provider-response',usage:{inputTokens:5,outputTokens:3,totalTokens:8}});
    await request.onTool('ontology_describe',{});lateRead=true;
    return{text:'不应发送的迟到结果',sessionId:'revoked',runId:'revoked'};
  },async stop(){stops++;},async close(){release();}};
  const service=await createServer({directory,driver,automaticApi:false});await new Promise<void>(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(service.server.address() as {port:number}).port}`;
  const call=async(path:string,token:string|undefined,body?:unknown)=>{const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{...(token?{'X-ContextOS-Token':token}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json() as any};};
  try{
    const account=await call('/api/users/create',service.adminToken,{operationId:'create',username:'reviewer',name:'只读审阅同事',role:'viewer',password:'synthetic-role-password'});assert.equal(account.status,200);
    const login=await call('/api/auth/login',undefined,{username:'reviewer',password:'synthetic-role-password'});assert.equal(login.status,200);const token=login.body.token;
    const session=await call('/api/sessions',token,{title:'撤权中的问答'});assert.equal(session.status,201);
    const sent=await call('/api/canvas/message',token,{page:'ontology',sessionId:session.body.session.id,messageId:'role-late',text:'查看当前本体',mode:'qa',dataView:{kind:'working'}});assert([200,202].includes(sent.status),JSON.stringify(sent.body));await entered;
    const revoked=action==='logout'?await call('/api/auth/logout',token,{}):await call('/api/users/update',service.adminToken,{id:account.body.user.id,version:account.body.user.version,operationId:'disable',enabled:false});assert.equal(revoked.status,200);
    release();await service.app.idle().catch(()=>{});
    assert.equal(lateRead,false);assert(stops>0);assert.equal(service.app.usage.overview().today.tokens,8,'incurred usage remains accounted after authority is revoked');
    const task=service.app.memory.getTask(service.app.memory.getMessage('role-late')!.taskId);
    assert.equal(task.executionId,null,'revoked authority cannot prevent trusted execution cleanup');assert.equal(task.status,'paused');
    const run=service.app.memory.listArtifacts('agent_run').find(item=>item.content.taskId===task.id)!;
    assert.equal(run.status,'stopped','the saved card, not only a UI fallback, must reflect the stopped run');assert.equal(run.content.status,'stopped');
    assert.equal((await call('/api/canvas/bootstrap',token)).status,403);assert.equal(service.app.memory.listArtifacts('ontology_change').length,0);
  }finally{release();await service.close();rmSync(directory,{recursive:true,force:true,maxRetries:3});}
});

test('an authenticated event stream stops exposing later assistant text after logout',{timeout:10000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'context-os-revoked-events-')),marker='仅退出之后产生的回答';
  const driver:AgentDriver={async run(request){request.onEvent('assistant.delta',{text:marker});return{text:marker,sessionId:'events',runId:'events',usage:{inputTokens:2,outputTokens:2,totalTokens:4}};},async stop(){},async close(){}};
  const service=await createServer({directory,driver,automaticApi:false});await new Promise<void>(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(service.server.address() as {port:number}).port}`,controller=new AbortController();
  const post=async(path:string,token:string|undefined,body:unknown)=>{const response=await fetch(origin+path,{method:'POST',headers:{...(token?{'X-ContextOS-Token':token}:{}),'Content-Type':'application/json'},body:JSON.stringify(body)});assert(response.ok,`${path}: ${response.status}`);return await response.json() as any;};
  try{
    await post('/api/users/create',service.adminToken,{operationId:'viewer',username:'stream-reader',name:'只读',role:'viewer',password:'synthetic-role-password'});
    const login=await post('/api/auth/login',undefined,{username:'stream-reader',password:'synthetic-role-password'});
    const response=await fetch(origin+'/api/events',{headers:{'X-ContextOS-Token':login.token},signal:controller.signal});assert.equal(response.status,200);const reader=response.body!.getReader();await reader.read();
    await post('/api/auth/logout',login.token,{});
    const session=await post('/api/sessions',service.adminToken,{title:'退出后新回答'});
    await post('/api/canvas/message',service.adminToken,{page:'ontology',sessionId:session.session.id,messageId:'after-logout',text:'只读查看',mode:'qa'});await service.app.idle();
    let text='',closed=false;const timeout=setTimeout(()=>controller.abort(),1500);
    try{for(;;){const chunk=await reader.read();if(chunk.done){closed=true;break;}text+=new TextDecoder().decode(chunk.value);if(text.includes(marker))break;}}catch{}finally{clearTimeout(timeout);}
    assert.equal(text.includes(marker),false,'a revoked SSE subscription cannot continue receiving live answer content');assert.equal(closed,true,'revoked SSE connections must close');
  }finally{controller.abort();await service.close();rmSync(directory,{recursive:true,force:true,maxRetries:3});}
});

test('viewer snapshots and event replay hide administrator objects while preserving business updates',{timeout:10000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'context-os-role-projection-')),service=await createServer({directory,automaticApi:false});
  await new Promise<void>(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(service.server.address() as {port:number}).port}`,controller=new AbortController();
  const call=async(path:string,token:string|undefined,body?:unknown)=>{const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{...(token?{'X-ContextOS-Token':token}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});assert(response.ok,`${path}: ${response.status}`);return await response.json() as any;};
  const account=(username:string)=>call('/api/users/create',service.adminToken,{operationId:username,username,name:username,role:'viewer',password:'synthetic-role-password'});
  try{
    await account('view-events');const login=await call('/api/auth/login',undefined,{username:'view-events',password:'synthetic-role-password'});
    const initial=await call('/api/snapshot',login.token);
    const hidden=(await account('hidden-before-reconnect')).user;
    await call('/api/canvas/upload',service.adminToken,{page:'setup',name:'可见来源.md',content:'事件引用仍应正常刷新资料。'});
    const source=service.app.memory.listArtifacts('source')[0];
    for(const path of ['/api/bootstrap','/api/state']){
      const snapshot=await call(path,login.token);assert(snapshot.artifacts.some((item:any)=>item.id===source.id));
      assert.equal(snapshot.artifacts.some((item:any)=>['local_user','audit_record'].includes(item.kind)),false);
      if(path==='/api/bootstrap')assert.equal(snapshot.token,login.token);
    }
    const response=await fetch(`${origin}/api/events?after=${encodeURIComponent(initial.eventCursor)}`,{headers:{'X-ContextOS-Token':login.token},signal:controller.signal});
    const reader=response.body!.getReader();let replay='';
    while(!replay.includes('event: ready'))replay+=new TextDecoder().decode((await reader.read()).value);
    assert(replay.includes(source.id));assert(!replay.includes(hidden.id));assert.doesNotMatch(replay,/"kind":"(?:local_user|audit_record)"/);
    const later=(await account('hidden-live-update')).user;
    await call('/api/canvas/upload',service.adminToken,{page:'setup',name:'后续可见来源.md',content:'后续事件仍可刷新业务来源。'});
    const updated=service.app.memory.listArtifacts('source').find(item=>item.id!==source.id)!;let live='';
    while(!live.includes(updated.id))live+=new TextDecoder().decode((await reader.read()).value);
    assert(!live.includes(later.id));assert.doesNotMatch(live,/"kind":"(?:local_user|audit_record)"/);
  }finally{controller.abort();await service.close();rmSync(directory,{recursive:true,force:true,maxRetries:3});}
});

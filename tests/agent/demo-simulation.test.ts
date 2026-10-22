import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AddressInfo} from 'node:net';
import {createHeatingDemo} from '../../src/demo/server.ts';

test('online demo simulates writes at the HTTP boundary while formal object queries and navigation stay available',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ade-demo-simulation-')),service=await createHeatingDemo(directory);
 try{
  await new Promise<void>(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const call=async(path:string,body:unknown,method='POST',raw=false)=>{const response=await fetch(base+path,{method,headers:{'x-dataengine-token':service.adminToken,'content-type':raw?'application/octet-stream':'application/json'},body:raw?String(body):JSON.stringify(body)});return{status:response.status,body:await response.json() as any};};
  const model=service.app.memory.listArtifacts('live_ontology').find(item=>item.status==='adopted')!,complaint=service.app.live.readLayered(model.id).semantic.entityTypes.find(item=>item.name==='投诉')!;
  const data=await call('/api/live/query',{modelId:model.id,modelVersion:model.version,conceptId:complaint.id,id:'TS002',relation:'居民回访'});
  assert.equal(data.status,200);assert.equal(data.body.items[0].$id,'HF002');assert.equal(data.body.items[0].反馈结果,'未改善');
  assert.equal((await call('/api/canvas/navigate',{page:'ontology'})).status,200);
  const before=service.app.memory.artifactHistory().length;
  const writes:[string,unknown,string?,boolean?][]=[
   ['/api/changes/propose',{operationId:'demo-must-not-save',origin:'human',type:'entity',baseline:service.app.changes.currentBaseline(),subject:{action:'add',entity:{id:'should_not_exist',name:'演示不应保存'}}}],
   ['/api/canvas/upload/table?name=should-not-save.csv','id,name\n1,test','POST',true],
   ['/api/releases/publish',{operationId:'demo-must-not-publish'}],
   ['/api/usage/policy',{timeZone:'UTC',perRunTokens:0}],
   ['/api/model',{provider:'openai',apiKey:'not-a-real-key'}],
   ['/api/auth/login',{username:'demo',password:'not-a-real-password'}],
   ['/api/sessions',{title:'不应创建'}],
  ];
  for(const [path,body,method,raw]of writes){const result=await call(path,body,method,raw);assert.equal(result.status,409,path);assert.equal(result.body.code,'demo_simulated',path);assert.equal(result.body.simulated,true);assert.match(result.body.error,/未保存.*未发布.*未签发/);}
  assert.equal(service.app.memory.artifactHistory().length,before,'simulated writes cannot append business, source, or credential artifacts');
  assert.equal(service.app.memory.listArtifacts('source').some(item=>item.title==='should-not-save.csv'),false);
  assert.equal(service.app.memory.listArtifacts('release_connection').length,0);
 }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});

test('online demo example questions run through the public QA mode and use actual semantic receipts',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ade-demo-qa-')),service=await createHeatingDemo(directory);
 try{
  await new Promise<void>(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const ask=async(page:string,text:string)=>{
   const response=await fetch(base+'/api/canvas/message',{method:'POST',headers:{'x-dataengine-token':service.adminToken,'content-type':'application/json'},body:JSON.stringify({page,text,mode:'qa',dataView:{kind:'working'},messageId:'demo-'+page})});
   assert.equal(response.status,202);await service.app.idle();
   const run=service.app.canvasState(page as 'ontology'|'consumption').agentRuns.at(-1)! as any;
   assert.equal(run.status,'completed',JSON.stringify(run));return run;
  };
  const access=await ask('consumption','谁可以调用这些记忆？');
  assert.equal(access.answer.receipt.readCount,1);assert.match(access.answer.conclusion,/本轮未读取接入授权/);
  const recovery=await ask('ontology','哪些投诉还缺恢复依据？');
  assert.equal(recovery.answer.receipt.readCount,8,'directory, complaints, and six actual callback traversals');
  assert.match(recovery.answer.conclusion,/6 条投诉/);assert.match(recovery.answer.conclusion,/2 条回访显示未改善/);assert.match(recovery.answer.conclusion,/1 条缺少回访依据/);
  assert(recovery.answer.evidence.some((reading:any)=>reading.result.items?.some((item:any)=>item.$id==='HF002'&&Object.values(item.values).includes('未改善'))),'the answer retains the real negative callback result');
  assert.equal(service.app.memory.listArtifacts('release_connection').length,0);
 }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});

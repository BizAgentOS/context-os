import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AddressInfo} from 'node:net';
import {createServer} from '../../src/agent/server.ts';
import type {AgentDriver} from '../../src/agent/runtime.ts';

test('model-first engine initialization persists a source choice without creating business data',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'context-os-engine-start-'));
 const driver:AgentDriver={async run(){return {text:'ok',sessionId:'test',runId:'test'};},async stop(){},async close(){}};
 let service=await createServer({directory,driver,automaticApi:false});
 const listen=async()=>{await new Promise<void>(r=>service.server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;};
 let origin=await listen();
 const request=async(path:string,body?:unknown)=>{const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{'x-contextos-token':service.adminToken,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
 try{
  let state=(await request('/api/onboarding')).body;
  assert.equal(state.flow,'engine');assert.equal(state.step,1);
  let r=await request('/api/onboarding/step',{expectedVersion:state.version,step:2});assert.equal(r.status,200);state=r.body.onboarding;
  r=await request('/api/onboarding/complete',{expectedVersion:state.version,sourceKind:'later'});
  assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.onboarding.active,false);assert.equal(r.body.onboarding.sourceKind,'later');assert.equal(r.body.currentPage,'setup');
  assert.equal(r.body.foundation.current,null);assert.equal(r.body.sources.length,0);assert.equal(r.body.live.connections.length,0);
  assert.equal((await request('/api/onboarding/complete',{expectedVersion:state.version,sourceKind:'api'})).status,400);
  await service.close();service=await createServer({directory,driver,automaticApi:false});origin=await listen();
  state=(await request('/api/onboarding')).body;assert.equal(state.active,false);assert.equal(state.sourceKind,'later');
  r=await request('/api/onboarding/start',{expectedVersion:state.version,flow:'engine'});state=r.body.onboarding;
  assert.equal(state.completedAt,undefined,'reopening starts a fresh initialization session');
  r=await request('/api/onboarding/step',{expectedVersion:state.version,step:2});state=r.body.onboarding;
  r=await request('/api/onboarding/suspend',{expectedVersion:state.version});state=r.body.onboarding;
  r=await request('/api/onboarding/start',{expectedVersion:state.version,flow:'engine'});state=r.body.onboarding;
  assert.equal(state.step,2,'closing and resuming a reopened initialization preserves its step');
  assert.equal((await request('/api/onboarding/complete',{expectedVersion:state.version,sourceKind:'invented'})).status,400);
 }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});

test('navigation preserves the running task and its original page until explicit stop',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'context-os-navigation-'));
 let finish!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);let stops=0;
 const driver:AgentDriver={async run(){entered();await new Promise<void>(r=>finish=r);return {text:'原任务已结束',sessionId:'nav',runId:'nav'};},async stop(){stops++;finish();},async close(){}};
 const service=await createServer({directory,driver,automaticApi:false});
 try{
  await service.app.canvasMessage({page:'setup',text:'查看现有数据源',messageId:'navigation-task'});await started;
  const before=service.app.canvasState('setup').agentTask;
  const after=await service.app.canvasNavigate({page:'ontology'});
  assert.equal(stops,0);assert.equal(after.busy,true);assert.equal(after.agentTask?.id,before?.id);assert.equal(after.agentTask?.page,'setup');
  await service.app.canvasStop({page:'ontology'});assert.equal(stops,1);assert.equal(service.app.canvasState().busy,false);
 }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AddressInfo} from 'node:net';
import {createServer} from '../../src/agent/server.ts';
import type {AgentDriver} from '../../src/agent/runtime.ts';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

test('release consumer delegates only its granted dataset through the ADE runtime',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ade-delegation-'));let runs=0;
 const driver:AgentDriver={async run(req){runs++;assert.deepEqual(req.nativeTools,[]);assert(!req.tools.some(t=>t.mutates));
  await assert.rejects(req.onTool('foundation_propose',{}),/不可用|不允许/);
  const catalog=await req.onTool('describe_dataset',{}) as any;
  assert.deepEqual(catalog.concepts.map((c:any)=>c.id),['company']);
  await assert.rejects(req.onTool('read_concept',{conceptId:'secret'}));
  await req.onTool('read_concept',{conceptId:'company'});
  return {text:'公司是获准查询的对象，依据本体定义。',sessionId:'fixture',runId:'fixture'};
 },async stop(){},async close(){}};
 const service=await createServer({directory,driver,automaticApi:false});let client:Client|undefined;
 await new Promise<void>(r=>service.server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
 const call=async(path:string,body?:unknown,key?:string)=>{const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{...(key?{authorization:`Bearer ${key}`}:{'x-dataengine-token':service.adminToken}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
 try{
  service.app.memory.putArtifact({kind:'foundation',title:'隔离测试',status:'adopted',content:{enterprise:{name:'隔离测试'},concepts:[{id:'company',name:'公司',description:'组织'},{id:'secret',name:'私有',description:'不可开放'}],relations:[],evidence:[],unknowns:[],conflicts:[]}});
  const overview=(await call('/api/releases')).body;assert.equal(typeof overview.working.inputHash,'string');
  const check=(await call('/api/releases/check',{inputHash:overview.working.inputHash})).body;
  const published=(await call('/api/releases/publish',{operationId:'p1',checkRef:{id:check.id,version:check.version},name:'v1.0'})).body;
  const connected=(await call('/api/releases/connect',{operationId:'c1',name:'独立Agent',releaseRef:{id:published.release.id,version:published.release.version},conceptIds:['company'],relationIds:[],agentEnabled:true})).body;
  assert.ok(connected.key);
  const disabled=(await call('/api/releases/connect',{operationId:'c2',name:'仅查询',releaseRef:{id:published.release.id,version:published.release.version},conceptIds:['company'],relationIds:[]})).body;
  assert.equal((await call('/v4/agent/tasks',{operationId:'no',prompt:'解释公司'},disabled.key)).status,403);
  const submitted=await call('/v4/agent/tasks',{operationId:'job1',prompt:'解释公司'},connected.key);assert.equal(submitted.status,202,JSON.stringify(submitted.body));
  const jobId=submitted.body.task.id;
  await service.app.idle();
  const completed=await call('/v4/agent/tasks/'+jobId,undefined,connected.key);assert.equal(completed.status,200);assert.equal(completed.body.task.status,'completed');assert.match(completed.body.task.content.result,/公司/);assert.equal(runs,1);
  const config=(await call(`/api/releases/connection?id=${connected.connection.id}&version=${connected.connection.version}`)).body;
  const transport=Object.values(config.mcp.mcpServers)[0] as any;
  client=new Client({name:'ADE delegation acceptance',version:'0.2.0'});
  await client.connect(new StdioClientTransport({command:transport.command,args:transport.args,env:{...transport.env,DATAENGINE_CONSUMER_KEY:connected.key},stderr:'pipe'}));
  assert((await client.listTools()).tools.some(t=>t.name==='submit_ade_task'));
  const fetched=await client.callTool({name:'read_ade_task',arguments:{id:jobId}});
  assert.equal((fetched.structuredContent as any).task.status,'completed');
  assert.equal((await call('/v4/agent/tasks/'+jobId,undefined,disabled.key)).status,403);
  const replay=await call('/v4/agent/tasks',{operationId:'job1',prompt:'解释公司'},connected.key);assert.equal(replay.body.task.id,jobId);assert.equal(runs,1);
  assert.equal((await call('/v4/agent/tasks',{operationId:'job1',prompt:'其他任务'},connected.key)).status,400);
  const connection=connected.connection;
  await call('/api/releases/revoke',{operationId:'revoke1',connectionRef:{id:connection.id,version:connection.version}});
  assert.equal((await call('/v4/agent/tasks/'+jobId,undefined,connected.key)).status,403);
 }finally{await client?.close();await service.close();rmSync(directory,{recursive:true,force:true});}
});

test('delegated cancellation blocks late results and a restart reports queued tasks interrupted',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ade-delegation-stop-'));let unblock!:()=>void,entered!:()=>void;
 let started=new Promise<void>(r=>entered=r);let rejected=false;
 const driver:AgentDriver={async run(req){entered();await new Promise<void>(r=>unblock=r);try{await req.onTool('describe_dataset',{});}catch{rejected=true;}return {text:'不得发布的迟到结果',sessionId:'stop',runId:'stop'};},async stop(){unblock?.();},async close(){}};
 let service=await createServer({directory,driver,automaticApi:false});
 const listen=async()=>{await new Promise<void>(r=>service.server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;};let origin=await listen();
 const call=async(path:string,body?:unknown,key?:string)=>{const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{...(key?{authorization:`Bearer ${key}`}:{'x-dataengine-token':service.adminToken}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
 try{
  service.app.memory.putArtifact({kind:'foundation',title:'测试',status:'adopted',content:{enterprise:{name:'测试'},concepts:[{id:'company',name:'公司',description:'组织'}],relations:[],evidence:[],unknowns:[],conflicts:[]}});
  const overview=(await call('/api/releases')).body;
  const check=(await call('/api/releases/check',{inputHash:overview.working.inputHash})).body;
  const release=(await call('/api/releases/publish',{operationId:'p',checkRef:{id:check.id,version:check.version},name:'v1'})).body.release;
  const connection=(await call('/api/releases/connect',{operationId:'c',name:'调用方',releaseRef:{id:release.id,version:release.version},conceptIds:['company'],relationIds:[],agentEnabled:true})).body;
  let first=(await call('/v4/agent/tasks',{operationId:'cancel',prompt:'调查公司'},connection.key)).body.task;await started;
  assert.equal((await call(`/v4/agent/tasks/${first.id}/cancel`,{},connection.key)).body.task.status,'cancelled');
  await service.app.idle();assert.equal(rejected,true);
  assert.equal((await call('/v4/agent/tasks/'+first.id,undefined,connection.key)).body.task.content.result,undefined);
  started=new Promise<void>(r=>entered=r);
  first=(await call('/v4/agent/tasks',{operationId:'running',prompt:'调查公司'},connection.key)).body.task;await started;
  const queued=(await call('/v4/agent/tasks',{operationId:'queued',prompt:'解释公司'},connection.key)).body.task;assert.equal(queued.status,'queued');
  await service.close();service=await createServer({directory,driver,automaticApi:false});origin=await listen();
  const recovered=(await call('/v4/agent/tasks/'+queued.id,undefined,connection.key)).body.task;assert.equal(recovered.status,'interrupted');assert.equal(recovered.content.result,undefined);
 }finally{unblock?.();await service.close();rmSync(directory,{recursive:true,force:true});}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../../src/agent/server.ts';
import type {ExampleQuestion} from '../../src/agent/first-use.ts';
import type {AgentDriver} from '../../src/agent/runtime.ts';
import {runNamingProtocol} from './naming-protocol-fixture.ts';

test('first-use HTTP batch preserves its conversation, replays uploads, builds eight tables once, and sends an example through normal QA',{timeout:30000},async()=>{
  let question:ExampleQuestion|undefined,namingCalls=0,qaCalls=0;
  // Protocol fixture only: the normal QA host executes its actual semantic tool; this does not evaluate model quality.
  const driver:AgentDriver={async run(request){const input=JSON.parse(request.input);if(input.mode==='automatic-naming'){namingCalls++;return runNamingProtocol(request);}
    assert.equal(input.mode,'qa');assert(question);qaCalls++;const read=await request.onTool(question.tool,question.args) as any;assert.equal(read.status,'available');assert.equal(read.result.items[0].values.total,2);
    return{text:'本次实际读取共2条记录，依据和范围见读取回执。',runId:'first-use-host',sessionId:'first-use-host'};},async stop(){},async close(){}};
  const directory=mkdtempSync(join(tmpdir(),'context-os-first-use-host-')),service=await createServer({directory,driver});
  await new Promise<void>(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${(service.server.address() as {port:number}).port}`;
  const call=async(path:string,body?:unknown)=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'X-ContextOS-Token':service.adminToken,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json() as any;assert(response.ok,JSON.stringify(value));return value;};
  try{
    const session=(await call('/api/sessions',{title:'首次整批来源'})).session,other=(await call('/api/sessions',{title:'另一个会话'})).session;
    const batch=(await call('/api/canvas/upload/table-batch/start',{operationId:'batch-start',page:'setup',sessionId:session.id})).batch;
    assert.equal((await call('/api/canvas/upload/table-batch/start',{operationId:'batch-start',page:'setup',sessionId:session.id})).batch.id,batch.id);
    for(const [index,name] of ['customers','products','tickets','people','teams','projects','releases','orders'].entries()){
      const query=new URLSearchParams({batchId:batch.id,operationId:`file-${index}`,name:`${name}.csv`,page:'ontology',sessionId:other.id}),content=`id,name\n${index}A,甲\n${index}B,乙\n`;
      const upload=async()=>{const response=await fetch(`${base}/api/canvas/upload/table?${query}`,{method:'POST',headers:{'X-ContextOS-Token':service.adminToken,'Content-Type':'application/octet-stream'},body:content});const value=await response.json() as any;assert.equal(response.status,200,JSON.stringify(value));return value;};
      const saved=await upload();assert.equal(saved.currentSessionId,session.id,'raw query cannot move an existing batch into another conversation');assert.equal(saved.currentPage,'setup');
      if(index===0){const replay=await upload();assert.equal(replay.replayed,true);assert.equal(replay.tableImport.sources[0].version,saved.tableImport.sources[0].version);}
      assert.equal(service.app.memory.listArtifacts('live_ontology').filter(item=>item.status==='adopted').length,0);
    }
    assert.equal((await call(`/api/canvas/upload/table-batch/read?id=${batch.id}`)).batch.content.sources.length,8);
    for(let count=0;count<2;count++)await call('/api/canvas/upload/table-batch/finalize',{batchId:batch.id});
    await service.app.idle();
    const guide=await call('/api/onboarding');assert.equal(guide.firstUse.ontology.entities,8);assert.equal(guide.firstUse.build.sourcesRead,8);assert.equal(guide.firstUse.build.status,'ready');assert.equal(namingCalls,1);
    assert.equal(service.app.memory.listArtifacts('api_build').length,1);assert.equal(service.app.memory.listArtifacts('engine_build').length,1);
    assert.equal((await call(`/api/sessions/${other.id}/messages`)).messages.length,0,'batch user trace belongs to the original conversation');
    const examples=await call('/api/onboarding/examples');assert.equal(examples.questions.length,3,'host constructor must connect the live semantic service');question=examples.questions[0];
    await call('/api/canvas/message',{page:'ontology',sessionId:session.id,messageId:'first-real-query',text:question!.question,mode:'qa',dataView:{kind:'working'}});await service.app.idle();
    assert.equal(qaCalls,1);assert((await call('/api/onboarding')).firstUse.firstAnswer);
    const firstAnswer=(await call('/api/onboarding')).firstUse.firstAnswer;
    await call('/api/canvas/message',{page:'ontology',sessionId:session.id,messageId:'later-real-query',text:'随后再查询一次记录数',mode:'qa',dataView:{kind:'working'}});await service.app.idle();
    assert.equal(qaCalls,2);assert.deepEqual((await call('/api/onboarding')).firstUse.firstAnswer,firstAnswer,'later successful questions must not replace the first answered question or its timing');
  }finally{await service.close();rmSync(directory,{recursive:true,force:true,maxRetries:3});}
});

test('table upload HTTP rejects viewer writes and saves no late source after the uploading maintainer is disabled',{timeout:10000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'context-os-first-use-role-')),service=await createServer({directory,automaticApi:false});
  await new Promise<void>(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${(service.server.address() as {port:number}).port}`;
  const call=async(path:string,token:string,body?:unknown)=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'X-ContextOS-Token':token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json() as any};};
  try{
    const create=async(username:string,role:string)=>{const user=(await call('/api/users/create',service.adminToken,{operationId:`create-${username}`,username,name:username,role,password:'synthetic-fixture-password'})).body.user;const token=(await call('/api/auth/login','',{username,password:'synthetic-fixture-password'})).body.token;return{user,token};};
    const viewer=await create('viewer','viewer'),maintainer=await create('maintainer','maintainer');
    assert.equal((await call('/api/canvas/upload/table-batch/start',viewer.token,{operationId:'denied',page:'setup'})).status,403);
    const batch=(await call('/api/canvas/upload/table-batch/start',maintainer.token,{operationId:'allowed',page:'setup'})).body.batch;
    assert.equal((await call('/api/canvas/upload/table-batch/finalize',viewer.token,{batchId:batch.id})).status,403);
    const query=new URLSearchParams({batchId:batch.id,operationId:'late-upload',name:'late.csv'});
    let finish!:(value:{status:number;text:string})=>void;const completed=new Promise<{status:number;text:string}>(resolve=>finish=resolve);
    const upload=httpRequest(`${base}/api/canvas/upload/table?${query}`,{method:'POST',headers:{'X-ContextOS-Token':maintainer.token,'Content-Type':'application/octet-stream'}},response=>{let text='';response.setEncoding('utf8');response.on('data',part=>text+=part);response.on('end',()=>finish({status:response.statusCode!,text}));});
    upload.write('id,name\n');
    assert.equal((await call('/api/users/update',service.adminToken,{id:maintainer.user.id,version:maintainer.user.version,operationId:'disable',enabled:false})).status,200);
    upload.end('A,迟到结果\n');const result=await completed;assert.equal(result.status,403,result.text);
    assert.equal(service.app.memory.listArtifacts('source').length,0);assert.equal(service.app.tableUploads.read(batch.id).content.sources instanceof Array,true);assert.deepEqual(service.app.tableUploads.read(batch.id).content.sources,[]);
    assert.equal((await call('/api/canvas/upload/table-batch/finalize',maintainer.token,{batchId:batch.id})).status,403);
  }finally{await service.close();rmSync(directory,{recursive:true,force:true,maxRetries:3});}
});

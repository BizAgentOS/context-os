import {test} from 'node:test';
import assert from 'node:assert/strict';
import {identityWorkspace,ref} from './identity-release-fixture.ts';
import type {AgentDriver} from '../../src/agent/runtime.ts';
import {AgentApplication} from '../../src/agent/app.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('the host freezes a consumer QA view, excludes build history and global counts, and saves only service-derived answer receipts',async()=>{
 let qaInput='',qaTools:string[]=[],queryResult:any;
 const driver:AgentDriver={async run(request){
  const input=JSON.parse(request.input);
  if(input.mode!=='qa')return{text:'先前构建内容已知。',runId:'build',sessionId:'qa-host'};
  qaInput=request.input;qaTools=request.tools.map(tool=>tool.name);
  const described=await request.onTool('ontology_describe',{}) as any;
  const person=described.result.entities.find((item:any)=>item.id==='person');
  const name=person.properties.find((item:any)=>item.name==='姓名');
  queryResult=await request.onTool('objects_query',{target:{entityTypeId:'person'},fields:[name.id]});
  return{text:`当前授权范围返回 ${queryResult.result.items.length} 名人员。`,runId:'qa',sessionId:'qa-host'};
 },async stop(){},async close(){}};
 const w=await identityWorkspace(driver),app=w.service.app;
 try{
  const release=await w.publish('问答宿主验收'),connected=await w.manage('/api/releases/connect',{operationId:'qa-host-reader',name:'只读姓名',releaseRef:ref(release),conceptIds:['person'],relationIds:[],business:{grants:[{type:'人员',fields:['$id','姓名'],relations:[]}]}});
  const session=app.memory.createSession();
  await app.canvasMessage({page:'setup',sessionId:session.id,text:'BUILD_HISTORY_PRIVATE_CANARY',messageId:'qa-host-build',mode:'build'});await app.idle();
  const dataView={kind:'consumer',releaseRef:ref(release),connectionRef:ref(connected.connection)};
  await app.canvasMessage({page:'ontology',sessionId:session.id,text:'有哪些人员姓名',messageId:'qa-host-read',mode:'qa',dataView});await app.idle();
  assert.doesNotMatch(qaInput,/BUILD_HISTORY_PRIVATE_CANARY|workSummary|pendingReference|sessionSummary/);
  assert.ok(qaTools.includes('objects_query'));assert.ok(!qaTools.includes('change_propose'));assert.ok(!qaTools.includes('memory_read'));
  assert.deepEqual(app.memory.getMessage('qa-host-read')!.binding!.dataView,dataView);
  const run=app.canvasState('ontology',session.id).agentRuns.at(-1)! as any;
  assert.equal(run.answer.receipt.dataView.connectionRef.id,connected.connection.id);
  assert.equal(run.answer.evidence[0].readId,queryResult.readId);
  assert.equal(run.answer.receipt.readCount,2);
  await assert.rejects(app.canvasMessage({page:'ontology',sessionId:session.id,text:'有哪些人员姓名',messageId:'qa-host-read',mode:'qa',dataView:{kind:'working'}}),/消息|绑定/);
 }finally{await w.close();}
});

test('failed QA outcomes never save success-like text or reuse it as verified conversation history',async()=>{
 let count=0,nextInput='';const directory=mkdtempSync(join(tmpdir(),'context-os-qa-failed-host-'));
 const driver:AgentDriver={async run(request){if(!count++)return{status:'failed',text:'所有数据均已验证完整。',error:'query failed',runId:'failed',sessionId:'qa-failure'};nextInput=request.input;return{text:'当前没有实际读取依据。',runId:'resumed',sessionId:'qa-failure'};},async stop(){},async close(){}};
 const app=new AgentApplication(directory,driver,new Set(),false);
 try{
  const first=await app.message({text:'检查人员数据',messageId:'qa-failed',mode:'qa'});await app.idle();
  const failed=app.memory.messages(first.task.id).filter(message=>message.role==='assistant');
  assert.ok(failed.some(message=>/未完成/.test(message.content)));assert.ok(failed.every(message=>!message.content.includes('所有数据均已验证完整')));
  await app.message({taskId:first.task.id,text:'继续核对',messageId:'qa-resumed',mode:'qa'});await app.idle();assert.doesNotMatch(nextInput,/所有数据均已验证完整/);
  await app.message({taskId:first.task.id,text:'读取不存在的发布',messageId:'qa-invalid-view',mode:'qa',dataView:{kind:'release',releaseRef:{id:'missing-release',version:1}}});await app.idle();
  assert.equal(app.pools().interactive.length,0,'a rejected view must release its execution');
  assert.match(app.memory.messages(first.task.id).at(-1)!.content,/未开始/);
 }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});

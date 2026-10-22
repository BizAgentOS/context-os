import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AgentApplication} from "../../src/agent/app.ts";
import type {AgentDriver,RunRequest} from "../../src/agent/runtime.ts";

test("the host freezes mode with each message, filters old mutation tools and rejects guessed write tools in QA",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"ade-mode-host-"));const requests:RunRequest[]=[];
 const driver:AgentDriver={async run(request){requests.push(request);if(requests.length===2){await assert.rejects(request.onTool("change_propose",{}),/模式|能力/);assert.throws(()=>request.authorizeTool?.("mcp_call",{}),/模式|能力/);}return {text:"已核对当前范围。",sessionId:"mode",runId:"mode"};},async stop(){},async close(){}};
 const app=new AgentApplication(directory,driver,new Set(),false);
 try{
  await app.canvasMessage({page:"setup",text:"先查看当前定义",messageId:"build-message",mode:"build"});await app.idle();
  assert.ok(requests[0].tools.some(t=>t.name==="change_propose"));
  for(const name of ["foundation_propose","live_propose","mapping_change_propose","task_ask"])assert.ok(!requests[0].tools.some(t=>t.name===name),name);
  await assert.rejects(app.canvasMessage({page:"setup",text:"先查看当前定义",messageId:"build-message",mode:"qa"}),/消息|绑定/);
  await app.canvasMessage({page:"ontology",text:"只读查询",messageId:"qa-message",mode:"qa"});await app.idle();
  assert.ok(!requests[1].tools.some(t=>t.name==="change_propose"));assert.deepEqual(requests[1].nativeTools,[]);
  assert.equal(app.memory.getMessage("build-message")!.binding?.mode,"build");assert.equal(app.memory.getMessage("qa-message")!.binding?.mode,"qa");
 }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});

test("the generic message endpoint freezes QA mode and rejects a changed retry binding",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"ade-generic-mode-"));let captured:RunRequest|undefined;
 const driver:AgentDriver={async run(request){captured=request;await assert.rejects(request.onTool("change_propose",{}),/模式|能力/);return{text:"当前范围只读。",sessionId:"qa",runId:"qa"};},async stop(){},async close(){}};
 const app=new AgentApplication(directory,driver,new Set(),false);
 try{
  const result=await app.message({text:"只读查看",messageId:"generic-qa",mode:"qa"});await app.idle();
  assert.equal(app.memory.getMessage("generic-qa")?.binding?.mode,"qa");
  assert.ok(captured&&!captured.tools.some(t=>t.name==="change_propose"));
  await assert.rejects(app.message({taskId:result.task.id,text:"只读查看",messageId:"generic-qa",mode:"build"}),/消息|绑定/);
 }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});

test("a mode suggestion waits for the user without changing the frozen message or granting writes",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"ade-mode-suggestion-"));
 const driver:AgentDriver={async run(request){
  assert.ok(request.tools.some(tool=>tool.name==="mode_suggest"));
  await request.onTool("mode_suggest",{mode:"build",reason:"需要先修正对象关系才能回答。"});
  await assert.rejects(request.onTool("change_propose",{}),/失效|等待用户|模式|能力/);
  return{text:"可切换到构建助手处理关系；本轮没有修改本体。",sessionId:"qa",runId:"suggest"};
 },async stop(){},async close(){}};
 const app=new AgentApplication(directory,driver,new Set(),false);
 try{
  await app.canvasMessage({page:"ontology",text:"请修正关系",messageId:"suggest-build",mode:"qa"});await app.idle();
  const message=app.memory.getMessage("suggest-build")!;
  assert.equal(message.binding?.mode,"qa");
  assert.equal(app.memory.getTask(message.taskId).status,"waiting");
  assert.equal(app.memory.listArtifacts("ontology_change").length,0);
  const run=app.memory.listArtifacts("agent_run")[0];
  assert.equal((run.content.decisions as any[])[0].kind,"mode_suggestion");
  assert.equal((run.content.decisions as any[])[0].mode,"build");
  assert.equal(app.memory.listArtifacts("pending_item").length,0);
 }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../../src/agent/server.ts';
import type {AddressInfo} from 'node:net';
import {Workspace} from '../../src/agent/workspace.ts';
import type {AgentDriver} from '../../src/agent/runtime.ts';

test('the first program build queues one naming review in the existing background pool',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ade-naming-host-'));let calls=0;
 const driver:AgentDriver={async run(request){
  assert.ok(request.tools.some(tool=>tool.name==='naming_context_read'));
  assert.equal(request.tools.some(tool=>/adopt|change_propose/.test(tool.name)),false);calls++;
  const proposals:any[]=[];let offset=0;
  do{
   const page=await request.onTool('naming_context_read',{offset,limit:30}) as any;
   for(const item of page.items)proposals.push({key:item.key,name:item.name,aliases:item.aliases??[],description:item.description||'当前来源中的业务记录',evidence:'已读取此项对应的实际字段画像和数据样本。'});
   offset=page.nextOffset;
  }while(offset!==null&&offset!==undefined);
  await request.onTool('naming_batch_propose',{items:proposals,finalize:true});
  return{text:'已保存待处理命名。',status:'completed',sessionId:'naming',runId:'naming'};
 },async stop(){},async close(){}};
 const service=await createServer({directory,driver,automaticApi:false}),app=service.app;
 await new Promise<void>(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 try{
  const source=new Workspace(app.memory).upload('orders.csv','id,amount\nO1,10\nO2,20\n');
  await app.programBuilds.build({operationId:'first-program',sourceIds:[source.id],autoAdopt:true});await app.idle();
  assert.equal(calls,1);assert.equal(app.memory.listArtifacts('naming_job').length,1);
  const candidate=app.memory.listArtifacts('naming_batch')[0];assert.ok(candidate);assert.equal(candidate.status,'candidate');
  const pending=app.pendingCenter.list({category:'naming'});assert.equal(pending.filteredTotal,1);assert.equal(pending.items[0].actions.adopt,false);
  assert.equal(app.pools().background.active,null);
  await app.programBuilds.idle();await app.idle();assert.equal(calls,1);
  const response=await fetch(`http://127.0.0.1:${(service.server.address() as AddressInfo).port}/api/naming/batches/read?`+new URLSearchParams({id:candidate.id,version:String(candidate.version)}),{headers:{'X-DataEngine-Token':service.adminToken}});
  assert.equal(response.status,200);const detail=await response.json() as any;assert.equal(detail.candidate.id,candidate.id);assert.ok(detail.items.length>0);
  const edit=await fetch(`http://127.0.0.1:${(service.server.address() as AddressInfo).port}/api/naming/batches/edit`,{method:'POST',headers:{'X-DataEngine-Token':service.adminToken,'Content-Type':'application/json'},body:JSON.stringify({id:candidate.id,version:candidate.version,items:[{key:detail.items[0].key,description:'人工核对的业务记录含义'}]})});
  assert.equal(edit.status,200);const edited=await edit.json() as any;assert.equal(edited.candidate.version,candidate.version+1);assert.equal(edited.change.status,'proposed');
 }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});

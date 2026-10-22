import {test} from 'node:test';
import assert from 'node:assert/strict';
import {identityWorkspace,ref} from './identity-release-fixture.ts';
import {Workspace} from '../../src/agent/workspace.ts';

test('source removal previews published and working dependencies, requires confirmation and protects every published upload',async()=>{
 const w=await identityWorkspace();
 try{
  const release=await w.publish('发布保留数据'),uploadRef=w.people.content.localSource as {id:string;version:number},source=w.service.app.memory.getArtifact(uploadRef.id);
  const path='/api/sources/impact?'+new URLSearchParams({id:source.id,version:String(source.version)}),impact=await w.manage(path);
  assert.equal(impact.releases[0].id,release.id);assert(impact.entities.some((item:any)=>item.name==='人员'));assert.equal(impact.allowed.remove,false);
  assert.equal((await w.request('/api/sources/manage',{...ref(source),operationId:'remove-published',action:'remove',acknowledgeImpact:true})).status,400);
  assert.equal((await w.request('/api/canvas/upload/remove',ref(source))).status,400,'the old upload route cannot bypass publication protection');
  assert.equal((await w.request('/api/sources/manage',{...ref(source),operationId:'disable-without-ack',action:'disable'})).status,400);
  const stopped=await w.manage('/api/sources/manage',{...ref(source),operationId:'stop-published',action:'disable',acknowledgeImpact:true});assert.equal(stopped.source.status,'disabled');assert.equal(w.service.app.memory.getArtifact(w.people.id).status,'disabled');
  assert.equal(w.service.app.memory.getArtifact(release.id).version,release.version);
  const loose=new Workspace(w.service.app.memory).upload('临时资料.md','没有被发布引用的临时文本。');
  const removed=await w.manage('/api/sources/manage',{...ref(loose),operationId:'remove-loose',action:'remove',acknowledgeImpact:true});assert.equal(removed.source.status,'removed');
  const replay=await w.manage('/api/sources/manage',{...ref(loose),operationId:'remove-loose',action:'remove',acknowledgeImpact:true});assert.equal(replay.source.version,removed.source.version);
  assert.equal((await w.manage('/api/sources/summary')).sources.some((item:any)=>item.id===loose.id),false);
 }finally{await w.close();}
});

test('a completed source action replay never stops a newer assistant run and the old route requires impact confirmation',async()=>{
 let stopped=0,started!:()=>void,finish!:()=>void;const running=new Promise<void>(resolve=>started=resolve);
 const driver={async run(){started();await new Promise<void>(resolve=>finish=resolve);return{text:'已结束',runId:'newer-run',sessionId:'newer-session'};},async stop(){stopped++;finish?.();},async close(){finish?.();}};
 const w=await identityWorkspace(driver);
 try{
  const source=new Workspace(w.service.app.memory).upload('删除回执资料.md','本地临时资料。');
  assert.equal((await w.request('/api/canvas/upload/remove',ref(source))).status,400);
  assert.equal(w.service.app.memory.getArtifact(source.id).status,'ready');
  const input={...ref(source),operationId:'completed-remove',action:'remove',acknowledgeImpact:true};await w.manage('/api/sources/manage',input);
  const session=w.service.app.memory.defaultSession();await w.manage('/api/canvas/message',{page:'setup',sessionId:session.id,messageId:'newer-run',text:'继续核对当前工作区',mode:'build'});await running;
  assert.equal((await w.request('/api/sources/manage',input)).status,200);assert.equal(stopped,0);assert.equal(w.service.app.pools().interactive.length,1);
 }finally{finish?.();await w.close();}
});

test('publication protection follows pinned document evidence used by adopted entity wording',async()=>{
 const w=await identityWorkspace();
 try{
  const {FoundationDocuments}=await import('../../src/agent/foundation-evidence.ts'),{freezeAgentTurn}=await import('../../src/agent/agent-modes.ts');
  const source=new Workspace(w.service.app.memory).upload('人员定义.md','星桥的人员是已登记并承担工作职责的实际工作人员。'),session=w.service.app.memory.createSession(),context=w.service.app.memory.beginExecution(session.taskId);
  try{
   const docs=new FoundationDocuments(w.service.app.memory,context),read=docs.read({sourceId:source.id}),turn=freezeAgentTurn(w.service.app.memory,context,{mode:'build'});
   await w.service.app.agentChanges.execute('change_propose',{operationId:'document-wording',type:'description',baseline:w.service.app.changes.currentBaseline(),evidence:'人员资料说明',subject:{target:'concept',id:'person',description:'已登记并承担工作职责的实际工作人员',evidence:[{id:'person-document',kind:'document',readId:read.readId,quote:read.text}]}},context,turn,docs);
  }finally{w.service.app.memory.endExecution(context);}
  const release=await w.publish('含文档说明的发布'),impact=await w.manage('/api/sources/impact?'+new URLSearchParams({id:source.id,version:String(source.version)}));
  assert(impact.releases.some((item:any)=>item.id===release.id));assert.equal(impact.allowed.remove,false);assert(impact.entities.some((item:any)=>item.id==='person'));
 }finally{await w.close();}
});

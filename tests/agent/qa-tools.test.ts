import {test} from 'node:test';
import assert from 'node:assert/strict';
import {identityWorkspace,ref} from './identity-release-fixture.ts';
import {QuestionAnswering} from '../../src/agent/qa-tools.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../../src/agent/server.ts';
import {seedFoundation} from './program-foundation-fixture.ts';
import {Releases} from '../../src/engine/releases.ts';
import {Workspace} from '../../src/agent/workspace.ts';
import {FoundationDocuments} from '../../src/agent/foundation-evidence.ts';
import {freezeAgentTurn} from '../../src/agent/agent-modes.ts';

const service=(app:any)=>new QuestionAnswering(app.memory,app.foundation,app.live,app.snapshots,app.workspaceVersions,app.changes);
test('question answering freezes working and release views, derives answer receipts, and never exposes mutation tools',async()=>{
  const w=await identityWorkspace(),app=w.service.app;
  try{
    const qa=service(app),release=await w.publish('问答基线');
    const working=qa.begin({question:'机器人属于谁',dataView:{kind:'working'}}),published=qa.begin({question:'发布内机器人属于谁',dataView:{kind:'release',releaseRef:ref(release)}});
    await w.decide('a-bot','no_match',null,'qa-no-bot');
    const query={target:{entityTypeId:'account',id:'a-bot'},traverse:[{relationTypeId:'account_owner'}]};
    const before=await working.execute('relations_traverse',query),fixed=await published.execute('relations_traverse',query);
    assert.equal((before.result as any).items[0].$id,'P2');assert.equal((fixed.result as any).items[0].$id,'P2');
    const fresh=await qa.begin({question:'现在机器人属于谁',dataView:{kind:'working'}}).execute('relations_traverse',query);
    assert.deepEqual((fresh.result as any).items,[]);
    assert.equal(fresh.reason,'empty','an explicit exclusion is a known empty result, not a missing mapping');
    const card=published.answer('发布时对应人员周');assert.equal((card.receipt as any).dataView.releaseRef.id,release.id);assert.equal((card.evidence as any[]).length,1);
    assert.ok(JSON.stringify(card).includes('dataAsOf'));
    const beforeWrites=app.memory.listArtifacts('ontology_change').length;
    await assert.rejects(published.execute('change_propose',{type:'entity'}),/问答|只读|能力/);
    assert.equal(app.memory.listArtifacts('ontology_change').length,beforeWrites);
    assert.ok(published.tools.every(tool=>!tool.mutates||tool.name==='gap_report'));
  }finally{await w.close();}
});

test('a published definition without a model remains describable and reports an unbound entity',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'ade-qa-definitions-')),server=await createServer({directory,automaticApi:false}),app=server.app;
  try{
    seedFoundation(app.memory,app.foundation,{enterprise:'定义先行',concepts:[{id:'company',name:'公司',description:'已确认的业务公司'}]});
    const releases=new Releases(app.memory,app.live),checked=await releases.check({inputHash:releases.overview().working.inputHash});assert.equal(checked.status,'ready');
    const release=releases.publish({operationId:'definition-release',checkRef:ref(checked),name:'定义发布'}).release;
    const run=service(app).begin({question:'有哪些公司',dataView:{kind:'release',releaseRef:ref(release)}});
    const directory=await run.execute('ontology_describe',{});assert.equal((directory.result as any).entities[0].name,'公司');
    assert.doesNotMatch(JSON.stringify(directory),/programEvidenceId|evidenceRefs/);
    const result=await run.execute('objects_query',{target:{entityTypeId:'company'}});assert.equal(result.reason,'unbound');
  }finally{await server.close();rmSync(directory,{recursive:true,force:true});}
});

test('authorized evidence is tied to returned objects and contains actual permitted source values',async()=>{
  const w=await identityWorkspace(),app=w.service.app;
  try{
    const release=await w.publish('有依据问答'),connected=await w.manage('/api/releases/connect',{operationId:'qa-evidence',name:'姓名及依据',releaseRef:ref(release),conceptIds:['person'],relationIds:[],business:{grants:[{type:'人员',fields:['$id','姓名'],relations:[],evidence:{fields:['姓名'],relations:[]}}]}});
    const name=app.live.readLayered(w.currentModel().id).semantic.properties.find(p=>p.entityTypeId==='person'&&p.name==='姓名')!.id;
    const run=service(app).begin({question:'P1姓名依据',dataView:{kind:'consumer',releaseRef:ref(release),connectionRef:ref(connected.connection)}});
    const read=await run.execute('objects_query',{target:{entityTypeId:'person',id:'P1'},fields:[name]});
    const evidence=await run.execute('evidence_read',{readId:read.readId,objectId:'P1',propertyId:name});
    const cell=(evidence.result as any).evidence[0].properties[name];assert.equal(cell.value,'林');assert.equal(cell.evidence[0].value,'林');assert.equal(cell.evidence[0].recordId,'P1');
    assert.doesNotMatch(JSON.stringify(evidence),/sourceId|bindingId|column|new@example/);
    await assert.rejects(run.execute('evidence_read',{readId:read.readId,objectId:'P2',propertyId:name}),/该次结果/);
    assert.equal((run.answer('林').evidence as any[]).length,2);
  }finally{await w.close();}
});

test('live sources support bounded object reads and explicitly decline full aggregation',async()=>{
  const w=await identityWorkspace(),app=w.service.app;
  try{
    const dataset=app.snapshots.bindingDataset(w.people.id,'records')!;app.snapshots.setPolicy({...ref(dataset),materialization:'live'});
    const name=app.live.readLayered(w.currentModel().id).semantic.properties.find(p=>p.entityTypeId==='person'&&p.name==='姓名')!.id;
    const run=service(app).begin({question:'实时人员'});
    const read=await run.execute('objects_query',{target:{entityTypeId:'person'},fields:[name]});
    assert.equal((read.result as any).items[0].values[name],'林');assert.ok((read.result as any).sources.some((s:any)=>s.readMode==='live'));
    const aggregate=await run.execute('objects_aggregate',{target:{entityTypeId:'person'},aggregate:{measures:[{as:'人数',op:'count'}]}});
    assert.equal(aggregate.reason,'incomplete');assert.match(String(aggregate.message),/实时|固定快照/);
    await assert.rejects(run.execute('gap_report',{readId:aggregate.readId,observation:'不能冒充建模缺口'}),/实际读取/);
  }finally{await w.close();}
});

test('consumer question answering enforces predicates and evidence grants and fails after revocation',async()=>{
  const w=await identityWorkspace(),app=w.service.app;
  try{
    const release=await w.publish('受限问答');
    const connected=await w.manage('/api/releases/connect',{operationId:'qa-reader',name:'仅姓名',releaseRef:ref(release),conceptIds:['person'],relationIds:[],business:{grants:[{type:'人员',fields:['$id','姓名'],relations:[]}]}});
    const qa=service(app),run=qa.begin({question:'人员姓名',dataView:{kind:'consumer',connectionRef:ref(connected.connection),releaseRef:ref(release)}});
    const layer=app.live.readLayered(w.currentModel().id),name=layer.semantic.properties.find(p=>p.entityTypeId==='person'&&p.name==='姓名')!.id,email=layer.semantic.properties.find(p=>p.entityTypeId==='person'&&p.name==='邮箱')!.id;
    const result=await run.execute('objects_query',{target:{entityTypeId:'person'},fields:[name]});
    assert.equal((result.result as any).items.length,2);assert.doesNotMatch(JSON.stringify(result),/new@example|shared@example|binding_|sourceId|connections/);
    const groups=await run.execute('objects_aggregate',{target:{entityTypeId:'person'},fields:[name],aggregate:{groupBy:[name],measures:[{as:'人数',op:'count'}]}});
    assert.equal((groups.result as any).groupMembers.flatMap((group:any)=>group.items).length,2);
    const card=run.answer('按姓名分组');assert.equal((card.evidence as any[])[0].labels[name],'姓名');assert.equal((card.evidence as any[])[0].labels[email],undefined);
    for(const expression of [{filters:[{propertyId:email,op:'eq',value:'new@example.test'}]},{sort:[{propertyId:email}]},{aggregate:{groupBy:[email],measures:[{as:'n',op:'count'}]}}])
      await assert.rejects(run.execute(expression.aggregate?'objects_aggregate':'objects_query',{target:{entityTypeId:'person'},fields:[name],...expression}),/授权|范围/);
    await assert.rejects(run.execute('evidence_read',{readId:result.readId,objectId:'P1',propertyId:name}),/依据|授权/);
    await w.manage('/api/releases/revoke',{operationId:'revoke-qa',connectionRef:ref(connected.connection)});
    await assert.rejects(run.execute('ontology_describe',{}),/停用|撤销|变化|授权/);
    assert.throws(()=>run.answer('不得泄露旧结果'),/停用|撤销|变化|授权/);
  }finally{await w.close();}
});

test('the per-turn reading limit is shared across tools and produces an explicit partial-answer limit',async()=>{
  const w=await identityWorkspace();
  try{
    const run=service(w.service.app).begin({question:'读取本体',dataView:{kind:'working'}});
    for(let i=0;i<24;i++)await run.execute(i%2?'ontology_search':'ontology_describe',i%2?{query:'人员'}:{});
    await assert.rejects(run.execute('ontology_describe',{}),/预算/);
    assert.match(JSON.stringify(run.answer('已返回已读部分')),/预算/);
  }finally{await w.close();}
});

test('stopping an in-flight read discards its late evidence',async()=>{
  const w=await identityWorkspace();
  try{
    let active=true;const run=service(w.service.app).begin({question:'列出人员',assertActive:()=>{if(!active)throw new Error('运行已停止');}});
    const pending=run.execute('objects_query',{target:{entityTypeId:'person'}});active=false;
    await assert.rejects(pending,/停止/);active=true;
    const answer=run.answer('未取得读取结果');assert.deepEqual(answer.evidence,[]);assert.equal((answer.receipt as any).bytes,0);
  }finally{await w.close();}
});

test('the shared evidence byte budget rejects oversized deliveries without retaining them in the answer',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'ade-qa-budget-')),server=await createServer({directory,automaticApi:false}),app=server.app;
  try{
    seedFoundation(app.memory,app.foundation,{enterprise:'大目录',concepts:Array.from({length:20},(_,i)=>({id:`entity-${i}`,name:`业务${i}`,description:'业务定义'.repeat(300)}))});
    const run=service(app).begin({question:'解释目录'});let delivered=0;
    for(;delivered<24;delivered++){
      try{await run.execute('ontology_describe',{});}catch(error){assert.match((error as Error).message,/依据读取预算/);break;}
    }
    assert.ok(delivered>0&&delivered<24);const card=run.answer('只解释已取得目录');assert.ok((card.receipt as any).bytes<=512*1024);assert.match(JSON.stringify(card.limits),/512/);
  }finally{await server.close();rmSync(directory,{recursive:true,force:true});}
});

test('knowledge search includes document citations adopted for an individual property',async()=>{
  const w=await identityWorkspace(),app=w.service.app;
  try{
    const property=app.live.readLayered(w.currentModel().id).semantic.properties.find(p=>p.entityTypeId==='person'&&p.name==='邮箱')!;
    const source=new Workspace(app.memory).upload('邮箱说明.md','邮箱字段记录员工的办公电子邮箱。');
    const session=app.memory.createSession(),context=app.memory.beginExecution(session.taskId),turn=freezeAgentTurn(app.memory,context,{mode:'build'}),documents=new FoundationDocuments(app.memory,context,new Set(),app.live.sources),part=documents.read({sourceId:source.id});
    try{await app.agentChanges.execute('change_propose',{operationId:'email-meaning',type:'description',baseline:app.changes.currentBaseline(),subject:{target:'property',id:property.id,description:'员工的办公电子邮箱',evidence:[{id:'email-citation',kind:'document',readId:part.readId,quote:part.text}]},evidence:'公司邮箱说明'},context,turn,documents);}finally{app.memory.endExecution(context);}
    const adopted=app.foundation.read().adopted!,conflict=(adopted.content.conflicts as any[]).find(item=>!item.resolvedBy);
    if(conflict){const proposal=await app.adjudication.propose({operationId:'email-interpretation',foundationRef:ref(adopted),issue:{kind:'conflict',id:conflict.id},action:'choose_proposed',reason:'公司确认这是办公邮箱'}),checked=await app.changes.verify({...ref(proposal.change),operationId:'email-check'});await app.changes.adopt({...ref(checked),operationId:'email-adopt'});}
    const result=await service(app).begin({question:'邮箱含义依据'}).execute('knowledge_query',{query:'办公电子邮箱'});
    assert.equal((result.result as any).items[0]?.quote,'邮箱字段记录员工的办公电子邮箱。');
  }finally{await w.close();}
});

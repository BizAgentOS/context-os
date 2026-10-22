import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../../src/agent/server.ts';
import {Onboarding} from '../../src/agent/onboarding.ts';
import {Workspace} from '../../src/agent/workspace.ts';

test('first use resumes after sources and reaches adopted ontology without enterprise profile or naming approval',{timeout:20000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'context-os-first-use-'));
  let service=await createServer({directory,automaticApi:false});
  const guide=()=>new Onboarding(service.app.memory,service.app.foundation,undefined,service.app.live);
  try{
    let onboarding=guide(),view=onboarding.view(true);
    assert.equal(view.firstUse.build.status,'waiting_source');assert.equal(view.firstUse.ontology.entities,0);
    assert.throws(()=>onboarding.step({expectedVersion:view.version,step:2},false),/连接模型/);
    onboarding.step({expectedVersion:view.version,step:2},true);
    const source=new Workspace(service.app.memory).upload('orders.csv','id,amount\nO1,10\nO2,20\nO3,30\n');
    onboarding.step({expectedVersion:onboarding.view(true).version,step:3,sourceKind:'file'},true);
    onboarding.suspend({expectedVersion:onboarding.view(true).version});
    await service.close();service=await createServer({directory,automaticApi:false});onboarding=guide();
    onboarding.start({expectedVersion:onboarding.view(true).version,flow:'engine'});
    assert.equal(onboarding.view(true).step,3);assert.equal(onboarding.view(true).sourceKind,'file');
    await service.app.programBuilds.build({operationId:'first-use-build',sourceIds:[source.id],autoAdopt:true});
    view=onboarding.view(true);assert.equal(view.firstUse.build.status,'ready');assert.equal(view.firstUse.build.sourcesRead,1);assert.equal(view.firstUse.ontology.entities,1);
    assert.equal(service.app.memory.listArtifacts('profile').length,0,'enterprise facts are optional and never invented');
    for(const step of [4,5,6])onboarding.step({expectedVersion:onboarding.view(true).version,step,...(step===5?{skipNaming:true}:{})},true);
    assert(onboarding.view(true).firstUse.skipped.includes('naming'));
    assert.equal(onboarding.view(true).firstUse.firstAnswer,null,'finishing navigation is not evidence of an answered question');
    onboarding.complete({expectedVersion:onboarding.view(true).version},true);
    assert.equal(onboarding.view(true).step,6);assert.equal(onboarding.view(true).active,false);
    assert.equal(service.app.memory.listArtifacts('ontology_change').filter(item=>item.content.type==='naming_batch'&&item.status==='adopted').length,0,'skipping naming never adopts it');
  }finally{await service.close();rmSync(directory,{recursive:true,force:true,maxRetries:3});}
});

test('three example questions use adopted bindings and execute against actual records without fabricating answers',{timeout:20000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'context-os-first-questions-')),service=await createServer({directory,automaticApi:false}),app=service.app;
  const onboarding=new Onboarding(app.memory,app.foundation,undefined,app.live);
  try{
    assert.equal(onboarding.examples().questions.length,0);
    const source=new Workspace(app.memory).upload('orders.csv','id,amount\nO1,10\nO2,20\nO3,30\n');
    await app.programBuilds.build({operationId:'questions-build',sourceIds:[source.id],autoAdopt:true});
    assert(onboarding.examples().questions.every(item=>!item.id.startsWith('sum:')),'untyped CSV values must not be advertised as numeric measures');
    const model=app.memory.listArtifacts('live_ontology').find(item=>item.status==='adopted')!,layered=app.live.readLayered(model.id);
    const amount=layered.semantic.properties.find(item=>item.name==='amount')!,binding=layered.bindings.properties.find(item=>item.propertyId===amount.id)!;
    const proposed=await app.changes.propose({operationId:'declare-amount',origin:'human',type:'property',baseline:app.changes.currentBaseline(),subject:{action:'update',property:{id:amount.id,valueType:'decimal'},binding:{entityBindingId:binding.entityBindingId,column:'amount',transform:{op:'cast',valueType:'decimal'}}}});
    const verified=await app.changes.verify({id:proposed.change.id,version:proposed.change.version,operationId:'verify-amount'});
    assert.equal(verified.status,'verified');await app.changes.adopt({id:verified.id,version:verified.version,operationId:'adopt-amount'});
    const examples=onboarding.examples();assert.equal(examples.questions.length,3);assert.deepEqual(examples.dataView,{kind:'working'});
    assert.equal(new Set(examples.questions.map(item=>item.question)).size,3);
    assert.equal(app.memory.listArtifacts('profile').length,0);
    const counts=[];const version=app.workspaceVersions.latest()!.id;
    for(const item of examples.questions){
      assert.equal((item as any).answer,undefined);
      const qa=app.questionAnswering.begin({question:item.question,dataView:examples.dataView});
      const reading=await qa.execute(item.tool,item.args);assert.equal(reading.status,'available',JSON.stringify(reading));
      const answer=qa.answer('以上数值来自本次实际读取。');assert((answer.evidence as any[]).length>0);
      if(item.tool==='objects_aggregate')counts.push(...(reading.result as any).items.map((row:any)=>row.values?.total??row.total));
    }
    assert(counts.includes(3),'one example counts the actual three orders');
    assert(counts.includes(60),'numeric examples aggregate actual values instead of guessed business facts');
    assert.equal(app.workspaceVersions.latest()!.id,version,'example generation and query do not modify the working version');
    const connection=app.live.sources.list().find(item=>(item.content.localSource as any)?.id===source.id)!;
    app.live.sources.disable(connection.id,connection.version);
    assert.equal(onboarding.examples().questions.length,0,'revoked sources do not remain advertised as executable example questions');
  }finally{await service.close();rmSync(directory,{recursive:true,force:true,maxRetries:3});}
});

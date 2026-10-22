import {test} from 'node:test';
import assert from 'node:assert/strict';
import {identityWorkspace,ref} from './identity-fixture.ts';
import {Workspace} from '../../src/agent/workspace.ts';
import {FoundationDocuments} from '../../src/agent/foundation-evidence.ts';
import {freezeAgentTurn} from '../../src/agent/agent-modes.ts';

test('renaming identity properties before adopting a relationship keeps stable IDs and allows the original gap to be reasked', {timeout:60000}, async()=>{
 const w=await identityWorkspace(),app=w.service.app;
 try{
  const initial=app.live.readLayered(w.model.id),identity=initial.semantic.properties.find(item=>item.entityTypeId==='person'&&item.isIdentity)!;
  await w.adopt('naming',{target:'property',id:identity.id,name:'员工编号'});
  const run=app.questionAnswering.begin({question:'账号 A1 对应哪位员工？'});
  const missing=await run.execute('relations_traverse',{target:{entityTypeId:'account',id:'A1'},relationName:'对应员工',toEntityTypeId:'person'});
  const gap=app.questionAnswering.gaps.handoff({...ref((await run.execute('gap_report',{readId:missing.readId,observation:'账号到员工缺少关系'})).gap as any),operationId:'named-gap-handoff'}).gap;
  const from=app.snapshots.bindingDataset(w.sources.accounts.id,'accounts')!,to=app.snapshots.bindingDataset(w.sources.people.id,'people')!;
  const proposed=(await w.call('/api/changes/propose',{operationId:'named-relation',origin:'human',type:'relation',baseline:app.changes.currentBaseline(),subject:{from:{datasetId:from.id,column:'email'},to:{datasetId:to.id,column:'email'},cardinality:'N:1'}})).body.change;
  const verified=(await w.call('/api/changes/verify',{...ref(proposed),operationId:'named-relation-verify'})).body.change;
  assert.equal(verified.status,'verified');
  const preview=await app.questionAnswering.gaps.preview({...ref(gap),operationId:'named-gap-preview',changeRef:ref(verified),relationResolutions:[{fromRelationId:(gap.content.query as any).traverse[0].relationTypeId,toRelationId:'$proposed'}]});
  assert.equal((preview.after.result as any).items[0].$id,'P1');
  app.questionAnswering.gaps.linkChange({...ref(gap),operationId:'named-gap-link',changeRef:ref(verified),previewRef:ref(preview.preview)});
  const adopted=await w.call('/api/changes/adopt',{...ref(verified),operationId:'named-relation-adopt',acknowledgeReview:true});
  assert.equal(adopted.status,200);
  const result=await w.call('/api/gaps/reask',{...ref(app.questionAnswering.gaps.get(gap.id)),operationId:'named-gap-reask'});
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.gap.status,'confirmed');
  assert.equal(result.body.result.result.items[0].$id,'P1');
  assert.equal((await w.call('/api/ontology/workspace')).status,200);
  const model=app.memory.getArtifact(adopted.body.change.content.effect.modelRef.id),current=app.live.readLayered(model.id);
  assert.deepEqual(current.semantic.entityTypes.find(item=>item.id==='person')!.identityKeys,[identity.id]);
  assert.equal(current.semantic.properties.find(item=>item.id===identity.id)!.name,'员工编号');
  assert.equal(current.semantic.properties.filter(item=>item.entityTypeId==='person'&&item.isIdentity).length,1);
 }finally{await w.close();}
});

test('historical name-derived property IDs recover only through the same immutable binding and fixed releases stay unchanged', {timeout:60000}, async()=>{
 const w=await identityWorkspace(),app=w.service.app;
 try{
  const original=app.live.readLayered(w.model.id),identity=original.semantic.properties.find(item=>item.entityTypeId==='person'&&item.isIdentity)!;
  await w.adopt('naming',{target:'property',id:identity.id,name:'员工编号'});
  const from=app.snapshots.bindingDataset(w.sources.accounts.id,'accounts')!,to=app.snapshots.bindingDataset(w.sources.people.id,'people')!;
  await w.adopt('relation',{from:{datasetId:from.id,column:'email'},to:{datasetId:to.id,column:'email'},cardinality:'N:1'});
  // Persist the pre-fix historical shape: executable bindings are valid, but the
  // renamed property got a fresh ID while the foundation retained its stable ID.
  const model=w.model,content=structuredClone(model.content),layered=content.layered as any,legacyId='historical_name_derived_identity';
  layered.semantic.properties.find((item:any)=>item.id===identity.id).id=legacyId;
  layered.semantic.entityTypes.find((item:any)=>item.id==='person').identityKeys=[legacyId];
  for(const binding of layered.bindings.properties)if(binding.propertyId===identity.id)binding.propertyId=legacyId;
  const historical=app.memory.putArtifact({...model,expectedVersion:model.version,content});
  const workspace=await w.call('/api/ontology/workspace');
  assert.equal(workspace.status,200,JSON.stringify(workspace.body));
  const restored=app.live.readLayered(historical.id);
  assert.deepEqual(restored.semantic.entityTypes.find(item=>item.id==='person')!.identityKeys,[identity.id]);
  assert.equal(restored.semantic.properties.find(item=>item.id===identity.id)!.name,'员工编号');
  assert.equal(app.memory.getArtifact(historical.id).version,historical.version,'compatibility reads must not rewrite history');
  assert.deepEqual(app.live.readLayered(historical.id,historical.version).semantic.entityTypes.find(item=>item.id==='person')!.identityKeys,[legacyId],'explicit historical wording remains fixed');
  const projected=app.live.projectModel(historical).content;
  const prepared=await app.live.prepareDefinitionAgainst({foundationRef:projected.foundationRef,baseModelRef:ref(historical),purpose:projected.purpose,rationale:'沿已确认绑定继续重建',types:projected.types,relations:projected.relations},app.foundation.read().adopted!);
  assert.deepEqual(((prepared.layered as any).semantic.entityTypes as any[]).find(item=>item.id==='person').identityKeys,[identity.id],'subsequent model preparation persists recovered stable IDs');
  const query=await w.call('/api/semantic/query',{target:{entityTypeId:'person',id:'P1'},fields:[identity.id]});
  assert.equal(query.status,200,JSON.stringify(query.body));
  const working=(await w.call('/api/releases')).body.working;
  const check=(await w.call('/api/releases/check',{inputHash:working.inputHash})).body;
  assert.equal(check.status,'ready',JSON.stringify(check));
  const published=(await w.call('/api/releases/publish',{operationId:'repaired-release',checkRef:ref(check),name:'恢复稳定身份的发布'})).body.release;
  const connection=await w.call('/api/releases/connect',{operationId:'repaired-reader',name:'人员读取',releaseRef:ref(published),conceptIds:['person'],relationIds:[],business:{grants:[{type:'人员',fields:['$id','员工编号'],relations:[]}]}});
  assert.equal(connection.status,200,JSON.stringify(connection.body));
  const external=await fetch(`http://127.0.0.1:${(w.service.server.address() as any).port}/v4/objects?type=${encodeURIComponent('人员')}&id=P1`,{headers:{authorization:`Bearer ${connection.body.key}`}});
  assert.equal(external.status,200,await external.clone().text());
  const fixed=app.questionAnswering.begin({question:'发布中的员工编号',dataView:{kind:'release',releaseRef:ref(published)}});
  assert.equal((await fixed.execute('objects_query',{target:{entityTypeId:'person',id:'P1'},fields:[identity.id]})).status,'available');
  const changed=structuredClone(historical.content),changedLayer=changed.layered as any;
  changedLayer.bindings.entities.find((item:any)=>item.entityTypeId==='person').keyColumns=['email'];
  changedLayer.bindings.properties.find((item:any)=>item.propertyId===legacyId).column='email';
  app.memory.putArtifact({kind:historical.kind,title:historical.title,status:'adopted',content:changed});
  assert.notEqual((await w.call('/api/ontology/workspace')).status,200,'changed binding cannot be silently treated as the historical identity');
  assert.equal((await fixed.execute('objects_query',{target:{entityTypeId:'person',id:'P1'},fields:[identity.id]})).status,'available','a later working-model defect cannot change the frozen release');
 }finally{await w.close();}
});


test('historical renamed IDs survive document revisions and repeated rebuild ancestry before relationship adoption', {timeout:60000}, async()=>{
 const w=await identityWorkspace(),app=w.service.app;
 try{
  const original=w.model,identity=app.live.readLayered(original.id).semantic.properties.find(item=>item.entityTypeId==='person'&&item.isIdentity)!;
  await w.adopt('naming',{target:'property',id:identity.id,name:'员工编号'});
  const source=new Workspace(app.memory).upload('员工身份说明.md','员工编号用于唯一识别在职人员。');
  const session=app.memory.createSession(),context=app.memory.beginExecution(session.taskId),turn=freezeAgentTurn(app.memory,context,{mode:'build'});
  const documents=new FoundationDocuments(app.memory,context,new Set(),app.live.sources),part=documents.read({sourceId:source.id});
  try{
   const result=await app.agentChanges.execute('change_propose',{operationId:'identity-document',type:'description',baseline:app.changes.currentBaseline(),subject:{target:'property',id:identity.id,description:'唯一识别在职人员',evidence:[{id:'identity-document',kind:'document',readId:part.readId,quote:part.text}]},evidence:'员工身份说明'},context,turn,documents) as any;
   assert.equal(result.change.status,'adopted');
  }finally{app.memory.endExecution(context);}
  const foundation=app.foundation.read().adopted!,conflict=(foundation.content.conflicts as any[]).find(item=>!item.resolvedBy);
  if(conflict){
   const proposal=await app.adjudication.propose({operationId:'confirm-identity-document',foundationRef:ref(foundation),issue:{kind:'conflict',id:conflict.id},action:'choose_proposed',reason:'确认员工编号的业务含义'});
   const checked=await app.changes.verify({...ref(proposal.change),operationId:'confirm-identity-document-check'});
   await app.changes.adopt({...ref(checked),operationId:'confirm-identity-document-adopt'});
  }
  // These immutable artifacts reproduce already-saved legacy builds: naming and
  // document revisions retained canonical foundation properties, while each
  // subsequent model copied the name-derived IDs from its predecessor.
  const named=app.live.projectModel(original).content,legacyId='historical_rebuild_identity';
  const content=structuredClone(named),layered=content.layered as any;
  layered.semantic.properties.find((item:any)=>item.id===identity.id).id=legacyId;
  layered.semantic.entityTypes.find((item:any)=>item.id==='person').identityKeys=[legacyId];
  for(const binding of layered.bindings.properties)if(binding.propertyId===identity.id)binding.propertyId=legacyId;
  let parent=original;
  for(let i=0;i<8;i++)parent=app.memory.putArtifact({kind:'live_ontology',title:'历史同结构重建',status:'adopted',content:{...content,baseModelRef:ref(parent)}});
  const before=JSON.stringify(app.memory.getArtifact(parent.id));
  const workspace=await w.call('/api/ontology/workspace');
  assert.equal(workspace.status,200,JSON.stringify(workspace.body));
  assert.deepEqual(app.live.readLayered(parent.id).semantic.entityTypes.find(item=>item.id==='person')!.identityKeys,[identity.id]);
  assert.equal(JSON.stringify(app.memory.getArtifact(parent.id)),before,'history is never rewritten');
  assert.deepEqual(app.live.readLayered(parent.id,parent.version).semantic.entityTypes.find(item=>item.id==='person')!.identityKeys,[legacyId]);
  const from=app.snapshots.bindingDataset(w.sources.accounts.id,'accounts')!,to=app.snapshots.bindingDataset(w.sources.people.id,'people')!;
  await w.adopt('relation',{from:{datasetId:from.id,column:'email'},to:{datasetId:to.id,column:'email'},cardinality:'N:1'});
  const query=await w.call('/api/semantic/query',{target:{entityTypeId:'person',id:'P1'},fields:[identity.id]});
  assert.equal(query.status,200,JSON.stringify(query.body));
  const current=app.live.readLayered(w.model.id);
  assert.deepEqual(current.semantic.entityTypes.find(item=>item.id==='person')!.identityKeys,[identity.id]);
  assert.equal(current.semantic.properties.find(item=>item.id===identity.id)!.name,'员工编号');
  assert.equal(current.semantic.relationTypes.length,1);
  // Reverting a changed binding later is not proof that the intervening model
  // preserved identity. Recovery must establish every historical transition.
  const changed=structuredClone(content),changedLayer=changed.layered as any;
  changedLayer.bindings.properties.find((item:any)=>item.propertyId===legacyId).column='email';
  changedLayer.bindings.entities.find((item:any)=>item.entityTypeId==='person').keyColumns=['email'];
  const invalid=app.memory.putArtifact({kind:'live_ontology',title:'历史绑定已变化',status:'adopted',content:{...changed,baseModelRef:ref(original)}});
  app.memory.putArtifact({kind:'live_ontology',title:'后来恢复源列',status:'adopted',content:{...content,baseModelRef:ref(invalid)}});
  assert.notEqual((await w.call('/api/ontology/workspace')).status,200,'cannot skip a changed binding in the ancestry');
 }finally{await w.close();}
});

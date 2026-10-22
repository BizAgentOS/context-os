import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AgentApplication} from '../../src/agent/app.ts';
import {seedFoundation} from './program-foundation-fixture.ts';
import {OntologyWorkspace} from '../../src/semantic/workspace.ts';
import {Workspace} from '../../src/agent/workspace.ts';
import {identityWorkspace,ref} from './identity-fixture.ts';

test('ontology workspace projects adopted entities, parallel relations, current pending and bounded evidence without raw artifacts',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ade-ontology-workspace-'));const app=new AgentApplication(directory,undefined,new Set(),false);
 try{
  seedFoundation(app.memory,app.foundation,{enterprise:'验收企业',concepts:[{id:'person',name:'人员',description:'实际工作人员'},{id:'task',name:'任务',description:'交付工作'}],relations:[{id:'owner',name:'负责人',from:'task',to:'person',description:'责任人员'},{id:'reviewer',name:'复核人',from:'task',to:'person',description:'复核人员'}]});
  const proposed=await app.changes.propose({operationId:'naming',origin:'human',type:'naming',baseline:app.changes.currentBaseline(),subject:{target:'concept',id:'person',name:'员工'}});
  const workspace=new OntologyWorkspace(app.memory,app.foundation,app.live,app.pendingCenter,app.workspaceVersions);
  const result=workspace.overview();
  assert.equal(result.title,'验收企业');assert.equal(result.pending.total,1);assert.equal(result.entities.length,2);assert.equal(result.relations.length,2);
  assert.equal(result.relations.find(item=>item.id==='owner')!.state,'empty','a semantic relation with no data binding has no data');
  assert.ok(result.nextSteps.some(x=>x.action==='pending'));assert.equal(result.entities.find(x=>x.id==='person')!.state,'pending');
  const detail=await workspace.detail({kind:'entity',id:'person'});
  assert.equal(detail.name,'人员');assert.equal(detail.relations.length,2);assert.equal(detail.evidence.total,1);assert.equal(detail.pending.items[0].id,proposed.change.id);
  assert.equal('technical' in detail,false);assert.equal('content' in detail,false);
  await assert.rejects(workspace.detail({kind:'entity',id:'missing'}),/不存在/);
  assert.equal((await workspace.detail({kind:'relation',id:'owner'})).title,'任务 → 负责人 → 人员');
 }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});

test('an adopted unbound property remains visible in entity details and its identity key is explicit',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ade-unbound-workspace-'));const app=new AgentApplication(directory,undefined,new Set(),false);
 try{
  const adopt=async(type:string,subject:unknown,operationId:string)=>{
   const {change}=await app.changes.propose({type,subject,origin:'human',operationId,baseline:app.changes.currentBaseline()});
   const checked=await app.changes.verify({id:change.id,version:change.version,operationId:operationId+'-check'});
   return app.changes.adopt({id:checked.id,version:checked.version,operationId:operationId+'-adopt'});
  };
  await adopt('entity',{action:'add',entity:{id:'contract',name:'合同'}},'entity');
  await adopt('property',{action:'add',property:{id:'contract_code',entityTypeId:'contract',name:'合同编号',valueType:'string',isIdentity:true}},'property');
  const workspace=new OntologyWorkspace(app.memory,app.foundation,app.live,app.pendingCenter,app.workspaceVersions);
  const detail=await workspace.detail({kind:'entity',id:'contract'});
  assert.equal(detail.properties[0].name,'合同编号');assert.deepEqual((detail as any).identityKeys,['contract_code']);assert.equal(detail.modelRef,null);
 }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});

test('a proposed new entity is visible as pending without becoming an adopted definition',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ade-pending-workspace-')),app=new AgentApplication(directory,undefined,new Set(),false);
 try{
  const proposed=await app.changes.propose({operationId:'new-pending-entity',origin:'human',type:'entity',baseline:app.changes.currentBaseline(),subject:{action:'add',entity:{id:'contract',name:'合同',description:'尚待确认的合同定义'}},evidence:'用户提出企业合同需要独立建模'});
  const workspace=new OntologyWorkspace(app.memory,app.foundation,app.live,app.pendingCenter,app.workspaceVersions),result=workspace.overview(),pending=result.entities.find(item=>item.id==='contract')!;
  assert.equal(pending.state,'pending');assert.deepEqual((pending as any).proposalRef,{id:proposed.change.id,version:proposed.change.version});
  assert.equal(app.foundation.read().adopted,null,'projection must not adopt a pending object');
  await app.changes.reject({id:proposed.change.id,version:proposed.change.version,operationId:'decline-pending-entity',reason:'本轮暂不增加合同'});
  assert.equal(workspace.overview().entities.length,0);
 }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});

test('program-discovered objects and column relations appear in the workspace until their exact pending item is decided',async()=>{
 const w=await identityWorkspace();try{
  const app=w.service.app,files=new Workspace(app.memory);
  files.upload('products.csv','product_id,label\nPR1,产品\n');
  await app.programBuilds.build({operationId:'pending-program-object',autoAdopt:true});
  const program=app.changes.list({type:'entity',status:'proposed'}).changes.find(item=>item.origin==='program')!;
  assert.ok(program);
  const candidate=app.changes.read(program.id),selection=candidate.content.subject as any;
  const id=selection.selection.entities[0];
  let result=(await w.call('/api/ontology/workspace')).body;
  assert.equal(result.entities.find((item:any)=>item.id===id)?.state,'pending');
  assert.deepEqual(result.entities.find((item:any)=>item.id===id).proposalRef,ref(candidate));
  assert.equal((app.foundation.read().adopted!.content.concepts as any[]).some(item=>item.id===id),false);
  const from=app.snapshots.bindingDataset(w.sources.staff.id,'staff')!,to=app.snapshots.bindingDataset(w.sources.people.id,'people')!;
  const proposed=await app.changes.propose({type:'relation',origin:'human',operationId:'pending-column-relation',baseline:app.changes.currentBaseline(),subject:{from:{datasetId:from.id,column:'email'},to:{datasetId:to.id,column:'email'}},evidence:'邮箱值说明来源人员存在对应关系'});
  result=(await w.call('/api/ontology/workspace')).body;
  const relation=result.relations.find((item:any)=>item.proposalRef?.id===proposed.change.id);
  assert.equal(relation?.state,'pending');assert.equal(relation.from,'staff');assert.equal(relation.to,'person');
  assert.ok(result.entities.find((item:any)=>item.id==='staff').pending>=1);
  assert.equal(result.pending.total,app.pendingCenter.summary().total);
  await app.changes.reject({...ref(proposed.change),operationId:'reject-visible-relation',reason:'本轮不采用'});
  await app.changes.reject({...ref(candidate),operationId:'reject-visible-program-object',reason:'本轮不采用新对象'});
  result=(await w.call('/api/ontology/workspace')).body;
  assert.equal(result.relations.some((item:any)=>item.proposalRef?.id===proposed.change.id),false);
  assert.equal(result.entities.some((item:any)=>item.id===id),false);
 }finally{await w.close();}
});

test('relation details measure current governed objects and bound unmatched examples without inventing live coverage',async()=>{
 const w=await identityWorkspace();try{
  const app=w.service.app,from=app.snapshots.bindingDataset(w.sources.staff.id,'staff')!,to=app.snapshots.bindingDataset(w.sources.people.id,'people')!;
  await w.adopt('relation',{from:{datasetId:from.id,column:'email'},to:{datasetId:to.id,column:'email'}});
  const relation=app.live.readLayered(w.model.id).semantic.relationTypes[0];
  w.rows.staff[1].email='unmatched@example.test';await app.snapshots.sync({operationId:'unmatched-row',sourceIds:[w.sources.staff.id]});
  const workspace=new OntologyWorkspace(app.memory,app.foundation,app.live,app.pendingCenter,app.workspaceVersions);
  let detail=await workspace.detail({kind:'relation',id:relation.id}) as any;
  assert.equal(detail.match.status,'measured');assert.equal(detail.match.total,2);assert.equal(detail.match.matched,1);assert.equal(detail.match.matchRate,0.5);
  assert.deepEqual(detail.match.unmatched.items.map((item:any)=>item.objectId),['H2']);assert.equal(detail.match.coverage.complete,true);
  for(let index=0;index<12;index++)w.rows.staff.push({id:`U${index}`,email:`unknown${index}@example.test`,phone:'10003'});
  await app.snapshots.sync({operationId:'many-unmatched-rows',sourceIds:[w.sources.staff.id]});
  detail=await workspace.detail({kind:'relation',id:relation.id}) as any;
  assert.equal(detail.match.unmatched.total,13);assert.equal(detail.match.unmatched.items.length,10);assert.equal(detail.match.unmatched.complete,false);
  await w.adopt('local_correction',{kind:'relation',entityTypeId:'staff',objectId:'H1',relationTypeId:relation.id,targetIds:[],reason:'此记录不属于正式人员',evidence:'管理员核对原始记录'});
  detail=await workspace.detail({kind:'relation',id:relation.id}) as any;
  assert.equal(detail.match.matched,0);assert.equal(detail.match.unmatched.total,14,'adopted local decisions are part of matching');
  const current=app.snapshots.bindingDataset(w.sources.staff.id,'staff')!;
  app.snapshots.setPolicy({...ref(current),materialization:'live'});
  detail=await workspace.detail({kind:'relation',id:relation.id}) as any;
  assert.equal(detail.match.status,'unavailable');assert.equal(detail.match.matchRate,null);assert.match(detail.match.reason,/实时|快照/);
 }finally{await w.close();}
});

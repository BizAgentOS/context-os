import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AgentApplication} from '../../src/agent/app.ts';
import {seedFoundation} from './program-foundation-fixture.ts';
import {OntologyWorkspace} from '../../src/semantic/workspace.ts';

test('ontology workspace projects adopted entities, parallel relations, current pending and bounded evidence without raw artifacts',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ade-ontology-workspace-'));const app=new AgentApplication(directory,undefined,new Set(),false);
 try{
  seedFoundation(app.memory,app.foundation,{enterprise:'验收企业',concepts:[{id:'person',name:'人员',description:'实际工作人员'},{id:'task',name:'任务',description:'交付工作'}],relations:[{id:'owner',name:'负责人',from:'task',to:'person',description:'责任人员'},{id:'reviewer',name:'复核人',from:'task',to:'person',description:'复核人员'}]});
  const proposed=await app.changes.propose({operationId:'naming',origin:'human',type:'naming',baseline:app.changes.currentBaseline(),subject:{target:'concept',id:'person',name:'员工'}});
  const workspace=new OntologyWorkspace(app.memory,app.foundation,app.live,app.pendingCenter,app.workspaceVersions);
  const result=workspace.overview();
  assert.equal(result.title,'验收企业');assert.equal(result.pending.total,1);assert.equal(result.entities.length,2);assert.equal(result.relations.length,2);
  assert.ok(result.nextSteps.some(x=>x.action==='pending'));assert.equal(result.entities.find(x=>x.id==='person')!.state,'pending');
  const detail=workspace.detail({kind:'entity',id:'person'});
  assert.equal(detail.name,'人员');assert.equal(detail.relations.length,2);assert.equal(detail.evidence.total,1);assert.equal(detail.pending.items[0].id,proposed.change.id);
  assert.equal('technical' in detail,false);assert.equal('content' in detail,false);
  assert.throws(()=>workspace.detail({kind:'entity',id:'missing'}),/不存在/);
  assert.equal(workspace.detail({kind:'relation',id:'owner'}).title,'任务 → 负责人 → 人员');
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
  const detail=workspace.detail({kind:'entity',id:'contract'});
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

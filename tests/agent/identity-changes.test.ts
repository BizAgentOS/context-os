import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityWorkspace,ref } from './identity-fixture.ts';
import type { Data } from '../../src/agent/contracts.ts';

test('belongs_to retains separate objects and explicit record decisions override the rule',async()=>{
 const w=await identityWorkspace();try{
  const left=w.binding('account'),right=w.binding('person');
  const adopted=await w.adopt('identity_rule',{kind:'belongs_to',left:{bindingId:left,columns:['email']},right:{bindingId:right,columns:['email']},relationName:'所属人员',reason:'账号归属人员',evidence:'管理员核对账号与人员职责'});
  const ruleId=(adopted.content.effect as Data).ruleId;
  const query=(id:string)=>w.service.app.live.query({modelId:w.model.id,type:'账号',id,relation:'所属人员'});
  assert.equal((await query('A1')).items[0].$id,'P1');
  assert.equal(w.service.app.live.readLayered(w.model.id).semantic.entityTypes.length,3);
  await w.adopt('identity_decision',{ruleId,left:{bindingId:left,recordId:'ci-bot'},right:null,decision:'no_match',reason:'这是机器人账号',evidence:'机器人运行登记'});
  assert.deepEqual((await query('ci-bot')).items,[]);
  await w.adopt('identity_decision',{ruleId,left:{bindingId:left,recordId:'A2'},right:{bindingId:right,recordId:'P2'},decision:'match',reason:'旧邮箱已变更',evidence:'HR变更单已核实'});
  assert.equal((await query('A2')).items[0].$id,'P2','record match wins even when the rule key differs');
 }finally{await w.close();}
});

test('same_as can connect an independent source after explicit adoption and preserves existing source objects',async()=>{
 const w=await identityWorkspace();try{
  assert.equal(w.service.app.live.readLayered(w.model.id).bindings.entities.filter(b=>b.role==='supplement').length,0);
  await w.adopt('identity_rule',{kind:'same_as',left:{bindingId:w.binding('staff'),columns:['email']},right:{bindingId:w.binding('person'),columns:['email']},reason:'同一批人员的另一个来源',evidence:'核对员工名册与通讯资料'});
  const result=await w.service.app.live.query({modelId:w.model.id,type:'人员',id:'P1'});
  assert.equal(result.items[0].电话,'10001');
  assert.equal((await w.service.app.live.query({modelId:w.model.id,type:'外部人员',id:'H1'})).items.length,1);
 }finally{await w.close();}
});

test('a shared email does not make accounts and people type-compatible for same_as',async()=>{
 const w=await identityWorkspace();try{
  const proposal=await w.call('/api/changes/propose',{operationId:'incompatible',origin:'human',type:'identity_rule',baseline:w.service.app.changes.currentBaseline(),subject:{kind:'same_as',left:{bindingId:w.binding('account'),columns:['email']},right:{bindingId:w.binding('person'),columns:['email']},reason:'邮箱重合',evidence:'字符串相同'}});
  assert.equal(proposal.status,201);
  const checked=await w.call('/api/changes/verify',{operationId:'incompatible-check',...ref(proposal.body.change)});
  assert.equal(checked.body.change.status,'failed');
  assert.match(checked.body.change.content.verification.notes.join(''),/类型|账号|人员/);
 }finally{await w.close();}
});

test('identity verification rejects incompatible observed key types without an explicit cast',async()=>{
 const w=await identityWorkspace();try{
  w.rows.staff[0].email=101;w.rows.staff[1].email=102;
  await w.service.app.snapshots.sync({operationId:'numeric-staff-keys'});
  const pending=w.service.app.snapshots.datasets().find(dataset=>dataset.content.sourceId===w.sources.staff.id)!;
  w.service.app.snapshots.accept({operationId:'accept-numeric-staff-keys',...ref(pending)});
  const proposal=await w.call('/api/changes/propose',{operationId:'incompatible-keys',origin:'human',type:'identity_rule',baseline:w.service.app.changes.currentBaseline(),subject:{kind:'same_as',left:{bindingId:w.binding('staff'),columns:['email']},right:{bindingId:w.binding('person'),columns:['email']},reason:'人员资料对应',evidence:'核对匹配列'}});
  const checked=await w.call('/api/changes/verify',{operationId:'incompatible-keys-check',...ref(proposal.body.change)});
  assert.equal(checked.body.change.status,'failed');
  assert.match(checked.body.change.content.verification.notes.join(''),/类型/);
 }finally{await w.close();}
});

test('renaming an account to User cannot erase its source role and enable person fusion',async()=>{
 const w=await identityWorkspace();try{
  await w.adopt('naming',{target:'concept',id:'account',name:'User'});
  const proposal=await w.call('/api/changes/propose',{operationId:'renamed-account',origin:'human',type:'identity_rule',baseline:w.service.app.changes.currentBaseline(),subject:{kind:'same_as',left:{bindingId:w.binding('account'),columns:['email']},right:{bindingId:w.binding('person'),columns:['email']},reason:'邮箱重合',evidence:'相同字符串不等于相同对象'}});
  const checked=await w.call('/api/changes/verify',{operationId:'renamed-account-check',...ref(proposal.body.change)});
  assert.equal(checked.body.change.status,'failed');
  assert.match(checked.body.change.content.verification.notes.join(''),/类型|账号|人员/);
 }finally{await w.close();}
});

test('same_as fusion honors explicit record matches and exclusions before automatic keys',async()=>{
 const w=await identityWorkspace();try{
  w.rows.staff[1].email='old@example.test';
  await w.service.app.snapshots.sync({operationId:'old-staff-email'});
  const adopted=await w.adopt('identity_rule',{kind:'same_as',left:{bindingId:w.binding('staff'),columns:['email']},right:{bindingId:w.binding('person'),columns:['email']},reason:'员工通讯资料',evidence:'核对名册中的同一人员'});
  const effect=adopted.content.effect as Data;
  const query=(id:string)=>w.service.app.live.query({modelId:w.model.id,type:'人员',id});
  assert.equal((await query('P2')).items[0].电话,null);
  await w.adopt('identity_decision',{ruleId:effect.ruleId,left:{bindingId:effect.leftBindingId,recordId:'H2'},right:{bindingId:effect.rightBindingId,recordId:'P2'},decision:'match',reason:'旧邮箱仍是同一人',evidence:'已核对HR人员编号'});
  assert.equal((await query('P2')).items[0].电话,'10002');
  await w.adopt('identity_decision',{ruleId:effect.ruleId,left:{bindingId:effect.leftBindingId,recordId:'H1'},right:null,decision:'no_match',reason:'这条资料不属于内部人员',evidence:'人工核对发现邮箱复用'});
  assert.equal((await query('P1')).items[0].电话,null);
  assert.equal((await query('P1')).evidence![0].matches[0].status,'missing');
 }finally{await w.close();}
});

test('identity adoption refuses data drift after verification even when matching keys still agree',async()=>{
 const w=await identityWorkspace();try{
  const proposal=await w.call('/api/changes/propose',{operationId:'drift-rule',origin:'human',type:'identity_rule',baseline:w.service.app.changes.currentBaseline(),subject:{kind:'same_as',left:{bindingId:w.binding('staff'),columns:['email']},right:{bindingId:w.binding('person'),columns:['email']},reason:'员工通讯资料',evidence:'核对当前资料'}});
  const checked=await w.call('/api/changes/verify',{operationId:'drift-rule-check',...ref(proposal.body.change)});
  assert.equal(checked.body.change.status,'verified');
  w.rows.staff[0].phone='new-phone';
  await w.service.app.snapshots.sync({operationId:'changed-staff-facts'});
  const adopted=await w.call('/api/changes/adopt',{operationId:'drift-rule-adopt',...ref(checked.body.change),acknowledgeReview:true});
  assert.equal(adopted.status,409);
  assert.equal(adopted.body.code,'verification_changed');
  assert.equal(w.service.app.live.readLayered(w.model.id).bindings.entities.filter(binding=>binding.role==='supplement').length,0);
 }finally{await w.close();}
});

test('an incomplete belongs_to search never selects the first match, while an explicit record decision can reach beyond the scan limit',async()=>{
 const w=await identityWorkspace();try{
  w.rows.people.push(...Array.from({length:1998},(_,index)=>({id:`F${index}`,email:`filler${index}@example.test`,name:`人员${index}`})),{id:'P3',email:'alice@example.test',name:'另一位人员'});
  await w.service.app.snapshots.sync({operationId:'large-people'});
  const left=w.binding('account'),right=w.binding('person');
  const adopted=await w.adopt('identity_rule',{kind:'belongs_to',left:{bindingId:left,columns:['email']},right:{bindingId:right,columns:['email']},relationName:'所属人员',reason:'账号归属',evidence:'部分邮箱重复，需要明确人员记录'});
  const query=()=>w.service.app.live.query({modelId:w.model.id,type:'账号',id:'A1',relation:'所属人员'});
  await assert.rejects(query,/覆盖不完整|无法确认/);
  await w.adopt('identity_decision',{ruleId:(adopted.content.effect as Data).ruleId,left:{bindingId:left,recordId:'A1'},right:{bindingId:right,recordId:'P3'},decision:'match',reason:'明确归属P3',evidence:'核对账号实名登记'});
  const selected=await query();
  assert.equal(selected.items[0].$id,'P3');
  assert.equal(selected.coverage.complete,true);
 }finally{await w.close();}
});

test('same_as reports multiple supplementary records for one primary as a review conflict',async()=>{
 const w=await identityWorkspace();try{
  w.rows.staff[1].email='alice@example.test';
  await w.service.app.snapshots.sync({operationId:'duplicate-staff-identity'});
  const proposed=await w.call('/api/changes/propose',{operationId:'conflicting-staff',origin:'human',type:'identity_rule',baseline:w.service.app.changes.currentBaseline(),subject:{kind:'same_as',left:{bindingId:w.binding('staff'),columns:['email']},right:{bindingId:w.binding('person'),columns:['email']},reason:'同一人员的资料来源',evidence:'重复记录必须保留冲突'}});
  const verified=await w.call('/api/changes/verify',{operationId:'conflicting-staff-check',...ref(proposed.body.change)});
  const verification=verified.body.change.content.verification;
  assert.equal(verification.result,'review');
  assert.equal(verification.metrics.reverseAmbiguous,1);
  assert.equal(verification.metrics.multipleSourceTargets,1);
  assert.match(verification.notes.join(''),/多条补充|反向/);
  const adopted=await w.call('/api/changes/adopt',{operationId:'conflicting-staff-adopt',...ref(verified.body.change)});
  assert.equal(adopted.status,409);
  assert.equal(adopted.body.code,'review_required');
 }finally{await w.close();}
});

test('identity rule adoption refuses a snapshot change during asynchronous definition preparation',async t=>{
 const w=await identityWorkspace();try{
  const app=w.service.app;
  const proposed=await w.call('/api/changes/propose',{operationId:'race-rule',origin:'human',type:'identity_rule',baseline:app.changes.currentBaseline(),subject:{kind:'same_as',left:{bindingId:w.binding('staff'),columns:['email']},right:{bindingId:w.binding('person'),columns:['email']},reason:'员工资料',evidence:'核对当前快照'}});
  const checked=await w.call('/api/changes/verify',{operationId:'race-rule-check',...ref(proposed.body.change)});
  assert.equal(checked.body.change.status,'verified');
  const baseline=app.changes.currentBaseline();let versionsAfterSync=0;
  const prepare=app.live.prepareDefinition.bind(app.live);
  t.mock.method(app.live,'prepareDefinition',async(...args:Parameters<typeof prepare>)=>{
   const result=await prepare(...args);w.rows.staff[0].phone='changed-during-prepare';
   await app.snapshots.sync({operationId:'rule-preparation-sync'});versionsAfterSync=app.memory.listArtifacts('workspace_version').length;
   return result;
  });
  const adopted=await w.call('/api/changes/adopt',{operationId:'race-rule-adopt',...ref(checked.body.change),acknowledgeReview:true});
  assert.equal(adopted.status,409,JSON.stringify(adopted.body));
  assert.equal(adopted.body.code,'verification_changed');
  assert.deepEqual(app.changes.currentBaseline(),baseline);
  assert.equal(app.memory.listArtifacts('workspace_version').length,versionsAfterSync);
 }finally{await w.close();}
});

test('identity decision adoption refuses a snapshot change while its record capture is in flight',async t=>{
 const w=await identityWorkspace();try{
  const app=w.service.app;
  const rule=await w.adopt('identity_rule',{kind:'belongs_to',left:{bindingId:w.binding('account'),columns:['email']},right:{bindingId:w.binding('person'),columns:['email']},relationName:'所属人员',reason:'账号归属',evidence:'核对当前资料'});
  const proposed=await w.call('/api/changes/propose',{operationId:'race-decision',origin:'human',type:'identity_decision',baseline:app.changes.currentBaseline(),subject:{ruleId:(rule.content.effect as Data).ruleId,left:{bindingId:w.binding('account'),recordId:'A2'},right:{bindingId:w.binding('person'),recordId:'P2'},decision:'match',reason:'旧邮箱',evidence:'人员实名登记'}});
  const checked=await w.call('/api/changes/verify',{operationId:'race-decision-check',...ref(proposed.body.change)});
  assert.equal(checked.body.change.status,'verified');
  const baseline=app.changes.currentBaseline();let versionsAfterSync=0,changed=false;
  const read=app.snapshots.readPinned.bind(app.snapshots);
  t.mock.method(app.snapshots,'readPinned',async(...args:Parameters<typeof read>)=>{
   const result=await read(...args);
   if(!changed){changed=true;w.rows.accounts[1].username='renamed-during-read';await app.snapshots.sync({operationId:'decision-capture-sync'});versionsAfterSync=app.memory.listArtifacts('workspace_version').length;}
   return result;
  });
  const adopted=await w.call('/api/changes/adopt',{operationId:'race-decision-adopt',...ref(checked.body.change),acknowledgeReview:true});
  assert.equal(adopted.status,409,JSON.stringify(adopted.body));
  assert.equal(adopted.body.code,'verification_changed');
  assert.deepEqual(app.changes.currentBaseline(),baseline);
  assert.equal(app.memory.listArtifacts('workspace_version').length,versionsAfterSync);
 }finally{await w.close();}
});

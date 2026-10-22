import {test} from 'node:test';
import assert from 'node:assert/strict';
import {identityWorkspace,ref} from './identity-fixture.ts';
import {Releases} from '../../src/engine/releases.ts';

test('release data comparison exposes real before and after rows with bounded samples',async()=>{
 const w=await identityWorkspace(),releases=new Releases(w.service.app.memory,w.service.app.live);
 try{
  const first=(await releases.dataDiff({})).datasets as unknown as any[];const added=first.find(item=>item.sourceId===w.sources.people.id);assert.equal(added.added,2);assert.deepEqual(added.samples[0].before,null);assert.equal(added.samples[0].after.id,'P1');
  const check=await releases.check({inputHash:releases.overview().working.inputHash});releases.publish({operationId:'before',name:'原始人员',checkRef:ref(check)});
  w.rows.people=[{id:'P1',email:'alice@example.test',name:'更名甲'},{id:'P3',email:'new@example.test',name:'丙'}];
  await w.service.app.snapshots.sync({operationId:'after',sourceIds:[w.sources.people.id]});
  const diff=await releases.dataDiff({}),source=(diff.datasets as unknown as any[]).find(item=>item.sourceId===w.sources.people.id);
  assert.deepEqual([source.added,source.removed,source.changed],[1,1,1]);
  assert.deepEqual(source.samples.find((item:any)=>item.k==='P1'),{k:'P1',kind:'changed',before:{id:'P1',email:'alice@example.test',name:'甲'},after:{id:'P1',email:'alice@example.test',name:'更名甲'}});
  assert.equal(source.samples.find((item:any)=>item.k==='P2').after,null);assert.equal(source.samples.find((item:any)=>item.k==='P3').before,null);
 }finally{await w.close();}
});

test('release execution checks revalidate adopted relation corrections against the proposed snapshot',async()=>{
 const w=await identityWorkspace(),releases=new Releases(w.service.app.memory,w.service.app.live);
 try{
  await w.adopt('identity_rule',{kind:'belongs_to',left:{bindingId:w.binding('account'),columns:['email']},right:{bindingId:w.binding('person'),columns:['email']},relationName:'持有人',reason:'邮箱对应',evidence:'目录中的邮箱'});
  const target={modelId:w.model.id,modelVersion:w.model.version,type:'账号',objectId:'A1',relation:'持有人'};
  const proposed=(await w.call('/api/live/corrections/propose',{operationId:'remove-owner',target,targetIds:[],reason:'此账号不代表人员',evidence:'管理员核对'})).body.saved;
  const checked=(await w.call('/api/live/corrections/check',{operationId:'check-owner',...ref(proposed)})).body.saved;
  const adopted=await w.call('/api/live/corrections/adopt',{operationId:'adopt-owner',...ref(checked)});assert.equal(adopted.status,200,JSON.stringify(adopted));
  w.rows.accounts[0].email='bob@example.test';await w.service.app.snapshots.sync({operationId:'changed-origin',sourceIds:[w.sources.accounts.id]});
  const blocked=await releases.check({inputHash:releases.overview().working.inputHash});assert.equal(blocked.status,'blocked');
  assert.ok((blocked.content.issues as any[]).some(item=>/纠正/.test(item.message)));
 }finally{await w.close();}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {identityWorkspace,ref} from './identity-release-fixture.ts';
import {Releases} from '../../src/engine/releases.ts';

test('connection upgrade preserves exact property and relation grants across business renames',async()=>{
 const w=await identityWorkspace(),releases=new Releases(w.service.app.memory,w.service.app.live);
 try{
  const first=await w.publish('原始目录');
  const connected=releases.connect({operationId:'scoped',name:'客服助手',purpose:'查看账号所属人员',releaseRef:ref(first),conceptIds:['account','person'],relationIds:['account_owner'],business:{grants:[
   {type:'账号',fields:['$id','名称','邮箱'],relations:['所属人员'],evidence:{fields:['名称'],relations:['所属人员']}},
   {type:'人员',fields:['$id','邮箱'],relations:[]},
  ]}});
  const property=w.service.app.live.readLayered(w.currentModel().id).semantic.properties.find(p=>p.entityTypeId==='account'&&p.name==='名称')!;
  await w.govern('naming',{target:'concept',id:'account',name:'登录账号'},'account-rename');
  await w.govern('naming',{target:'property',id:property.id,name:'账号名称'},'property-rename');
  await w.govern('naming',{target:'relation',id:'account_owner',name:'实际持有人'},'relation-rename');
  await w.decide('a-bot','no_match',null,'bot-upgrade-impact');
  const next=await w.publish('新名称目录');
  const preview=await releases.upgradePreview({connectionRef:ref(connected.connection),releaseRef:ref(next)});
  assert.equal(preview.compatible,true);assert.equal(preview.blockers.length,0);
  assert.ok(preview.affected.some(item=>item.id===property.id));assert.ok(preview.affected.some(item=>item.kind==='identity_decision'),'a record decision affecting an allowed relation belongs in its upgrade impact');
  assert.equal(releases.connectionDetail(ref(connected.connection)).connection.content.purpose,'查看账号所属人员');
  const upgraded=releases.upgrade({operationId:'upgrade-renamed',connectionRef:ref(connected.connection),releaseRef:ref(next)});
  assert.deepEqual((upgraded.connection.content.business as any).grants,[
   {type:'登录账号',fields:['$id','账号名称','邮箱'],relations:['实际持有人'],evidence:{fields:['账号名称'],relations:['实际持有人']}},
   {type:'人员',fields:['$id','邮箱'],relations:[]},
  ]);
  const read=async(key:string,type:string,fields:string)=>{const response=await fetch(w.origin+'/v4/objects?'+new URLSearchParams({type,fields,id:'a-user'}),{headers:{authorization:'Bearer '+key}});return{status:response.status,body:await response.json() as any};};
  assert.equal((await read(connected.key!,'账号','$id,名称')).status,403);
  const result=await read(upgraded.key!,'登录账号','$id,账号名称');assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.items[0].properties.账号名称.value,'工作账号');
  const relation=await fetch(w.origin+'/v4/objects?'+new URLSearchParams({type:'登录账号',id:'a-user',relation:'实际持有人',fields:'$id,邮箱'}),{headers:{authorization:'Bearer '+upgraded.key}});assert.equal(relation.status,200);assert.equal((await relation.json() as any).items[0].objectRef.id,'P1');
  assert.equal((await read(upgraded.key!,'人员','$id,姓名')).status,403,'renaming cannot expand authorized properties');
  const detail=releases.connectionDetail(ref(upgraded.connection));assert.equal(detail.scope.properties.some(item=>item.name==='姓名'),false);
  assert.equal(detail.usage.calls,3);assert.equal(detail.usage.succeeded,2);assert.equal(detail.usage.failed,1);assert.equal((detail.usage.recentErrors as any[])[0].status,403);
  assert.doesNotMatch(JSON.stringify(detail),/keyHash|cos_dataset_/);
  w.service.app.live.sources.disable(w.accounts.id,w.accounts.version);
  const deniedPreview=releases.upgradePreview({connectionRef:ref(upgraded.connection),releaseRef:ref(first)});assert.equal(deniedPreview.compatible,false,'upgrade preview must respect current source authority');
 }finally{await w.close();}
});

test('connection configuration tests a real authorized business query and keeps the secret one time',async()=>{
 const w=await identityWorkspace();
 try{
  const release=await w.publish('连通性测试'),connected=await w.connect(release,'可读账号');
  const checked=await w.manage('/api/datasets/test',{id:connected.dataset.id,key:connected.key});
  assert.equal(checked.query.tool,'query_objects');assert.equal(checked.query.type,'账号');assert.equal(checked.query.rows,1);
  const config=await w.manage(`/api/releases/connection?id=${connected.connection.id}&version=${connected.connection.version}`);
  assert.ok(config.http.endpoints.some((item:any)=>item.path==='/v4/aggregate'));
  assert.doesNotMatch(JSON.stringify(config),new RegExp(connected.key));
  w.service.app.live.sources.disable(w.accounts.id,w.accounts.version);
  assert.equal((await w.request('/api/datasets/test',{id:connected.dataset.id,key:connected.key})).status>=400,true,'metadata success cannot mask a failed business query');
 }finally{await w.close();}
});

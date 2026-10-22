import {test} from 'node:test';
import assert from 'node:assert/strict';
import {identityWorkspace,ref} from './identity-release-fixture.ts';

test('release management exposes exact consumer scope and upgrade impact without accepting a consumer key',async()=>{
 const w=await identityWorkspace();
 try{
  const release=await w.publish('host-base');
  const connected=await w.manage('/api/releases/connect',{operationId:'host-consumer',name:'只查姓名',purpose:'核对员工显示名',releaseRef:ref(release),conceptIds:['person'],relationIds:[],business:{grants:[{type:'人员',fields:['$id','姓名'],relations:[]}]}});
  const connection=connected.connection,params=new URLSearchParams({id:connection.id,version:String(connection.version)});
  const detail=await w.manage('/api/releases/connection-detail?'+params);
  assert.equal(detail.connection.content.purpose,'核对员工显示名');
  assert.deepEqual(detail.dataView,{kind:'consumer',releaseRef:ref(release),connectionRef:ref(connection)});
  assert.ok(!JSON.stringify(detail.scope).includes('邮箱'));
  const views=await w.manage('/api/qa/views');assert.deepEqual(views.currentReleaseRef,ref(release));
  const preview=await w.manage('/api/releases/upgrade-preview?'+new URLSearchParams({connectionId:connection.id,connectionVersion:String(connection.version),releaseId:release.id,releaseVersion:String(release.version)}));
  assert.equal(preview.compatible,false);assert.ok(preview.blockers.length);
  const denied=await fetch(w.origin+'/api/releases/connection-detail?'+params,{headers:{authorization:'Bearer '+connected.key}});
  assert.equal(denied.status,403);
  const revoked=await w.manage('/api/releases/revoke',{operationId:'host-revoke',connectionRef:ref(connection)});
  const historical=await w.manage('/api/releases/connection-detail?'+new URLSearchParams({id:connection.id,version:String(revoked.connection.version)}));
  assert.equal(historical.connection.status,'revoked');
 }finally{await w.close();}
});

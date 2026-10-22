import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {identityWorkspace,ref} from './identity-release-fixture.ts';
import {OntologyDatasets} from '../../src/live/ontology-datasets.ts';

test('standalone historical datasets cannot keep serving v4 after retirement while published connections retain the same objects',async()=>{
 const w=await identityWorkspace();
 try{
  const release=await w.publish('正式发布'),connection=await w.connect(release,'正式客服'),app=w.service.app,datasets=new OntologyDatasets(app.memory,app.live);
  const owner=app.memory.getArtifact(connection.connection.id),datasetRef=owner.content.datasetRef as {id:string;version:number},current=app.memory.getArtifact(datasetRef.id,datasetRef.version);
  const {releaseRef,...oldContent}=current.content,key='de_dataset_retiredfixture';
  const historical=app.memory.putArtifact({kind:'ontology_dataset',title:'旧独立数据集',status:'active',content:{...oldContent,keyHash:createHash('sha256').update(key).digest('hex')}});
  assert.equal((await datasets.handle('/v4/dataset',new URLSearchParams(),`Bearer ${key}`)).status,403);
  assert.throws(()=>datasets.connection(ref(historical),'http://127.0.0.1'),/已下线|发布/);
  assert.equal((await w.external(connection.key,'a-user')).body.items[0].objectRef.id,'P1');
  assert.equal(app.memory.getArtifact(historical.id).status,'active','retirement never rewrites saved audit records');
 }finally{await w.close();}
});

test('retired v1 v2 v3 HTTP contracts return a removal receipt and their history remains exportable only to administrators',async()=>{
 const w=await identityWorkspace();
 try{
  for(const path of ['/v1','/v1/schema','/v2','/v2/objects?type=人员','/v3','/v3/catalog']){
   const response=await fetch(w.origin+path,{headers:{authorization:'Bearer de_consumer_retired'}}),body=await response.json() as any;
   assert.equal(response.status,410,path);assert.equal(body.code,'legacy_consumption_retired');
  }
  assert.equal((await fetch(w.origin+'/api/consumers/audit-export')).status,403);
  const audit=await w.manage('/api/consumers/audit-export');assert.equal(audit.readOnly,true);assert.equal(audit.formatVersion,1);
  const release=await w.publish('旧接口下线后发布'),reader=await w.connect(release,'新接入路径');assert.equal((await w.external(reader.key,'a-user')).status,200);
 }finally{await w.close();}
});

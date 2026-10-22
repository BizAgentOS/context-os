import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryStore} from '../../src/agent/memory.ts';
import {ConsumptionService} from '../../src/agent/consumption.ts';
import {exportLegacyConsumptionAudit} from '../../src/live/legacy-audit.ts';
import {withActor} from '../../src/security/actors.ts';

test('retired access exports every historical scope and read receipt without credentials or current-release internals',()=>{
 const directory=mkdtempSync(join(tmpdir(),'context-os-retired-audit-')),memory=new MemoryStore(directory),consumption=new ConsumptionService(directory,memory);
 try{
  const scope=memory.putArtifact({kind:'consumer_view',title:'历史客服范围',status:'active',content:{keyHash:'secret-hash',grants:[{type:'投诉',fields:['$id','状态']}],operationId:'old-operation'}});
  memory.putArtifact({...scope,expectedVersion:scope.version,status:'revoked'});
  const current=memory.putArtifact({kind:'ontology_dataset',title:'当前发布内部数据集',status:'active',content:{releaseRef:{id:'release',version:1},keyHash:'current-hash'}});
  memory.putArtifact({kind:'release_connection',title:'当前接入方',status:'active',content:{datasetRef:{id:current.id,version:1}}});
  memory.putArtifact({kind:'live_access',title:'历史读取',status:'allowed',content:{consumerId:scope.id,path:'/v3/objects',status:200,count:2}});
  // Retired requests are audited even when their key was invalid; export must not silently cap at the UI's 100 rows.
  for(let i=0;i<105;i++)consumption.handle({method:'GET',path:'/v1/objects',query:new URLSearchParams({type:'投诉'}),authorization:'Bearer invalid'});
  const before=memory.artifactHistory().length,archive=exportLegacyConsumptionAudit(memory,consumption);
  assert.equal(archive.formatVersion,1);assert.equal(archive.readOnly,true);
  assert.deepEqual(archive.records.filter(item=>item.id===scope.id).map(item=>[item.version,item.status]),[[1,'active'],[2,'revoked']]);
  assert.equal(archive.access.v1.length,105);assert.equal(archive.access.semantic.length,1);
  assert.equal(archive.records.some(item=>item.id===current.id),false);
  assert.doesNotMatch(JSON.stringify(archive),/keyHash|secret-hash|current-hash|old-operation/);
  assert.equal(memory.artifactHistory().length,before,'audit export never changes original history');
  for(const role of ['viewer','maintainer'] as const)withActor({kind:'human',id:role,name:role,role},()=>assert.throws(()=>exportLegacyConsumptionAudit(memory,consumption),/权限/));
 }finally{consumption.close();memory.close();rmSync(directory,{recursive:true,force:true});}
});

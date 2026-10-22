import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHeatingDemo} from '../../src/demo/server.ts';
import {OntologyWorkspace} from '../../src/semantic/workspace.ts';
import {sourceSummary} from '../../src/agent/source-summary.ts';

test('fictional heating demo fills the formal source, semantic and release workspaces and preserves the known negative evidence',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ade-formal-demo-'));let service=await createHeatingDemo(directory);
 try{
  const app=service.app,workspace=new OntologyWorkspace(app.memory,app.foundation,app.live,app.pendingCenter,app.workspaceVersions),view=workspace.overview();
  assert.equal(view.entities.length,6);assert.equal(view.relations.length,10);assert(view.modelRef);
  const sources=sourceSummary(app.memory);assert.equal(sources.total,8);assert.equal(sources.sources.filter(source=>source.category==='table'&&source.readMode==='active_snapshot').length,6);
  const complaint=view.entities.find(item=>item.name==='投诉')!;
  const result=await app.live.query({modelId:view.modelRef.id,modelVersion:view.modelRef.version,conceptId:complaint.id,id:'TS002',relation:'居民回访'});
  assert.equal(result.items.length,1);assert.equal(result.items[0].$id,'HF002');assert.equal(result.items[0].反馈结果,'未改善');
  assert.equal(app.memory.listArtifacts('data_release').length,1,'formal release page has a fictional pinned release');
  assert.equal(app.memory.listArtifacts('release_connection').length,0,'demo does not sign a real consumer key');
  const model=view.modelRef;await service.close();service=await createHeatingDemo(directory);
  assert.deepEqual(new OntologyWorkspace(service.app.memory,service.app.foundation,service.app.live,service.app.pendingCenter,service.app.workspaceVersions).overview().modelRef,model,'restart does not replace user edits with the fixture');
 }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MemoryStore} from '../../src/agent/memory.ts';
import {Workspace} from '../../src/agent/workspace.ts';
import {LiveMemory} from '../../src/live/memory.ts';
import {Snapshots} from '../../src/data/snapshots.ts';
import {TableFiles} from '../../src/data/table-files.ts';
import {WorkspaceRetention} from '../../src/security/workspace-retention.ts';
import {FoundationDocuments} from '../../src/agent/foundation-evidence.ts';
import {FoundationService} from '../../src/agent/foundation.ts';
import {ProgramBuilds} from '../../src/engine/program-builds.ts';
import {WorkspaceVersions} from '../../src/engine/workspace-versions.ts';

test('retention expires original uploads including their old revisions while immutable snapshots remain queryable',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ade-retention-')),memory=new MemoryStore(dir),live=new LiveMemory(dir,memory),snapshots=new Snapshots(memory,live,dir),workspace=new Workspace(memory);
 try{
  const original=workspace.upload('产品.csv','编号,名称\nP1,初始产品\n'),updated=workspace.upload('产品.csv','编号,名称\nP1,后续产品\n');
  const text=workspace.upload('产品说明.md','需要过期清理的原始说明。');
  const originalFile=String((memory.getArtifact(text.id,undefined,{content:'compact'}).content.sourceContent as any)?.raw.file);
  assert(existsSync(join(dir,'source-content',originalFile)));
  const uploaded=await new TableFiles(memory,dir).import({name:'门店.tsv',input:(async function*(){yield Buffer.from('编号\t名称\nS1\t南门店\n');})()});
  await snapshots.sync({operationId:'before-expiry'});
  const retained=snapshots.datasets().map(a=>({id:a.id,snapshotId:String(a.content.activeVersion)}));
  const service=new WorkspaceRetention(memory,snapshots);
  assert.deepEqual(service.settings(),{rawDays:90,snapshotVersions:5});
  const future=new Date(Date.now()+91*86400000).toISOString(),preview=service.preview(future);
  assert.equal(preview.originals.length,4);
  assert.equal(existsSync(join(dir,'data','table-files',String((uploaded.sources[0].content.tableFile as any).file))),true);
  const result=await service.run({operationId:'expire-once',now:future});assert.equal(result.status,'completed');
  for(const source of [original,updated,text])assert.equal(memory.getArtifact(source.id,source.version).content.raw,undefined);
  assert.equal(existsSync(join(dir,'source-content',originalFile)),false,'expired text is removed from managed storage');
  assert.equal(existsSync(join(dir,'data','table-files',String((uploaded.sources[0].content.tableFile as any).file))),false);
  assert.equal((await snapshots.preview({datasetId:retained[0].id,snapshotId:retained[0].snapshotId})).rows.length,1);
  assert.equal((await service.run({operationId:'expire-once',now:future})).id,result.id);
  assert.equal(service.preview(future).originals.length,0);
 }finally{await snapshots.close();memory.close();rmSync(dir,{recursive:true,force:true});}
});

test('a historical working version pins its original snapshot even when the unpinned retention limit is one',{timeout:20000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ade-retention-working-')),memory=new MemoryStore(dir),live=new LiveMemory(dir,memory),snapshots=new Snapshots(memory,live,dir),foundation=new FoundationService(memory,live),engine=new ProgramBuilds(memory,foundation,live,snapshots),workspace=new Workspace(memory);
 try{
  workspace.upload('产品.csv','编号,名称\nP1,原始产品\n');await engine.build({operationId:'first',autoAdopt:true});
  const history=new WorkspaceVersions(memory,foundation,live),first=history.latest()!,pin=(first.content.composition as any).snapshots[0];
  const service=new WorkspaceRetention(memory,snapshots);service.configure({rawDays:90,snapshotVersions:1});
  workspace.upload('产品.csv','编号,名称\nP1,新版产品\n');await snapshots.sync({operationId:'next'});
  await service.run({operationId:'retain-history'});
  assert((snapshots.dataset(pin.datasetId).content.versions as string[]).includes(pin.snapshotId));
  assert.equal((await snapshots.preview({datasetId:pin.datasetId,snapshotId:pin.snapshotId})).rows[0].名称,'原始产品');
  assert.equal((await snapshots.preview({datasetId:pin.datasetId})).rows[0].名称,'新版产品');
 }finally{await engine.close();await snapshots.close();memory.close();rmSync(dir,{recursive:true,force:true});}
});

test('retention preserves exact historical citation text and a document already read in the active session',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ade-retention-evidence-'));let memory=new MemoryStore(dir),live=new LiveMemory(dir,memory),snapshots=new Snapshots(memory,live,dir);
 try{
  const workspace=new Workspace(memory),source=workspace.upload('职责.md','售后部门负责退款。上下文必须保留。'),docs=new FoundationDocuments(memory),read=docs.read({sourceId:source.id}),evidence=docs.cite({id:'origin',kind:'document',readId:read.readId,quote:'售后部门负责退款。'});
  memory.putArtifact({kind:'change_evidence_receipt',title:'已引用正文',status:'captured',content:{evidence:[evidence] as any}});
  workspace.upload('职责.md','售后部门负责咨询。');
  await snapshots.close();memory.close();memory=new MemoryStore(dir);live=new LiveMemory(dir,memory);snapshots=new Snapshots(memory,live,dir);
  const currentDocs=new FoundationDocuments(memory),sessionSource=new Workspace(memory).upload('本轮读取.md','本轮实际读取，稍后引用。'),sessionRead=currentDocs.read({sourceId:sessionSource.id});
  await new WorkspaceRetention(memory,snapshots).run({operationId:'expire-documents',now:new Date(Date.now()+91*86400000).toISOString()});
  assert.match(new FoundationDocuments(memory).locate(evidence).text,/上下文必须保留/);
  const cited=currentDocs.cite({id:'session',kind:'document',readId:sessionRead.readId,quote:'本轮实际读取，稍后引用。'});
  assert.match(currentDocs.locate(cited).text,/稍后引用/);
 }finally{await snapshots.close();memory.close();rmSync(dir,{recursive:true,force:true});}
});

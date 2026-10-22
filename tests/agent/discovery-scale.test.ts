import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryStore} from '../../src/agent/memory.ts';
import {Workspace} from '../../src/agent/workspace.ts';
import {LiveMemory} from '../../src/live/memory.ts';
import {Snapshots} from '../../src/data/snapshots.ts';
import {discoverFromSnapshots} from '../../src/engine/snapshot-discovery.ts';

test('discovery materializes large overlap results once before reading all result pages',{timeout:30000},async(t)=>{
 const directory=mkdtempSync(join(tmpdir(),'context-os-discovery-scale-')),memory=new MemoryStore(directory),live=new LiveMemory(directory,memory),snapshots=new Snapshots(memory,live,directory);
 try{
  const names=Array.from({length:40},(_,i)=>`key_${i}_id`),csv=names.join(',')+'\n'+Array.from({length:10},(_,i)=>names.map(()=>`R${i}`).join(',')).join('\n');
  new Workspace(memory).upload('完整多键表.csv',csv);await snapshots.sync({operationId:'scale'});
  const execute=t.mock.method(snapshots.executor,'run',snapshots.executor.run.bind(snapshots.executor));
  const result=await discoverFromSnapshots(snapshots,id=>memory.getArtifact(id));
  assert.equal(result.entities.length,1);assert.equal(result.entities[0].rows,10);
  const overlap=execute.mock.calls.filter(call=>String(call.arguments[0].sql).includes('AS a_distinct'));
  assert.equal(overlap.length,1,'all overlap result pages share one full database computation');
  assert.equal(overlap[0].arguments[0].mode,'materialize');
  assert.equal(readdirSync(join(directory,'data','results','workspace')).length,0,'temporary discovery result is removed');
 }finally{await snapshots.close();memory.close();rmSync(directory,{recursive:true,force:true});}
});

test('high cardinality signatures prune disjoint ranges and surviving pairs retain exact full-data overlap',{timeout:30000},async(t)=>{
 const directory=mkdtempSync(join(tmpdir(),'context-os-discovery-signatures-')),memory=new MemoryStore(directory),live=new LiveMemory(directory,memory),snapshots=new Snapshots(memory,live,directory);
 try{
  const workspace=new Workspace(memory);
  for(const [name,prefix,address] of [['accounts','A','same'],['people','P','same'],['unrelated','Z','zzzz']])workspace.upload(name+'.csv','id,email\n'+Array.from({length:1001},(_,i)=>`${prefix}${i},${address}${i}@example.com`).join('\n'));
  await snapshots.sync({operationId:'scale'});
  const execute=t.mock.method(snapshots.executor,'run',snapshots.executor.run.bind(snapshots.executor));
  const result=await discoverFromSnapshots(snapshots,id=>memory.getArtifact(id));
  assert.equal(result.entities.length,3,'signatures never merge independent entities');
  const reviews=result.reviews!.filter(item=>item.kind==='value_overlap'&&item.from?.column==='email'&&item.to?.column==='email');
  assert.equal(reviews.length,1);assert.equal(reviews[0].matchedRows,1001);assert.equal(reviews[0].matchedDistinct,1001);
  assert.equal(execute.mock.calls.filter(call=>call.arguments[0].mode==='materialize').length,2,'bounded signatures run before full candidate verification');
 }finally{await snapshots.close();memory.close();rmSync(directory,{recursive:true,force:true});}
});

test('twenty-four source entities stay explicit when the current twenty-type mapping budget is reached',{timeout:60000},async(t)=>{
 const {FoundationService}=await import('../../src/agent/foundation.ts'),{ProgramBuilds}=await import('../../src/engine/program-builds.ts');
 const directory=mkdtempSync(join(tmpdir(),'context-os-discovery-capacity-')),memory=new MemoryStore(directory),live=new LiveMemory(directory,memory),snapshots=new Snapshots(memory,live,directory),engine=new ProgramBuilds(memory,new FoundationService(memory,live),live,snapshots);
 try{
  const workspace=new Workspace(memory);for(let n=0;n<24;n++)workspace.upload(`实体_${String(n).padStart(2,'0')}.csv`,'id,name\n'+Array.from({length:30},(_,i)=>`E${n}-${i},业务对象${n}-${i}`).join('\n'));
  const start=Date.now(),job=await engine.build({operationId:'over-capacity'}),candidate=engine.overview().candidate!;
  assert.equal(job.content.outcome,'candidate');assert(candidate);
  assert.equal((candidate.content.discovery as any).entities.length,24,'all discovered entities remain reviewable');
  assert.equal((candidate.content.types as any[]).length,20);
  const capacity=(candidate.content.issues as any[]).find(issue=>issue.code==='capacity_limit'&&issue.details?.entities?.length);
  assert.equal(capacity.details.entities.length,4);assert.match(capacity.message,/20/);
  assert.equal(snapshots.datasets().length,24);assert(snapshots.datasets().every(dataset=>(dataset.content.profile as any).rows===30));
  const checked=await engine.check({id:candidate.id,version:candidate.version});assert.equal((checked.content.checks as any).valid,true);
  const adopted=await engine.adopt({id:checked.id,version:checked.version,operationId:'explicit-capacity'}),type=(adopted.model.content.types as any[])[0];
  const query=await live.query({modelId:adopted.model.id,type:type.name,limit:20});assert.equal(query.items.length,20);
  t.diagnostic(`24 entities × 30 rows: discover, retain 4 explicit capacity items, verify/adopt 20 and query: ${Date.now()-start} ms`);
 }finally{await engine.close();await snapshots.close();memory.close();rmSync(directory,{recursive:true,force:true});}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {MemoryStore} from '../../src/agent/memory.ts';
import {LiveMemory} from '../../src/live/memory.ts';
import {Snapshots} from '../../src/data/snapshots.ts';
import {SyncGovernance} from '../../src/data/sync-governance.ts';

test('category pages keep a bounded response and latency as unrelated artifact history grows',async(t)=>{
 const directory=mkdtempSync(join(tmpdir(),'ade-enterprise-list-')),memory=new MemoryStore(directory);
 try{
  memory.atomic(()=>{for(let i=0;i<20;i++)memory.putArtifact({kind:'source',title:`原文${i}`,status:'ready',content:{format:'text',raw:'正文保持完整。'.repeat(20000)}});});
  const measure=()=>{const times:number[]=[];for(let n=0;n<100;n++){const start=performance.now(),page=memory.listArtifacts('source',{content:'compact',limit:20});assert.equal(page.length,20);assert(Buffer.byteLength(JSON.stringify(page))<20000);times.push(performance.now()-start);}return times.sort((a,b)=>a-b)[94];};
  const baseline=measure();
  memory.atomic(()=>{for(let n=0;n<20000;n++)memory.putArtifact({kind:'historical_run',title:`历史运行${n}`,status:'completed',content:{result:'独立类别的历史数据'.repeat(100)}});});
  const grown=measure();t.diagnostic(`source metadata page p95: 20 artifacts ${baseline.toFixed(2)} ms; 20020 artifacts ${grown.toFixed(2)} ms`);
  assert(grown<100,'metadata page must stay below 100 ms');assert(grown<Math.max(20,baseline*15),'unrelated history must not add a linear parse cost');
 }finally{memory.close();rmSync(directory,{recursive:true,force:true});}
});

test('permanently expired credentials become a visible data issue while the last complete snapshot remains queryable',{timeout:20000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ade-enterprise-expired-')),prior=process.env.ADE_VAULT_KEY_DIRECTORY;process.env.ADE_VAULT_KEY_DIRECTORY=join(directory,'external-keys');
 // A credential key must be outside the actual workspace.
 const memory=new MemoryStore(join(directory,'workspace')),live=new LiveMemory(memory.directory,memory),snapshots=new Snapshots(memory,live,memory.directory);let expired=false;
 const server=createServer((_request,response)=>{response.setHeader('content-type','application/json');if(expired){response.statusCode=401;response.end('{"error":"expired"}');}else response.end(JSON.stringify({items:[{id:'A1',name:'保留客户'}],total:1}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const source=await live.sources.connect({name:'凭据失效来源',protocol:'http',url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,token:'synthetic-expired-token',capabilities:[{name:'records',path:'/records',fields:['id','name'],totalPath:'total'}]});
  await snapshots.sync({operationId:'valid'});const initial=snapshots.datasets()[0];expired=true;
  const result=await snapshots.sync({operationId:'expired'});assert.equal(result.content.outcome,'needs_attention');assert.equal(snapshots.dataset(initial.id).content.activeVersion,initial.content.activeVersion);
  const issues=new SyncGovernance(memory,snapshots).list();assert.equal(issues.length,1);assert.match(issues[0].evidence,/401|授权|凭据/);
  assert.equal((await snapshots.preview({datasetId:initial.id})).rows[0].name,'保留客户');await assert.rejects(live.sources.readRecords(source.id,'records'),/401|授权|凭据/);
 }finally{await snapshots.close();memory.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));if(prior===undefined)delete process.env.ADE_VAULT_KEY_DIRECTORY;else process.env.ADE_VAULT_KEY_DIRECTORY=prior;rmSync(directory,{recursive:true,force:true});}
});

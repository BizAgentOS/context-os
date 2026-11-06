import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadCoordinationTables} from '../../src/knowledge/native-coordination.ts';
import {StructuredCompiler,structuredTableInput} from '../../src/knowledge/structured-compiler.ts';
import {KnowledgeJobs,PROMPT_VERSION} from '../../src/knowledge/jobs.ts';
import {fingerprint} from '../../src/knowledge/sources.ts';
import type {KnowledgeCore} from '../../src/knowledge/service.ts';
import type {Sql} from '../../src/knowledge/database.ts';
import type {JsonModel} from '../../src/knowledge/model.ts';
import type {DiscoverySource} from '../../src/knowledge/discovery.ts';
import {retainedCoordination} from './coordination-fixture.ts';
// @ts-expect-error Browser JavaScript is verified separately.
import {submitCoordination} from '../../web/knowledge/plans.js';
const parentId='00000000-0000-4000-8000-000000000009';
function fixture(){
 const sources:DiscoverySource[]=[1,2].map(i=>({id:`00000000-0000-4000-8000-00000000000${i}`,kind:'table',sourceNamespace:`source.source${i}`,keyColumn:'id',columns:['id'],rows:[{id:'1'}],nativeValues:{'1':{id:'1'}},warnings:[],rowCount:1,coverage:{sampled:1,total:1},metadata:{name:`table${i}`,columns:[{name:'id',type:'integer'}]}}));
 const scope={sourceVersionIds:sources.map(s=>s.id)};
 const parent:any={id:parentId,kind:'discover',state:'completed',payload:{input:{kind:'discover',operationId:'old',...scope},modelId:'old-model',modelPolicy:null,promptVersion:'knowledge-native-sources-v16-structured-wire'}};
 const receipts:any[]=sources.map((source,i)=>({stage:`table:${source.id}`,fingerprint:fingerprint({policy:'structured-compiler-v6',configuration:{model:'old-model',budget:null,prompt:parent.payload.promptVersion},stage:`table:${source.id}`,input:structuredTableInput(source,null,true)}),result:{name:'对象',types:[{id:`Type${i}`,name:'对象',properties:[{id:`id${i}`,name:'编号',valueType:'integer',sourceColumns:[{column:'id'}]}]}],links:[]}}));
 const jobs:any[]=[];const steps=new Map<string,any>();let current=true;
 const sql:Sql={async query(text,args=[]){
  let rows:any[]=[];
  if(text==='SELECT * FROM knowledge.jobs WHERE id=$1')rows=args[0]===parentId?[parent]:jobs.filter(j=>j.id===args[0]);
  else if(text.startsWith('SELECT stage,fingerprint,result'))rows=receipts;
  else if(text.startsWith('SELECT COALESCE'))rows=[{active_version:current?(sources.find(s=>s.sourceNamespace===`source.${args[0]}`)?.id??args[0]):'changed'}];
  else if(text.startsWith('SELECT * FROM knowledge.jobs WHERE operation_id'))rows=jobs.filter(j=>j.operation_id===args[0]);
  else if(text.startsWith('INSERT INTO knowledge.jobs')){const j={id:args[0],operation_id:args[1],fingerprint:args[2],kind:args[3],actor_id:args[4],payload:JSON.parse(String(args[5])),state:'queued',attempts:0};jobs.push(j);rows=[j];}
  else if(text.startsWith('SELECT fingerprint,result'))rows=steps.has(String(args[1]))?[steps.get(String(args[1]))]:[];
  else if(text.startsWith('INSERT INTO knowledge.analysis_steps'))steps.set(String(args[1]),{fingerprint:args[2],result:JSON.parse(String(args[3]))});
  else if(text.startsWith('SELECT id FROM knowledge.jobs'))rows=[{id:'lease'}];
  else if(text.startsWith('SELECT * FROM knowledge.jobs WHERE state='))rows=jobs.filter(j=>j.state==='queued').slice(0,1);
  else if(text.startsWith("UPDATE knowledge.jobs SET state='running'")){const j=jobs.find(j=>j.id===args[0]);Object.assign(j,{state:'running',lease_token:args[1],attempts:j.attempts+1});rows=[j];}
  else if(text.startsWith("UPDATE knowledge.jobs SET state='completed'")){const j=jobs.find(j=>j.id===args[0]);Object.assign(j,{state:'completed',result:JSON.parse(String(args[2])),metrics:JSON.parse(String(args[3]))});}
  else if(text.startsWith("UPDATE knowledge.jobs SET state='failed',error=$3")){const j=jobs.find(j=>j.id===args[0]);Object.assign(j,{state:'failed',error:args[2],metrics:JSON.parse(String(args[3]))});}
  else if(text.startsWith('UPDATE knowledge.job_attempts')||text.startsWith('INSERT INTO knowledge.job_attempts')||text.startsWith("UPDATE knowledge.jobs SET state='failed',error='任务租约失效")){}

  else if(text.startsWith('SELECT s.result,s.job_id'))rows=[];
  else throw new Error(`unexpected mock SQL: ${text}`);
  return {rows:rows as any,rowCount:rows.length};
 }};
 const core={db:{pool:sql,transaction:async(run:any)=>run(sql)},sourceVersion:async(_actor:any,id:string)=>{
  const source=sources.find(s=>s.id===id)!;return {id,source_id:source.sourceNamespace!.slice(7),content:source};
 }} as unknown as KnowledgeCore;
 return {sources,scope,parent,receipts,jobs,steps,sql,core,stale(){current=false;}};
}

test('v16 receipts bridge explicitly to current coordination with original fingerprint and evidence validation',async()=>{
 const f=fixture(),before=structuredClone(f.receipts);
 const saved=await loadCoordinationTables(f.sql,parentId,f.sources,null,f.scope);
 assert.equal(saved.tableCount,2);assert.equal(saved.emptyCount,0);assert.equal(saved.snapshotHash.length,64);
 assert.deepEqual(f.receipts,before,'old receipts remain unchanged');
 assert.equal(saved.originJobId,parentId);
});

test('v17 and current table receipts retain explicit policy compatibility with frozen-input verification',async()=>{
 for(const [prompt,policy] of [['knowledge-native-sources-v17-major-decisions','structured-compiler-v7'],['knowledge-native-sources-v18-compact-coordination','structured-compiler-v8'],['knowledge-native-sources-v19-evidence-coordination','structured-compiler-v9'],['knowledge-native-sources-v20-dependency-coordination','structured-compiler-v10'],['knowledge-native-sources-v21-current-reference-coverage','structured-compiler-v11'],[PROMPT_VERSION,'structured-compiler-v12']]){
  const f=fixture();f.parent.payload.promptVersion=prompt;
  for(const [index,source] of f.sources.entries())f.receipts[index].fingerprint=fingerprint({policy,configuration:{model:f.parent.payload.modelId,budget:f.parent.payload.modelPolicy,prompt},stage:`table:${source.id}`,input:structuredTableInput(source,null,!['structured-compiler-v9','structured-compiler-v10','structured-compiler-v11','structured-compiler-v12'].includes(policy),policy==='structured-compiler-v9')});
  assert.equal((await loadCoordinationTables(f.sql,parentId,f.sources,null,f.scope)).tableCount,2);
  f.receipts[0].fingerprint='changed';
  await assert.rejects(loadCoordinationTables(f.sql,parentId,f.sources,null,f.scope),/指纹/);
 }
});

test('missing, stale, incompatible and mismatched receipts fail closed without filling gaps',async()=>{
 for(const mutate of [
  (f:ReturnType<typeof fixture>)=>{f.receipts.pop();},
  (f:ReturnType<typeof fixture>)=>f.stale(),
  (f:ReturnType<typeof fixture>)=>{f.parent.payload.promptVersion='v15';},
  (f:ReturnType<typeof fixture>)=>{f.receipts[0].fingerprint='changed';},
  (f:ReturnType<typeof fixture>)=>{f.parent.state='running';},
  (f:ReturnType<typeof fixture>)=>{f.receipts[0].result.evidenceReferences=[];},
 ]){
  const f=fixture();mutate(f);
  await assert.rejects(loadCoordinationTables(f.sql,parentId,f.sources,null,f.scope));
  assert.equal(f.jobs.length,0);
 }
 const f=fixture();await assert.rejects(loadCoordinationTables(f.sql,parentId,f.sources,null,{...f.scope,baseRevision:2}),/范围|修订/);
});

test('explicit coordination invokes only one coordinate stage, retry reuses its saved response',async()=>{
 const f=fixture(),saved=await loadCoordinationTables(f.sql,parentId,f.sources,null,f.scope),calls:string[]=[],cached:string[]=[];
 const compiler=new StructuredCompiler({core:f.core,job:{id:'new',leaseToken:'lease'},policy:{},reusedTables:saved.tables,cached:s=>cached.push(s),async generate(stage,_task,input:any){
  calls.push(stage);assert.equal(input.tableCandidates.length,2);return retainedCoordination(input);
 }});
 const result=await compiler.discover(f.sources,null);
 assert.deepEqual(calls,['coordinate']);assert.equal(result.tableProposals.length,2);
 await compiler.discover(f.sources,null);assert.deepEqual(calls,['coordinate']);assert.ok(cached.includes('coordinate'));
 const broken=new StructuredCompiler({core:f.core,job:{id:'new',leaseToken:'lease'},policy:{},reusedTables:{},cached(){},async generate(){throw new Error('must not be invoked');}});
 await assert.rejects(broken.discover(f.sources,null),/禁止回退/);
});

test('public recoordinate is idempotent and never queues mapping or collection',async()=>{
 const f=fixture();let paid=0;
 const model={identity:'current-model',executionPolicy:null,async generate(){paid++;throw new Error('not authorized');},async close(){}} as unknown as JsonModel;
 const jobs=new KnowledgeJobs(f.core,model),actor={id:'editor',role:'editor' as const};
 const first=await jobs.recoordinate(actor,parentId,'explicit-coordinate');
 const second=await jobs.recoordinate(actor,parentId,'explicit-coordinate');
 assert.equal(first.id,second.id);assert.equal(f.jobs.length,1);assert.equal(paid,0);
 assert.equal(first.payload.promptVersion,PROMPT_VERSION);assert.equal(first.payload.modelId,'current-model');
 assert.equal(first.payload.input.coordinateFromJobId,parentId);assert.equal(first.payload.input.collectDecisions,false);
 assert.equal(first.payload.input.coordinateSnapshotHash.length,64);
 await assert.rejects(jobs.recoordinate({id:'viewer',role:'viewer'},parentId,'other'));
 f.stale();await assert.rejects(jobs.recoordinate(actor,parentId,'other'),/新版本/);assert.equal(f.jobs.length,1);
});

test('coordination submission preserves accepted job on refresh failure and does not auto retry a lost response',async()=>{
 for(const lost of [false,true]){
  const messages:string[]=[],requests:any[]=[];
  const result=await submitCoordination({jobId:parentId,operationId:'stable-request',async api(path:string,body:any){requests.push({path,body});if(lost)throw new Error('response lost');return {id:'accepted'};},async refresh(){throw new Error('refresh failed');},feedback:(m:string)=>messages.push(m)});
  assert.equal(requests.length,1);assert.equal(requests[0].body.confirmModelCall,true);
  assert.equal(requests[0].body.operationId,'stable-request');
  if(lost){assert.equal(result,null);assert.match(messages.at(-1)!,/stable-request/);}else{assert.equal(result.id,'accepted');assert.match(messages.at(-1)!,/已创建.*accepted/);}
 }
});


test('worker executes the public coordinate job into a separate draft without downstream tasks',async()=>{
 const f=fixture(),calls:string[]=[],drafts:any[]=[];
 (f.core as any).draft=async(_actor:any,definition:any,_existing:any,_lease:any,discovery:any,_copy:any,afterCreate:any)=>{
  const draft={id:'new-draft',definition,discovery};
  if(afterCreate)await afterCreate(f.sql,draft);
  drafts.push(draft);return draft;
 };
 const model={identity:'current-model',executionPolicy:null,async generate(task:string,input:any){calls.push(input.stage);assert.equal(task,'discover');return retainedCoordination(input);},async close(){}} as unknown as JsonModel;
 const jobs=new KnowledgeJobs(f.core,model);
 await jobs.recoordinate({id:'editor',role:'editor'},parentId,'worker-coordinate');
 await jobs.once();
 assert.equal(f.jobs[0].state,'completed',f.jobs[0].error);
 assert.deepEqual(calls,['coordinate']);assert.equal(f.jobs.length,1);assert.equal(drafts.length,1);
 assert.equal(drafts[0].discovery.coordinationReuse.jobId,parentId);
 assert.equal(drafts[0].definition.types.length,2);assert.equal(f.parent.state,'completed');
 assert.equal(f.jobs[0].metrics.modelCalls.length,1);
});


test('empty sources remain automatic coverage records and a single nonempty table still gets explicit coordination',async()=>{
 const f=fixture();f.sources[1].rows=[];f.sources[1].rowCount=0;
 const saved=await loadCoordinationTables(f.sql,parentId,f.sources,null,f.scope);
 assert.equal(saved.tableCount,1);assert.equal(saved.emptyCount,1);
 const calls:string[]=[];
 const compiler=new StructuredCompiler({core:f.core,job:{id:'new',leaseToken:'lease'},policy:{},reusedTables:saved.tables,cached(){},async generate(stage,_task,input:any){calls.push(stage);return retainedCoordination(input);}});
 const result=await compiler.discover(f.sources.slice(0,1),null);
 assert.deepEqual(calls,['coordinate']);assert.equal(result.tableProposals.length,1);
});

test('worker rejects changed receipts before a paid call, and retains a paid response if sources change during coordination',async()=>{
 for(const changeDuringCall of [false,true]){
  const f=fixture();let calls=0;
  (f.core as any).draft=async()=>{throw new Error('must not adopt stale output');};
  const model={identity:'current-model',executionPolicy:null,async generate(_task:string,input:any){calls++;f.stale();return retainedCoordination(input);},async close(){}} as unknown as JsonModel;
  const jobs=new KnowledgeJobs(f.core,model);
  await jobs.recoordinate({id:'editor',role:'editor'},parentId,'stale-coordinate');
  if(!changeDuringCall)f.receipts[0].result.name='changed saved output';
  await jobs.once();assert.equal(f.jobs[0].state,'failed');
  assert.equal(calls,changeDuringCall?1:0);assert.equal(f.jobs.length,1);
  if(changeDuringCall){assert.ok(f.steps.has('coordinate'));assert.match(f.jobs[0].error,/保存结果保留/);assert.equal(f.jobs[0].metrics.modelCalled,true);}
 }
});
test('legacy and current all-abstain receipts can be re-coordinated without repurchasing table stages',async()=>{
 for(const [prompt,policy]of [['knowledge-native-sources-v16-structured-wire','structured-compiler-v6'],['knowledge-native-sources-v20-dependency-coordination','structured-compiler-v10'],['knowledge-native-sources-v21-current-reference-coverage','structured-compiler-v11'],[PROMPT_VERSION,'structured-compiler-v12']]){
  const f=fixture();f.parent.payload.promptVersion=prompt;
  for(const [i,s]of f.sources.entries()){f.receipts[i].result={name:'暂缓',types:[],links:[],disposition:'deferred',reason:'需要跨来源发现'};f.receipts[i].fingerprint=fingerprint({policy,configuration:{model:'old-model',budget:null,prompt},stage:`table:${s.id}`,input:structuredTableInput(s,null,policy==='structured-compiler-v6')});}
  const saved=await loadCoordinationTables(f.sql,parentId,f.sources,null,f.scope);assert.equal(saved.tableCount,2);assert.equal(Object.keys(saved.tables).length,2);
 }
});

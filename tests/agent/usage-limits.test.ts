import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MemoryStore} from '../../src/agent/memory.ts';
import {UsageService} from '../../src/agent/usage.ts';
import type {AgentDriver,RunRequest} from '../../src/agent/runtime.ts';
import {KodaXDriver} from '../../src/agent/runtime.ts';
import {withActor} from '../../src/security/actors.ts';

const request=(onTool:RunRequest['onTool']=async()=>null):RunRequest=>({title:'预算边界',system:'协议回归，不调用真实模型',input:'核对数据',tools:[],onSession(){},onEvent(){},onTool});
test('actual provider usage stops a run before further tools and blocks the shared daily budget until the next day',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'context-os-usage-')),memory=new MemoryStore(directory);let now=new Date('2026-10-21T02:00:00Z'),calls=0,stops=0,writes=0;
  try{
    const usage=new UsageService(memory,{clock:()=>now});
    usage.configure({operationId:'budget',timeZone:'Asia/Shanghai',perRun:{tokens:140},daily:{tokens:150},rates:[{provider:'custom',model:'fixture',inputPer1M:1,outputPer1M:2}]});
    const driver:AgentDriver={async run(req){calls++;req.onEvent('run.usage',{sampleId:'response-1',usage:{inputTokens:100,outputTokens:50,totalTokens:150}});
      await assert.rejects(req.onTool('save',{}),/上限|预算/);return {text:'不可声称完成',runId:'fixture',sessionId:'fixture',usage:{inputTokens:100,outputTokens:50,totalTokens:150}};
    },async stop(){stops++;},async close(){}};
    const wrapped=usage.wrap(driver,()=>({provider:'custom',model:'fixture'}),'test');
    const outcome=await wrapped.run(request(async()=>{writes++;return null;}));assert.equal(outcome.status,'stopped');assert.match(outcome.error!,/上限/);assert.equal(writes,0);assert.equal(stops,1);
    assert.equal((outcome.usage as any).costUsd,0.0002);
    const today=usage.overview().today;assert.equal(today.tokens,150);assert.equal(today.costUsd,0.0002);assert.equal(today.runs,1);
    await assert.rejects(wrapped.run(request()),/每日.*上限/);assert.equal(calls,1);
    now=new Date('2026-10-22T02:00:00Z');assert.equal(usage.overview().today.tokens,0);assert.equal(usage.overview().month.tokens,150);
    await wrapped.run(request());assert.equal(calls,2);assert.equal(usage.overview().month.tokens,300);
  }finally{memory.close();rmSync(directory,{recursive:true,force:true});}
});

test('revoking the caller while a model is in flight still accounts for its returned provider usage',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'context-os-usage-revoked-')),memory=new MemoryStore(directory);let finish!:(outcome:any)=>void,active=true;
  try{
    const usage=new UsageService(memory),driver:AgentDriver={run:async()=>new Promise(resolve=>{finish=resolve;}),async stop(){},async close(){}};
    const running=withActor({kind:'human',id:'viewer-fixture',name:'查看同事',role:'viewer'},()=>usage.wrap(driver,()=>({provider:'custom',model:'unpriced'}),'revoked').run(request()),()=>{if(!active)throw new Error('登录授权已变化');});
    active=false;finish({text:'迟到回答',runId:'late',sessionId:'late',usage:{inputTokens:10,outputTokens:5,totalTokens:15}});
    const result=await running;assert.equal(result.status,'stopped');assert.match(result.error!,/授权/);
    assert.equal(usage.overview().today.tokens,15);assert.equal(usage.overview().runs[0].status,'stopped');
  }finally{memory.close();rmSync(directory,{recursive:true,force:true});}
});

test('concurrent runs reserve the daily allowance and release unused capacity; unknown usage never becomes a free run',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'context-os-usage-shared-')),memory=new MemoryStore(directory);let finish!:(outcome:any)=>void;
  try{
    const usage=new UsageService(memory);usage.configure({operationId:'shared',perRun:{tokens:100},daily:{tokens:100}});
    const driver:AgentDriver={run:async()=>new Promise(resolve=>{finish=resolve;}),async stop(){},async close(){}};
    const wrapped=usage.wrap(driver,()=>({provider:'custom',model:'unpriced'}),'parallel');
    const first=wrapped.run(request());await assert.rejects(wrapped.run(request()),/每日.*上限/);
    finish({text:'完成',sessionId:'first',runId:'first',usage:{inputTokens:20,outputTokens:10,totalTokens:30}});await first;
    assert.equal(usage.overview().today.tokens,30);assert.equal(usage.overview().today.costUsd,null);
    const second=wrapped.run(request());finish({text:'未回报计量',sessionId:'second',runId:'second'});
    const missing=await second;assert.equal(missing.status,'stopped');assert.match(missing.error!,/没有返回.*用量/);assert.equal(usage.overview().today.unknownRuns,1);
    await assert.rejects(wrapped.run(request()),/未确认用量/);
    usage.configure({operationId:'price-required',perRun:{usd:0.1}});
    await assert.rejects(wrapped.run(request()),/费率/);
  }finally{memory.close();rmSync(directory,{recursive:true,force:true});}
});

test('the SDK boundary forwards each actual provider response once and does not bill estimated context size',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'context-os-usage-sdk-')),memory=new MemoryStore(directory);let listener:(event:any)=>void=()=>{};
  const runtime={sessions:{async create(){return{id:'session'};}},events:{subscribe(_filter:unknown,callback:typeof listener){listener=callback;return{close(){}};}},runs:{async start(){
    const event={type:'run.progress',payload:{kind:'iteration_end',info:{iter:1,tokenSource:'api',tokenCount:9000,usage:{inputTokens:100,outputTokens:50,totalTokens:150}}}};
    listener(event);listener(event);
    listener({type:'run.progress',payload:{kind:'iteration_end',info:{iter:2,tokenSource:'api',tokenCount:12000,usage:{inputTokens:60,outputTokens:20,totalTokens:80}}}});
    return{runId:'runtime-run',result:Promise.resolve({phase:'completed',result:{lastText:'依据已核对',usage:{inputTokens:160,outputTokens:70,totalTokens:230}}})};
  },async abort(){}},async close(){}};
  const driver=new KodaXDriver(join(directory,'runtime'),{provider:'custom',model:'fixture',baseUrl:'https://example.invalid',protocol:'openai'});driver.initialize=async()=>runtime as any;
  try{
    const usage=new UsageService(memory);usage.configure({operationId:'rates',rates:[{provider:'custom',model:'fixture',inputPer1M:1,outputPer1M:2}]});
    const result=await usage.wrap(driver,()=>driver.settings,'sdk').run(request());
    assert.equal((result.usage as any).totalTokens,230);assert.equal(usage.overview().today.costUsd,0.0003);assert.equal(usage.overview().today.tokens,230);
    assert.equal(((usage.overview().runs[0].content.samples as any[])).length,2,'duplicate SDK observation is not another bill, and context size is not provider usage');
  }finally{await driver.close();memory.close();rmSync(directory,{recursive:true,force:true});}
});

test('final cumulative telemetry includes unstreamed responses and interrupted accounting stays explicitly unknown',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'context-os-usage-final-')),memory=new MemoryStore(directory);
  try{
    const usage=new UsageService(memory);usage.configure({operationId:'final-budget',perRun:{tokens:100},daily:{tokens:200},rates:[{provider:'custom',model:'fixture',inputPer1M:1,outputPer1M:2}]});
    const driver:AgentDriver={async run(req){req.onEvent('run.usage',{sampleId:'first',usage:{inputTokens:20,outputTokens:10,totalTokens:30}});return{sessionId:'final',runId:'final',text:'完整回执',usage:{inputTokens:80,outputTokens:30,totalTokens:110}};},async stop(){},async close(){}};
    const result=await usage.wrap(driver,()=>({provider:'custom',model:'fixture'}),'final').run(request());
    assert.equal(result.status,'stopped');assert.equal(usage.overview().today.tokens,110);assert.equal(usage.overview().today.costUsd,0.00014);
    const interrupted:AgentDriver={async run(req){req.onEvent('run.usage',{sampleId:'known',usage:{inputTokens:5,outputTokens:5,totalTokens:10}});throw new Error('上游响应中断');},async stop(){},async close(){}};
    await assert.rejects(usage.wrap(interrupted,()=>({provider:'custom',model:'fixture'}),'partial').run(request()),/中断/);
    assert.equal(usage.overview().today.tokens,120,'known incurred tokens remain visible');assert.equal(usage.overview().today.unknownRuns,1,'an unfinished upstream response cannot be reported as zero');assert.equal(usage.overview().today.costUsd,null);
    await assert.rejects(usage.wrap(driver,()=>({provider:'custom',model:'fixture'}),'blocked').run(request()),/未确认用量/);
  }finally{memory.close();rmSync(directory,{recursive:true,force:true});}
});

test('daily reservations remain shared across midnight and restart does not turn a pending run into known usage',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'context-os-usage-midnight-'));let memory=new MemoryStore(directory),now=new Date('2026-10-21T15:59:59Z'),finish!:(value:any)=>void;
  try{
    const usage=new UsageService(memory,{clock:()=>now});usage.configure({operationId:'midnight',perRun:{tokens:100},daily:{tokens:100}});
    let calls=0;const driver:AgentDriver={async run(){if(calls++)return{sessionId:'unexpected',runId:'unexpected',text:'预算不应允许此调用'};return new Promise(resolve=>{finish=resolve;});},async stop(){},async close(){}};
    const wrapped=usage.wrap(driver,()=>({provider:'custom',model:'fixture'}),'midnight'),first=wrapped.run(request());
    now=new Date('2026-10-21T16:00:01Z');await assert.rejects(wrapped.run(request()),/每日.*上限/);
    finish({sessionId:'midnight',runId:'midnight',text:'完成',usage:{inputTokens:20,outputTokens:10,totalTokens:30}});await first;assert.equal(usage.overview().today.tokens,30);
    memory.putArtifact({kind:'usage_run',title:'重启前未完成请求',status:'running',content:{startedAt:now.toISOString(),accounting:'available',samples:[],reservation:{tokens:70,usd:0}}});
    memory.close();memory=new MemoryStore(directory);const restarted=new UsageService(memory,{clock:()=>now});
    assert.equal(restarted.overview().today.unknownRuns,1);assert.equal(restarted.overview().runs[0].status,'interrupted');
    await assert.rejects(restarted.wrap(driver,()=>({provider:'custom',model:'fixture'}),'after-restart').run(request()),/未确认用量/);
  }finally{memory.close();rmSync(directory,{recursive:true,force:true});}
});

test('a budget cannot save contradictory tariffs for the same provider and model',()=>{
  const directory=mkdtempSync(join(tmpdir(),'context-os-usage-tariff-')),memory=new MemoryStore(directory);
  try{
    const usage=new UsageService(memory),tariff={provider:'custom',model:'fixture',inputPer1M:1,outputPer1M:2};
    assert.throws(()=>usage.configure({operationId:'duplicate',rates:[tariff,{...tariff,inputPer1M:10}]}),/费率.*重复|重复.*费率/);
    assert.equal(memory.listArtifacts('usage_policy').length,0);
    usage.configure({operationId:'different-models',rates:[tariff,{...tariff,model:'other',inputPer1M:10}]});assert.equal(usage.policy().rates.length,2);
  }finally{memory.close();rmSync(directory,{recursive:true,force:true});}
});

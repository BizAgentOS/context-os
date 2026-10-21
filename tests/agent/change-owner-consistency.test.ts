import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import { createFusionSources, primaryCapability, supplementCapability, fusionDefinition } from "./fusion-fixture.ts";
const ref = (a: any) => ({ id: a.id, version: a.version });

for (const syncAgain of [true, false]) test(`adoption refuses changed owner verification inputs (${syncAgain ? 'new snapshot' : 'live facts'})`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-owner-consistency-'));
  const upstream = await createFusionSources();
  const service = await createServer({directory, automaticApi:false});
  await new Promise<void>(resolve => service.server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const call = async (path:string, body?:unknown) => {
    const response = await fetch(base+path,{method:body === undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-DataEngine-Token':service.adminToken},...(body === undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json() as any};
  };
  try {
    const primary = await service.app.live.sources.connect({name:'投诉',protocol:'http',url:upstream.url,capabilities:[primaryCapability]});
    const extra = await service.app.live.sources.connect({name:'工单',protocol:'mcp',url:upstream.url+'/mcp',capabilities:[supplementCapability]});
    if(syncAgain) await service.app.snapshots.sync({operationId:'before'});
    const candidate = await service.app.live.propose(fusionDefinition(primary.id,extra.id));
    const listed = await call('/api/changes');
    const change = listed.body.changes.find((item:any)=>item.owner?.id === candidate.id);
    const checked = await call('/api/changes/verify',{operationId:'verify',...ref(change)});
    assert.equal(checked.body.change.status,'verified',JSON.stringify(checked.body));
    upstream.state.outcome = '已改善';
    if(syncAgain) await service.app.snapshots.sync({operationId:'after'});
    const before = (await call('/api/workspace-versions')).body;
    const adopted = await call('/api/changes/adopt',{operationId:'adopt',...ref(checked.body.change)});
    assert.equal(adopted.status,409,JSON.stringify(adopted.body));
    assert.equal(adopted.body.code,'verification_changed');
    const legacy = await call('/api/live/adopt',ref(candidate));
    assert.equal(legacy.status,409,'the legacy entry point must enforce the same reviewed facts');
    assert.equal(legacy.body.code,'verification_changed');
    assert.equal((await call('/api/workspace-versions')).body.versions.length,before.versions.length);
    const refreshed = await call('/api/changes/verify',{operationId:'reverify',...ref(checked.body.change)});
    assert.equal(refreshed.body.change.status,'verified');
    assert.equal((await call('/api/changes/adopt',{operationId:'after-reverify',...ref(refreshed.body.change)})).body.change.status,'adopted');
  } finally { await service.close(); await upstream.close(); rmSync(directory,{recursive:true,force:true}); }
});

test('rejecting a foundation candidate preserves its decision while allowing genuinely changed content on the same foundation', async () => {
  const directory=mkdtempSync(join(tmpdir(),'ade-owner-content-'));
  const service=await createServer({directory,automaticApi:false});
  try {
    const {memory,foundation,changes}=service.app;
    const task=memory.createTask('本体候选'), message=memory.addMessage(task.id,'user','澄川热力管理居民投诉与处理信息。');
    const context=memory.beginExecution(task.id);
    const propose=(description:string)=>foundation.propose({baseVersion:foundation.read().current?.version ?? 0,
      enterprise:{name:'澄川热力',evidenceRefs:['evidence']},concepts:[{id:'complaint',name:'投诉',description,evidenceRefs:['evidence']}],relations:[],
      evidence:[{id:'evidence',messageId:message.id,quote:message.content}],unknowns:[],conflicts:[]},context,description,'method');
    try {
      const first=propose('居民投诉');
      const rejected=changes.reject({operationId:'reject',...ref(changes.list().changes.find((item:any)=>item.owner?.id===first.id)),reason:'说明过于宽泛'});
      assert.throws(()=>foundation.adopt(first.id,first.version),/已处理/);
      const second=propose('居民关于供热服务的投诉及处理状态');
      assert.equal(second.id,first.id);
      const revised=changes.list().changes.find((item:any)=>item.owner?.id===second.id && item.status==='proposed')!;
      assert.ok(revised,'new content gets a new actionable proposal');
      assert.notEqual(revised.id,rejected.id);
      const checked=await changes.verify({operationId:'verify',...ref(revised)});
      assert.equal((await changes.adopt({operationId:'adopt',...ref(checked)})).status,'adopted');
      assert.equal(changes.read(rejected.id).status,'rejected','prior rejection remains immutable');
    } finally {memory.endExecution(context);}
  } finally {await service.close();rmSync(directory,{recursive:true,force:true});}
});

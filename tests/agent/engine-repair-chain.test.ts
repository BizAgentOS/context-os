import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Artifact } from "../../src/agent/contracts.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";
import { createServer } from "../../src/agent/server.ts";

const ref = (a: Artifact) => ({id: a.id, version: a.version});

test("program construction, Agent wording repair and versioned publication preserve an existing consumer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-repair-chain-"));
  let calls = 0;
  let repaired: Artifact | undefined;
  const driver: AgentDriver = {
    async run(request) {
      calls++;
      const input = JSON.parse(request.input);
      const foundation = (await request.onTool("foundation_read", {}) as any).current;
      await request.onTool("skill_use", {name: "company-foundation-ontology"});
      const message = input.recentMessages.at(-1);
      repaired = await request.onTool("foundation_propose", {
        baseVersion: foundation.version, enterprise: foundation.content.enterprise,
        concepts: [{id: foundation.content.concepts[0].id, name: "公司", description: "公司业务记录", evidenceRefs: ["repair"]}],
        relations: [], evidence: [{id: "repair", messageId: message.id, quote: message.content}], unknowns: [], conflicts: [],
      }) as unknown as Artifact;
      return {text: "候选已保存，等待页面采用。", sessionId: "repair-chain", runId: `repair-chain-${calls}`};
    }, async stop() {}, async close() {},
  };
  const service = await createServer({directory, driver});
  await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(origin + path, {method: body ? "POST" : "GET", headers: {"x-dataengine-token": service.adminToken, "content-type": "application/json"}, ...(body ? {body: JSON.stringify(body)} : {})});
    const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result;
  };
  const external = async (key: string, path: string) => {
    const response = await fetch(origin + path, {headers: {authorization: `Bearer ${key}`}});
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  const publish = async (name: string) => {
    const overview = await api("/api/releases");
    const checked = await api("/api/releases/check", {inputHash: overview.working.inputHash});
    assert.equal(checked.status, "ready", JSON.stringify(checked.content));
    return (await api("/api/releases/publish", {operationId: name, name, checkRef: ref(checked)})).release;
  };
  try {
    await api("/api/canvas/upload", {page: "setup", name: "companies.csv", content: "id,name\nA,Example\n"});
    await service.app.idle();
    assert.equal(calls, 0, "program construction must not invoke the model");
    const initial = service.app.foundation.read().adopted!;
    const initialModel = service.app.live.overview().models.find(m => m.status === "adopted")!;
    const originalType = (initialModel.content.types as any[])[0], conceptId = originalType.conceptId;
    const first = await publish("v1");
    const old = await api("/api/releases/connect", {operationId: "old", name: "原消费者", releaseRef: ref(first), conceptIds: [conceptId], relationIds: [], business: {grants: [{type: originalType.name, fields: ["$id", "name"], relations: []}]}});
    const conceptPath = `/v4/concept?conceptId=${encodeURIComponent(conceptId)}`;
    const originalObjectPath = `/v4/objects?type=${encodeURIComponent(originalType.name)}`;
    assert.equal((await external(old.key, originalObjectPath)).items[0].properties.name.value, "Example");

    await api("/api/canvas/navigate", {page: "ontology"});
    await api("/api/canvas/message", {page: "ontology", text: "把这个概念叫公司，含义为公司业务记录。", messageId: "repair"});
    await service.app.idle();
    assert.equal(repaired?.status, "candidate");
    assert.equal(service.app.foundation.read().adopted!.version, initial.version);
    await api("/api/canvas/foundation/adopt", {page: "ontology", ...ref(repaired!)});
    await service.app.idle();
    assert.equal((service.app.foundation.read().adopted!.content.concepts as any[])[0].name, "公司");
    assert.equal((await external(old.key, conceptPath)).concept.name, originalType.name);
    assert.equal((await external(old.key, originalObjectPath)).items[0].properties.name.value, "Example");
    // Current wording is projected by stable IDs; immutable bindings do not rebind.
    const active = service.app.live.overview().models.find(m => m.status === "adopted")!;
    assert.equal(active.id,initialModel.id);
    assert.equal(active.version,initialModel.version);
    assert.deepEqual((active.content.layered as any).bindings,(initialModel.content.layered as any).bindings);
    assert.equal((service.app.memory.getArtifact(initialModel.id,initialModel.version).content.types as any[])[0].name,originalType.name);
    assert.equal((active.content.types as any[])[0].name, "公司");
    assert.equal((active.content.types as any[])[0].description, "公司业务记录");
    assert.equal(service.app.canvasState().automaticApiBuild.status, "completed");
    const records = await api("/api/live/query", {modelId: active.id, type: "公司"});
    assert.equal(records.items[0].name, "Example");
    assert.equal((await api("/api/live/query",{modelId:active.id,type:originalType.name})).items[0].name,"Example","current query retains the original type alias");
    const second = await publish("v2");
    assert.equal(second.content.sequence, 2);
    assert.equal(second.content.definition.concepts[0].name, "公司");
    assert.equal(second.content.definition.model.types[0].name,"公司");
    assert.equal(first.content.definition.model.types[0].name,originalType.name);
    assert.deepEqual(second.content.modelRef,first.content.modelRef);
    assert(second.content.diff.some((d: any) => d.path === `/concepts/${conceptId}/name` && d.before === originalType.name && d.after === "公司"));
    const newer = await api("/api/releases/connect", {operationId: "new", name: "新版消费者", releaseRef: ref(second), conceptIds: [conceptId], relationIds: [], business: {grants: [{type: "公司", fields: ["$id", "name"], relations: []}]}});
    assert.equal((await external(newer.key, conceptPath)).concept.description, "公司业务记录");
    assert.equal((await external(newer.key, `/v4/objects?type=${encodeURIComponent("公司")}`)).items[0].properties.name.value, "Example");
    assert.equal((await external(old.key, conceptPath)).concept.name, originalType.name);
    assert.equal((await external(old.key, originalObjectPath)).items[0].properties.name.value, "Example");
    assert.equal((await fetch(origin+`/v4/objects?type=${encodeURIComponent("公司")}`,{headers:{authorization:`Bearer ${old.key}`}})).status,403,"old release grants cannot follow current wording");
    assert.equal(calls, 1, "the Agent only assists the repair; the program realigns the mapping");
  } finally {await service.close(); rmSync(directory, {recursive: true, force: true});}
});

test("renaming semantic types and relations preserves local corrections and still rejects changed source facts", async()=>{
  const {createHeatingSources,connectHeatingSources,heatingDefinition}=await import('../../src/live/heating-sources.ts');
  const {seedFoundation}=await import('./program-foundation-fixture.ts');
  const {RelationCorrections}=await import('../../src/live/relation-corrections.ts');
  const directory=mkdtempSync(join(tmpdir(),'ade-correction-wording-')),upstream=await createHeatingSources();
  const service=await createServer({directory,automaticApi:false});
  try {
    const connections=await connectHeatingSources(service.app.live.sources,upstream),definition=heatingDefinition(connections.api.id,connections.mcp.id);
    definition.relations.push({...definition.relations[0],name:'备用回访'});
    const ids=new Map(definition.types.map((type,index)=>[type.name,'entity-'+index]));
    const foundation=seedFoundation(service.app.memory,service.app.foundation,{enterprise:'热力企业',
      concepts:definition.types.map(type=>({id:ids.get(type.name)!,name:type.name,description:type.description})),
      relations:definition.relations.map((relation,index)=>({id:'relation-'+index,name:relation.name,from:ids.get(relation.from)!,to:ids.get(relation.to)!,description:'来自既有字段关联。'}))});
    const candidate=await service.app.live.propose({...definition,foundationRef:ref(foundation),baseModelRef:null,
      types:definition.types.map(type=>({...type,conceptId:ids.get(type.name)})),
      relations:definition.relations.map((relation,index)=>({...relation,relationId:'relation-'+index}))});
    const model=await service.app.live.adopt(candidate.id,candidate.version),corrections=new RelationCorrections(service.app.memory,service.app.live);
    const target={modelId:model.id,modelVersion:model.version,type:'投诉',objectId:'TS002',relation:'回访记录'};
    let correction=await corrections.execute('propose',{operationId:'wording-propose',target,targetIds:[],reason:'此回访误关联',evidence:'验收指定移除此对象的回访关联'});
    correction=await corrections.execute('check',{operationId:'wording-check',...ref(correction)});
    correction=await corrections.execute('adopt',{operationId:'wording-adopt',...ref(correction)});
    const task=service.app.memory.createTask('修改业务称呼'),message=service.app.memory.addMessage(task.id,'user','投诉改称服务诉求，回访记录改称回访依据，结构与来源不变。');
    const context=service.app.memory.beginExecution(task.id);
    try {
      const semantic=service.app.foundation.propose({baseVersion:foundation.version,enterprise:foundation.content.enterprise,
        concepts:[{id:ids.get('投诉'),name:'服务诉求',description:definition.types[0].description,evidenceRefs:['wording']}],
        relations:[{id:'relation-0',name:'回访依据',from:ids.get('投诉'),to:ids.get('回访'),description:'来自既有字段关联。',evidenceRefs:['wording']}],
        evidence:[{id:'wording',messageId:message.id,quote:message.content}],unknowns:[],conflicts:[]},context,'wording','test-method',undefined,{lockStructure:true});
      service.app.foundation.adopt(semantic.id,semantic.version,{automatic:true});
    }finally{service.app.memory.endExecution(context);}
    const current=await service.app.live.query({modelId:model.id,type:'服务诉求',id:'TS002',relation:'回访依据'});
    assert.deepEqual(current.items,[]);assert.equal(current.correction?.id,correction.id);
    assert.deepEqual((await service.app.live.query({modelId:model.id,type:target.type,id:target.objectId,relation:target.relation})).items,[]);
    const original=await service.app.live.query({modelId:model.id,type:target.type,id:target.objectId,relation:target.relation},()=>{},false);
    assert.equal(original.items[0].$id,'HF002');
    assert.equal(service.app.memory.getArtifact(model.id).version,model.version);
    let newer=await corrections.execute('propose',{operationId:'renamed-propose',target:{...target,type:'服务诉求',relation:'回访依据'},targetIds:['HF002'],reason:'重新核对确认保留回访',evidence:'验收指定保留该回访关联'});
    newer=await corrections.execute('check',{operationId:'renamed-check',...ref(newer)});
    newer=await corrections.execute('adopt',{operationId:'renamed-adopt',...ref(newer)});
    let stale=await corrections.execute('propose',{operationId:'concurrent-propose',target:{...target,type:'服务诉求',relation:'回访依据'},targetIds:[],reason:'待审的独立纠正',evidence:'此候选尚未获得最终决定'});
    stale=await corrections.execute('check',{operationId:'concurrent-check',...ref(stale)});
    const currentFoundation=service.app.foundation.read().adopted!;
    const resetTask=service.app.memory.createTask('恢复业务称呼'),resetMessage=service.app.memory.addMessage(resetTask.id,'user','服务诉求恢复称投诉，回访依据恢复称回访记录，结构保持原样。');
    const resetContext=service.app.memory.beginExecution(resetTask.id);
    try {
      const reset=service.app.foundation.propose({baseVersion:currentFoundation.version,enterprise:currentFoundation.content.enterprise,
        concepts:[{id:ids.get('投诉'),name:'投诉',description:definition.types[0].description,evidenceRefs:['reset']}],
        relations:[{id:'relation-0',name:'回访记录',from:ids.get('投诉'),to:ids.get('回访'),description:'来自既有字段关联。',evidenceRefs:['reset']}],
        evidence:[{id:'reset',messageId:resetMessage.id,quote:resetMessage.content}],unknowns:[],conflicts:[]},resetContext,'reset','test-method',undefined,{lockStructure:true});
      service.app.foundation.adopt(reset.id,reset.version,{automatic:true});
    }finally{service.app.memory.endExecution(resetContext);}
    const restored=await service.app.live.query({modelId:model.id,type:'投诉',id:'TS002',relation:'回访记录'});
    assert.equal(restored.correction?.id,newer.id,'latest decision for a stable relation wins even after its original name returns');
    assert.equal(restored.items[0].$id,'HF002');
    let latest=await corrections.execute('propose',{operationId:'restored-propose',target,targetIds:[],reason:'采用原称呼下新核对的决定',evidence:'当前管理员再次确认移除回访'});
    latest=await corrections.execute('check',{operationId:'restored-check',...ref(latest)});
    latest=await corrections.execute('adopt',{operationId:'restored-adopt',...ref(latest)});
    await assert.rejects(corrections.execute('check',{operationId:'stale-renamed-recheck',...ref(stale)}),/已有新的纠正决定/,'a checked candidate under a former name cannot ignore a newer stable-relation decision');
    await assert.rejects(corrections.execute('adopt',{operationId:'stale-renamed-adopt',...ref(stale)}),/已有新的纠正决定/);
    assert.equal(service.app.memory.getArtifact(stale.id).version,stale.version,'rejected concurrency checks do not mutate the older candidate');
    assert.equal((await service.app.live.query({modelId:model.id,type:'投诉',id:'TS002',relation:'回访记录'})).correction?.id,latest.id);
    await assert.rejects(service.app.live.query({modelId:model.id,conceptId:ids.get('投诉'),type:'回访'}),/类型与概念引用不一致/);
    const swapTask=service.app.memory.createTask('交换两条关系显示名'),swapMessage=service.app.memory.addMessage(swapTask.id,'user','交换两条既有回访关系的显示名称，关联键和稳定身份保持原样。');
    const swapContext=service.app.memory.beginExecution(swapTask.id);
    try {
      const beforeSwap=service.app.foundation.read().adopted!;
      const swap=service.app.foundation.propose({baseVersion:beforeSwap.version,enterprise:beforeSwap.content.enterprise,concepts:[],
        relations:[{id:'relation-0',name:'备用回访',from:ids.get('投诉'),to:ids.get('回访'),description:'来自既有字段关联。',evidenceRefs:['swap']},
          {id:'relation-1',name:'回访记录',from:ids.get('投诉'),to:ids.get('回访'),description:'来自既有字段关联。',evidenceRefs:['swap']}],
        evidence:[{id:'swap',messageId:swapMessage.id,quote:swapMessage.content}],unknowns:[],conflicts:[]},swapContext,'swap','test-method',undefined,{lockStructure:true});
      service.app.foundation.adopt(swap.id,swap.version,{automatic:true});
    }finally{service.app.memory.endExecution(swapContext);}
    const unrelated=await service.app.live.query({modelId:model.id,type:'投诉',id:'TS002',relation:'回访记录'});
    assert.equal(unrelated.items[0].$id,'HF002','the other stable relation keeps its source result after names are exchanged');
    assert.equal(unrelated.correction,undefined,'a matching reused display name must not inherit another relation correction');
    assert.equal((await service.app.live.query({modelId:model.id,type:'投诉',id:'TS002',relation:'备用回访'})).correction?.id,latest.id);
    upstream.setOutcome('已改善');
    await assert.rejects(service.app.live.query({modelId:model.id,type:'投诉',id:'TS002',relation:'备用回访'}),/局部纠正.*已变化/);
  }finally{await service.close();await upstream.close();rmSync(directory,{recursive:true,force:true});}
});

test("correction capture retains generated stable relation identity without a foundation", async()=>{
  const {createHeatingSources,connectHeatingSources,heatingDefinition}=await import('../../src/live/heating-sources.ts');
  const {RelationCorrections}=await import('../../src/live/relation-corrections.ts');
  const directory=mkdtempSync(join(tmpdir(),'ade-correction-generated-id-')),upstream=await createHeatingSources();
  const service=await createServer({directory,automaticApi:false});
  try {
    const connections=await connectHeatingSources(service.app.live.sources,upstream);
    const candidate=await service.app.live.propose(heatingDefinition(connections.api.id,connections.mcp.id));
    const model=await service.app.live.adopt(candidate.id,candidate.version);
    assert.equal(model.content.foundationRef,undefined);
    assert.equal((model.content.relations as any[])[0].relationId,undefined,'the legacy projection supplied no explicit stable relation identity');
    const relationId=service.app.live.readLayered(model.id,model.version).semantic.relationTypes[0].id;
    const corrections=new RelationCorrections(service.app.memory,service.app.live);
    let correction=await corrections.execute('propose',{operationId:'generated-propose',target:{modelId:model.id,modelVersion:model.version,type:'投诉',objectId:'TS002',relation:'回访记录'},targetIds:[],reason:'移除误关联回访',evidence:'管理员核对原始登记后确认该回访不属于此投诉'});
    assert.equal((correction.content.snapshot as any).relation.relationId,relationId,'new corrections resolve identity from the canonical layered model');
    assert.equal((correction.content.modelDefinition as any).relations[0].relationId,relationId);
    correction=await corrections.execute('check',{operationId:'generated-check',...ref(correction)});
    correction=await corrections.execute('adopt',{operationId:'generated-adopt',...ref(correction)});
    const result=await service.app.live.query({modelId:model.id,type:'投诉',id:'TS002',relation:'回访记录'});
    assert.equal(result.correction?.id,correction.id);
    assert.deepEqual(result.items,[]);
  }finally{await service.close();await upstream.close();rmSync(directory,{recursive:true,force:true});}
});

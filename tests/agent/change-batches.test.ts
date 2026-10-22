import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AgentApplication} from "../../src/agent/app.ts";
import {seedFoundation} from "./program-foundation-fixture.ts";
import type {Artifact,Data} from "../../src/agent/contracts.ts";
import {Workspace} from "../../src/agent/workspace.ts";
import {identityWorkspace} from "./identity-fixture.ts";

const ref=(a:Artifact)=>({id:a.id,version:a.version});
async function fixture(seed=true){
  const directory=mkdtempSync(join(tmpdir(),"context-os-change-batch-")),app=new AgentApplication(directory,undefined,undefined,false);
  if(seed)seedFoundation(app.memory,app.foundation,{enterprise:"批量治理",concepts:[{id:"person",name:"人员",description:"人员记录"},{id:"team",name:"团队",description:"团队记录"}]});
  let seq=0;
  const proposal=async(type:string,subject:Data)=>{const {change}=await app.changes.propose({operationId:`p-${++seq}`,origin:"human",type,subject,baseline:app.changes.currentBaseline()});return app.changes.verify({operationId:`v-${seq}`,...ref(change)});};
  return {app,proposal,async close(){await app.close();rmSync(directory,{recursive:true,force:true});}};
}

test("a mixed naming and description batch adopts all edits in one working version and replays its receipt",async()=>{
  const f=await fixture();try{
    const renamed=await f.proposal("naming",{target:"concept",id:"person",name:"员工"}),described=await f.proposal("description",{target:"concept",id:"team",description:"正式组织团队"});
    const before=f.app.workspaceVersions.list().length;
    const args={operationId:"wording-batch",items:[ref(renamed),ref(described)]};
    const result=await f.app.changes.batchAdopt(args);
    assert.deepEqual(result.changes.map(a=>a.status),["adopted","adopted"]);
    const concepts=f.app.foundation.read().adopted!.content.concepts as Data[];
    assert.equal(concepts.find(c=>c.id==="person")!.name,"员工");assert.equal(concepts.find(c=>c.id==="team")!.description,"正式组织团队");
    assert.equal(f.app.workspaceVersions.list().length,before+1);
    assert.deepEqual(await f.app.changes.batchAdopt(args),result);
    assert.equal(f.app.workspaceVersions.list().length,before+1);
  }finally{await f.close();}
});

test("two independent relations merge into one definition and remain queryable",async()=>{
  const w=await identityWorkspace();try{
    const app=w.service.app,verified:Artifact[]=[];
    for(const [from,to] of [["staff","people"],["accounts","staff"]]){
      const dataset=(key:string)=>app.snapshots.datasets().find(d=>d.content.sourceId===w.sources[key].id)!.id;
      const {change}=await app.changes.propose({operationId:`relation-${from}`,origin:"human",type:"relation",baseline:app.changes.currentBaseline(),subject:{from:{datasetId:dataset(from),column:"email"},to:{datasetId:dataset(to),column:"email"}}});
      const checked=await app.changes.verify({operationId:`check-${from}`,...ref(change)});
      assert.equal(checked.status,"verified");verified.push(checked);
    }
    const before=app.workspaceVersions.list().length;
    const result=await app.changes.batchAdopt({operationId:"relations",items:verified.map(ref),acknowledgeReview:true});
    assert.equal(app.workspaceVersions.list().length,before+1);
    const modelRef=(result.changes[0].content.effect as Data).modelRef as {id:string;version:number};
    const model=app.live.projectModel(app.memory.getArtifact(modelRef.id,modelRef.version));
    assert.equal((model.content.relations as Data[]).length,2);
    for(const [type,id,target] of [["外部人员","H1","P1"],["账号","A1","H1"]]){
      const relation=(model.content.relations as Data[]).find(r=>r.from===type)!;
      assert.equal((await app.live.query({modelId:model.id,type,id,relation:String(relation.name)})).items[0].$id,target);
    }
  }finally{await w.close();}
});

test("independent record identity decisions can be adopted together without replacing each other",async()=>{
  const w=await identityWorkspace();try{
    const left=w.binding("account"),right=w.binding("person"),app=w.service.app;
    const adopted=await w.adopt("identity_rule",{kind:"belongs_to",left:{bindingId:left,columns:["email"]},right:{bindingId:right,columns:["email"]},relationName:"归属",reason:"账号与人员不同",evidence:"管理员核对"});
    const ruleId=(adopted.content.effect as Data).ruleId,verified:Artifact[]=[];
    for(const [id,target] of [["ci-bot",null],["A2","P2"]]){
      const {change}=await app.changes.propose({operationId:`identity-${id}`,origin:"human",type:"identity_decision",baseline:app.changes.currentBaseline(),subject:{ruleId,left:{bindingId:left,recordId:id},right:target?{bindingId:right,recordId:target}:null,decision:target?"match":"no_match",reason:"人工核对",evidence:"登记记录"}});
      verified.push(await app.changes.verify({operationId:`check-${id}`,...ref(change)}));
    }
    const before=app.workspaceVersions.list().length;
    const args={operationId:"identity-batch",items:verified.map(ref)};
    const adoptedBatch=await w.call("/api/changes/batch-adopt",args);
    assert.equal(adoptedBatch.status,200,JSON.stringify(adoptedBatch.body));
    const result=adoptedBatch.body as {changes:Artifact[]};
    assert.equal(app.workspaceVersions.list().length,before+1);
    assert.deepEqual(result.changes.map(c=>c.status),["adopted","adopted"]);
    assert.deepEqual((await app.live.query({modelId:w.model.id,type:"账号",id:"ci-bot",relation:"归属"})).items,[]);
    assert.equal((await app.live.query({modelId:w.model.id,type:"账号",id:"A2",relation:"归属"})).items[0].$id,"P2");
    assert.deepEqual((await w.call("/api/changes/batch-adopt",args)).body,result);
    assert.equal((await w.call("/api/changes/batch-reject",{operationId:"reject-adopted",items:verified.map(ref),reason:"迟到拒绝"})).status,409);
  }finally{await w.close();}
});

test("independent local corrections share one batch transaction and working version",async()=>{
  const w=await identityWorkspace();try{
    const app=w.service.app;
    await w.adopt("identity_rule",{kind:"belongs_to",left:{bindingId:w.binding("account"),columns:["email"]},right:{bindingId:w.binding("person"),columns:["email"]},relationName:"归属",reason:"独立账号",evidence:"人员名册"});
    const verified:Artifact[]=[];
    for(const objectId of ["A1","ci-bot"]){
      const p=await w.call("/api/live/corrections/propose",{operationId:`p-${objectId}`,target:{modelId:w.model.id,modelVersion:w.model.version,type:"账号",objectId,relation:"归属"},targetIds:[],reason:"错误关系",evidence:"核对登记"});
      assert.equal(p.status,200,JSON.stringify(p.body));
      const tracked=app.changes.list({type:"local_correction"}).changes.find(change=>(change.owner as Data)?.id===p.body.saved.id)!;
      const checked=await app.changes.verify({operationId:`v-${objectId}`,id:tracked.id,version:tracked.version});assert.equal(checked.status,"verified");verified.push(checked);
    }
    const before=app.workspaceVersions.list().length;
    const result=await app.changes.batchAdopt({operationId:"corrections",items:verified.map(ref)});
    assert.deepEqual(result.changes.map(change=>change.status),["adopted","adopted"]);
    assert.equal(app.workspaceVersions.list().length,before+1);
    for(const id of ["A1","ci-bot"])assert.deepEqual((await app.live.query({modelId:w.model.id,type:"账号",id,relation:"归属"})).items,[]);
  }finally{await w.close();}
});

test("overlapping or jointly duplicate naming edits leave every decision and the workspace untouched",async()=>{
  const f=await fixture();try{
    const a=await f.proposal("naming",{target:"concept",id:"person",name:"新名称"});
    const b=await f.proposal("naming",{target:"concept",id:"team",name:"新名称"});
    const duplicate=await f.proposal("naming",{target:"concept",id:"person",name:"第二名称"});
    const before=f.app.workspaceVersions.list();
    for(const items of [[a,b],[a,duplicate]])await assert.rejects(f.app.changes.batchAdopt({operationId:`conflict-${items[1].id}`,items:items.map(ref)}),/重复|同一对象/);
    assert.equal((f.app.foundation.read().adopted!.content.concepts as Data[])[0].name,"人员");
    assert.deepEqual([a,b,duplicate].map(item=>f.app.changes.read(item.id).status),["verified","verified","verified"]);
    assert.deepEqual(f.app.workspaceVersions.list(),before);
  }finally{await f.close();}
});

test("batch rejection accepts stale proposals, requires one category and replays exact results",async()=>{
  const f=await fixture();try{
    const a=await f.proposal("naming",{target:"concept",id:"person",name:"员工"}),b=await f.proposal("description",{target:"concept",id:"team",description:"待拒绝说明"});
    const other=await f.proposal("description",{target:"concept",id:"person",description:"已采用的新说明"});
    const relation=await f.app.changes.propose({operationId:"relation",type:"relation",origin:"human",baseline:f.app.changes.currentBaseline(),subject:{from:{datasetId:"a",column:"id"},to:{datasetId:"b",column:"id"}}});
    assert.throws(()=>f.app.changes.batchReject({operationId:"mixed",items:[ref(a),ref(relation.change)],reason:"混合类别"}),/同一类别/);
    await f.app.changes.adopt({operationId:"advance",...ref(other)});
    const before=f.app.workspaceVersions.list();
    const args={operationId:"reject-stale",items:[ref(a),ref(b)],reason:"已经由其他事项解决"};
    assert.throws(()=>f.app.changes.batchReject({...args,reason:""}));
    const result=f.app.changes.batchReject(args);
    assert.deepEqual(result.changes.map(item=>item.status),["rejected","rejected"]);
    assert.ok(result.changes.every(item=>item.content.closedReason===args.reason));
    assert.deepEqual(f.app.changes.batchReject(args),result);
    assert.throws(()=>f.app.changes.batchReject({...args,reason:"不同请求"}),/幂等/);
    assert.deepEqual(f.app.workspaceVersions.list(),before);
  }finally{await f.close();}
});

test("one outdated item prevents a batch rejection from deciding any other item",async()=>{
  const f=await fixture();try{
    const a=await f.proposal("naming",{target:"concept",id:"person",name:"员工"}),b=await f.proposal("description",{target:"concept",id:"team",description:"新团队说明"});
    await f.app.changes.verify({operationId:"recheck",...ref(b)});
    assert.throws(()=>f.app.changes.batchReject({operationId:"outdated",items:[ref(a),ref(b)],reason:"拒绝整批"}),/版本已变化/);
    assert.equal(f.app.changes.read(a.id).status,"verified");
    assert.equal(f.app.changes.read(b.id).status,"verified");
  }finally{await f.close();}
});

test("separate discoveries from one program candidate are compiled together in one batch",async()=>{
  const f=await fixture(false);try{
    const files=new Workspace(f.app.memory);
    files.upload("companies.csv","company_id,label\nC1,企业\n");
    await f.app.programBuilds.build({operationId:"base",autoAdopt:true});
    files.upload("products.csv","product_id,label\nP1,产品\n");files.upload("teams.csv","team_id,label\nT1,团队\n");
    await f.app.programBuilds.build({operationId:"discover",autoAdopt:true});
    const pending=f.app.changes.list({type:"entity",status:"proposed"}).changes.filter(c=>c.origin==="program");
    assert.equal(pending.length,2);
    const verified:Artifact[]=[];for(const item of pending)verified.push(await f.app.changes.verify({operationId:`check-${item.id}`,...ref(f.app.changes.read(item.id))}));
    const before=f.app.workspaceVersions.list().length;
    const result=await f.app.changes.batchAdopt({operationId:"program-batch",items:verified.map(ref)});
    assert.deepEqual(result.changes.map(c=>c.status),["adopted","adopted"]);
    assert.equal(f.app.workspaceVersions.list().length,before+1);
    const model=f.app.memory.listArtifacts("live_ontology").find(m=>m.status==="adopted")!;
    const projected=f.app.live.projectModel(model);
    for(const [cap,id] of [["products","P1"],["teams","T1"]]){
      const type=(projected.content.types as Data[]).find(type=>String(type.name).toLowerCase().includes(cap.slice(0,-1)))!;
      assert.ok(type,JSON.stringify(projected.content.types));
      assert.equal((await f.app.live.query({modelId:model.id,type:String(type.name),id})).items.length,1);
    }
  }finally{await f.close();}
});

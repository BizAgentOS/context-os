import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createServer} from "../../src/agent/server.ts";
import {FeishuConnector} from "../../src/connectors/feishu.ts";
import {TableCli,connected} from "./feishu-tables-fixture.ts";

test("selected Feishu tables synchronize every page with mapped values and build executable objects",{timeout:25000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),"ade-feishu-tables-")),service=await createServer({directory,automaticApi:false}),cli=new TableCli(),connector=new FeishuConnector(directory,cli),app=service.app;
  try{
    await connected(connector);const tables=app.live.sources.attachFeishu(connector),url="https://team.feishu.cn/base/base_test";
    const listing=await tables.browse({url});assert.deepEqual(listing.tables.map(item=>item.name),["人员"]);assert.equal(listing.coverage.complete,true);
    const selected=await tables.select({operationId:"select-people",url,tableIds:["tbl_people"]}),source=selected.sources[0];
    assert.equal(source.content.adapter,"feishu");
    assert.equal((await tables.select({operationId:"select-people",url,tableIds:["tbl_people"]})).sources[0].id,source.id);
    const result=await app.snapshots.sync({operationId:"sync-people",sourceIds:[source.id]});assert.equal(result.status,"completed",JSON.stringify(result));
    const dataset=app.snapshots.datasets().find(item=>item.content.sourceId===source.id)!;
    assert.equal(dataset.content.profile&& (dataset.content.profile as any).rows,205);assert.equal((dataset.content.coverage as any).complete,true);
    const sample=await app.snapshots.preview({datasetId:dataset.id,offset:204,limit:1});assert.equal(sample.rows[0].record_id,"rec_204");assert.equal(Number(sample.rows[0].积分),204);assert.equal(sample.rows[0].在职,true);assert.equal(sample.rows[0].标签,'["正式"]');
    const job=await app.programBuilds.build({operationId:"build-people",autoAdopt:true});assert.equal(job.content.outcome,"adopted",JSON.stringify(job));
    const model=app.memory.listArtifacts("live_ontology").find(item=>item.status==="adopted")!;const type=(model.content.types as any[])[0];const object=await app.live.query({modelId:model.id,type:type.name,id:"rec_204"});assert.equal(object.items.length,1);
    assert(cli.calls.filter(args=>args.includes("+record-list")).some(args=>args.includes("200")),"the final page really was requested");
    assert(!cli.calls.some(args=>args.some(arg=>/\+(?:create|update|delete)|--as=bot/.test(arg))));
  }finally{await connector.close();await service.close();rmSync(directory,{recursive:true,force:true});}
});

test("table access requires its own readonly scopes and disconnect revokes saved table reads",{timeout:15000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),"ade-feishu-permissions-")),service=await createServer({directory,automaticApi:false}),cli=new TableCli(),connector=new FeishuConnector(directory,cli),app=service.app;
  try{
    cli.scopes="docx:document:readonly";await connected(connector);const tables=app.live.sources.attachFeishu(connector),url="https://team.feishu.cn/base/base_test";
    await assert.rejects(tables.browse({url}),/表格只读权限/);assert.equal(connector.status().account?.tablesAuthorized,false);
    const profile=cli.profile;connector.authorizeTables();for(let i=0;i<100&&connector.status().job?.phase!=="connected";i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(connector.status().account?.tablesAuthorized,true);assert.equal(cli.profile,profile);assert.equal(cli.calls.filter(args=>args[0]==="config").length,1,"scope upgrade retains the same ADE-owned account");
    const source=(await tables.select({operationId:"select",url,tableIds:["tbl_people"]})).sources[0];
    const item=await app.live.sources.readRecords(source.id,"records",{record_id:"rec_204"},0,1);assert.equal(item.items[0].record_id,"rec_204");
    await app.snapshots.sync({operationId:"baseline",sourceIds:[source.id]});
    let release!:()=>void;cli.gate=new Promise(resolve=>{release=resolve;});
    const late=app.live.sources.readRecords(source.id,"records",{},0,3);await new Promise(resolve=>setImmediate(resolve));
    await connector.disconnect();release();await assert.rejects(late,/断开|停用/);assert.equal(app.memory.getArtifact(source.id).status,"disabled");
    assert.throws(()=>app.live.sources.pinnedCapability(source.id,"records",source.version),/停用|断开/);
    const serialized=JSON.stringify(app.memory.listArtifacts());assert(!serialized.includes(cli.profile));assert(!serialized.includes(cli.openId));assert.doesNotMatch(serialized,/appSecret|access_token/);
  }finally{await connector.close();await service.close();rmSync(directory,{recursive:true,force:true});}
});

test("table links cannot silently widen a view and changed identities cannot reuse another account's selection",{timeout:15000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),"ade-feishu-scope-")),service=await createServer({directory,automaticApi:false}),cli=new TableCli(),connector=new FeishuConnector(directory,cli),app=service.app;
  try{
    await connected(connector);const tables=app.live.sources.attachFeishu(connector),url="https://team.feishu.cn/base/base_test";
    for(const rejected of [url+"?view=vew_private",url+"?token=secret","https://evil.example/base/base_test"])await assert.rejects(tables.browse({url:rejected}),/链接|视图|参数/);
    assert(!cli.calls.some(args=>args.includes("+table-list")));
    cli.openId="ou_other_user";await assert.rejects(tables.select({operationId:"other-account",url,tableIds:["tbl_people"]}),/账号已变化/);
    assert.equal(app.live.sources.list().length,0);
  }finally{await connector.close();await service.close();rmSync(directory,{recursive:true,force:true});}
});

test("a changing remote revision cannot become a mixed snapshot and a later sync restarts cleanly",{timeout:20000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),"ade-feishu-revision-")),service=await createServer({directory,automaticApi:false}),cli=new TableCli(),connector=new FeishuConnector(directory,cli),app=service.app;
  try{
    await connected(connector);const tables=app.live.sources.attachFeishu(connector),source=(await tables.select({operationId:"select",url:"https://team.feishu.cn/base/base_test",tableIds:["tbl_people"]})).sources[0];
    await app.snapshots.sync({operationId:"baseline",sourceIds:[source.id]});const old=app.snapshots.datasets()[0].content.activeVersion;
    cli.changedAtOffset=100;
    const changed=await app.snapshots.sync({operationId:"changed",sourceIds:[source.id]});assert.equal(changed.content.outcome,"needs_attention");assert.equal(app.snapshots.datasets()[0].content.activeVersion,old);
    cli.rev=9;cli.changedAtOffset=null;cli.rows[0].姓名="更新后的甲";
    const retried=await app.snapshots.sync({operationId:"retried",sourceIds:[source.id]});assert.equal(retried.content.outcome,"synced",JSON.stringify(retried));
    const dataset=app.snapshots.datasets()[0];assert.notEqual(dataset.content.activeVersion,old);assert.equal((await app.snapshots.preview({datasetId:dataset.id,limit:1})).rows[0].姓名,"更新后的甲");
  }finally{await connector.close();await service.close();rmSync(directory,{recursive:true,force:true});}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AddressInfo} from 'node:net';
import {createHeatingDemo} from '../../src/demo/server.ts';
import {createServer} from '../../src/agent/server.ts';
import {Workspace} from '../../src/agent/workspace.ts';

test('published HTTP access remains scoped, pinned and revocable after retired contracts disappear',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'dataengine-agent-connection-')),fixture=await createHeatingDemo(directory);
 await fixture.close();
 // Reopen the prepared content as a normal workspace: the demo host intentionally simulates writes.
 const service=await createServer({directory,automaticApi:false});
 try{
  await new Promise<void>(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const admin=async(path:string,body?:object)=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'X-DataEngine-Token':service.adminToken,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json() as any;assert.equal(response.status,200,JSON.stringify(data));return data;};
  const overview=await admin('/api/releases'),release=overview.releases[0],definition=release.content.definition,concepts=definition.concepts.filter((item:any)=>['投诉','回访'].includes(item.name)),relation=definition.relations.find((item:any)=>item.name==='居民回访');
  const active=await admin('/api/releases/connect',{operationId:'http-consumer',name:'独立第三方 Agent',purpose:'读取固定投诉和回访证据',releaseRef:{id:release.id,version:release.version},conceptIds:concepts.map((item:any)=>item.id),relationIds:[relation.id],business:{grants:[{type:'投诉',fields:['$id','处理状态'],relations:['居民回访']},{type:'回访',fields:['$id','投诉编号','反馈结果'],relations:[]}]}});
  const configPath='/api/releases/connection?'+new URLSearchParams({id:active.connection.id,version:String(active.connection.version)});
  assert.equal((await fetch(base+configPath)).status,403);const config=await admin(configPath),transport=Object.values(config.mcp.mcpServers)[0] as any;
  assert.equal(transport.env.DATAENGINE_URL,base);assert(!JSON.stringify(config).includes(active.key));assert(!JSON.stringify(config).includes(service.adminToken));assert.equal(config.localOnly,true);
  const read=async(path:string,params:Record<string,string>={})=>{const response=await fetch(`${base}${path}?${new URLSearchParams(params)}`,{headers:{Authorization:`Bearer ${active.key}`}});return{status:response.status,body:await response.json() as any};};
  const schema=await read('/v4/dataset');assert.equal(schema.status,200);assert.equal(schema.body.releaseRef.id,release.id);assert(!JSON.stringify(schema.body).includes('联系手机'));assert(!JSON.stringify(schema.body).includes('sourceId'));
  assert.equal((await fetch(base+configPath,{headers:{Authorization:`Bearer ${active.key}`}})).status,403);
  const args={type:'投诉',id:'TS002',relation:'居民回访',fields:'$id,反馈结果'},before=await read('/v4/objects',args);assert.equal(before.body.items[0].properties.反馈结果.value,'未改善');
  assert.equal((await read('/v4/objects',{type:'投诉',id:'TS002',fields:'$id,联系手机'})).status,403);
  const source=service.app.memory.listArtifacts('source').find(item=>item.title==='客服回访.csv')!,changed=new Workspace(service.app.memory).upload(source.title,String(source.content.raw).replace('未改善','已改善').replace('居民反馈过滤器清理后室内仍偏冷','居民确认室温恢复'));assert.equal(changed.id,source.id);
  assert.equal((await read('/v4/objects',args)).body.items[0].properties.反馈结果.value,'未改善','uploaded changes cannot mutate an existing pinned release');
  const historical=service.app.memory.listArtifacts('ontology').find(item=>item.status==='adopted')!,original=service.app.objectDetails(new URLSearchParams({artifactId:historical.id,version:String(historical.version),type:'回访',id:'HF002'}));assert.equal((original.result as any).fields.反馈结果,'未改善','historical audit retains the exact original source version');
  for(const path of ['/v1/schema','/v2/schema','/v3/catalog'])assert.equal((await read(path)).status,410);
  await admin('/api/releases/revoke',{operationId:'http-revoke',connectionRef:{id:active.connection.id,version:active.connection.version}});
  assert.equal((await read('/v4/dataset')).status,403);assert.equal((await read('/v4/objects',args)).status,403);
  assert(!JSON.stringify((await admin('/api/releases/connection-detail?'+new URLSearchParams({id:active.connection.id,version:String(active.connection.version+1)}))).usage).includes(active.key));
 }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});

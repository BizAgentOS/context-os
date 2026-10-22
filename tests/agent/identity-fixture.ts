import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as httpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";
import type { Artifact, Data } from "../../src/agent/contracts.ts";
export const ref = (a: { id:string;version:number }) => ({id:a.id,version:a.version});
export async function identityWorkspace() {
  const directory=mkdtempSync(join(tmpdir(),'context-os-identities-'));
  const rows: Record<string,Data[]> = {
    people:[{id:'P1',email:'alice@example.test',name:'甲'},{id:'P2',email:'bob@example.test',name:'乙'}],
    accounts:[{id:'A1',email:'alice@example.test',username:'alice'},{id:'A2',email:'old@example.test',username:'bob'},{id:'ci-bot',email:'alice@example.test',username:'ci-bot'}],
    staff:[{id:'H1',email:'alice@example.test',phone:'10001'},{id:'H2',email:'bob@example.test',phone:'10002'}],
  };
  const upstream=httpServer((request,response)=>{
    const url=new URL(request.url!,'http://localhost'), all=rows[url.pathname.slice(1)] ?? [];
    const filtered=all.filter(row=>[...url.searchParams].every(([key,value])=>['offset','limit'].includes(key)||String(row[key])===value));
    const offset=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit')??20);
    response.setHeader('Content-Type','application/json');response.end(JSON.stringify({items:filtered.slice(offset,offset+limit),total:filtered.length}));
  });
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const service=await createServer({directory,automaticApi:false});
  await new Promise<void>(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const address=`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const sources:Record<string,Artifact>={};
  try {
  for(const [key,data] of Object.entries(rows)) sources[key]=await service.app.live.sources.connect({name:key,protocol:'http',url:address,capabilities:[{
    name:key,path:'/'+key,fields:Object.keys(data[0]),idField:'id',totalPath:'total',filters:Object.fromEntries(Object.keys(data[0]).map(key=>[key,key])),
  }]});
  const foundation=seedFoundation(service.app.memory,service.app.foundation,{enterprise:'身份对应实验',concepts:[{id:'person',name:'人员',description:'在职人员'},{id:'account',name:'账号',description:'系统账号，包含机器人'},{id:'staff',name:'外部人员',description:'同一批人员的通讯资料'}]});
  await service.app.snapshots.sync({operationId:'initial'});
  const candidate=await service.app.live.propose({purpose:'三个来源独立实体',rationale:'身份只能明确采用',foundationRef:ref(foundation),baseModelRef:null,types:[
    {conceptId:'person',name:'人员',description:'在职人员',sourceId:sources.people.id,capability:'people',fields:{邮箱:'email',姓名:'name'}},
    {conceptId:'account',name:'账号',description:'系统账号，包含机器人',sourceId:sources.accounts.id,capability:'accounts',fields:{邮箱:'email',用户名:'username'}},
    {conceptId:'staff',name:'外部人员',description:'同一批人员的通讯资料',sourceId:sources.staff.id,capability:'staff',fields:{邮箱:'email',电话:'phone'}},
  ],relations:[]});
  let model=await service.app.live.adopt(candidate.id,candidate.version);
  const base=`http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const call=async(path:string,body?:unknown)=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-ContextOS-Token':service.adminToken},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json() as any};};
  let n=0;
  const adopt=async(type:string,subject:Data)=>{
    const id=String(++n),p=await call('/api/changes/propose',{operationId:'p'+id,origin:'human',type,baseline:service.app.changes.currentBaseline(),subject});
    if(p.status!==201) throw new Error(JSON.stringify(p));
    const v=await call('/api/changes/verify',{operationId:'v'+id,...ref(p.body.change)});
    if(v.body.change?.status!=='verified') throw new Error(JSON.stringify(v));
    const a=await call('/api/changes/adopt',{operationId:'a'+id,...ref(v.body.change),acknowledgeReview:true});
    if(a.status!==200)throw new Error(JSON.stringify(a));
    model=service.app.memory.listArtifacts('live_ontology').find(a=>a.status==='adopted')!;
    return a.body.change as Artifact;
  };
  const binding=(conceptId:string)=>service.app.live.readLayered(model.id).bindings.entities.find(b=>b.entityTypeId===conceptId&&b.role==='primary')!.id;
  return {service,call,rows,sources,binding,adopt,get model(){return model;},async close(){await service.close();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});}};
  } catch(error) { await service.close(); upstream.closeAllConnections(); await new Promise<void>(resolve=>upstream.close(()=>resolve())); rmSync(directory,{recursive:true,force:true}); throw error; }
}

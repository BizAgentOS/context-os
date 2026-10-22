import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../../src/agent/server.ts';

test('local accounts establish their own management sessions and every domain write obeys role permissions',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-role-host-')),service=await createServer({directory:root,automaticApi:false,driver:{async run(){return{text:'已核对',runId:'role-fixture-run',sessionId:'role-fixture-session'};},async stop(){},async close(){}}});await new Promise<void>(resolve=>service.server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(service.server.address() as {port:number}).port}`;
 const request=async(path:string,token?:string,body?:unknown)=>{const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{...(token?{'X-DataEngine-Token':token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,body:await response.json() as any};};
 try{
  const create=async(username:string,role:string)=>{const result=await request('/api/users/create',service.adminToken,{operationId:'create-'+username,username,name:username,password:'synthetic-local-password',role});assert.equal(result.status,200);return result.body.user;};
  const viewer=await create('viewer','viewer'),maintainer=await create('maintainer','maintainer');
  const login=async(username:string)=>{const result=await request('/api/auth/login',undefined,{username,password:'synthetic-local-password'});assert.equal(result.status,200);return result.body.token as string;};
  const viewToken=await login('viewer'),maintainToken=await login('maintainer');
  const boot=await request('/api/canvas/bootstrap',viewToken);assert.equal(boot.status,200);assert.equal(boot.body.actor.id,viewer.id);assert.equal(boot.body.actor.role,'viewer');assert.equal(boot.body.token,viewToken);assert.notEqual(boot.body.token,service.adminToken);
  for(const path of ['/api/settings','/api/releases/check','/api/releases/connect','/api/changes/propose','/api/backup','/api/sources/manage','/api/users/create'])assert.equal((await request(path,viewToken,{})).status,403,path);
  assert.equal((await request('/api/canvas/message',viewToken,{page:'setup',messageId:'viewer-build',text:'修改业务定义',mode:'build'})).status,403);
  assert.equal((await request('/api/users',viewToken)).status,403);
  assert.equal((await request('/api/artifacts/'+viewer.id,viewToken)).status,403,'management objects cannot bypass role checks through generic artifact reads');
  for(const path of ['/api/settings','/api/releases/check','/api/releases/connect','/api/users/create'])assert.equal((await request(path,maintainToken,{})).status,403,path);
  const uploaded=await request('/api/canvas/upload',maintainToken,{page:'setup',name:'维护者资料.md',content:'维护者接入的业务资料。'});assert.equal(uploaded.status,200,JSON.stringify(uploaded.body));
  const saved=service.app.memory.listArtifacts('source')[0];assert.equal(saved.actor?.id,maintainer.id);assert.equal(saved.actor?.role,'maintainer');
  const session=await request('/api/sessions',viewToken,{title:'只读问答'});assert.equal(session.status,201);
  const answer=await request('/api/canvas/message',viewToken,{page:'ontology',sessionId:session.body.session.id,messageId:'viewer-qa',text:'查看当前实体定义',mode:'qa',dataView:{kind:'working'}});assert.equal(answer.status,202);
  assert.equal((await request('/api/usage',viewToken)).status,200);
  assert.equal((await request('/api/auth/logout',viewToken,{})).status,200);assert.equal((await request('/api/canvas/bootstrap',viewToken)).status,403);
  const invalidated=await request('/api/users/update',service.adminToken,{id:maintainer.id,version:maintainer.version,operationId:'disable-maintainer',enabled:false});assert.equal(invalidated.status,200);assert.equal((await request('/api/canvas/bootstrap',maintainToken)).status,403);
  assert((await request('/api/audit',service.adminToken)).body.items.some((item:any)=>item.content.target.id===saved.id));
 }finally{await service.close();rmSync(root,{recursive:true,force:true,maxRetries:3});}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {openDatabase} from '../../src/knowledge/database.ts';
import {createKnowledgeServer} from '../../src/knowledge/server.ts';
import {CredentialVault} from '../../src/security/credential-vault.ts';
import {KnowledgeJobs} from '../../src/knowledge/jobs.ts';
import type {JsonModel} from '../../src/knowledge/model.ts';
const pg=process.env.CONTEXT_OS_KNOWLEDGE_TEST_DATABASE_URL,mysql=process.env.CONTEXT_OS_KNOWLEDGE_TEST_MYSQL_URL;
test('HTTP connection starts native capture, discovery and draft-plan analysis before a single publication decision', {skip:!pg||!mysql},async()=>{
 const db=await openDatabase(pg!),root=await mkdtemp(join(tmpdir(),'knowledge-connected-http-'));let owns=false,ownsRemote=false,app:Awaited<ReturnType<typeof createKnowledgeServer>>|undefined;
 const remote=await (await import('mysql2/promise')).createConnection(mysql!);let calls=0;
 try{
  assert.equal((await db.pool.query("SELECT 1 FROM pg_namespace WHERE nspname='knowledge'")).rows.length,0);await db.initialize();owns=true;
  await remote.query("CREATE TABLE http_contracts (id varchar(30) PRIMARY KEY, amount decimal(20,2)) ENGINE=InnoDB COMMENT='合同'");ownsRemote=true;await remote.query("INSERT INTO http_contracts VALUES ('C1',100.00)");
  const model:JsonModel={identity:'fixture',async close(){},async generate(task,raw){calls++;const input=raw as any;
   if(task==='discover')return {name:'合同',types:[{id:'Contract',name:'合同',properties:[{id:'amount',name:'金额',valueType:'decimal'}]}],links:[],evidenceReferences:[{memberId:'amount',evidenceIds:[input.evidenceCatalog.find((e:any)=>e.field==='amount').evidenceId]}]};
   assert.equal(task,'plan');return {csv:input.sources.map((s:any)=>({sourceVersionId:s.id,objects:[{id:'c',typeId:'Contract',identityColumn:'id'}],properties:[{id:'a',object:'c',predicate:'amount',column:'amount'}],links:[]}))};
  }};
  const admin='a'.repeat(40),editor='e'.repeat(40),viewer='v'.repeat(40);
  app=await createKnowledgeServer({db,directory:root,worker:false,model,vault:new CredentialVault(join(root,'credentials'),{keyDirectory:join(root,'keys'),keychain:null}),principals:[{id:'admin',role:'admin',token:admin},{id:'editor',role:'editor',token:editor},{id:'viewer',role:'viewer',token:viewer}]});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const call=async(path:string,data?:unknown,token=admin)=>{const r=await fetch(base+path,{method:data===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:r.status,body:await r.json() as any};};
  const input={operationId:'connect-http',name:'合同库',config:{url:mysql},tables:['http_contracts']};
  assert.equal((await call('/api/connections',input,viewer)).status,403);
  const connected=await call('/api/connections',input);assert.equal(connected.status,200);
  const sync=await call(`/api/connections/${connected.body.id}/sync`,{operationId:'sync-http',construct:true});assert.equal(sync.status,202);
  for(let i=0;i<3;i++)await app.jobs.once();
  const persisted=(await db.pool.query("SELECT kind,result FROM knowledge.jobs WHERE state='completed' ORDER BY created_at")).rows;
  assert.ok(persisted.find(j=>j.kind==='discover')!.result.nextJobId,'discovery output persists its next job');
  const packageId=persisted.find(j=>j.kind==='plan')!.result.decisionPackageId;assert.ok(packageId);
  assert.equal((await call(`/api/decision-packages/${packageId}`)).body.state,'preparing');
  // A new worker without any model configuration resumes the durable local collection step.
  await new KnowledgeJobs(app.core).once();assert.equal(calls,2);
  const state=await call('/api/state');assert.equal(calls,2);assert.equal(state.body.objects.length,0);assert.equal(state.body.decisionPackages.length,1);
  assert.ok(!JSON.stringify(state.body).includes('local-autonomy-test-only'));
  const pack=(await call(`/api/decision-packages/${state.body.decisionPackages[0].id}`)).body;
  assert.equal(pack.summary.ontologyStatus,'draft');assert.equal(pack.summary.ontologyIssues.length,1);
  const payload={expectedRevision:pack.revision,candidateHash:pack.summary.candidateHash,reason:'确认本次合同业务范围'};
  assert.equal((await call(`/api/decision-packages/${pack.id}/submit`,payload,editor)).status,403);
  const built=await call(`/api/decision-packages/${pack.id}/submit`,payload);assert.equal(built.status,200,JSON.stringify(built.body));assert.equal(built.body.state,'built');assert.equal(calls,2);
  await call(`/api/connections/${connected.body.id}/sync`,{operationId:'sync-no-change',construct:true});await app.jobs.once();await app.jobs.once();assert.equal(calls,2,'unchanged capture creates no discovery model request');
 }finally{
  if(ownsRemote)await remote.query('DROP TABLE http_contracts');await remote.end();
  if(app){await app.jobs.close();await new Promise<void>(resolve=>app!.server.close(()=>resolve()));}
  if(owns){await db.pool.query('DROP SCHEMA knowledge CASCADE');await db.pool.query('DELETE FROM knowledge_schema_versions WHERE version BETWEEN 1 AND 6');}await db.close();await rm(root,{recursive:true,force:true});
 }
});

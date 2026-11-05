import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../../src/knowledge/database.ts';
import {KnowledgeCore} from '../../src/knowledge/service.ts';
import {BuildPlans} from '../../src/knowledge/build-plans.ts';
import {KnowledgeJobs} from '../../src/knowledge/jobs.ts';
import {ConnectedSources} from '../../src/knowledge/connected-sources.ts';
import {CredentialVault} from '../../src/security/credential-vault.ts';
import type {JsonModel} from '../../src/knowledge/model.ts';

const pg=process.env.CONTEXT_OS_KNOWLEDGE_TEST_DATABASE_URL,mysql=process.env.CONTEXT_OS_KNOWLEDGE_TEST_MYSQL_URL;
test('public jobs retry only invalid table discovery/mapping steps and retain one coordinated draft', {skip:!pg||!mysql},async()=>{
 const db=await openDatabase(pg!),root=await mkdtemp(join(tmpdir(),'structured-pipeline-'));
 const remote=await (await import('mysql2/promise')).createConnection(mysql!);
 const owned:string[]=[];let owns=false;const actor={id:'compiler-reviewer',role:'admin' as const};
 try{
  assert.equal((await db.pool.query("SELECT 1 FROM pg_namespace WHERE nspname='knowledge'")).rows.length,0);
  await db.initialize();owns=true;
  for(const name of ['compiler_a','compiler_b','compiler_deferred','compiler_technical','compiler_empty']){
   await remote.query(`CREATE TABLE ${name} (id varchar(20) PRIMARY KEY, amount decimal(20,2), bind_state int, create_time varchar(30)) ENGINE=InnoDB`);owned.push(name);
   if(name!=='compiler_empty')await remote.query(`INSERT INTO ${name} VALUES ('C1',100.00,1,'2026-06-18 22:40:41')`);
  }
  const core=new KnowledgeCore(db),connections=new ConnectedSources(core,new CredentialVault(join(root,'vault'),{keyDirectory:join(root,'keys'),keychain:null}));
  const connection=await connections.create(actor,{operationId:'compiler-connect',name:'编译夹具',config:{url:mysql},tables:owned});
  const ids:string[]=[];
  for(const table of owned)ids.push((await connections.capture(actor,connection.id,{operationId:`capture-${table}`,table,maxRows:10})).sourceVersionId);
  const calls=new Map<string,number>();
  const model:JsonModel={identity:'compiler-fixture',async close(){},async generate(task,raw){
   const input=raw as any,key=`${input.stage}:${input.sources[0].id}`,n=(calls.get(key)??0)+1;calls.set(key,n);
   if(task==='discover'){
    if(input.stage==='table'&&input.sources[0].id===ids[3])return {name:'技术表',types:[],links:[],evidenceReferences:[],disposition:'not_applicable',reason:'系统技术元数据，不属于当前业务建模范围'};
    if(input.stage==='table'&&input.sources[0].id===ids[2])return {name:'待定',types:[{id:'Ambiguous',name:'待定对象',properties:[{id:'unclearAmount',name:'指标',valueType:'decimal'}]}],links:[],evidenceReferences:[{memberId:'unclearAmount',evidenceIds:[input.evidenceCatalog.find((e:any)=>e.field==='amount').evidenceId]}],uncertainties:[{memberId:'Ambiguous',kind:'definition',question:'类型业务含义尚未明确'}]};
    const invalid=input.stage==='table'&&input.sources[0].id===ids[1]&&n===1;
    return {name:'合同',types:[{id:'Contract',name:'合同',properties:[{id:'amount',name:'金额',valueType:'decimal'},{id:'bind_state',name:'绑定状态',valueType:'enum',enumValues:['0','1']},{id:'createTime',name:'创建时间',valueType:'datetime'},{id:'enabled',name:'Enabled',valueType:'boolean'}]}],links:[],
     evidenceReferences:[{memberId:'amount',evidenceIds:[invalid?'invented':input.evidenceCatalog.find((e:any)=>e.field==='amount').evidenceId]},{memberId:'bind_state',evidenceIds:[input.evidenceCatalog.find((e:any)=>e.field==='bind_state').evidenceId]},{memberId:'createTime',evidenceIds:[input.evidenceCatalog.find((e:any)=>e.field==='create_time').evidenceId]},{memberId:'enabled',evidenceIds:[input.evidenceCatalog.find((e:any)=>e.field==='bind_state').evidenceId]}]};
   }
   assert.equal(input.stage,'table_mapping');
   return {csv:[{sourceVersionId:input.sources[0].id===ids[1]&&n===1?ids[0]:input.sources[0].id,
    objects:[{id:'c',typeId:'Contract',identityColumn:'id'}],properties:[{id:'a',object:'c',predicate:'amount',column:'amount'},{id:'flag',object:'c',predicate:'enabled',column:'bind_state',booleanEncoding:'zero_one'}],links:[]}]};
  }};
  const jobs=new KnowledgeJobs(core,model);
  const discover=await jobs.enqueue(actor,{kind:'discover',operationId:'compiler-discover',sourceVersionIds:ids,collectDecisions:true});
  await jobs.once();
  assert.equal((await core.list(actor,'jobs')).find(j=>j.id===discover.id)!.state,'failed');
  assert.equal((await core.list(actor,'ontologies')).length,0,'no partial per-table draft');
  await jobs.retry(actor,discover.id);await jobs.once();
  assert.equal(calls.get(`table:${ids[0]}`),1);assert.equal(calls.get(`table:${ids[1]}`),2);
  const drafts=await core.list(actor,'ontologies');
  assert.equal(drafts.length,1,'one coordinated draft');
  assert.equal(calls.has(`table:${ids[4]}`),false,'empty source does not buy an impossible discovery call');
  const draft=await core.ontology(actor,drafts[0].id);
  assert.equal(draft.definition.types[0].properties.find((p:any)=>p.id==='bind_state')!.valueType,'enum','business enum remains a draft proposal');
  assert.deepEqual(draft.discovery.validation.tableDecisions.slice(2).map((d:any)=>d.status),['deferred','not_applicable','no_evidence']);
  assert.equal(draft.discovery.validation.issues.filter((i:any)=>i.kind==='source_exclusion').length,3);
  assert.ok(draft.discovery.validation.tableProposals.some((p:any)=>p.sourceVersionId===ids[2]&&p.evidence.length),'deferred candidate and exact locators remain auditable');
  const dateIssue=draft.discovery.validation.issues.find((i:any)=>i.kind==='datetime_confirmation'&&i.memberId==='createTime');
  assert.ok(dateIssue,'text dates remain proposals and do not abort the remaining table analysis');
  assert.match(dateIssue.question,/create_time.*varchar/);
  await assert.rejects(core.reviewDiscovery(actor,draft.id,{expectedRevision:draft.revision,issueIds:draft.discovery.validation.issues.filter((i:any)=>i.id!==dateIssue.id).map((i:any)=>i.id),reason:'故意漏掉日期决定'}),/重大/);
  const constraint=draft.discovery.validation.issues.find((i:any)=>i.kind==='constraint_confirmation'&&i.memberId==='bind_state');
  assert.ok(constraint,'non-ENUM physical columns produce a concentrated decision rather than a failed discovery');
  assert.match(constraint.question,/0.*1/);
  await assert.rejects(core.reviewDiscovery(actor,draft.id,{expectedRevision:draft.revision,issueIds:draft.discovery.validation.issues.filter((i:any)=>i.id!==constraint.id).map((i:any)=>i.id),reason:'故意漏掉枚举决定'}),/重大|完整|全部/);
  const planJob=(await core.list(actor,'jobs')).find(j=>j.kind==='plan')!;
  await jobs.once();assert.equal((await core.list(actor,'jobs')).find(j=>j.id===planJob.id)!.state,'failed');
  await jobs.retry(actor,planJob.id);await jobs.once();
  assert.equal(calls.get(`table_mapping:${ids[0]}`),1);assert.equal(calls.get(`table_mapping:${ids[1]}`),2);
  const plans=new BuildPlans(core),listed=await plans.list(actor);
  assert.equal(listed.length,1);const saved=await plans.get(actor,listed[0].id);assert.equal(saved.proposal.csv.length,2);assert.equal(saved.proposal.skipped?.length,3);
  const preview=await plans.preflight(actor,saved.id,saved.revision);
  assert.equal(preview.preview!.events.filter(e=>e.kind==='source_exclusion').length,3);
  assert.ok(preview.preview!.events.some(e=>e.kind==='representation_policy'),'explicit zero-one mappings require a current event decision');
  assert.ok(preview.preview!.errors.some(e=>e.includes('重大构建事件')),'source omissions require an explicit current decision');
  assert.equal((await core.list(actor,'objects')).length,0,'analysis never partially builds official objects');
  await jobs.close();
 }finally{
  for(const name of owned)await remote.query(`DROP TABLE ${name}`);await remote.end();
  if(owns){await db.pool.query('DROP SCHEMA knowledge CASCADE');await db.pool.query('DELETE FROM knowledge_schema_versions WHERE version BETWEEN 1 AND 7');}
  await db.close();await rm(root,{recursive:true,force:true});
 }
});

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
import {retainedCoordination} from './coordination-fixture.ts';

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
   const input=raw as any,key=`${input.stage}:${input.sources?.[0]?.id??'global'}`,n=(calls.get(key)??0)+1;calls.set(key,n);
   if(task==='discover'){
    if(input.stage==='table'&&input.sources[0].id===ids[3])return {name:'技术表',types:[],links:[],disposition:'not_applicable',reason:'系统技术元数据，不属于当前业务建模范围'};
    if(input.stage==='table'&&input.sources[0].id===ids[2])return {name:'待定',types:[{id:'Ambiguous',name:'待定对象',properties:[{id:'unclearAmount',name:'指标',valueType:'decimal',sourceColumns:[{column:'amount'}]}],uncertainties:[{kind:'definition',question:'类型业务含义尚未明确'}]}],links:[]};
    const invalid=input.stage==='table'&&input.sources[0].id===ids[1]&&n===1;
    if(input.stage==='coordinate')return retainedCoordination(input);
    return {name:'合同',types:[{id:'Contract',name:'合同',properties:[
      {id:'amount',name:'金额',valueType:invalid?'invalid':'decimal',sourceColumns:[{column:'amount'}]},
      {id:'bind_state',name:'绑定状态',valueType:'enum',enumValues:['0','1'],sourceColumns:[{column:'bind_state'}]},
      {id:'createTime',name:'创建时间',valueType:'datetime',sourceColumns:[{column:'create_time'}]},
      {id:'enabled',name:'Enabled',valueType:'boolean',sourceColumns:[{column:'bind_state'}]}]}],links:[]};
   }
   assert.equal(input.stage,'table_mapping');
   return {csv:[{sourceVersionId:input.sources[0].id===ids[1]&&n===1?'invalid-wire-uuid':input.sources[0].id,
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
  assert.equal(draft.definition.types[0].properties.find((p:any)=>p.id==='bind_state')!.valueType,'integer','sample values do not create a closed business enum');
  assert.deepEqual(draft.discovery.validation.tableDecisions.slice(2).map((d:any)=>d.status),['deferred','not_applicable','no_evidence']);
  assert.equal(draft.discovery.validation.issues.filter((i:any)=>i.kind==='source_exclusion').length,0);
  assert.ok(draft.discovery.validation.tableProposals.some((p:any)=>p.sourceVersionId===ids[2]&&p.evidence.length),'deferred candidate and exact locators remain auditable');
  const dateIssue=draft.discovery.validation.issues.find((i:any)=>i.kind==='datetime_confirmation'&&i.memberId==='createTime');
  assert.ok(dateIssue,'text dates remain proposals and do not abort the remaining table analysis');
  assert.match(dateIssue.question,/create_time.*varchar/);
  await assert.rejects(core.reviewDiscovery(actor,draft.id,{expectedRevision:draft.revision,issueIds:draft.discovery.validation.issues.filter((i:any)=>i.id!==dateIssue.id).map((i:any)=>i.id),reason:'故意漏掉日期决定'}),/重大/);
  assert.equal(draft.discovery.validation.issues.some((i:any)=>i.kind==='constraint_confirmation'),false);
  const planJob=(await core.list(actor,'jobs')).find(j=>j.kind==='plan')!;
  await jobs.once();assert.equal((await core.list(actor,'jobs')).find(j=>j.id===planJob.id)!.state,'failed');
  await jobs.retry(actor,planJob.id);await jobs.once();
  assert.equal(calls.get(`table_mapping:${ids[0]}`),1);assert.equal(calls.get(`table_mapping:${ids[1]}`),2);
  const plans=new BuildPlans(core),listed=await plans.list(actor);
  assert.equal(listed.length,1);const saved=await plans.get(actor,listed[0].id);assert.equal(saved.proposal.csv.length,2);assert.equal(saved.proposal.skipped?.length,3);
  const preview=await plans.preflight(actor,saved.id,saved.revision);
  assert.equal(preview.preview!.events.filter(e=>e.kind==='source_exclusion').length,0);
  assert.ok(preview.preview!.events.some(e=>e.kind==='representation_policy'),'explicit zero-one mappings require a current event decision');
  assert.ok(preview.preview!.errors.some(e=>e.includes('重大构建事件')),'representation policy still requires a current decision');
  assert.equal((await core.list(actor,'objects')).length,0,'analysis never partially builds official objects');
  await jobs.close();
 }finally{
  for(const name of owned)await remote.query(`DROP TABLE ${name}`);await remote.end();
  if(owns){await db.pool.query('DROP SCHEMA knowledge CASCADE');await db.pool.query('DELETE FROM knowledge_schema_versions WHERE version BETWEEN 1 AND 7');}
  await db.close();await rm(root,{recursive:true,force:true});
 }
});

// No database or model provider: exercise the compiler's public staged boundary with local receipts.
test('staged compiler carries program-owned column evidence through coordination and preserves unbound proposals', async()=>{
 const {StructuredCompiler}=await import('../../src/knowledge/structured-compiler.ts');
 const {discoveryInput,validateDiscovery}=await import('../../src/knowledge/discovery.ts');
 const first={id:'00000000-0000-4000-8000-000000000001',kind:'table' as const,keyColumn:'id',columns:['id'],rows:[{id:'1'}],nativeValues:{'1':{id:'1'}},warnings:[],metadata:{name:'a',columns:[{name:'id',type:'integer'}]}};
 const second={...first,id:'00000000-0000-4000-8000-000000000002',metadata:{name:'b',columns:[{name:'id',type:'integer'}]}};
 const receipts=new Map<string,{fingerprint:string;result:unknown}>();
 const query=async(sql:string,values:unknown[]=[])=>{
  if(sql.startsWith('SELECT fingerprint'))return {rows:receipts.has(String(values[1]))?[receipts.get(String(values[1]))]:[]};
  if(sql.startsWith('INSERT INTO'))receipts.set(String(values[1]),{fingerprint:String(values[2]),result:JSON.parse(String(values[3]))});
  return {rows:[{id:'lease'}]};
 };
 const core={db:{pool:{query},transaction:async(run:(sql:unknown)=>Promise<unknown>)=>run({query})}} as unknown as KnowledgeCore;
 let calls=0;
 const compiler=new StructuredCompiler({core,job:{id:'fixture',leaseToken:'lease'},policy:{},cached(){},async generate(_stage,_task,raw){
  calls++;const input=raw as any;
  if(input.stage==='coordinate'){
   return retainedCoordination(input);
  }
  return {name:'业务对象',types:[{id:`Type${calls}`,name:'对象',properties:[
   {id:`bound${calls}`,name:'编号',valueType:'integer',sourceColumns:[{column:'id'}]},
   {id:`missing${calls}`,name:'待定',valueType:'string'}]}],links:[]};
 }});
 const result=await compiler.discover([first,second],null);
 const checked=validateDiscovery(result.raw,[first,second],result.catalog,null);
 assert.equal(calls,3,'one call per source plus coordination; no repair model calls');
 assert.ok(checked.definition.discoveryEvidence.some(e=>e.memberId==='bound1'&&e.locator.kind==='column'));
 assert.ok(checked.validation.deferred.some(d=>d.member.id==='missing1'));
 assert.equal(result.tableProposals.length,2,'coordination cannot erase the original candidates');
 assert.ok(receipts.has('coordinate'),'successful normalized validation permits a saved checkpoint');
 const id=discoveryInput([first],null).input.sources[0].sourceColumns![0].sourceColumnId;
 assert.ok(result.catalog.some(e=>e.id===id),'structural column IDs are not rewritten as per-table instance ids');
});


test('an unresolved column binding defers only its source and preserves later clear table discovery',async()=>{
 const {StructuredCompiler}=await import('../../src/knowledge/structured-compiler.ts');
 const {validateDiscovery}=await import('../../src/knowledge/discovery.ts');
 const make=(id:string)=>({id,kind:'table' as const,keyColumn:'id',columns:['id'],rows:[{id:'1'}],nativeValues:{'1':{id:'1'}},warnings:[],metadata:{name:id,columns:[{name:'id',type:'integer'}]}});
 const sources=[make('00000000-0000-4000-8000-000000000001'),make('00000000-0000-4000-8000-000000000002')];
 const query=async()=>({rows:[{id:'lease'}]});
 const core={db:{pool:{query:async(sql:string)=>sql.startsWith('SELECT fingerprint')?{rows:[]}:query()},transaction:async(run:(sql:unknown)=>Promise<unknown>)=>run({query})}} as unknown as KnowledgeCore;
 const compiler=new StructuredCompiler({core,job:{id:'fixture',leaseToken:'lease'},policy:{},cached(){},async generate(_stage,_task,raw){
  const input=raw as any;
  if(input.stage==='coordinate'){assert.equal(input.tableCandidates.length,2);return retainedCoordination(input);}
  const bad=input.sources[0].id===sources[0].id;
  return {name:'日志',types:[{id:bad?'Bad':'Good',name:'日志',uncertainties:bad?[{kind:'source_binding',question:'不存在的列：deleted_column'}]:[],properties:[{id:bad?'bad_id':'good_id',name:'编号',valueType:'integer',sourceColumns:[{column:bad?'deleted_column':'id'}]}]}],links:[]};
 }});
 const result=await compiler.discover(sources,null);
 assert.deepEqual(result.tableDecisions.map(d=>d.status),['candidate','candidate']);
 assert.equal(validateDiscovery(result.raw,sources,result.catalog,null).definition.types[0].id,'Good');
 assert.ok(JSON.stringify(result.tableProposals[0]).includes('deleted_column'),'unresolved binding content survives source isolation');
});

test('native compiler resolves physical dates and sample enums before generating business approvals',async()=>{
 const {StructuredCompiler}=await import('../../src/knowledge/structured-compiler.ts');
 const {validateDiscovery,discoverySourceOutcomes}=await import('../../src/knowledge/discovery.ts');
 const source={id:'00000000-0000-4000-8000-000000000001',kind:'table' as const,keyColumn:'id',columns:['id','created'],rows:[{id:'1',created:'2026-01-01 00:00:00'}],warnings:[],metadata:{name:'log',columns:[{name:'id',type:'integer',comment:'0禁用1启用'},{name:'created',type:'timestamp'}]}};
 const query=async(sql:string)=>({rows:sql.startsWith('SELECT fingerprint')?[]:[{id:'lease'}]});
 const core={db:{pool:{query},transaction:async(run:(sql:unknown)=>Promise<unknown>)=>run({query})}} as unknown as KnowledgeCore;
 const compiler=new StructuredCompiler({core,job:{id:'fixture',leaseToken:'lease'},policy:{},cached(){},async generate(_stage,_task,input:any){if(input.stage==='coordinate')return retainedCoordination(input);return {name:'日志',types:[{id:'Log',name:'日志',identityNamespaces:['shared'],properties:[
  {id:'id',name:'编号',valueType:'enum',enumValues:['1'],required:true,sourceColumns:[{column:'id'}]},
  {id:'created',name:'创建时间',valueType:'datetime',sourceColumns:[{column:'created'}],uncertainties:[{kind:'datetime_representation',question:'确认UTC读取时区'}]}
 ]}],links:[]};}});
 const staged=await compiler.discover([source],null),result=validateDiscovery(staged.raw,[source],staged.catalog,null);
 assert.deepEqual(result.validation.issues.map(i=>i.kind),['first_release']);
 assert.equal(result.definition.types[0].properties[0].valueType,'integer');
 assert.equal(result.definition.types[0].properties[0].required,false);
 assert.ok(result.validation.uncertainties.some(u=>u.memberId==='id'&&u.kind==='constraint'&&u.question.includes('0禁用1启用')&&u.question.includes('原提议值')),'scalar downgrade preserves comment dictionary semantics and unresolved closure');
 const absent={...staged.tableDecisions[0],sourceVersionId:'00000000-0000-4000-8000-000000000002'};
 assert.equal(discoverySourceOutcomes(result.definition,[absent])[0].status,'deferred','coordination omissions cannot install an unsupported source head');
});

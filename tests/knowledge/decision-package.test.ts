import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/knowledge/database.ts';
import { KnowledgeCore } from '../../src/knowledge/service.ts';
import { BuildPlans } from '../../src/knowledge/build-plans.ts';
import { DecisionPackages } from '../../src/knowledge/decision-packages.ts';
import { prepareCsv } from '../../src/knowledge/sources.ts';
const url = process.env.CONTEXT_OS_KNOWLEDGE_TEST_DATABASE_URL;
test('one decision package collects first publication and all identity groups, reuses decisions and rejects stale definitions', { skip: !url }, async () => {
  const db = await openDatabase(url!), dir = await mkdtemp(join(tmpdir(),'knowledge-decisions-')); let owns = false;
  const actor = { id: 'admin', role: 'admin' as const }, editor = { id: 'editor', role: 'editor' as const };
  try {
    assert.equal((await db.pool.query("SELECT 1 FROM pg_namespace WHERE nspname='knowledge'")).rows.length,0); await db.initialize(); owns = true;
    const core = new KnowledgeCore(db), plans = new BuildPlans(core), packages = new DecisionPackages(core,plans);
    const model = await core.draft(actor,{ name:'业务', types:[{ id:'Contract',name:'合同',properties:[{ id:'amount',name:'金额',valueType:'decimal' }] },{ id:'Company',name:'公司',properties:[{ id:'code',name:'代码',valueType:'string' }] }] });
    const a = await core.importSource(actor,'a','a','A',await prepareCsv(dir,'id,amount,company\nC1,100,ORG1\n','id'));
    const b = await core.importSource(actor,'b','b','B',await prepareCsv(dir,'id,amount,company\nC1,120,ORG1\n','id'));
    const proposal = { csv:[a,b].map(s=>({ sourceVersionId:s.version.id,objects:[{ id:'c',typeId:'Contract',identityColumn:'id' },{ id:'o',typeId:'Company',identityColumn:'company' }],properties:[{ id:'a',object:'c',predicate:'amount',column:'amount' },{ id:'co',object:'o',predicate:'code',column:'company' }],links:[] })) };
    const plan = await plans.create(actor,model.id,[a.version.id,b.version.id],proposal);
    const pack = await packages.create(actor,{ planId:plan.id });
    assert.equal(pack.summary.identities.length,2); assert.equal(pack.summary.ontologyIssues.length,1);
    assert.equal((await core.list(actor,'objects')).length,0);
    await assert.rejects(packages.submit(editor,pack.id,{ expectedRevision:pack.revision,candidateHash:pack.summary.candidateHash,reason:'确认',identityDecision:'same' }),/管理员/);
    const done = await packages.submit(actor,pack.id,{ expectedRevision:pack.revision,candidateHash:pack.summary.candidateHash,reason:'明确本批具体编号及范围',identityDecision:'same' });
    assert.equal(done.state,'built'); assert.equal((await core.list(actor,'objects')).length,2,'different groups remain separate objects');
    assert.ok(done.receipts.publishedOntologyId); assert.ok(done.receipts.build);
    assert.equal((await packages.get(actor,pack.id)).state,'built');
    const second = await core.draft(actor,model.definition);
    const secondPlan = await plans.create(actor,second.id,[a.version.id,b.version.id],proposal);
    const next = await packages.create(actor,{planId:secondPlan.id});
    await core.draft(actor,{...second.definition,name:'changed'},{id:second.id,expectedRevision:second.revision});
    await assert.rejects(packages.submit(actor,next.id,{expectedRevision:next.revision,candidateHash:next.summary.candidateHash,reason:'stale',identityDecision:'same'}),/变化|失效/);
    const thirdPlan=await plans.create(actor,second.id,[a.version.id,b.version.id],proposal);
    const replacement=await packages.create(actor,{planId:thirdPlan.id});
    const obsolete=await packages.get(actor,next.id);assert.equal(obsolete.state,'superseded');assert.equal((obsolete as any).superseded_by,replacement.id);
    await assert.rejects(packages.submit(actor,obsolete.id,{expectedRevision:obsolete.revision,candidateHash:obsolete.summary.candidateHash,reason:'不能批准旧批'}),/归档|取代|失效|错误/);
    const archived=await packages.archive(actor,replacement.id,{expectedRevision:replacement.revision,candidateHash:replacement.summary.candidateHash,reason:'待业务范围重新确定'});
    const archivedHash=archived.summary.candidateHash;
    await core.draft(actor,{...second.definition,name:'归档后再次变更'},{id:second.id,expectedRevision:second.revision+1});
    assert.equal((await packages.get(actor,archived.id)).summary.candidateHash,archivedHash,'archive freezes the reviewed fingerprint even when its old draft changes');
    assert.equal(archived.state,'archived');assert.equal((archived as any).archive_reason,'待业务范围重新确定');
    await assert.rejects(packages.submit(actor,archived.id,{expectedRevision:archived.revision,candidateHash:archived.summary.candidateHash,reason:'不能批准归档项'}),/归档|取代|错误/);
  } finally { if(owns){await db.pool.query('DROP SCHEMA knowledge CASCADE');await db.pool.query('DELETE FROM knowledge_schema_versions WHERE version BETWEEN 1 AND 7');}await db.close();await rm(dir,{recursive:true,force:true}); }
});

test('published incompatible ontology cannot silently reinterpret existing assertions before migration', {skip:!url}, async()=>{
  const db=await openDatabase(url!),dir=await mkdtemp(join(tmpdir(),'knowledge-reading-'));let owns=false;
  const actor={id:'admin',role:'admin' as const};
  try{
    assert.equal((await db.pool.query("SELECT 1 FROM pg_namespace WHERE nspname='knowledge'")).rows.length,0);await db.initialize();owns=true;
    const core=new KnowledgeCore(db),plans=new BuildPlans(core);
    const old=await core.draft(actor,{name:'合同',types:[{id:'Contract',name:'合同',properties:[{id:'amount',name:'金额',valueType:'decimal'}]}]});
    await core.act(actor,{kind:'PublishOntologyVersion',operationId:'old-publish',targetId:old.id,expectedRevision:1,reason:'首次启用'});
    const src=await core.importSource(actor,'source','source','CSV',await prepareCsv(dir,'id,amount\nC1,100\n','id'));
    let plan=await plans.create(actor,old.id,[src.version.id],{csv:[{sourceVersionId:src.version.id,objects:[{id:'c',typeId:'Contract',identityColumn:'id'}],properties:[{id:'p',object:'c',predicate:'amount',column:'amount'}],links:[]}]});
    plan=await plans.preflight(actor,plan.id,plan.revision);await plans.build(actor,plan.id);
    const obj=(await core.list(actor,'objects'))[0];const before=new Date().toISOString();
    const next=await core.draft(actor,{...old.definition,types:[{...old.definition.types[0],properties:[{...old.definition.types[0].properties[0],name:'含税金额',comparisonRequired:['currency']}]}]});
    await core.act(actor,{kind:'PublishOntologyVersion',operationId:'new-publish',targetId:next.id,expectedRevision:1,reason:'改变业务口径'});
    await assert.rejects(core.object(actor,obj.id),/迁移|未就绪|不兼容/);
    assert.equal((await core.object(actor,obj.id,{knownAt:before})).ontologyId,old.id);
  }finally{if(owns){await db.pool.query('DROP SCHEMA knowledge CASCADE');await db.pool.query('DELETE FROM knowledge_schema_versions WHERE version BETWEEN 1 AND 7');}await db.close();await rm(dir,{recursive:true,force:true});}
});

test('publication and approval receipts survive a build failure and local resume does not republish', {skip:!url}, async()=>{
  const db=await openDatabase(url!),dir=await mkdtemp(join(tmpdir(),'knowledge-resume-'));let owns=false;
  const actor={id:'admin',role:'admin' as const};
  try{
    assert.equal((await db.pool.query("SELECT 1 FROM pg_namespace WHERE nspname='knowledge'")).rows.length,0);await db.initialize();owns=true;
    const core=new KnowledgeCore(db),plans=new BuildPlans(core);
    const ontology=await core.draft(actor,{name:'合同',types:[{id:'Contract',name:'合同',properties:[{id:'amount',name:'金额',valueType:'decimal'}]}]});
    const src=await core.importSource(actor,'resume-src','resume','合同',await prepareCsv(dir,'id,amount\nC1,100\n','id'));
    const plan=await plans.create(actor,ontology.id,[src.version.id],{csv:[{sourceVersionId:src.version.id,objects:[{id:'c',typeId:'Contract',identityColumn:'id'}],properties:[{id:'a',object:'c',predicate:'amount',column:'amount'}],links:[]}]});
    class InterruptedBuild extends BuildPlans { override async build():ReturnType<BuildPlans['build']>{throw new Error('fixture infrastructure interruption');} }
    const interrupted=new DecisionPackages(core,new InterruptedBuild(core));
    const pack=await interrupted.create(actor,{planId:plan.id});
    await assert.rejects(interrupted.submit(actor,pack.id,{expectedRevision:pack.revision,candidateHash:pack.summary.candidateHash,reason:'确认本次合同范围'}),/fixture/);
    const recoverable=await new DecisionPackages(core).get(actor,pack.id);
    assert.equal(recoverable.state,'needs_recovery');assert.equal(recoverable.receipts.publishedOntologyId,ontology.id);assert.equal(recoverable.receipts.approvedPlanId,plan.id);
    assert.equal((await core.list(actor,'objects')).length,0);
    const done=await new DecisionPackages(core).submit(actor,pack.id,{expectedRevision:recoverable.revision,candidateHash:recoverable.summary.candidateHash});
    assert.equal(done.state,'built');assert.equal((await core.list(actor,'objects')).length,1);
    assert.equal((await core.list(actor,'ontologies')).length,1,'resume reuses the published ontology');
  }finally{if(owns){await db.pool.query('DROP SCHEMA knowledge CASCADE');await db.pool.query('DELETE FROM knowledge_schema_versions WHERE version BETWEEN 1 AND 7');}await db.close();await rm(dir,{recursive:true,force:true});}
});

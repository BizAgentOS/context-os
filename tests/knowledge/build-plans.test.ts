import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../src/knowledge/database.ts';
import { KnowledgeCore } from '../../src/knowledge/service.ts';
import { BuildPlans } from '../../src/knowledge/build-plans.ts';
import { ontologySchema } from '../../src/knowledge/contracts.ts';
import { prepareCsv } from '../../src/knowledge/sources.ts';

const url = process.env.CONTEXT_OS_KNOWLEDGE_TEST_DATABASE_URL;
const actor = { id: 'reviewer', role: 'admin' as const };
test('plans: review, source-isolated identities, approval, reverse relationship, replay and refresh', { skip: !url }, async () => {
  const db = await openDatabase(url!), dir = await mkdtemp(join(tmpdir(), 'knowledge-plans-'));
  let owns = false;
  try {
    assert.equal((await db.pool.query("SELECT 1 FROM pg_namespace WHERE nspname='knowledge'")).rows.length, 0);
    await db.initialize(); owns = true;
    const core = new KnowledgeCore(db), plans = new BuildPlans(core);
    const definition = ontologySchema.parse({ name: 'Generated-style IDs', types: [
      { id: 'deal_x', name: 'Contract', properties: [{ id: 'money_x', name: 'Amount', valueType: 'decimal' }] },
      { id: 'staff_x', name: 'Employee', properties: [] },
    ], links: [{ id: 'handles_x', name: 'Employee handles contract', from: 'staff_x', to: 'deal_x', multiple: true }] });
    const draft = await core.draft(actor, definition);
    const csv = await core.importSource(actor, 'upload', 'contracts', 'Contracts', await prepareCsv(dir, 'id,amount,employee,from,to\nC001,100.00,E001,2026-04-01T00:00:00Z,2026-05-01T00:00:00Z\n', 'id'));
    const text = 'Contract C001 amount 120.00 from 2026-04-01T00:00:00Z. Employee E001 handles C001 until 2026-05-01T00:00:00Z.';
    const pdf = await core.importSource(actor, 'document', 'document', 'Document', { hash: 'fixture', path: 'fixture', content: { kind: 'pdf', text, warnings: [] }, async discard() {} });
    const proposal = {
      csv: [{ sourceVersionId: csv.version.id, objects: [{ id: 'contract', typeId: 'deal_x', identityColumn: 'id' }, { id: 'employee', typeId: 'staff_x', identityColumn: 'employee' }], properties: [{ id: 'money', object: 'contract', predicate: 'money_x', column: 'amount', time: { mode: 'fixed', from: '2026-04-01T00:00:00Z', reason: 'reviewed amount applicability' } }], links: [{ id: 'handles', predicate: 'handles_x', from: 'employee', to: 'contract', time: { mode: 'columns', fromColumn: 'from', toColumn: 'to', reason: 'assignment dates' } }] }],
      documents: [{ sourceVersionId: pdf.version.id, claims: [{ claim: { subject: { typeId: 'deal_x', namespace: 'local', value: 'C001' }, predicate: 'money_x', value: '120.00', validity: { from: '2026-04-01T00:00:00Z', to: null, precision: 'instant' }, evidence: [{ kind: 'quote', quote: text, start: 0 }] }, timeEvidenceIndexes: [0], timeExplanation: 'amount applicability, not contract termination' }] }],
    };
    let plan = await plans.create(actor, draft.id, [csv.version.id, pdf.version.id], proposal);
    const before = await core.list(actor, 'objects'); assert.equal(before.length, 0);
    const preview = await plans.preflight(actor, plan.id, plan.revision);
    assert.ok(preview.preview);
    assert.equal(preview.preview.ready, false);
    assert.equal(preview.preview.identities.length, 1);
    assert.equal((await core.list(actor, 'objects')).length, 0, 'dry-run does not materialize objects');
    await assert.rejects(plans.approve(actor, plan.id, preview.revision));
    const review = { items: Object.fromEntries(preview.preview.items.map((i: any) => [i.key, { include: true, reviewed: true }])), identities: Object.fromEntries(preview.preview.identities.map((i: any) => [i.key, { decision: 'same', reason: 'reviewed same contract-number issuer and scope' }])), reason: 'all mappings, time and replacement reviewed' };
    await assert.rejects(plans.decideIdentityBatch(actor, plan.id, { expectedRevision: preview.revision, candidateHash: 'outdated', decision: 'same', reason: 'common scope' }), /候选或绑定/);
    plan = await plans.decideIdentityBatch(actor, plan.id, { expectedRevision: preview.revision, candidateHash: preview.preview.identityCandidateHash, decision: 'same', reason: 'one decision for this concrete batch' });
    let ready = await plans.preflight(actor, plan.id, plan.revision);
    if (ready.preview?.events.length) {
      plan = await plans.save(actor, plan.id, ready.revision, proposal, { ...review, eventAcknowledgement: ready.preview.eventHash });
      ready = await plans.preflight(actor, plan.id, plan.revision);
    }
    assert.ok(ready.preview);
    assert.equal(ready.preview.ready, true, JSON.stringify(ready.preview.errors));
    await assert.rejects(plans.approve(actor, plan.id, ready.revision), /发布/);
    await core.act(actor, { operationId: 'publish', kind: 'PublishOntologyVersion', targetId: draft.id, expectedRevision: 1, reason: 'reviewed' });
    const approved = await plans.approve(actor, plan.id, ready.revision);
    await assert.rejects(plans.save(actor, plan.id, approved.revision, proposal, review));
    const built = await plans.build(actor, plan.id);
    const again = await plans.build({ id: 'other-editor', role: 'editor' }, plan.id);
    assert.deepEqual(built, again);
    const views = await Promise.all((await core.list(actor, 'objects')).map(o => core.object(actor, o.id, { validAt: '2026-04-20T00:00:00Z' })));
    const contract = views.filter(v => v.typeId === 'deal_x');
    assert.equal(contract.length, 1);
    assert.equal((contract[0].fields.money_x as any).status, 'conflict');
    assert.equal(contract[0].identifiers.filter(i => i.namespace.startsWith('source.')).length, 2, 'approved merge retains both source aliases');
    assert.ok(contract[0].identifiers.some(i => i.namespace.startsWith('approved.')));
    await assert.rejects(core.commitExtraction(actor, { operationId: 'bypass-shared', ontologyId: draft.id, sourceVersionId: csv.version.id, configuration: {}, output: { claims: [{ ...ready.preview.outputs[0].output.claims[0], subject: { typeId: 'deal_x', namespace: 'shared', value: 'C001' } }] } }), /构建计划|身份/);
    const localClaim = { ...ready.preview.outputs.find(o => o.sourceVersionId === csv.version.id)!.output.claims[0], subject: { typeId: 'deal_x', namespace: `source.${csv.source.id}`, value: 'C001' } };
    await assert.rejects(core.commitExtraction(actor, { operationId: 'bypass-continuity', ontologyId: draft.id, sourceVersionId: csv.version.id, configuration: {}, output: { claims: [localClaim] } }), /重新审核/);
    const employee = views.find(v => v.typeId === 'staff_x')!;
    assert.equal((employee.fields.handles_x as any).value[0].objectId, contract[0].id);
    const beforeMay = await core.object(actor, employee.id, { validAt: '2026-05-01T00:00:00Z' });
    assert.deepEqual((beforeMay.fields.handles_x as any).value, []);
    const updated = await core.importSource(actor, 'updated', 'contracts', 'Contracts', await prepareCsv(dir, 'id,amount,employee,from,to\nC001,110.00,E002,2026-05-01T00:00:00Z,\n', 'id'));
    await assert.rejects(plans.build(actor, plan.id), /来源/);
    const stale = await plans.get(actor, plan.id); assert.ok(stale.staleReason);
    // Only the CSV is selected. Reuse of the prior concrete binding must be reviewed, not inferred from source-set equality.
    const nextProposal = { csv: [{ ...proposal.csv[0], sourceVersionId: updated.version.id }], documents: [] };
    let next = await plans.create(actor, draft.id, [updated.version.id], nextProposal);
    let nextPreview = await plans.preflight(actor, next.id, next.revision);
    assert.ok(nextPreview.preview);
    assert.equal(nextPreview.preview.identities.length, 1);
    assert.equal(nextPreview.preview.identities[0].participants.length, 1);
    assert.equal(nextPreview.preview.identities[0].participants[0].objectId, contract[0].id);
    const nextReview = { items: {}, identities: {}, reason: '确认来源冲突与固定时间节点，普通绑定及已批准身份自动沿用' };
    assert.equal(nextPreview.preview.identities[0].autoContinued, true);
    next = await plans.save(actor, next.id, nextPreview.revision, nextProposal, nextReview);
    nextPreview = await plans.preflight(actor, next.id, next.revision);
    if (nextPreview.preview?.events.length && !nextPreview.preview.ready) {
      next = await plans.save(actor, next.id, nextPreview.revision, nextProposal, { ...nextReview, eventAcknowledgement: nextPreview.preview.eventHash });
      nextPreview = await plans.preflight(actor, next.id, next.revision);
    }
    assert.equal(nextPreview.preview?.ready, true, JSON.stringify(nextPreview.preview?.errors));
    next = await plans.approve(actor, next.id, nextPreview.revision);
    await plans.build(actor, next.id);
    const refreshed = await core.object(actor, contract[0].id, { validAt: '2026-05-20T00:00:00Z' });
    assert.equal((refreshed.fields.money_x as any).status, 'conflict');
    assert.ok(refreshed.assertions.some((a: any) => a.source_version_id === updated.version.id && a.value === '110.00'));
    assert.equal((await core.list(actor, 'objects')).filter(o => o.type_id === 'deal_x').length, 1);
    // A later same-version build invalidates the earlier approved plan, even though its source version is unchanged.
    let newer = await plans.create(actor, draft.id, [updated.version.id], nextProposal);
    newer = await plans.save(actor, newer.id, newer.revision, nextProposal, nextReview);
    newer = await plans.preflight(actor, newer.id, newer.revision);
    newer = await plans.approve(actor, newer.id, newer.revision);
    await plans.build(actor, newer.id);
    await assert.rejects(plans.build(actor, next.id), /后续构建/);
    const attempts = await plans.events(actor, plan.id); assert.ok(attempts.some(e => e.kind === 'approved'));
  } finally {
    if (owns) { await db.pool.query('DROP SCHEMA knowledge CASCADE'); await db.pool.query('DELETE FROM knowledge_schema_versions WHERE version BETWEEN 1 AND 7'); }
    await db.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('excluding every claim keeps that source active and its facts in conflict preflight', {skip:!url},async()=>{
  const db=await openDatabase(url!),dir=await mkdtemp(join(tmpdir(),'knowledge-replacement-'));let owns=false;
  try{
    assert.equal((await db.pool.query("SELECT 1 FROM pg_namespace WHERE nspname='knowledge'")).rows.length,0);await db.initialize();owns=true;
    const core=new KnowledgeCore(db),plans=new BuildPlans(core);
    const model=await core.draft(actor,{name:'合同',types:[{id:'Contract',name:'合同',properties:[{id:'amount',name:'金额',valueType:'decimal'}]}]});
    await core.act(actor,{kind:'PublishOntologyVersion',operationId:'exclude-publish',targetId:model.id,expectedRevision:1,reason:'首次发布'});
    const add=async(op:string,key:string,value:string)=>core.importSource(actor,op,key,key,await prepareCsv(dir,`id,amount,from\nC1,${value},2026-04-01\n`,'id'));
    const a=await add('a','a','100'),b=await add('b','b','100');
    const proposal=(ids:string[])=>({csv:ids.map(id=>({sourceVersionId:id,objects:[{id:'c',typeId:'Contract',identityColumn:'id'}],properties:[{id:'a',object:'c',predicate:'amount',column:'amount',time:{mode:'columns',fromColumn:'from',reason:'金额生效日期'}}],links:[]}))});
    let initial=await plans.create(actor,model.id,[a.version.id,b.version.id],proposal([a.version.id,b.version.id]));
    initial=await plans.preflight(actor,initial.id,initial.revision);
    initial=await plans.decideIdentityBatch(actor,initial.id,{expectedRevision:initial.revision,candidateHash:initial.preview!.identityCandidateHash,decision:'same',reason:'同一合同编号'});
    initial=await plans.preflight(actor,initial.id,initial.revision);await plans.build(actor,initial.id);
    const changed=await add('b-change','b','120');
    let next=await plans.create(actor,model.id,[a.version.id,changed.version.id],proposal([a.version.id,changed.version.id]));
    const {itemKey}=await import('../../src/knowledge/build-contracts.ts');
    next=await plans.save(actor,next.id,next.revision,next.proposal,{items:{[itemKey(a.version.id,'property','a')]:{include:false,reviewed:false}}});
    next=await plans.preflight(actor,next.id,next.revision);
    assert.ok(next.preview!.events.some(e=>e.kind==='fact_conflict'),'unreplaced source A must still conflict with changed source B');
  }finally{if(owns){await db.pool.query('DROP SCHEMA knowledge CASCADE');await db.pool.query('DELETE FROM knowledge_schema_versions WHERE version BETWEEN 1 AND 7');}await db.close();await rm(dir,{recursive:true,force:true});}
});

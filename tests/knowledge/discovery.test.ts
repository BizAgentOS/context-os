import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoveryInput, validateDiscovery, discoveryCandidateSchema, discoveryReviewIssues, type DiscoverySource } from '../../src/knowledge/discovery.ts';
import { strictComparisonSchema, ontologySchema } from '../../src/knowledge/contracts.ts';
import { openDatabase } from '../../src/knowledge/database.ts';
import { KnowledgeCore } from '../../src/knowledge/service.ts';
const source: DiscoverySource = { id: '00000000-0000-4000-8000-000000000001', kind: 'csv', keyColumn: 'id', columns: ['id', 'amount'], rows: [{ id: 'C001', amount: '100.00' }], warnings: [] };
const candidate = () => ({ name: '合同候选', types: [{ id: 'Contract', name: '合同', properties: [{ id: 'amount', name: '金额', valueType: 'decimal' }] }], links: [], evidenceReferences: [{ memberId: 'Contract', evidenceIds: ['e1'] }, { memberId: 'amount', evidenceIds: ['e2'] }], uncertainties: [] });
test('discovery catalog owns locators, enforces property coverage and rejects invented references', () => {
  const prepared = discoveryInput([source], null);
  const valid = validateDiscovery(candidate(), [source], prepared.catalog, null);
  assert.equal(valid.definition.discoveryEvidence.length, 2);
  assert.equal(valid.validation.evidenceValid, true);
  assert.equal(valid.validation.semanticVerified, false);
  assert.equal(valid.validation.issues.length, 1);
  assert.equal(valid.validation.issues[0].kind, 'first_release');
  const unknown = candidate(); unknown.evidenceReferences[1].evidenceIds = ['invented'];
  assert.throws(() => validateDiscovery(unknown, [source], prepared.catalog, null), /证据目录/);
  const absent = candidate(); absent.evidenceReferences.pop();
  assert.throws(() => validateDiscovery(absent, [source], prepared.catalog, null), /属性|依据/);
  assert.throws(() => discoveryCandidateSchema.parse({ ...candidate(), discoveryEvidence: [{ memberId: 'Contract', locator: { kind: 'quote', quote: 'id: C001（模型解释）', start: 0 } }] }));
});
test('PDF evidence is copied from exact slices; unchanged base members may retain prior references', () => {
  const pdf: DiscoverySource = { id: '00000000-0000-4000-8000-000000000002', kind: 'pdf', text: 'Contract C001.\nAmount 100.00.', warnings: [] };
  const prepared = discoveryInput([pdf], null);
  assert.deepEqual(prepared.catalog.map(e => e.locator), [{ kind: 'quote', quote: 'Contract C001.', start: 0 }, { kind: 'quote', quote: 'Amount 100.00.', start: 15 }]);
  const old = validateDiscovery(candidate(), [source], discoveryInput([source], null).catalog, null).definition;
  const same = { ...old, evidenceReferences: [], uncertainties: [] } as any; delete same.discoveryEvidence;
  assert.equal(validateDiscovery(same, [source], [], old).definition.discoveryEvidence.length, 2);
  same.types[0].properties[0].name = '含税金额';
  assert.throws(() => validateDiscovery(same, [source], [], ontologySchema.parse({ ...old, types: [{ ...old.types[0], properties: [{ ...old.types[0].properties[0], name: '金额' }] }] })), /依据/);
});
test('missing comparison explanations are not business context values', () => {
  for (const comparison of [{ currency: '未知（原文未标明）' }, { currency: 'ZZ' }, { unit: '金额' }, { scope: '来源未注明币种' }]) assert.equal(strictComparisonSchema.safeParse(comparison).success, false);
  assert.equal(strictComparisonSchema.safeParse({}).success, true);
  assert.equal(strictComparisonSchema.safeParse({ currency: 'CNY', unit: 'yuan', scope: 'tax-included' }).success, true);
});
const url = process.env.CONTEXT_OS_KNOWLEDGE_TEST_DATABASE_URL;
test('automatic ontology gates major release events instead of per-item confirmations', { skip: !url }, async () => {
  const db = await openDatabase(url!); let owns = false;
  const actor = { id: 'reviewer', role: 'admin' as const };
  try {
    assert.equal((await db.pool.query("SELECT 1 FROM pg_namespace WHERE nspname='knowledge'")).rows.length, 0);
    await db.initialize(); owns = true;
    const core = new KnowledgeCore(db), prepared = discoveryInput([source], null);
    const result = validateDiscovery(candidate(), [source], prepared.catalog, null);
    // Empty evidence here represents unchanged base/manual data only; missing actual source versions cannot publish.
    const draft = await core.draft(actor, result.definition, undefined, undefined, { jobId: 'fixture', validation: result.validation });
    const publish = { operationId: 'publish', kind: 'PublishOntologyVersion', targetId: draft.id, expectedRevision: 1, reason: 'reviewed' };
    await assert.rejects(core.act(actor, publish), /重大/);
    await assert.rejects(core.reviewDiscovery(actor, draft.id, { expectedRevision: 1, issueIds: [], reason: 'incomplete' }), /重大/);
    const reviewed = await core.reviewDiscovery(actor, draft.id, { expectedRevision: 1, issueIds: result.validation.issues.map(i => i.id), reason: 'checked against source' });
    const edited = await core.draft(actor, { ...result.definition, name: '修订后的合同候选' }, { id: draft.id, expectedRevision: reviewed.revision });
    assert.equal(edited.discovery.review, null);
    await assert.rejects(core.act(actor, { ...publish, expectedRevision: edited.revision }), /重大/);
    await core.reviewDiscovery(actor, draft.id, { expectedRevision: edited.revision, issueIds: edited.discovery.validation.issues.map((i: any) => i.id), reason: 'rechecked' });
    const latest = await core.ontology(actor, draft.id);
    await assert.rejects(core.act(actor, { ...publish, expectedRevision: latest.revision }), /目标不存在/, 'approval cannot manufacture a nonexistent source version');
  } finally {
    if (owns) { await db.pool.query('DROP SCHEMA knowledge CASCADE'); await db.pool.query('DELETE FROM knowledge_schema_versions WHERE version BETWEEN 1 AND 7'); }
    await db.close();
  }
});

test('ordinary additive changes do not require decisions; semantic changes and constraints do', () => {
  const base = validateDiscovery(candidate(), [source], discoveryInput([source], null).catalog, null).definition;
  const extra = ontologySchema.parse({ ...base, types: [{ ...base.types[0], properties: [...base.types[0].properties, { id: 'note', name: '备注', valueType: 'string' }] }] });
  assert.deepEqual(discoveryReviewIssues(extra, [], base), []);
  const changed = ontologySchema.parse({ ...base, types: [{ ...base.types[0], properties: [{ ...base.types[0].properties[0], name: '含税金额' }] }] });
  assert.ok(discoveryReviewIssues(changed, [], base).some(i => i.kind === 'semantic_change'));
});
test('an ambiguous property is deferred without blocking the clear type and its first-release summary', () => {
  const proposal = { ...candidate(), uncertainties: [{ memberId: 'amount', kind: 'definition', question: '此字段究竟代表金额还是其他统计指标，定义尚不明确' }] };
  const result = validateDiscovery(proposal, [source], discoveryInput([source], null).catalog, null);
  assert.equal(result.definition.types[0].properties.length, 0);
  assert.equal(result.validation.deferred.length, 1);
  assert.equal(result.validation.issues.length, 1);
  assert.equal(result.validation.issues[0].kind, 'first_release');
});

test('value conflicts and missing currency retain the amount concept without picking a winner', () => {
  for (const uncertainty of [
    { memberId: 'amount', kind: 'fact_conflict', question: '两份来源金额不同' },
    { memberId: 'amount', kind: 'missing_context', question: '原文没有币种', dimensions: ['currency'] },
    { memberId: 'amount', kind: 'time_attachment', question: '金额生效时间归属未明' },
  ]) {
    const result = validateDiscovery({ ...candidate(), uncertainties: [uncertainty] }, [source], discoveryInput([source], null).catalog, null);
    assert.equal(result.definition.types[0].properties[0].id, 'amount');
    assert.equal(result.validation.deferred.length, 0);
    assert.equal(result.validation.issues.some(i => i.kind === 'resolve_deferred'), false);
    if (uncertainty.kind === 'missing_context') assert.deepEqual(result.definition.types[0].properties[0].comparisonRequired, ['currency']);
  }
});

test('type coverage reuses owned real references without inventing quotes or skipping property evidence', () => {
  const raw = candidate(); raw.evidenceReferences = raw.evidenceReferences.filter(r => r.memberId !== 'Contract');
  const prepared = discoveryInput([source], null);
  const result = validateDiscovery(raw, [source], prepared.catalog, null);
  assert.ok(result.definition.discoveryEvidence.some(e => e.memberId === 'Contract' && e.locator.kind === 'field' && e.locator.field === 'amount'));
  assert.deepEqual(result.validation.derivedTypeEvidence[0].fromMemberIds, ['amount']);
  assert.equal(result.validation.semanticVerified, false);
  const missing = candidate(); missing.evidenceReferences = [];
  assert.throws(() => validateDiscovery(missing, [source], prepared.catalog, null), /Contract、amount/);
});


test('native discovery carries bounded profiling and declaration candidates without name-based datetime or inferred enum', () => {
  const native:DiscoverySource={...source,kind:'table',columns:['id','time','start_time','state','category','enabled'],
    rows:[{id:'1',time:'33.62',start_time:'2026-06-18 22:40:41',state:'OPEN',category:'1',enabled:'1'}],
    metadata:{schema:'test',name:'logs',primaryKey:['id'],foreignKeys:[],columns:[
      {name:'id',type:'bigint'},{name:'time',type:'decimal(10,2)',comment:'请求耗时，单位毫秒'},
      {name:'start_time',type:'timestamp'},{name:'state',type:"enum('OPEN','Done')"},
      {name:'category',type:'varchar(20)'},{name:'enabled',type:'tinyint(1)'}]}};
  const c=discoveryInput([native],null).input.sources[0].structuredCandidates!;
  assert.equal(c.columns.find(p=>p.column==='time')!.valueType,'decimal');
  assert.equal(c.columns.find(p=>p.column==='start_time')!.valueType,'datetime');
  assert.deepEqual(c.columns.find(p=>p.column==='state')!.enumValues,['OPEN','Done']);
  assert.equal(c.columns.find(p=>p.column==='category')!.valueType,'string');
  assert.equal(c.columns.find(p=>p.column==='enabled')!.valueType,'integer');
  assert.equal(c.profile.coverage,'sample');assert.equal(c.profile.totalRows,null);
  assert.deepEqual(c.identity,{declaredPrimaryKey:['id'],inferred:false});
});


test('unproven business enum constraints stay draft and require a current explicit decision, not a SQL ENUM column', () => {
  const raw=candidate();
  Object.assign(raw.types[0].properties[0],{valueType:'enum',enumValues:['100.00','200.00']});
  const proposal={...raw,uncertainties:[{memberId:'amount',kind:'constraint',question:'字段为数值列，样本不能证明业务枚举完整；请核对业务字典。'}]};
  const prepared=discoveryInput([source],null),result=validateDiscovery(proposal,[source],prepared.catalog,null);
  assert.equal(result.definition.types[0].properties[0].valueType,'enum');
  assert.equal(result.validation.deferred.length,0,'constraint uncertainty does not discard the attribute');
  const constraint=result.validation.issues.find(i=>i.kind==='constraint_confirmation'&&i.memberId==='amount')!;
  assert.ok(constraint);
  const repeated=discoveryReviewIssues(result.definition,[...proposal.uncertainties,...proposal.uncertainties]);
  assert.equal(repeated.filter(i=>i.kind==='constraint_confirmation').length,1,'coordinated duplicate proposals must remain reviewable');
  const changed=ontologySchema.parse({...result.definition,types:[{...result.definition.types[0],properties:[{...result.definition.types[0].properties[0],enumValues:['100.00','200.00','300.00']}]}]});
  assert.notEqual(discoveryReviewIssues(changed,proposal.uncertainties).find(i=>i.kind==='constraint_confirmation')!.id,constraint.id,'enum edits invalidate the decision fingerprint');
  const scalar=ontologySchema.parse({...result.definition,types:[{...result.definition.types[0],properties:[{id:'amount',name:'金额',valueType:'decimal'}]}]});
  assert.equal(discoveryReviewIssues(scalar,proposal.uncertainties).some(i=>i.kind==='constraint_confirmation'),false,'removing enum removes its pending constraint issue');
});


test('date representation uncertainty stays a proposal and requires one current concentrated decision', () => {
  const raw=candidate();raw.types[0].properties[0].valueType='datetime';
  const uncertainty={memberId:'amount',kind:'datetime_representation',question:'来源time为decimal；需区分耗时和日期时间戳，不自动猜单位或时区。'};
  const proposal={...raw,uncertainties:[uncertainty,uncertainty]};
  const result=validateDiscovery(proposal,[source],discoveryInput([source],null).catalog,null);
  assert.equal(result.definition.types[0].properties[0].valueType,'datetime');
  assert.equal(result.validation.deferred.length,0);
  assert.equal(result.validation.issues.filter(i=>i.kind==='datetime_confirmation').length,1);
  const scalar=ontologySchema.parse({...result.definition,types:[{...result.definition.types[0],properties:[{id:'amount',name:'金额',valueType:'decimal'}]}]});
  assert.equal(discoveryReviewIssues(scalar,proposal.uncertainties).some(i=>i.kind==='datetime_confirmation'),false);
});

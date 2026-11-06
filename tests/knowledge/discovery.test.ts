import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoveryInput, validateDiscovery, discoveryCandidateSchema, discoveryReviewIssues, validateDiscoveryEvidence, carryDiscoveryEvidence, refreshDiscoveryValidation, reassessNativeDefinition, type DiscoverySource } from '../../src/knowledge/discovery.ts';
import { locateDiscoveryEvidence } from '../../src/knowledge/sources.ts';
import { strictComparisonSchema, ontologySchema, claimSchema } from '../../src/knowledge/contracts.ts';
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
  assert.ok(result.validation.issues.some(i=>i.kind==='first_release'));
  assert.equal(result.validation.issues.some(i=>i.kind==='deferred_candidates'),false);
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


test('all-NULL native columns retain exact evidence for optional schema candidates without inventing dates', () => {
  const native: DiscoverySource = { id: source.id, kind: 'table', keyColumn: 'id', columns: ['id', 'create_time'],
    rows: [{ id: '1', create_time: '' }, { id: '2', create_time: '' }], warnings: [],
    nativeValues: { '1': { id: '1', create_time: null }, '2': { id: '2', create_time: null } },
    metadata: { name: 'system_exception_log', columns: [{ name: 'create_time', type: 'datetime', comment: '创建时间', nullable: true }] } };
  const prepared = discoveryInput([native], null);
  const refs = prepared.catalog.filter(e => e.locator.kind === 'field' && e.locator.field === 'create_time');
  assert.equal(refs.length, 2);
  assert.ok(refs.every(e => e.value === null));
  const inputEvidence = prepared.input.evidenceCatalog.find(e => e.evidenceId === refs[0].id)!;
  assert.ok('value' in inputEvidence);
  assert.equal(inputEvidence.value, null);
  const proposal = { name: '日志', types: [{ id: 'Log', name: '日志', properties: [{ id: 'created', name: '创建时间', valueType: 'datetime', required: false }] }], links: [],
    evidenceReferences: [{ memberId: 'created', evidenceIds: [refs[0].id] }], uncertainties: [] };
  const result = validateDiscovery(proposal, [native], prepared.catalog, null);
  assert.equal(result.definition.types[0].properties[0].valueType, 'datetime');
  assert.equal(result.definition.types[0].properties[0].required, false);
  assert.equal(result.validation.semanticVerified, false);
  const evidence = result.definition.discoveryEvidence.find(e => e.memberId === 'created')!;
  const located = locateDiscoveryEvidence(native, evidence.locator);
  assert.ok('value' in located);
  assert.equal(located.value, null);
  assert.throws(() => validateDiscovery({ ...proposal, evidenceReferences: [] }, [native], prepared.catalog, null), /暂无可自动采用/);
  assert.throws(() => validateDiscovery({ ...proposal, evidenceReferences: [{ memberId: 'created', evidenceIds: ['invented'] }] }, [native], prepared.catalog, null), /证据目录/);
});

const nativeEvidenceSource = (): DiscoverySource => ({ id: source.id, kind: 'table', keyColumn: 'id', columns: ['id', 'create_time'],
  rows: [{ id: '1', create_time: '' }], nativeValues: { '1': { id: '1', create_time: null } }, warnings: [],
  metadata: { name: 'unpredictable_table', columns: [{ name: 'id', type: 'integer' }, { name: 'create_time', type: 'datetime', comment: '创建时间', nullable: true }] } });

test('explicit source columns attach schema evidence independently of member names and record values', () => {
  const native=nativeEvidenceSource(),prepared=discoveryInput([native],null);
  const column=prepared.input.sources[0].sourceColumns!.find(c=>c.column==='create_time')!;
  const proposal={name:'业务候选',types:[{id:'Anything',name:'对象',properties:[{id:'unrelated_member_name',name:'创建时间',valueType:'datetime',sourceColumnIds:[column.sourceColumnId]}]}],links:[]};
  const result=validateDiscovery(proposal,[native],prepared.catalog,null);
  assert.equal(result.validation.deferred.length,0);
  const evidence=result.definition.discoveryEvidence.find(e=>e.memberId==='unrelated_member_name')!;
  assert.equal(evidence.locator.kind,'column');
  assert.ok('declaration' in locateDiscoveryEvidence(native,evidence.locator));
  assert.equal(result.validation.semanticVerified,false);
  assert.equal('sourceColumnIds' in result.definition.types[0].properties[0],false,'compiler bindings do not enter semantic definitions');
  const empty={...native,rows:[],nativeValues:{},rowCount:0};
  assert.deepEqual(discoveryInput([empty],null).input.sources[0].sourceColumns,prepared.input.sources[0].sourceColumns,'declaration IDs do not depend on sample rows');
  assert.equal(locateDiscoveryEvidence(empty,evidence.locator).kind,'column');
  assert.equal(claimSchema.safeParse({subject:{typeId:'Anything',namespace:'local',value:'1'},predicate:'unrelated_member_name',value:'2026-11-05',evidence:[evidence.locator]}).success,false,'schema evidence cannot be used to manufacture a record fact');
  const rejected=validateDiscoveryEvidence({...proposal,types:[{...proposal.types[0],properties:[{...proposal.types[0].properties[0],sourceColumnIds:['column:invented']}]}]},[native],prepared.catalog,null);
  assert.ok(rejected.candidate.uncertainties.some(u=>u.kind==='source_binding'));
  assert.ok(!rejected.proposed.discoveryEvidence.some(e=>e.memberId==='unrelated_member_name'));
  assert.throws(()=>locateDiscoveryEvidence({...native,metadata:{...native.metadata,name:'different_table'}},evidence.locator),/结构指纹/);
});

test('native missing evidence defers the member without guessing its id suffix, without a review gate after refresh', () => {
  const native=nativeEvidenceSource(),prepared=discoveryInput([native],null),column=prepared.input.sources[0].sourceColumns![0];
  const proposal={name:'日志',types:[{id:'Log',name:'日志',sourceColumnIds:[column.sourceColumnId],properties:[{id:'Log.id',name:'ID',valueType:'integer'}]}],links:[]};
  const result=validateDiscovery(proposal,[native],prepared.catalog,null);
  assert.equal(result.definition.types[0].properties.length,0,'a real id column is not enough to infer a missing binding');
  assert.equal(result.validation.deferred[0].member.id,'Log.id');
  assert.equal(result.validation.issues.some(i=>i.kind==='deferred_candidates'),false);
  assert.equal(refreshDiscoveryValidation(result.definition,result.validation).issues.some((i:{kind:string})=>i.kind==='deferred_candidates'),false);
  assert.throws(()=>validateDiscovery({...proposal,evidenceReferences:[{memberId:'Log.id',evidenceIds:['invented']}]},[native],prepared.catalog,null),/证据目录/);
});

test('coordination restores unchanged member provenance and renamed members use explicit stable column bindings', () => {
  const native=nativeEvidenceSource(),prepared=discoveryInput([native],null),column=prepared.input.sources[0].sourceColumns![0];
  const prior=validateDiscoveryEvidence({name:'日志',types:[{id:'Log',name:'日志',properties:[{id:'log_id',name:'编号',valueType:'integer',sourceColumnIds:[column.sourceColumnId]}]}],links:[]},[native],prepared.catalog,null).candidate;
  const omitted=structuredClone(prior);omitted.evidenceReferences=[];omitted.types[0].properties[0].sourceColumnIds=[];
  const carried=carryDiscoveryEvidence(omitted,[prior]);
  assert.equal(validateDiscovery(carried,[native],prepared.catalog,null).validation.deferred.length,0);
  const renamed=structuredClone(prior);renamed.types[0].properties[0].id='renamed_id';renamed.evidenceReferences=[];
  assert.ok(validateDiscovery(renamed,[native],prepared.catalog,null).definition.discoveryEvidence.some(e=>e.memberId==='renamed_id'));
  const moved=structuredClone(omitted);moved.types[0].id='DifferentOwner';
  assert.equal(carryDiscoveryEvidence(moved,[prior]).types[0].properties[0].sourceColumnIds.length,0,'owner changes cannot inherit evidence by a repeated property id');
});


test('explicit column names are resolved by the host and mistyped opaque ids are quarantined without fuzzy repair', () => {
  const native=nativeEvidenceSource(),prepared=discoveryInput([native],null);
  const proposal={name:'日志',types:[{id:'Log',name:'日志',properties:[
    {id:'id',name:'编号',valueType:'integer',sourceColumns:[{column:'id'}]},
    {id:'created',name:'创建时间',valueType:'datetime',sourceColumns:[{column:'create_time'}]},
    {id:'bad',name:'错误来源',valueType:'string',sourceColumnIds:['column:40a40bdc1834fa41c6483d6d604fd0fe720363e7d06d4100535991923b9698b6']}
  ]}],links:[]};
  const normalized=validateDiscoveryEvidence(proposal,[native],prepared.catalog,null);
  assert.deepEqual(normalized.candidate.types[0].properties[1].sourceColumns,[{sourceVersionId:native.id,column:'create_time'}]);
  const result=validateDiscovery(normalized.candidate,[native],prepared.catalog,null);
  assert.deepEqual(result.definition.types[0].properties.map(p=>p.id),['id','created']);
  assert.ok(result.validation.deferred.some(d=>d.member.id==='bad'&&d.reason.includes('40a40b')));
  const mixed={...proposal,types:[{...proposal.types[0],properties:[proposal.types[0].properties[0],{...proposal.types[0].properties[2],sourceColumns:[{column:'id'}]}]}]};
  assert.ok(validateDiscovery(mixed,[native],prepared.catalog,null).validation.deferred.some(d=>d.member.id==='bad'),'a valid binding does not silently pardon another rejected binding');
  const second={...native,id:'00000000-0000-4000-8000-000000000099'};
  const ambiguous=validateDiscoveryEvidence(proposal,[native,second],discoveryInput([native,second],null).catalog,null);
  assert.ok(ambiguous.candidate.uncertainties.some(u=>u.memberId==='id'&&u.kind==='source_binding'),'multi-source shorthand is not resolved by matching a column name');
  const explicit={...proposal,types:[{...proposal.types[0],properties:[{...proposal.types[0].properties[0],sourceColumns:[{column:'id',sourceVersionId:native.id}]}]}]};
  assert.ok(validateDiscoveryEvidence(explicit,[native,second],discoveryInput([native,second],null).catalog,null).proposed.discoveryEvidence.some(e=>e.memberId==='id'&&e.sourceVersionId===native.id));
});

test('native qualified property references and uncertainties resolve only through exact declared ownership', () => {
  const native=nativeEvidenceSource(),prepared=discoveryInput([native],null);
  const evidenceId=prepared.catalog.find(e=>e.locator.kind==='column'&&e.locator.field==='id')!.id;
  const proposal={name:'关联表',types:[{id:'SystemRoleMenuRelation',name:'关联',properties:[{id:'id',name:'编号',valueType:'integer'}]}],links:[],
    evidenceReferences:[{memberId:'SystemRoleMenuRelation.id',evidenceIds:[evidenceId]}],
    uncertainties:[{memberId:'SystemRoleMenuRelation.id',kind:'fact_conflict',question:'编号存在冲突，保留依据'}]};
  const result=validateDiscovery(proposal,[native],prepared.catalog,null);
  assert.ok(result.definition.discoveryEvidence.some(e=>e.memberId==='id'));
  assert.equal(result.validation.uncertainties[0].memberId,'id');
  assert.equal(result.validation.deferred.length,0);
  const missing=validateDiscoveryEvidence({...proposal,evidenceReferences:[{memberId:'OtherType.id',evidenceIds:[evidenceId]}],uncertainties:[]},[native],prepared.catalog,null);
  assert.ok(!missing.proposed.discoveryEvidence.some(e=>e.memberId==='id'),'matching a suffix never repairs an unknown owner');
  assert.ok(missing.candidate.uncertainties.some(u=>u.kind==='source_binding'&&u.question.includes('OtherType.id')));
  const unknownUncertainty=validateDiscoveryEvidence({...proposal,uncertainties:[{memberId:'Removed',kind:'fact_conflict',question:'原冲突提醒'}]},[native],prepared.catalog,null);
  assert.ok(unknownUncertainty.candidate.uncertainties.some(u=>u.kind==='source_binding'&&u.question.includes('原冲突提醒')),'orphan warnings must not be silently deleted');
  assert.throws(()=>validateDiscoveryEvidence({...proposal,evidenceReferences:[{memberId:'OtherType.id',evidenceIds:['invented']}]},[native],prepared.catalog,null),/证据目录/,'orphan member references do not bypass evidence validation');
});

test('canonical member IDs take precedence over qualified aliases', () => {
  const native=nativeEvidenceSource(),prepared=discoveryInput([native],null);
  const evidenceId=prepared.catalog.find(e=>e.locator.kind==='column'&&e.locator.field==='id')!.id;
  const checked=validateDiscoveryEvidence({name:'日志',types:[{id:'Log',name:'日志',properties:[{id:'id',name:'ID',valueType:'integer'},{id:'Log.id',name:'独立成员',valueType:'integer'}]}],links:[],
    evidenceReferences:[{memberId:'Log.id',evidenceIds:[evidenceId]}]},[native],prepared.catalog,null);
  assert.ok(checked.proposed.discoveryEvidence.some(e=>e.memberId==='Log.id'));
  assert.ok(!checked.proposed.discoveryEvidence.some(e=>e.memberId==='id'));
});


test('local native reassessment removes routine gates and speculative constraints while retaining exclusions and evidence',()=>{
  const native=nativeEvidenceSource(),prepared=discoveryInput([native],null);
  const raw={name:'日志',types:[{id:'Log',name:'日志',identityNamespaces:['shared'],properties:[
    {id:'id',name:'编号',valueType:'enum',enumValues:['1'],required:true,sourceColumns:[{column:'id'}]},
    {id:'created',name:'创建日期',valueType:'datetime',sourceColumns:[{column:'create_time'}]}
  ]}],links:[]};
  const original=validateDiscovery(raw,[native],prepared.catalog,null);
  const previous={...original.validation,uncertainties:[{memberId:'created',kind:'datetime_representation',question:'确认时区'},{memberId:'created',kind:'datetime_representation',question:'重复确认'}],tableDecisions:[{sourceVersionId:native.id,status:'deferred',reason:'局部问题'}],tableProposals:[{sourceVersionId:native.id,candidate:raw}],deferred:[{member:{id:'missing'},evidence:[{sourceVersionId:native.id}],reason:'缺目标'}]};
  const result=reassessNativeDefinition(original.definition,previous,[native]);
  assert.deepEqual(result.validation.issues.map((i:{kind:string})=>i.kind),['first_release']);
  assert.equal(result.definition.types[0].properties[0].valueType,'integer');
  assert.equal(result.definition.types[0].properties[0].required,false);
  assert.deepEqual(result.definition.types[0].identityNamespaces,[]);
  assert.deepEqual(result.definition.discoveryEvidence,original.definition.discoveryEvidence);
  assert.deepEqual(result.validation.deferred,previous.deferred);
  assert.ok(result.validation.unresolvedSourceVersionIds.includes(native.id),'old source heads must remain protected');
  assert.equal(result.validation.tableDecisions[0].status,'candidate');
  assert.equal(original.definition.types[0].properties[0].required,true,'input is not mutated');
  const existing=reassessNativeDefinition(original.definition,{...previous,baseline:original.definition},[native]);
  assert.equal(existing.definition.types[0].properties[0].required,true,'existing business constraints remain intact');
  assert.equal(existing.definition.types[0].properties[0].valueType,'enum');
});

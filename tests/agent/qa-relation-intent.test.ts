import {test} from 'node:test';
import assert from 'node:assert/strict';
import {identityWorkspace,ref} from './identity-release-fixture.ts';

test('a requested missing relation produces a replayable host-owned query without the model inventing an ID',async()=>{
 const w=await identityWorkspace(),app=w.service.app;
 try{
  const run=app.questionAnswering.begin({question:'账号的负责人是否已确认？',dataView:{kind:'working'}});
  const directory=await run.execute('ontology_describe',{});
  assert(((directory.result as any).entities as any[]).some(item=>item.id==='account'));
  const read=await run.execute('relations_traverse',{target:{entityTypeId:'account',id:'a-user'},relationName:'技术负责人',toEntityTypeId:'person'});
  assert.equal(read.reason,'missing_relation');assert.match(String(read.message),/技术负责人/);
  const report=await run.execute('gap_report',{readId:read.readId,observation:'已实际检查当前采用目录，技术负责人关系不存在。'});
  const gap=report.gap as any;assert.equal(gap.status,'open');assert.match(gap.content.query.traverse[0].relationTypeId,/^requested_relation_/);
  assert.deepEqual(gap.content.query.target,{entityTypeId:'account',id:'a-user'});
  const actual=app.live.readLayered(w.currentModel().id).semantic.relationTypes.find(item=>item.from==='account'&&item.to==='person')!;
  const available=await run.execute('relations_traverse',{target:{entityTypeId:'account',id:'a-user'},relationName:actual.name,toEntityTypeId:'person'});
  assert.equal(available.status,'available');assert.equal(((available.result as any).items as any[])[0].$id,'P1');
  const release=await w.publish('只开放人员');
  const connection=await w.manage('/api/releases/connect',{operationId:'intent-reader',name:'仅人员',releaseRef:ref(release),conceptIds:['person'],relationIds:[],business:{grants:[{type:'人员',fields:['$id','姓名'],relations:[]}]}});
  const restricted=app.questionAnswering.begin({question:'不允许借名称扩大范围',dataView:{kind:'consumer',releaseRef:ref(release),connectionRef:ref(connection.connection)}});
  await assert.rejects(restricted.execute('relations_traverse',{target:{entityTypeId:'person',id:'P1'},relationName:'技术负责人',toEntityTypeId:'account'}),/授权|范围/);
 }finally{await w.close();}
});

test('a missing named relationship keeps its requested endpoint through repair and user reask',{timeout:60000},async()=>{
 const {identityWorkspace:threeEntities}=await import('./identity-fixture.ts');
 const w=await threeEntities(),app=w.service.app,qa=app.questionAnswering;
 try{
  const run=qa.begin({question:'A1 的技术负责人（人员）是谁？'});
  const read=await run.execute('relations_traverse',{target:{entityTypeId:'account',id:'A1'},relationName:'技术负责人',toEntityTypeId:'person'});
  const gap=qa.gaps.handoff({...ref((await run.execute('gap_report',{readId:read.readId,observation:'账号到人员缺少负责人关系'})).gap as any),operationId:'endpoint-handoff'}).gap;
  const originalId=(gap.content.query as any).traverse[0].relationTypeId;
  const propose=async(target:'staff'|'people',tag:string)=>{
   const from=app.snapshots.bindingDataset(w.sources.accounts.id,'accounts')!,to=app.snapshots.bindingDataset(w.sources[target].id,target)!;
   const p=await app.changes.propose({operationId:'endpoint-'+tag,origin:'human',type:'relation',baseline:app.changes.currentBaseline(),subject:{from:{datasetId:from.id,column:'email'},to:{datasetId:to.id,column:'email'},cardinality:'N:1'},evidence:'核对实际邮箱对应'});
   const checked=await app.changes.verify({...ref(p.change),operationId:'endpoint-check-'+tag});assert.equal(checked.status,'verified');
   const definition=(await app.changes.preparePreview(ref(checked))).definition!;
   return {checked,relation:(definition.layered as any).semantic.relationTypes.at(-1)};
  };
  const wrong=await propose('staff','wrong');
  await assert.rejects(qa.gaps.preview({...ref(gap),operationId:'endpoint-preview-wrong',changeRef:ref(wrong.checked),relationResolutions:[{fromRelationId:originalId,toRelationId:wrong.relation.id}]}),/端点|目标|原始/);
  await assert.rejects(qa.gaps.preview({...ref(gap),operationId:'endpoint-preview-wrong-placeholder',changeRef:ref(wrong.checked),relationResolutions:[{fromRelationId:originalId,toRelationId:'$proposed'}]}),/端点|目标|原始/);
  assert.equal(qa.gaps.get(gap.id).version,gap.version,'a rejected repair cannot update or link the gap');
  assert.equal(app.memory.listArtifacts('gap_preview').length,0,'a rejected repair leaves no usable preview receipt');
  assert.deepEqual((gap.content.receipt as any).result.requestedRelation,{id:originalId,from:'account',to:'person',name:'技术负责人'});
  const right=await propose('people','right');
  const preview=await qa.gaps.preview({...ref(gap),operationId:'endpoint-preview-right',changeRef:ref(right.checked),relationResolutions:[{fromRelationId:originalId,toRelationId:'$proposed'}]});
  assert.equal((preview.preview.content.relationResolutions as any[])[0].toRelationId,right.relation.id,'the host resolves and persists the actual newly proposed relation ID');
  assert.equal((preview.after.result as any).items[0].$id,'P1');
  qa.gaps.linkChange({...ref(gap),operationId:'endpoint-link',changeRef:ref(right.checked),previewRef:ref(preview.preview)});
  await app.changes.adopt({...ref(right.checked),operationId:'endpoint-adopt',acknowledgeReview:true});
  const reask=await qa.gaps.reask({...ref(qa.gaps.get(gap.id)),operationId:'endpoint-reask'});
  assert.equal(reask.gap.status,'confirmed');assert.equal((reask.result.result as any).items[0].$id,'P1');
  const unspecified=qa.begin({question:'账号还缺少哪个关系？'}),unknown=await unspecified.execute('relations_traverse',{target:{entityTypeId:'account',id:'A1'},relationName:'另一个待核对关系'});
  assert.equal(Object.hasOwn((unknown.result as any).requestedRelation,'to'),false,'an unspecified endpoint must stay unknown');
 }finally{await w.close();}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {identityWorkspace,ref} from './identity-fixture.ts';
import {SemanticQuery} from '../../src/semantic/query.ts';

test('semantic query filters, orders and pages stable property IDs and rejects unauthorized predicates',async()=>{
  const w=await identityWorkspace();
  try {
    const query=new SemanticQuery(w.service.app.memory,w.service.app.live,w.service.app.snapshots);
    const email=w.service.app.live.readLayered(w.model.id).semantic.properties.find(p=>p.entityTypeId==='person'&&p.name==='邮箱')!.id;
    const request={target:{entityTypeId:'person'},fields:[email],filters:[{propertyId:email,op:'contains',value:'example.test'}],sort:[{propertyId:email,direction:'desc'}],page:{offset:1,limit:1}};
    const result=await query.execute(request,{modelRef:ref(w.model)});
    assert.deepEqual(result.items,[{$id:'P1',values:{[email]:'alice@example.test'}}]);
    assert.equal(result.coverage.total,2);assert.equal(result.coverage.complete,false);
    assert.equal(result.columns[0].name,'邮箱');assert.equal(result.readMode,'active_snapshot');
    assert.ok(result.sources.every(source=>source.snapshotId&&source.dataAsOf));
    const scope={entityTypeIds:new Set(['person']),propertyIds:new Set<string>(),relationTypeIds:new Set<string>()};
    await assert.rejects(query.execute({...request,fields:[]},{modelRef:ref(w.model),scope}),/授权/);
    await assert.rejects(query.execute({...request,page:{offset:0,limit:51}},{modelRef:ref(w.model),maxPageSize:50}),/每页/);
    await assert.rejects(query.execute({...request,sql:'select * from anything'},{modelRef:ref(w.model)}));
  } finally{await w.close();}
});

test('fused attributes filter over the full snapshot and retain explicit exclusions and ambiguous values',async()=>{
  const w=await identityWorkspace();
  try {
    const adopted=await w.adopt('identity_rule',{kind:'same_as',left:{bindingId:w.binding('staff'),columns:['email']},right:{bindingId:w.binding('person'),columns:['email']},transform:{op:'none'},reason:'通讯录补充人员',evidence:'样本复验'});
    const effect=adopted.content.effect as any;
    const query=new SemanticQuery(w.service.app.memory,w.service.app.live,w.service.app.snapshots);
    const phone=w.service.app.live.readLayered(w.model.id).semantic.properties.find(p=>p.entityTypeId==='person'&&p.name==='电话')!.id;
    const request={target:{entityTypeId:'person'},fields:[phone],filters:[{propertyId:phone,op:'eq',value:'10002'}]};
    assert.deepEqual((await query.execute(request,{modelRef:ref(w.model)})).items,[{$id:'P2',values:{[phone]:'10002'}}]);
    await w.adopt('identity_decision',{ruleId:effect.ruleId,left:{bindingId:effect.leftBindingId,recordId:'H2'},right:null,decision:'no_match',reason:'排除通讯录机器人',evidence:'人核'});
    assert.deepEqual((await query.execute(request,{modelRef:ref(w.model)})).items,[]);
    assert.deepEqual((await query.execute(request,{modelRef:ref(w.model),identityDecisionPins:false})).items,[{$id:'P2',values:{[phone]:'10002'}}]);
  }finally{await w.close();}
});

test('one query traverses both directions, filters target attributes, and aggregates full groups',async()=>{
  const w=await identityWorkspace();
  try {
    const adopted=await w.adopt('identity_rule',{kind:'belongs_to',left:{bindingId:w.binding('account'),columns:['email']},right:{bindingId:w.binding('person'),columns:['email']},transform:{op:'none'},relationName:'属于',reason:'账号归属人员',evidence:'邮箱对应'});
    const effect=adopted.content.effect as any,layered=w.service.app.live.readLayered(w.model.id);
    const name=layered.semantic.properties.find(p=>p.entityTypeId==='person'&&p.name==='姓名')!.id;
    const user=layered.semantic.properties.find(p=>p.entityTypeId==='account'&&p.name==='用户名')!.id;
    const query=new SemanticQuery(w.service.app.memory,w.service.app.live,w.service.app.snapshots);
    const forward=await query.execute({target:{entityTypeId:'account'},traverse:[{relationTypeId:effect.relationTypeId}],fields:[name],filters:[{propertyId:name,op:'eq',value:'甲'}]}, {modelRef:ref(w.model)});
    assert.deepEqual(forward.items,[{$id:'P1',values:{[name]:'甲'}}]);
    const reverse=await query.execute({target:{entityTypeId:'person',id:'P1'},traverse:[{relationTypeId:effect.relationTypeId,direction:'in'}],fields:[user]}, {modelRef:ref(w.model)});
    assert.deepEqual(reverse.items.map(i=>i.$id),['A1','ci-bot']);
    const aggregate=await query.execute({target:{entityTypeId:'account'},aggregate:{groupBy:[user],measures:[{as:'accounts',op:'count'}]}}, {modelRef:ref(w.model)});
    assert.deepEqual(aggregate.items.map(i=>i.values),[{[user]:'alice',accounts:1},{[user]:'bob',accounts:1},{[user]:'ci-bot',accounts:1}]);
    const scope={entityTypeIds:new Set(['person','account']),propertyIds:new Set([name]),relationTypeIds:new Set([effect.relationTypeId])};
    await assert.rejects(query.execute({target:{entityTypeId:'account'},aggregate:{groupBy:[user],measures:[{as:'n',op:'count'}]}},{modelRef:ref(w.model),scope}),/授权/);
  }finally{await w.close();}
});

test('self-reference traversal bounds depth and reports cycles instead of silently presenting a complete path',async()=>{
  const {queryTableFixture}=await import('./query-table-fixture.ts');
  const w=await queryTableFixture('id,parent\nA,B\nB,C\nC,A\nD,E\nE,F\nF,G\nG,H\nH,I\nI,J\nJ,K\nK,L\nL,M\nM,N\nN,O\nO,\n');
  try {
    const layered=w.live.readLayered(w.model.id),entity=layered.semantic.entityTypes[0],binding=layered.bindings.entities[0];
    layered.semantic.relationTypes.push({id:'parent',name:'上级',description:'自引用',aliases:[],from:entity.id,to:entity.id,direction:'directed',cardinality:'N:1',allowSelf:true});
    layered.bindings.relations.push({id:'parent-binding',relationTypeId:'parent',fromBindingId:binding.id,toBindingId:binding.id,kind:'foreign_key',fromColumns:['parent'],toColumns:['id']});
    const proposed=await w.live.propose({purpose:'自引用',rationale:'层级路径',layered});const model=await w.live.adopt(proposed.id,proposed.version);
    const request={target:{entityTypeId:entity.id,id:'A'},traverse:[{relationTypeId:'parent',recursive:true}],fields:[]};
    const cyclic=await w.query.execute(request,{modelRef:ref(model)});
    assert.equal(cyclic.traversal?.cycleDetected,true);assert.equal(cyclic.traversal?.truncated,false);
    assert.deepEqual(new Set(cyclic.items.map(i=>i.$id)),new Set(['A','B','C']));
    assert.deepEqual(cyclic.paths?.find(p=>p.objectId==='A')?.paths,[['A','B','C','A']]);
    const deep=await w.query.execute({...request,target:{entityTypeId:entity.id,id:'D'}},{modelRef:ref(model)});
    assert.equal(deep.traversal?.truncated,true);assert.equal(deep.traversal?.maxDepth,10);assert.equal(deep.coverage.complete,false);
    assert.equal(deep.items.length,10);
  }finally{await w.close();}
});

test('100,000 real snapshot rows support numeric ordering, full aggregates and the 1000-group bound',async(t)=>{
  const {queryTableFixture}=await import('./query-table-fixture.ts');
  const csv='id,score,product\n'+Array.from({length:100000},(_,i)=>`${i},${i},P${i%10}\n`).join('');
  const w=await queryTableFixture(csv);
  try{
    const layered=w.live.readLayered(w.model.id),entity=layered.semantic.entityTypes[0];
    const score=layered.semantic.properties.find(p=>p.name==='score')!,product=layered.semantic.properties.find(p=>p.name==='product')!,id=entity.identityKeys[0];
    score.valueType='decimal';layered.bindings.properties.find(p=>p.propertyId===score.id)!.transform={op:'cast',valueType:'decimal'};
    const proposed=await w.live.propose({purpose:'数值查询',rationale:'明示数值转换',layered}),model=await w.live.adopt(proposed.id,proposed.version);
    const start=Date.now();
    const filtered=await w.query.execute({target:{entityTypeId:entity.id},fields:[score.id],filters:[{propertyId:score.id,op:'gte',value:99900}],sort:[{propertyId:score.id,direction:'desc'}],page:{offset:1,limit:2}},{modelRef:ref(model)});
    assert.deepEqual(filtered.items,[{$id:'99998',values:{[score.id]:99998}},{$id:'99997',values:{[score.id]:99997}}]);assert.equal(filtered.coverage.total,100);
    const full=await w.query.execute({target:{entityTypeId:entity.id},aggregate:{measures:[{as:'n',op:'count'},{as:'total',op:'sum',propertyId:score.id},{as:'average',op:'avg',propertyId:score.id},{as:'minimum',op:'min',propertyId:score.id},{as:'maximum',op:'max',propertyId:score.id}]}},{modelRef:ref(model)});
    assert.deepEqual(full.items[0].values,{n:100000,total:4999950000,average:49999.5,minimum:0,maximum:99999});
    const grouped=await w.query.execute({target:{entityTypeId:entity.id},aggregate:{groupBy:[product.id],measures:[{as:'n',op:'count'}]}},{modelRef:ref(model)});
    assert.equal(grouped.items.length,10);assert.ok(grouped.items.every(i=>i.values.n===10000));
    await assert.rejects(w.query.execute({target:{entityTypeId:entity.id},aggregate:{groupBy:[id],measures:[{as:'n',op:'count'}]}},{modelRef:ref(model)}),/1000/);
    const elapsed=Date.now()-start;t.diagnostic(`100000-row filter + total + grouped + rejected oversized groups: ${elapsed} ms`);assert.ok(elapsed<15000);
  }finally{await w.close();}
});

test('twenty objects with three supplements resolve all sixty values through batched snapshot matching',async()=>{
  const {queryTableFixture}=await import('./query-table-fixture.ts'),{Readable}=await import('node:stream');
  const w=await queryTableFixture('id,name\n'+Array.from({length:20},(_,i)=>`P${i},人员${i}\n`).join(''));
  try{
    const supplements=[];
    for(let n=1;n<=3;n++){
      const source=(await w.files.import({name:`supplement${n}.csv`,input:Readable.from([Buffer.from('id,person,value\n'+Array.from({length:20},(_,i)=>`S${i},P${i},值${n}-${i}\n`).join(''))])})).sources[0];
      const connection=w.live.sources.connectUpload(source.id,source.version,'id');
      supplements.push({name:`补充${n}`,sourceId:connection.id,capability:'records',match:{primaryField:'$id',sourceField:'person'},fields:{['属性'+n]:'value'},rationale:'采用同一身份对应'});
    }
    await w.snapshots.sync({operationId:'supplements'});
    const candidate=await w.live.propose({purpose:'批量补充',rationale:'已授权补充规则',types:[{name:'对象',description:'测试对象',sourceId:w.connection.id,capability:'records',fields:{name:'name'},supplements}],relations:[]});
    const model=await w.live.adopt(candidate.id,candidate.version);
    const old=await w.live.query({modelId:model.id,type:'对象',limit:20});
    assert.equal(old.items.length,20);assert.ok(old.items.every(row=>[1,2,3].every(n=>typeof row['属性'+n]==='string')));
    assert.ok(old.evidence!.every(e=>e.matches.every(m=>m.status==='unique')));
    const layer=w.live.readLayered(model.id),entity=layer.semantic.entityTypes[0];
    const result=await w.query.execute({target:{entityTypeId:entity.id}},{modelRef:ref(model)});
    assert.equal(result.items.length,20);assert.ok(result.evidence.every(e=>Object.values(e.properties).every(p=>p.status==='resolved')));
  }finally{await w.close();}
});

test('link-table traversal and fixed correction sets preserve governed relation results',async()=>{
  const w=await identityWorkspace();
  try{
    const change=await w.adopt('identity_rule',{kind:'belongs_to',left:{bindingId:w.binding('account'),columns:['email']},right:{bindingId:w.binding('person'),columns:['email']},relationName:'归属',reason:'身份归属',evidence:'名册'}),effect=change.content.effect as any;
    const query=new SemanticQuery(w.service.app.memory,w.service.app.live,w.service.app.snapshots),request={target:{entityTypeId:'account',id:'A1'},traverse:[{relationTypeId:effect.relationTypeId}],fields:[]};
    assert.equal((await query.execute(request,{modelRef:ref(w.model)})).items[0].$id,'P1');
    const proposal=await w.call('/api/live/corrections/propose',{operationId:'correction',target:{modelId:w.model.id,modelVersion:w.model.version,type:'账号',objectId:'A1',relation:'归属'},targetIds:[],reason:'错误对应',evidence:'核对排除'});
    assert.equal(proposal.status,200,JSON.stringify(proposal.body));
    const tracked=w.service.app.changes.list({type:'local_correction'}).changes.find(c=>(c.owner as any)?.id===proposal.body.saved.id)!;
    const verified=await w.service.app.changes.verify({operationId:'verify-correction',...ref(tracked)});
    await w.service.app.changes.adopt({operationId:'adopt-correction',...ref(verified),acknowledgeReview:true});
    assert.deepEqual((await query.execute(request,{modelRef:ref(w.model)})).items,[]);
    assert.equal((await query.execute(request,{modelRef:ref(w.model),correctionPins:new Set()})).items[0].$id,'P1');
  }finally{await w.close();}
  const {queryTableFixture}=await import('./query-table-fixture.ts'),{Readable}=await import('node:stream');
  const f=await queryTableFixture('id,name\nA,任务甲\nB,任务乙\n');
  try{
    const importFile=async(name:string,content:string,id:string)=>{const source=(await f.files.import({name,input:Readable.from([Buffer.from(content)])})).sources[0];return f.live.sources.connectUpload(source.id,source.version,id);};
    const products=await importFile('products.csv','id,name\nX,产品一\nY,产品二\n','id'),links=await importFile('links.csv','id,task,product\n1,A,X\n2,A,Y\n3,B,Y\n','id');
    await f.snapshots.sync({operationId:'links'});
    const proposed=await f.live.propose({purpose:'中间表关系',rationale:'明确任务产品对应',types:[{name:'任务',description:'任务',sourceId:f.connection.id,capability:'records',fields:{名称:'name'}},{name:'产品',description:'产品',sourceId:products.id,capability:'records',fields:{名称:'name'}}],relations:[{name:'关联产品',from:'任务',to:'产品',fromField:'$id',toField:'$id',fromColumns:['id'],toColumns:['id'],linkTable:{sourceId:links.id,capability:'records',fromColumns:['task'],toColumns:['product']}}]});
    const model=await f.live.adopt(proposed.id,proposed.version),layered=f.live.readLayered(model.id),entity=layered.semantic.entityTypes.find(e=>e.name==='任务')!,relation=layered.semantic.relationTypes[0];
    const result=await f.query.execute({target:{entityTypeId:entity.id,id:'A'},traverse:[{relationTypeId:relation.id}],fields:[]},{modelRef:ref(model)});
    assert.deepEqual(result.items.map(i=>i.$id),['X','Y']);
  }finally{await f.close();}
});

test('numeric predicates retain value types and integer transforms reject fractional facts',async()=>{
  const {queryTableFixture}=await import('./query-table-fixture.ts');
  const w=await queryTableFixture('id,amount\nA,1\nB,2\nC,3\nD,1.5\n');
  try{
    const layer=w.live.readLayered(w.model.id),entity=layer.semantic.entityTypes[0],amount=layer.semantic.properties.find(p=>p.name==='amount')!;
    layer.bindings.properties.find(p=>p.propertyId===amount.id)!.transform={op:'cast',valueType:'decimal'};
    const proposal=await w.live.propose({purpose:'数值过滤',rationale:'数值事实',layered:layer}),model=await w.live.adopt(proposal.id,proposal.version);
    assert.deepEqual((await w.query.execute({target:{entityTypeId:entity.id},fields:[amount.id],filters:[{propertyId:amount.id,op:'eq',value:1}]},{modelRef:ref(model)})).items,[{$id:'A',values:{[amount.id]:1}}]);
    layer.bindings.properties.find(p=>p.propertyId===amount.id)!.transform={op:'cast',valueType:'integer'};
    const invalid=await w.live.propose({purpose:'整数过滤',rationale:'整数事实',layered:layer}),adopted=await w.live.adopt(invalid.id,invalid.version);
    await assert.rejects(w.query.execute({target:{entityTypeId:entity.id,id:'D'}},{modelRef:ref(adopted)}),/整数|数值转换/);
  }finally{await w.close();}
});

test('aggregation does not turn ambiguous fused values into a known zero or group',async()=>{
  const w=await identityWorkspace();
  try{
    await w.adopt('identity_rule',{kind:'same_as',left:{bindingId:w.binding('staff'),columns:['email']},right:{bindingId:w.binding('person'),columns:['email']},reason:'通讯资料补充',evidence:'独立核对'});
    const phone=w.service.app.live.readLayered(w.model.id).semantic.properties.find(p=>p.entityTypeId==='person'&&p.name==='电话')!.id;
    w.rows.staff.push({id:'H3',email:'alice@example.test',phone:'99999'});await w.service.app.snapshots.sync({operationId:'ambiguous',sourceIds:[w.sources.staff.id]});
    const query=new SemanticQuery(w.service.app.memory,w.service.app.live,w.service.app.snapshots);
    const aggregate=await query.execute({target:{entityTypeId:'person'},aggregate:{measures:[{as:'knownPhones',op:'count',propertyId:phone}]}},{modelRef:ref(w.model)});
    assert.equal(aggregate.items[0].values.knownPhones,null);assert.equal(aggregate.coverage.complete,false);
    assert.equal(aggregate.aggregateEvidence?.[0].measures.knownPhones.uncertain,1);
    for(const filter of [{propertyId:phone,op:'is_null'},{propertyId:phone,op:'eq',value:null}]){const filtered=await query.execute({target:{entityTypeId:'person'},fields:[phone],filters:[filter]},{modelRef:ref(w.model)});assert.deepEqual(filtered.items,[]);assert.equal(filtered.coverage.uncertainFilterRows,1);}
    await assert.rejects(query.execute({target:{entityTypeId:'person'},aggregate:{groupBy:[phone],measures:[{as:'people',op:'count'}]}},{modelRef:ref(w.model)}),/分组.*不确定|分组.*冲突/);
  }finally{await w.close();}
});

test('source columns cannot shadow query object identity and composite identities round-trip',async()=>{
  const {queryTableFixture}=await import('./query-table-fixture.ts');
  const w=await queryTableFixture('id,__id,country,local\nA,not-A,CN,001\nB,not-B,US,002\n');
  try{
    const layered=w.live.readLayered(w.model.id),entity=layered.semantic.entityTypes[0];
    const raw=await w.query.execute({target:{entityTypeId:entity.id},fields:[]},{modelRef:ref(w.model)});assert.deepEqual(raw.items.map(i=>i.$id),['A','B']);
    const keys=['country','local'].map(name=>layered.semantic.properties.find(p=>p.name===name)!.id);
    entity.identityKeys=keys;for(const property of layered.semantic.properties)property.isIdentity=keys.includes(property.id);
    layered.bindings.entities[0].keyColumns=['country','local'];
    const proposed=await w.live.propose({purpose:'复合身份',rationale:'国家与本地编号',layered}),model=await w.live.adopt(proposed.id,proposed.version);
    const legacy=await w.live.query({modelId:model.id,type:'对象',limit:20});
    const id=String(legacy.items[0].$id),result=await w.query.execute({target:{entityTypeId:entity.id,id},fields:[]},{modelRef:ref(model)});
    assert.deepEqual(result.items,[{$id:id,values:{}}]);
  }finally{await w.close();}
});

test('incomplete identity targets do not become formal belonging edges',async()=>{
  const w=await identityWorkspace();
  try{
    const changed=await w.adopt('identity_rule',{kind:'belongs_to',left:{bindingId:w.binding('account'),columns:['email']},right:{bindingId:w.binding('person'),columns:['email']},relationName:'归属',reason:'需唯一归属',evidence:'名册'}),relationTypeId=(changed.content.effect as any).relationTypeId;
    const previous=process.env.ADE_SNAPSHOT_MAX_ROWS;process.env.ADE_SNAPSHOT_MAX_ROWS='1';
    try{await w.service.app.snapshots.sync({operationId:'partial',sourceIds:[w.sources.people.id]});}finally{if(previous===undefined)delete process.env.ADE_SNAPSHOT_MAX_ROWS;else process.env.ADE_SNAPSHOT_MAX_ROWS=previous;}
    const query=new SemanticQuery(w.service.app.memory,w.service.app.live,w.service.app.snapshots),result=await query.execute({target:{entityTypeId:'account',id:'A1'},traverse:[{relationTypeId}],fields:[]},{modelRef:ref(w.model)});
    assert.deepEqual(result.items,[]);assert.equal(result.coverage.sourceComplete,false);assert.equal(result.coverage.total,null);
  }finally{await w.close();}
});

test('stable semantic property IDs cannot collide with internal query columns',async()=>{
  const {queryTableFixture}=await import('./query-table-fixture.ts');
  const w=await queryTableFixture('id,amount,status\nA,10,开放\n');
  try{
    const layered=w.live.readLayered(w.model.id),entity=layered.semantic.entityTypes[0];
    for(const [name,id] of [['amount','__id'],['status','__status___id']]){
      const property=layered.semantic.properties.find(p=>p.name===name)!,old=property.id;property.id=id;
      for(const binding of layered.bindings.properties)if(binding.propertyId===old)binding.propertyId=id;
    }
    const proposal=await w.live.propose({purpose:'稳定ID边界',rationale:'允许业务语义ID',layered}),model=await w.live.adopt(proposal.id,proposal.version);
    const result=await w.query.execute({target:{entityTypeId:entity.id},fields:['__id','__status___id'],filters:[{propertyId:'__id',op:'eq',value:'10'}]},{modelRef:ref(model)});
    assert.deepEqual(result.items,[{$id:'A',values:{__id:'10',__status___id:'开放'}}]);
    const aggregate=await w.query.execute({target:{entityTypeId:entity.id},aggregate:{groupBy:['__id'],measures:[{as:'__uncertain___id',op:'count'}]}},{modelRef:ref(model)});
    assert.deepEqual(aggregate.items[0].values,{__id:'10',__uncertain___id:1});
  }finally{await w.close();}
});

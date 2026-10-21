import {test} from 'node:test';
import assert from 'node:assert/strict';
import {identityWorkspace,ref} from './identity-fixture.ts';
import {connectLocalChanges} from '../../src/engine/local-changes.ts';
import {SemanticQuery} from '../../src/semantic/query.ts';

test('adopted property values participate in semantic filters, sorting, grouping and legacy predicates',async()=>{
  const w=await identityWorkspace(),app=w.service.app;
  try{
    connectLocalChanges(app.memory,app.live,app.changes);
    const phone=app.live.readLayered(w.model.id).semantic.properties.find(p=>p.entityTypeId==='staff'&&p.name==='电话')!.id;
    await w.adopt('local_correction',{kind:'property',entityTypeId:'staff',objectId:'H1',propertyId:phone,value:'99999',reason:'号码更正',evidence:'当事人确认'});
    const query=new SemanticQuery(app.memory,app.live,app.snapshots),request={target:{entityTypeId:'staff'},fields:[phone]};
    const selected=await query.execute({...request,filters:[{propertyId:phone,op:'eq',value:'99999'}]});
    assert.deepEqual(selected.items,[{$id:'H1',values:{[phone]:'99999'}}]);
    assert.match(JSON.stringify(selected.evidence),/10001/);
    assert.deepEqual((await query.execute({...request,filters:[{propertyId:phone,op:'eq',value:'10001'}]})).items,[]);
    assert.deepEqual((await query.execute({...request,sort:[{propertyId:phone,direction:'desc'}]})).items.map(i=>i.$id),['H1','H2']);
    const grouped=await query.execute({target:{entityTypeId:'staff'},aggregate:{groupBy:[phone],measures:[{as:'n',op:'count'}]}});
    assert.deepEqual(new Set(grouped.items.map(i=>i.values[phone])),new Set(['99999','10002']));
    assert.equal((await query.execute({...request,target:{entityTypeId:'staff',id:'H1'}},{propertyCorrectionPins:false})).items[0].values[phone],'10001');
    const legacy=await app.live.query({modelId:w.model.id,type:'外部人员',where:{电话:'99999'}});
    assert.equal(legacy.items[0].电话,'99999');assert.match(JSON.stringify(legacy.evidence),/10001/);
    assert.deepEqual((await app.live.query({modelId:w.model.id,type:'外部人员',where:{电话:'10001'}})).items,[]);
  }finally{await w.close();}
});

test('an explicit null is resolved and is excluded from property counts while fixed empty pins retain raw values',async()=>{
  const w=await identityWorkspace(),app=w.service.app;
  try{
    connectLocalChanges(app.memory,app.live,app.changes);
    const phone=app.live.readLayered(w.model.id).semantic.properties.find(p=>p.entityTypeId==='staff'&&p.name==='电话')!.id;
    await w.adopt('local_correction',{kind:'property',entityTypeId:'staff',objectId:'H1',propertyId:phone,value:null,reason:'停用号码',evidence:'当事人确认'});
    const query=new SemanticQuery(app.memory,app.live,app.snapshots);
    const result=await query.execute({target:{entityTypeId:'staff'},fields:[phone],filters:[{propertyId:phone,op:'is_null'}]});
    assert.deepEqual(result.items,[{$id:'H1',values:{[phone]:null}}]);assert.equal(result.evidence[0].properties[phone].status,'resolved');
    const count=await query.execute({target:{entityTypeId:'staff'},aggregate:{measures:[{as:'n',op:'count',propertyId:phone}]}});
    assert.equal(count.items[0].values.n,1);
    const original=await app.live.query({modelId:w.model.id,type:'外部人员',id:'H1'},undefined,true,undefined,false,undefined,undefined,true,undefined,new Set());
    assert.equal(original.items[0].电话,'10001');
  }finally{await w.close();}
});

test('relation corrections retain raw membership facts while their returned objects apply exact property pins',async()=>{
  const w=await identityWorkspace(),app=w.service.app;
  try{
    connectLocalChanges(app.memory,app.live,app.changes);
    const rule=await w.adopt('identity_rule',{kind:'belongs_to',left:{bindingId:w.binding('account'),columns:['email']},right:{bindingId:w.binding('staff'),columns:['email']},relationName:'通信人员',reason:'账号通信对象',evidence:'名册核对'});
    const relation=(rule.content.effect as any).relationTypeId;
    const phone=app.live.readLayered(w.model.id).semantic.properties.find(p=>p.entityTypeId==='staff'&&p.name==='电话')!.id;
    await w.adopt('local_correction',{kind:'relation',entityTypeId:'account',objectId:'A1',relationTypeId:relation,targetIds:['H2'],reason:'人工指定',evidence:'人核'});
    await w.adopt('local_correction',{kind:'property',entityTypeId:'staff',objectId:'H2',propertyId:phone,value:'99999',reason:'号码更正',evidence:'人核'});
    const input={modelId:w.model.id,type:'账号',id:'A1',relation:'通信人员'};
    const current=await app.live.query(input);assert.equal(current.items[0].$id,'H2');assert.equal(current.items[0].电话,'99999');
    const original=await app.live.query(input,undefined,true,undefined,false,undefined,undefined,true,undefined,new Set());
    assert.equal(original.items[0].电话,'10002');
    const semantic=await new SemanticQuery(app.memory,app.live,app.snapshots).execute({target:{entityTypeId:'account',id:'A1'},traverse:[{relationTypeId:relation}],fields:[phone]});
    assert.deepEqual(semantic.items,[{$id:'H2',values:{[phone]:'99999'}}]);
  }finally{await w.close();}
});

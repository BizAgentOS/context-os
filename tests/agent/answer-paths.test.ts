import {test} from 'node:test';
import assert from 'node:assert/strict';
import {identityWorkspace,ref} from './identity-fixture.ts';
import {SemanticQuery} from '../../src/semantic/query.ts';

test('three-hop answers retain the actual intermediate objects and relation directions without extra reads',async()=>{
  const w=await identityWorkspace();
  try{
    const adopted=await w.adopt('identity_rule',{kind:'belongs_to',left:{bindingId:w.binding('account'),columns:['email']},right:{bindingId:w.binding('person'),columns:['email']},relationName:'属于',reason:'账号归属人员',evidence:'邮箱对应'});
    const relationId=String((adopted.content.effect as any).relationTypeId),query=new SemanticQuery(w.service.app.memory,w.service.app.live,w.service.app.snapshots);
    const answer=await query.execute({target:{entityTypeId:'account',id:'A1'},traverse:[{relationTypeId:relationId},{relationTypeId:relationId,direction:'in'},{relationTypeId:relationId}]},{modelRef:ref(w.model)});
    assert.deepEqual(answer.items.map(item=>item.$id),['P1']);
    assert.deepEqual(answer.paths?.[0].paths,[['A1','P1','A1','P1'],['A1','P1','ci-bot','P1']]);
    assert.deepEqual((answer.paths?.[0] as any).traces[0].entityTypeIds,['account','person','account','person']);
    assert.deepEqual((answer.paths?.[0] as any).traces[0].relationTypeIds,[relationId,relationId,relationId]);
    assert.equal((answer.paths?.[0] as any).coverage.complete,true);
  }finally{await w.close();}
});

test('path and aggregate member receipts report their twenty-item limits accurately',async()=>{
  const {queryTableFixture}=await import('./query-table-fixture.ts');
  const w=await queryTableFixture('id,parent\nR,\n'+Array.from({length:25},(_,i)=>`C${String(i).padStart(2,'0')},R\n`).join(''));
  try{
    const layer=w.live.readLayered(w.model.id),entity=layer.semantic.entityTypes[0],binding=layer.bindings.entities[0],parent=layer.semantic.properties.find(item=>item.name==='parent')!;
    layer.semantic.relationTypes.push({id:'parent',name:'上级',description:'层级',aliases:[],from:entity.id,to:entity.id,direction:'directed',cardinality:'N:1',allowSelf:true});
    layer.bindings.relations.push({id:'parent-binding',relationTypeId:'parent',fromBindingId:binding.id,toBindingId:binding.id,kind:'foreign_key',fromColumns:['parent'],toColumns:['id']});
    const proposal=await w.live.propose({purpose:'路径与组样本',rationale:'实际25个子节点',layered:layer}),model=await w.live.adopt(proposal.id,proposal.version);
    const paths=await w.query.execute({target:{entityTypeId:entity.id,id:'R'},traverse:[{relationTypeId:'parent',direction:'in'},{relationTypeId:'parent'}],fields:[]},{modelRef:ref(model)});
    assert.equal(paths.paths![0].paths.length,20);assert.deepEqual(paths.paths![0].coverage,{total:25,shown:20,complete:false});
    const aggregate=await w.query.execute({target:{entityTypeId:entity.id},fields:[parent.id],aggregate:{groupBy:[parent.id],measures:[{as:'数量',op:'count'}]}},{modelRef:ref(model),includeGroupMembers:true});
    const group=aggregate.items.find(item=>item.values[parent.id]==='R')!;
    assert.equal(group.values.数量,25);assert.deepEqual(aggregate.groupMembers!.find(item=>item.groupId===group.$id)!.coverage,{total:25,shown:20,complete:false});
  }finally{await w.close();}
});

test('aggregate answers carry a bounded authorized member sample for each returned group',async()=>{
  const w=await identityWorkspace();
  try{
    const query=new SemanticQuery(w.service.app.memory,w.service.app.live,w.service.app.snapshots),layer=w.service.app.live.readLayered(w.model.id);
    const email=layer.semantic.properties.find(p=>p.entityTypeId==='account'&&p.name==='邮箱')!.id,user=layer.semantic.properties.find(p=>p.entityTypeId==='account'&&p.name==='用户名')!.id;
    const answer=await query.execute({target:{entityTypeId:'account'},fields:[user],aggregate:{groupBy:[email],measures:[{as:'数量',op:'count'}]}},{includeGroupMembers:true,modelRef:ref(w.model),scope:{entityTypeIds:new Set(['account']),propertyIds:new Set([email,user]),relationTypeIds:new Set()}});
    const group=answer.items.find(item=>item.values[email]==='alice@example.test')!;
    const members=(answer as any).groupMembers.find((item:any)=>item.groupId===group.$id);
    assert.deepEqual(members.items,[{$id:'A1',values:{[user]:'alice'},status:{[user]:'resolved'}},{$id:'ci-bot',values:{[user]:'ci-bot'},status:{[user]:'resolved'}}]);
    assert.deepEqual(members.coverage,{total:2,shown:2,complete:true});
    assert.equal(members.items[0].values[email],undefined,'members use only the requested visible fields');
  }finally{await w.close();}
});

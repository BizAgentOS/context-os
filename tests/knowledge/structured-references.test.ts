import {test} from 'node:test';
import assert from 'node:assert/strict';
import {crossTableReferences} from '../../src/knowledge/structured-references.ts';
import {structuredCandidates,TableProfiler,commentCodes} from '../../src/knowledge/structured-profile.ts';
import type {DiscoverySource} from '../../src/knowledge/discovery.ts';
const source=(n:number,name:string,columns:string[],rows:Record<string,string>[],metadata:Record<string,unknown>={}):DiscoverySource=>({id:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,kind:'table',sourceNamespace:`source.${n}`,keyColumn:'id',columns,rows,warnings:[],coverage:{sampled:rows.length,total:100},metadata:{name,columns:columns.map(name=>({name,type:'integer'})),...metadata}});
test('no FK and different endpoint names preserve every key suggestion and zero-match definitions',()=>{
 const a=source(1,'branch',['id','quyu_id','create_by','update_by'],[{id:'1',quyu_id:'9',create_by:'2',update_by:'2'}]);
 const b=source(2,'quyu',['code'],[{code:'9'}],{uniqueKeys:[['code']],comment:'区域业务编号'});
 const c=source(3,'users',['id'],[{id:'2'}],{primaryKey:['id']});
 const input=[a,b,c],before=structuredClone(input);
 const result=crossTableReferences(input,[{types:[{id:'type.quyu',sourceColumns:[{sourceVersionId:b.id,column:'code'}]}]}]);
 const reference=result.find(r=>r.columns[0]==='quyu_id')!;
 assert.ok(reference.alternatives.some(t=>t.targetCandidateTypes.includes('type.quyu')&&t.dataMatch.matched===1));
 assert.ok(reference.alternatives.some(t=>t.dataMatch.status==='sample_no_match'));
 assert.equal(reference.adoption,'requires_explicit_coordination');assert.equal(reference.identityMerge,false);
 assert.ok(result.some(r=>r.columns[0]==='create_by'));assert.ok(result.some(r=>r.columns[0]==='update_by'));
 assert.deepEqual(input,before);
});
test('declared differently named composite references stay ordered tuples; self and middle-table roles survive',()=>{
 const target=source(2,'people',['tenant','id'],[{tenant:'7',id:'2'}],{primaryKey:['tenant','id']});
 const relation=source(1,'members',['tenant_id','user_id','role_id'],[{tenant_id:'7',user_id:'2',role_id:'3'}],{foreignKeys:[{name:'owner',column:'tenant_id',targetTable:'people',targetColumn:'tenant',ordinal:1},{name:'owner',column:'user_id',targetTable:'people',targetColumn:'id',ordinal:2}]});
 const result=crossTableReferences([relation,target],[]);
 const match=result.find(r=>r.columns[0]==='user_id')!.alternatives.find(r=>r.targetSourceVersionId===target.id)!;
 assert.deepEqual(match.sourceColumns,['tenant_id','user_id']);assert.deepEqual(match.targetColumns,['tenant','id']);assert.equal(match.dataMatch.matched,1);
 assert.ok(result.some(r=>r.columns[0]==='role_id'));assert.ok(!result.find(r=>r.sourceVersionId===target.id)!.alternatives.some(r=>r.targetSourceVersionId===target.id&&r.sourceColumns.join()===r.targetColumns.join()));
});
test('SQL enums, comment codes and complete safe observations retain separate provenance',()=>{
 const content=source(1,'status',['id','status'],Array.from({length:8},(_,i)=>({id:String(i),status:String(i)})),{columns:[{name:'status',type:'tinyint',comment:'0禁用1启用'},{name:'declared',type:"enum('A','B')"}]});
 const profiler=new TableProfiler(['status']);profiler.add(content.rows!.map(row=>({values:row})));content.metadata!.profile=profiler.finish();
 const view=structuredCandidates(content);
 assert.deepEqual(view.columns[0].commentCodeCandidates,[{code:'0',meaning:'禁用'},{code:'1',meaning:'启用'}]);assert.equal(view.columns[0].enumValues,undefined);
 assert.deepEqual(view.columns[1].enumValues,['A','B']);assert.equal(view.columns[1].enumBasis,'database_declaration');
 assert.equal(view.profile.columns[0].observedValues.length,8);assert.equal(('valuesTruncated' in view.profile.columns[0]?view.profile.columns[0].valuesTruncated:undefined),false);
 assert.equal(structuredCandidates(content,true).profile.columns[0].observedValues.length,5);
});

test('undeclared differently named composite references remain unresolved suggestions',()=>{
 const a=source(1,'entries',['tenant_id','user_id'],[{tenant_id:'7',user_id:'99'}]);
 const b=source(2,'people',['tenant','number'],[{tenant:'7',number:'2'}],{uniqueKeys:[['tenant','number']]});
 const reference=crossTableReferences([a,b],[]).find(r=>r.columns[0]==='user_id')!.alternatives.find(r=>r.targetSourceVersionId===b.id)!;
 assert.deepEqual(reference.targetColumns,['tenant','number']);assert.equal(reference.bindingValidity,'composite_mapping_unknown');assert.equal(reference.dataMatch.status,'not_checked');
});

test('composite foreign keys keep roles separate even when declaration rows are interleaved',()=>{
 const target=source(2,'people',['tenant','id'],[{tenant:'7',id:'2'},{tenant:'8',id:'3'}],{primaryKey:['tenant','id']});
 const a=source(1,'audit',['created_tenant','created_user','approved_tenant','approved_user'],[{created_tenant:'7',created_user:'2',approved_tenant:'8',approved_user:'3'}],{foreignKeys:[
 {name:'creator',column:'created_user',targetTable:'people',targetColumn:'id',ordinal:2},{name:'approver',column:'approved_tenant',targetTable:'people',targetColumn:'tenant',ordinal:1},
 {name:'creator',column:'created_tenant',targetTable:'people',targetColumn:'tenant',ordinal:1},{name:'approver',column:'approved_user',targetTable:'people',targetColumn:'id',ordinal:2}]});
 const result=crossTableReferences([a,target],[]);
 const created=result.find(r=>r.columns[0]==='created_user')!.alternatives.filter(a=>a.bindingBasis==='declared_foreign_key');
 const approved=result.find(r=>r.columns[0]==='approved_user')!.alternatives.filter(a=>a.bindingBasis==='declared_foreign_key');
 assert.ok(created.some(a=>JSON.stringify(a.sourceColumns)===JSON.stringify(['created_tenant','created_user'])));
 assert.ok(approved.some(a=>JSON.stringify(a.sourceColumns)===JSON.stringify(['approved_tenant','approved_user'])));
 assert.ok([...created,...approved].every(a=>!a.sourceColumns.includes('created_tenant')||!a.sourceColumns.includes('approved_user')));
});
test('undeclared id and key candidates bind only classes evidenced by the actual key columns',()=>{
 const a=source(1,'invoice',['customer_key'],[{customer_key:'4'}]);
 const b=source(2,'mixed',['customer_id','audit_id'],[{customer_id:'4',audit_id:'9'}]);
 const result=crossTableReferences([a,b],[{types:[{id:'Customer',properties:[{sourceColumns:[{sourceVersionId:b.id,column:'customer_id'}]}]},{id:'Audit',properties:[{sourceColumns:[{sourceVersionId:b.id,column:'audit_id'}]}]}]}]);
 const candidate=result.find(r=>r.columns[0]==='customer_key')!.alternatives.find(a=>a.targetColumns.length===1&&a.targetColumns[0]==='customer_id')!;
 assert.ok(candidate);assert.deepEqual(candidate.targetCandidateTypes,['Customer']);assert.equal(candidate.businessMeaning,'unconfirmed');
});


test('fixed-version tuple search suggests renamed composite columns without choosing identity',()=>{
 const a=source(1,'entries',['tenant_id','user_id'],[{tenant_id:'7',user_id:'2'}]);
 const b=source(2,'people',['tenant','number'],[{tenant:'7',number:'2'}],{uniqueKeys:[['tenant','number']]});
 const suggestions=crossTableReferences([a,b],[]).find(r=>r.columns[0]==='user_id')!.alternatives;
 const candidate=suggestions.find(c=>c.targetSourceVersionId===b.id&&c.bindingBasis==='bounded_tuple_mapping_candidate')!;
 assert.deepEqual(candidate.sourceColumns,['tenant_id','user_id']);assert.deepEqual(candidate.targetColumns,['tenant','number']);assert.equal(candidate.dataMatch.matched,1);assert.equal(candidate.businessMeaning,'unconfirmed');assert.equal(candidate.identityMerge,false);
});


test('comment code candidates support string and mixed codes while preserving the historical numeric projection',()=>{
 assert.deepEqual(commentCodes('A1:启用 B2:禁用'),[{code:'A1',meaning:'启用'},{code:'B2',meaning:'禁用'}]);
 assert.deepEqual(commentCodes('0禁用 A:启用'),[{code:'0',meaning:'禁用'},{code:'A',meaning:'启用'}]);
 assert.deepEqual(commentCodes('A:启用 B:禁用',true),[]);
 assert.deepEqual(commentCodes('0禁用1启用'),commentCodes('0禁用1启用',true));
});

test('sampled non-overlap is never a complete zero-match claim, even when one side is fully loaded',()=>{
 const a=source(1,'entries',['id','user_id'],[{id:'1',user_id:'99'}],{primaryKey:['id']});
 const b=source(2,'users',['id'],[{id:'2'}],{primaryKey:['id']});
 const check=(left:DiscoverySource,right:DiscoverySource)=>crossTableReferences([left,right],[]).find(r=>r.sourceVersionId===left.id&&r.columns[0]==='user_id')!.alternatives.find(a=>a.targetSourceVersionId===right.id)!.dataMatch;
 const partial=check(a,b);assert.equal(partial.status,'sample_no_match');assert.equal(partial.checked,1);assert.equal(partial.targetChecked,1);
 assert.equal(partial.sourceScope.complete,false);assert.equal(partial.sourceScope.totalRows,100);
 assert.equal(check({...a,rowCount:1},b).status,'sample_no_match');
 const complete=check({...a,rowCount:1},{...b,rowCount:1});assert.equal(complete.status,'zero_match');assert.equal(complete.sourceScope.complete,true);assert.equal(complete.targetScope.complete,true);
 assert.equal(check({...a,coverage:undefined},{...b,coverage:undefined}).status,'sample_no_match');
 const many={...a,rows:Array.from({length:1001},(_,i)=>({id:String(i),user_id:'99'})),rowCount:1001};
 const capped=check(many,{...b,rowCount:1});assert.equal(capped.status,'sample_no_match');assert.equal(capped.checked,1000);assert.equal(capped.sourceScope.complete,false);
 assert.equal(check({...a,rowCount:1},{...b,rows:[],rowCount:0}).status,'zero_match');
});

test('self-reference filtering preserves distinct column mappings and explicitly declared identity roles',()=>{
 const tree=source(1,'tree',['id','upstream_code'],[{id:'1',upstream_code:'1'}],{primaryKey:['id']});
 const suggestions=crossTableReferences([tree],[]);
 assert.ok(!suggestions.flatMap(r=>r.alternatives).some(a=>a.sourceColumns.join()===a.targetColumns.join()));
 assert.ok(suggestions.flatMap(r=>r.alternatives).some(a=>a.sourceColumns.join()==='upstream_code'&&a.targetColumns.join()==='id'));
 const declared={...tree,metadata:{...tree.metadata,foreignKeys:[{name:'explicit_self',column:'id',targetTable:'tree',targetColumn:'id',ordinal:1}]}};
 assert.ok(crossTableReferences([declared],[]).flatMap(r=>r.alternatives).some(a=>a.role==='explicit_self'&&a.sourceColumns.join()==='id'&&a.targetColumns.join()==='id'));
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {relationshipValidation} from '../../src/knowledge/relationship-validation.ts';
import {crossTableReferences} from '../../src/knowledge/structured-references.ts';
import type {DiscoverySource} from '../../src/knowledge/discovery.ts';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const make=(n:number,name:string,columns:string[],rows:Record<string,string>[],pk:string[]=[]):DiscoverySource=>({id:id(n),kind:'table',keyColumn:columns[0],columns,rows,warnings:[],metadata:{name,columns:columns.map(name=>({name,type:'integer'})),primaryKey:pk}});
test('zero-match selected mappings keep the semantic definition and separate reasons, binding and data status',()=>{
 const a=make(1,'branch',['id','quyu_id'],[{id:'1',quyu_id:'99'}],['id']),b=make(2,'region',['id'],[{id:'7'}],['id']);
 const bind=(n:number,column:string)=>({sourceVersionId:id(n),column});
 const raw={types:[{id:'Branch',sourceColumns:[bind(1,'id')]},{id:'type.quyu',sourceColumns:[bind(2,'id')]}],links:[{id:'belongs',from:'Branch',to:'type.quyu',sourceColumns:[bind(1,'quyu_id'),bind(2,'id')]}]};
 const suggestion=crossTableReferences([a,b],[raw]).find(r=>r.columns[0]==='quyu_id')!.alternatives.find(c=>c.targetSourceVersionId===b.id)!;
 const result=relationshipValidation(raw,[a,b],[{memberId:'belongs',reason:'业务注释说明分所属于区域'}],[{linkId:'belongs',bindings:[{candidateRef:suggestion.ref,endpoint:'to'}],reason:'选择明确来源版本和键列'}]);
 assert.equal(result[0].dataMatch.status,'sample_no_match');assert.equal(result[0].sourceBinding.status,'selected_and_validated');assert.equal(raw.links.length,1);assert.deepEqual(result[0].businessMeaning.reasons,['业务注释说明分所属于区域']);
 assert.equal(relationshipValidation(raw,[a,b])[0].dataMatch.status,'not_checked');
 assert.throws(()=>relationshipValidation(raw,[a,b],[],[{linkId:'belongs',bindings:[{candidateRef:suggestion.ref,endpoint:'from'}],reason:'错误端点'}]),/端点/);
});
test('middle-table role bindings are checked jointly per record, never as unrelated single-column overlaps',()=>{
 const middle=make(1,'user_role',['user_id','role_id'],[{user_id:'1',role_id:'99'},{user_id:'99',role_id:'2'}]);
 const user=make(2,'users',['id'],[{id:'1'}],['id']),role=make(3,'roles',['id'],[{id:'2'}],['id']);
 const bind=(n:number,column:string)=>({sourceVersionId:id(n),column});
 const raw={types:[{id:'User',sourceColumns:[bind(2,'id')]},{id:'Role',sourceColumns:[bind(3,'id')]}],links:[{id:'membership',from:'User',to:'Role',sourceColumns:[bind(1,'user_id'),bind(1,'role_id'),bind(2,'id'),bind(3,'id')]}]};
 const suggestions=crossTableReferences([middle,user,role],[raw]);
 const u=suggestions.find(r=>r.sourceVersionId===middle.id&&r.columns[0]==='user_id')!.alternatives.find(a=>a.targetSourceVersionId===user.id)!;
 const r=suggestions.find(r=>r.sourceVersionId===middle.id&&r.columns[0]==='role_id')!.alternatives.find(a=>a.targetSourceVersionId===role.id)!;
 const result=relationshipValidation(raw,[middle,user,role],[],[{linkId:'membership',bindings:[{candidateRef:u.ref,endpoint:'from'},{candidateRef:r.ref,endpoint:'to'}],reason:'中间表的两个独立角色'}]);
 assert.equal(result[0].dataMatch.matched,0);assert.equal(result[0].dataMatch.checked,2);assert.equal(result[0].dataMatch.status,'sample_no_match');
});
test('reciprocal paths from different driving sources cannot be read as one middle-table row',()=>{
 const a=make(1,'a',['id','b_id'],[{id:'1',b_id:'2'}],['id']),b=make(2,'b',['id','a_id'],[{id:'2',a_id:'1'}],['id']);
 const bind=(n:number,column:string)=>({sourceVersionId:id(n),column});
 const raw={types:[{id:'A',sourceColumns:[bind(1,'id')]},{id:'B',sourceColumns:[bind(2,'id')]}],links:[{id:'ab',from:'A',to:'B',sourceColumns:[bind(1,'id'),bind(1,'b_id'),bind(2,'id'),bind(2,'a_id')]}]};
 const refs=crossTableReferences([a,b],[raw]);
 const forward=refs.find(r=>r.sourceVersionId===a.id&&r.columns[0]==='b_id')!.alternatives.find(c=>c.targetSourceVersionId===b.id)!;
 const reverse=refs.find(r=>r.sourceVersionId===b.id&&r.columns[0]==='a_id')!.alternatives.find(c=>c.targetSourceVersionId===a.id)!;
 assert.throws(()=>relationshipValidation(raw,[a,b],[],[{linkId:'ab',bindings:[{candidateRef:forward.ref,endpoint:'to'},{candidateRef:reverse.ref,endpoint:'from'}],reason:'相反路径应分别检查'}]),/同一驱动来源/);
});

test('selected relationships report sampled non-match without dropping the binding or definition',()=>{
 const a={...make(1,'branch',['id','quyu_id'],[{id:'1',quyu_id:'99'}],['id']),rowCount:100};
 const b={...make(2,'region',['id'],[{id:'7'}],['id']),rowCount:1};
 const bind=(n:number,column:string)=>({sourceVersionId:id(n),column});
 const raw={types:[{id:'Branch',sourceColumns:[bind(1,'id')]},{id:'Region',sourceColumns:[bind(2,'id')]}],links:[{id:'belongs',from:'Branch',to:'Region',sourceColumns:[bind(1,'quyu_id'),bind(2,'id')]}]};
 const candidate=crossTableReferences([a,b],[raw]).find(r=>r.columns[0]==='quyu_id')!.alternatives.find(c=>c.targetSourceVersionId===b.id)!;
 const selection=[{linkId:'belongs',bindings:[{candidateRef:candidate.ref,endpoint:'to' as const}],reason:'明确来源列与业务含义'}];
 const result=relationshipValidation(raw,[a,b],[],selection)[0];assert.equal(result.dataMatch.status,'sample_no_match');assert.equal(result.dataMatch.checked,1);assert.equal(result.sourceBinding.status,'selected_and_validated');assert.equal(raw.links.length,1);
 assert.equal(relationshipValidation(raw,[{...a,rowCount:1},b],[],selection)[0].dataMatch.status,'zero_match');
});

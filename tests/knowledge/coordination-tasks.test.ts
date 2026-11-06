import {test} from 'node:test';
import assert from 'node:assert/strict';
import {coordinationPages,catalogPairs} from '../../src/knowledge/coordination-tasks.ts';
import {modelRequestSize} from '../../src/knowledge/model.ts';
import {compactCoordinationSchema,coordinationReferences} from '../../src/knowledge/compact-coordination.ts';
test('one oversized business member is completely partitioned including every Unicode text segment',()=>{
 const text='甲😀乙'.repeat(10000);
 const input={stage:'coordinate',coordinationFormat:'references-v3',businessQuestion:'核查一个大成员',sources:[],tableCandidates:[],details:{text}};
 const pages=coordinationPages(input);
 assert.ok(pages.length>1);assert.equal(pages.map(p=>p.input.details.text).join(''),text);
 assert.ok(pages.every(p=>modelRequestSize('discover',p.input,compactCoordinationSchema)<=48000));
});
test('global catalog pages inspect every pair across batches and retain single-page coverage',()=>{
 const pairs=catalogPairs(Array.from({length:19},(_,i)=>i),4),seen=new Set<string>();
 for(const pair of pairs){const all=[...pair.left,...pair.right];for(const a of all)for(const b of all)seen.add(`${Math.min(a,b)}:${Math.max(a,b)}`);}
 for(let a=0;a<19;a++)for(let b=a;b<19;b++)assert.ok(seen.has(`${a}:${b}`));
});
test('stable member references survive unrelated source insertion and candidate regrouping',()=>{
 const one=(id:string,sourceVersionId:string)=>({name:'对象',types:[{id,name:id,sourceColumns:[{sourceVersionId,column:'id'}],properties:[{id:id+'.id',name:'编号',valueType:'integer',sourceColumns:[{sourceVersionId,column:'id'}]}]}],links:[]});
 const a=one('A','00000000-0000-4000-8000-000000000001'),b=one('B','00000000-0000-4000-8000-000000000002');
 const before=coordinationReferences([a],true)[0].types[0],after=coordinationReferences([b,a],true)[1].types[0];
 assert.equal(before.ref,after.ref);assert.equal(before.properties[0].ref,after.properties[0].ref);
 const regrouped=coordinationReferences([{...a,types:[...b.types,...a.types]}],true)[0].types[1];assert.equal(before.ref,regrouped.ref);
});
test('global evidence comparison windows jointly retain both sides and protect full composite constraints',async()=>{
 const {semanticWindows}=await import('../../src/knowledge/coordination-tasks.ts');
 const sources=['A','B'].map(id=>({id,kind:'table',metadata:{name:id,primaryKey:['tenant','code'],columns:[{name:'code',type:'integer',comment:id+'业务引用说明'},{name:'unrelated',type:'text',comment:'很长的原始注释'.repeat(5000)}]}}));
 const windows=semanticWindows(sources),seen=new Set<string>();
 for(let i=0;i<windows.length;i++)for(let j=i;j<windows.length;j++){
  const jointEvidence=i===j?windows[i]:[...windows[i],...windows[j]];
  const pages=coordinationPages({stage:'coordinate',coordinationFormat:'references-v3',coverage:{pair:[0,1]},globalDirectory:[{id:'A'},{id:'B'}],jointEvidence,details:'长上下文'.repeat(5000)});
  for(const page of pages){assert.deepEqual(page.input.jointEvidence,jointEvidence);for(const a of page.input.jointEvidence)for(const b of page.input.jointEvidence)seen.add(a.context.sourceVersionId+':'+b.context.sourceVersionId);}
 }
 assert.ok(seen.has('A:B'));
 const keys=windows.flat().filter(u=>u.context.kind==='primaryKey');assert.ok(keys.length===2);assert.deepEqual(keys.map(u=>u.value),[['tenant','code'],['tenant','code']]);
});
test('wide interleaved FK roles remain grouped ordered composite units across window boundaries',async()=>{
 const {semanticWindows}=await import('../../src/knowledge/coordination-tasks.ts');
 const foreignKeys=Array.from({length:30},(_,i)=>['owner','reviewer'].map(name=>({name,column:'part_'+i,targetTable:'users',targetColumn:'key_'+i,ordinal:i+1}))).flat();
 const units=semanticWindows([{id:'A',metadata:{foreignKeys}}]).flat().filter(u=>u.context.kind==='foreignKeys');
 assert.equal(units.length,2);for(const unit of units){assert.equal(unit.value.length,30);assert.equal(new Set(unit.value.map((k:any)=>k.name)).size,1);assert.deepEqual(unit.value.map((k:any)=>k.ordinal),Array.from({length:30},(_,i)=>i+1));}
});

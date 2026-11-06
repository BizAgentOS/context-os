import {test} from 'node:test';
import assert from 'node:assert/strict';
import {StructuredCompiler} from '../../src/knowledge/structured-compiler.ts';
import {modelRequestSize} from '../../src/knowledge/model.ts';
import type {DiscoverySource} from '../../src/knowledge/discovery.ts';
import type {KnowledgeCore} from '../../src/knowledge/service.ts';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const source=(n:number,name:string):DiscoverySource=>({id:id(n),kind:'table',sourceNamespace:`source.${name}`,columns:['id'],keyColumn:'id',rows:[{id:'1'}],warnings:[],rowCount:1,metadata:{name,columns:[{name:'id',type:'integer'}],primaryKey:['id']}});
function harness(){
 const receipts=new Map<string,any>(),calls:Array<{job:string;stage:string;input:any;bytes:number}>=[],events:any[]=[];
 const query=async(sql:string,args:unknown[]=[])=>{
  if(sql.startsWith('SELECT fingerprint'))return {rows:receipts.has(`${args[0]}:${args[1]}`)?[receipts.get(`${args[0]}:${args[1]}`)]:[]};
  if(sql.startsWith('SELECT s.result,s.job_id'))return {rows:[...receipts.values()].filter(r=>r.fingerprint===args[0]&&r.stage===args[2]&&r.job_id!==args[3]).slice(-1)};
  if(sql.startsWith('INSERT INTO knowledge.analysis_steps'))receipts.set(`${args[0]}:${args[1]}`,{job_id:args[0],stage:args[1],fingerprint:args[2],result:JSON.parse(String(args[3]))});
  return {rows:[{id:'lease'}]};
 };
 const core={db:{pool:{query},transaction:async(run:any)=>run({query})}} as unknown as KnowledgeCore;
 const compiler=(job:string,generate?:(stage:string,input:any)=>unknown,reusedTables?:Record<string,unknown>)=>new StructuredCompiler({core,job:{id:job,leaseToken:'lease'},policy:{model:'fixture',prompt:'v20'},reuseActorId:'owner',cached(){},progress:event=>events.push(event),reusedTables,
  async generate(stage,task,input:any,schema){calls.push({job,stage,input,bytes:modelRequestSize(task,input,schema)});if(generate)return generate(stage,input);
   if(input.stage==='table'){const name=String(input.sources[0].metadata.name);return {name:'对象',types:[{id:name,name,description:'业务对象描述'.repeat(500),properties:[{id:`${name}.id`,name:'编号',valueType:'integer',sourceColumns:[{column:'id'}]}]}],links:[]};}
   return {name:'统一候选'};
  }});
 return {compiler,calls,receipts,events};
}
test('a changed frozen source recomputes its table and related work while unchanged business definitions are reused across jobs',async()=>{
 const h=harness(),sources=['A','B','C','D','E','F'].map((name,i)=>source(i+1,name));
 await h.compiler('first').discover(sources,null);
 await h.compiler('second').discover(sources.map(s=>s.metadata?.name==='B'?{...s,id:id(22),rows:[{id:'9'}]}:s),null);
 const next=h.calls.filter(c=>c.job==='second');
 assert.deepEqual(next.filter(c=>c.input.stage==='table').map(c=>c.input.sources[0].metadata.name),['B']);
 assert.ok(next.some(c=>c.input.businessQuestion?.includes('对象 B 的定义')));
 assert.equal(next.some(c=>c.input.businessQuestion?.includes('对象 C 的定义')),false);
 assert.ok(h.events.some(e=>e.kind==='analysis.dependency_reused'));
 assert.ok([...h.receipts.values()].some(r=>r.job_id==='second'&&r.stage.startsWith('dependencies:')&&r.result.originJobId==='first'));
});
test('all local tables may abstain yet global evidence can add classes and a cross-source relation',async()=>{
 const h=harness(),sources=[source(1,'Left'),source(2,'Right')];
 const result=await h.compiler('global-only',(_stage,input)=>input.stage==='table'?{name:'局部弃权',types:[],links:[],disposition:'deferred',reason:'需结合另一来源判断'}:{name:'全局发现',additions:{types:sources.map((s,i)=>({reason:'全局声明和列注释支持业务对象',member:{id:i?'Right':'Left',name:i?'右对象':'左对象',sourceColumns:[{sourceVersionId:s.id,column:'id'}],properties:[]}})),links:[{reason:'两来源的业务引用说明',member:{id:'cross',name:'引用',from:'Left',to:'Right',sourceColumns:sources.map(s=>({sourceVersionId:s.id,column:'id'}))}}]}}).discover(sources,null);
 assert.equal(result.raw.types.length,2);assert.equal(result.raw.links.length,1);assert.equal(result.coverageManifest.state,'completed');
});
test('a single oversized member is recursively reviewed and cached recovery never purchases completed pages twice',async()=>{
 const h=harness(),s=source(1,'Large');
 const issues=Array.from({length:50},(_,i)=>({kind:'fact_conflict',question:`问题${i}：`+'业务依据'.repeat(350)}));
 const raw={name:'大型业务定义',types:[{id:'Large',name:'对象',uncertainties:issues,properties:[{id:'large_id',name:'编号',valueType:'integer',sourceColumns:[{sourceVersionId:s.id,column:'id'}]}]}],links:[]};
 const compiler=h.compiler('large',()=>({name:'分片检查'}),{[s.id]:raw});
 const result=await compiler.discover([s],null),before=h.calls.length;
 await compiler.discover([s],null);
 assert.equal(h.calls.length,before);assert.ok(before>1);assert.ok(h.calls.every(c=>c.bytes<=48000));
 const shown=new Set(h.calls.flatMap(c=>(c.input.indexedUncertainties??[]).map((u:any)=>u.question)));
 for(const issue of issues)assert.ok(shown.has(issue.question));
 assert.equal(result.coverageManifest.completed.length,result.coverageManifest.planned);
});

test('coordination resolves an inconsistent endpoint name by an explicit keyed binding and persists three separate evidence layers',async()=>{
 const h=harness();const a={...source(1,'branch'),columns:['id','quyu_id'],rows:[{id:'1',quyu_id:'9'}],metadata:{name:'branch',columns:[{name:'id',type:'integer'},{name:'quyu_id',type:'integer',comment:'区域编号'}],primaryKey:['id']}};
 const b={...source(2,'regions'),columns:['code'],keyColumn:'code',rows:[{code:'9'}],metadata:{name:'regions',columns:[{name:'code',type:'integer',comment:'区域业务编号'}],uniqueKeys:[['code']]}};
 const result=await h.compiler('endpoint-binding',(_stage,input)=>{
  if(input.stage==='table')return input.sources[0].id===a.id?{name:'分所',types:[{id:'Branch',name:'分所',properties:[{id:'branch.id',name:'编号',valueType:'integer',sourceColumns:[{column:'id'}]}]}],links:[{id:'belongs',name:'所属区域',from:'Branch',to:'Region',sourceColumns:[{column:'quyu_id'}]}]}:{name:'区域',types:[{id:'type.quyu',name:'区域',properties:[{id:'region.code',name:'编号',valueType:'integer',sourceColumns:[{column:'code'}]}]}],links:[]};
  const link=input.tableCandidates.flatMap((c:any)=>c.links).find((l:any)=>l.id==='belongs');
  const candidate=input.referenceCandidates.find((r:any)=>r.sourceVersionId===a.id&&r.columns[0]==='quyu_id').alternatives.find((c:any)=>c.targetSourceVersionId===b.id);
  return {name:'有据协调',links:[{refs:[link.ref],changes:{to:'type.quyu'},bindings:[{sourceVersionId:a.id,column:'quyu_id'},{sourceVersionId:b.id,column:'code'}],reason:'区域编号及目标唯一业务编号支持所属区域关系'}],
   resolutions:(input.indexedUncertainties??[]).filter((u:any)=>u.ref===link.ref).map((u:any)=>({ref:u.ref,indexes:[u.index],reason:'明确来源版本及业务编号对应端点'})),
   relationshipBindings:[{linkId:'belongs',bindings:[{candidateRef:candidate.ref,endpoint:'to'}],reason:'明确采用此区域业务键映射'}]};
 }).discover([a,b],null);
 assert.equal(result.raw.links[0].to,'type.quyu');assert.equal(result.relationshipBindings.length,1);assert.ok(result.coordinationAudit.some(a=>a.memberId==='belongs'&&a.reason.includes('区域编号')));
});
test('partial coordination mechanically isolates duplicate link IDs and properties colliding with another class',async()=>{
 const h=harness(),sources=[source(1,'A'),source(2,'B')];
 const reused=Object.fromEntries(sources.map((s,i)=>[s.id,{name:'分表',types:[{id:i?'B':'A',name:i?'乙':'甲',description:'长业务说明'.repeat(700),properties:[{id:i?'b.id':'B',name:'编号',valueType:'integer',sourceColumns:[{sourceVersionId:s.id,column:'id'}]}]}],links:[{id:'parent',name:'上级',from:i?'B':'A',to:i?'B':'A',sourceColumns:[{sourceVersionId:s.id,column:'id'}]}]}]));
 const result=await h.compiler('collisions',()=>({name:'保留不同业务对象'}),reused).discover(sources,null);
 assert.equal(result.raw.links.length,2);assert.equal(new Set(result.raw.links.map(l=>l.id)).size,2);assert.ok(result.mechanicalIds.some(m=>m.originalId==='B'&&m.owner==='A'));assert.equal(result.coverageManifest.state,'completed');
});
test('global adopted evidence promotes a local not-applicable decision and mapping is still requested',async()=>{
 const {discoverySourceOutcomes,validateDiscovery,discoveryInput}=await import('../../src/knowledge/discovery.ts');
 const s=source(1,'A'),prepared=discoveryInput([s],null);
 const raw={name:'全局对象',types:[{id:'A',name:'甲',properties:[],sourceColumns:[{sourceVersionId:s.id,column:'id'}]}],links:[]};
 const definition=validateDiscovery(raw,[s],prepared.catalog,null).definition;
 const decisions=discoverySourceOutcomes(definition,[{sourceVersionId:s.id,status:'not_applicable',reason:'仅逐表不适用'}]);assert.equal(decisions[0].status,'candidate');
 const h=harness();await h.compiler('mapping',()=>({csv:[],skipped:[{sourceVersionId:s.id,reason:'已检查但无事实映射'}],notes:[]})).plan(definition,[s],null,[],decisions);
 assert.ok(h.calls.some(c=>c.input.stage==='table_mapping'));
 const skipped=await h.compiler('skip').plan(definition,[s],null,[],[{sourceVersionId:s.id,status:'deferred',reason:'定义暂缓'}],[],[{member:{id:'A'},evidence:[{sourceVersionId:s.id}]}]);
 assert.match(skipped.skipped![0].reason,/触发成员：A.*影响范围.*保留旧正式事实/);
});
test('coverage sees relations added earlier and refreshes newly discovered types across joint windows',async()=>{
 const h=harness(),sources=[source(1,'A'),source(2,'B')].map(s=>({...s,metadata:{...s.metadata,comment:'来源业务长注释'.repeat(2000)}}));let added=false,seen=false;
 const result=await h.compiler('dynamic',(_stage,input)=>{
  if(input.stage==='table'){const name=input.sources[0].metadata.name;return {name,types:[{id:name,name,properties:[{id:name+'.id',name:'编号',valueType:'integer',sourceColumns:[{column:'id'}]}]}],links:[]};}
  if(input.coverage&&!added){added=true;return {name:'补全',additions:{types:[{reason:'来源B支持独立角色',member:{id:'Extra',name:'独立角色',sourceColumns:[{sourceVersionId:sources[1].id,column:'id'}],properties:[]}}],links:[{reason:'业务说明',member:{id:'extra-link',name:'关联',from:'A',to:'Extra',sourceColumns:[{sourceVersionId:sources[0].id,column:'id'},{sourceVersionId:sources[1].id,column:'id'}]}}]}};}
  if(input.coverage&&input.globalDirectory.some((t:any)=>t.id==='Extra')&&input.tableCandidates.some((c:any)=>c.links.some((l:any)=>l.id==='extra-link')))seen=true;
  return {name:'保留'};
 }).discover(sources,null);
 assert.ok(added&&seen);assert.equal(result.raw.links.length,1);
});

test('reference questions see current endpoint IDs after a prior reference renames a type, including cached replay',async()=>{
 const h=harness(),sources=['A','B','C','D','E','F'].map((name,i)=>{const s=source(i+1,name);return i?s:{...s,metadata:{...s.metadata,columns:[{name:'id',type:'integer',comment:'完整列业务说明'.repeat(300)}]}};});let renamed=false,checked=0;
 const compiler=h.compiler('reference-refresh',(_stage,input)=>{
  if(input.stage==='table'){const name=input.sources[0].metadata.name;return {name,types:[{id:name,name,description:'业务对象描述'.repeat(500),properties:[{id:name+'.id',name:'编号',valueType:'integer',sourceColumns:[{column:'id'}]}]}],links:[]};}
  if(input.referenceCandidates?.length&&input.businessQuestion?.includes('跨表业务关系')){
   if(!renamed){renamed=true;const b=input.globalDirectory.find((t:any)=>t.id==='B');return {name:'有据更名',types:[{refs:[b.ref],properties:[],changes:{id:'B_renamed'},reason:'业务核实更名'}]};}
   for(const a of input.referenceCandidates.flatMap((r:any)=>r.alternatives).filter((a:any)=>a.targetSourceVersionId===sources[1].id)){
    assert.deepEqual(a.targetCandidateTypes,['B_renamed']);assert.ok(input.globalDirectory.some((t:any)=>t.id==='B_renamed'));checked++;
   }
  }
  return {name:'保留'};
 });
 const result=await compiler.discover(sources,null);assert.ok(checked>0);assert.ok(result.raw.types.some(t=>t.id==='B_renamed'));
 assert.ok(h.calls.some(c=>c.stage.includes(':page:')),'reference fixture must exercise partitioned pages');
 const calls=h.calls.length;await compiler.discover(sources,null);assert.equal(h.calls.length,calls);
});

test('later reference questions project merged and newly added endpoint owners from the current candidate',async()=>{
 const h=harness(),sources=['A','B','C','D','E','F'].map((name,i)=>source(i+1,name));let phase=0,checked=0;
 await h.compiler('reference-owners',(_stage,input)=>{
  if(input.stage==='table'){const name=input.sources[0].metadata.name;return {name,types:[{id:name,name,description:'业务对象描述'.repeat(500),properties:[{id:name+'.id',name:'编号',valueType:'integer',sourceColumns:[{column:'id'}]}]}],links:[]};}
  if(input.referenceCandidates?.length&&input.businessQuestion?.includes('跨表业务关系')){
   if(phase++===0){const refs=['B','C'].map(id=>input.globalDirectory.find((t:any)=>t.id===id).ref);return {name:'显式合并',types:[{refs,properties:[],changes:{id:'Combined',name:'联合对象'},reason:'来源依据支持同一业务类型'}]};}
   if(phase===2)return {name:'补充角色',additions:{types:[{member:{id:'Extra',name:'独立角色',sourceColumns:[{sourceVersionId:sources[1].id,column:'id'}],properties:[]},reason:'来源另有明确业务角色'}]}};
   const target=input.referenceCandidates.flatMap((r:any)=>r.alternatives).find((a:any)=>a.targetSourceVersionId===sources[1].id);
   if(target){assert.deepEqual([...target.targetCandidateTypes].sort(),['Combined','Extra']);checked++;}
  }
  return {name:'保留'};
 }).discover(sources,null);
 assert.ok(checked>0);
});

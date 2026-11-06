import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { structuredDiscoveryModelSchema, fromStructuredModel, toStructuredModel, structuredOntologyView, structuredSourceView, structuredCoordinationSourceView, structuredMappingModelSchema, assertStructuredModelRequest } from '../../src/knowledge/structured-model-boundary.ts';
import { discoveryInput, validateDiscoveryEvidence, validateDiscovery, type DiscoverySource } from '../../src/knowledge/discovery.ts';
import { ontologySchema } from '../../src/knowledge/contracts.ts';
import { StructuredCompiler } from '../../src/knowledge/structured-compiler.ts';
import { KnowledgeCore } from '../../src/knowledge/service.ts';
import { DriverJsonModel, modelTaskInstructions } from '../../src/knowledge/model.ts';
import type { AgentDriver } from '../../src/agent/runtime.ts';
import { retainedCoordination } from './coordination-fixture.ts';

const source:DiscoverySource={id:'00000000-0000-4000-8000-000000000001',kind:'table',columns:['id','create_time'],keyColumn:'id',rows:[{id:'1',create_time:''}],nativeValues:{'1':{id:'1',create_time:null}},warnings:[],metadata:{name:'a',columns:[{name:'id',type:'integer'},{name:'create_time',type:'datetime',nullable:true}]}};
const wire=()=>({name:'日志',types:[{id:'Log',name:'日志',properties:[{id:'created',name:'时间',valueType:'datetime',sourceColumns:[{column:'create_time'}],uncertainties:[{kind:'time_attachment',question:'业务时间归属未知'}]}]}],links:[]});
const forbidden=new Set(['evidenceCatalog','evidenceReferences','evidenceIds','evidenceId','sourceColumnIds','sourceColumnId','structureHash','discoveryEvidence','locator','memberId']);
function noInternalKeys(value:unknown,allowed=new Set<string>()) {
  if(Array.isArray(value)){value.forEach(v=>noInternalKeys(v,allowed));return;}
  if(value&&typeof value==='object')for(const [key,item]of Object.entries(value)){
    assert.ok(!forbidden.has(key)||allowed.has(key),`unexpected wire field ${key}`);noInternalKeys(item,allowed);
  }
}

test('new native model schemas exclude every legacy reference path and own uncertainty association',()=>{
  for(const stage of ['table','coordinate'] as const)noInternalKeys(z.toJSONSchema(structuredDiscoveryModelSchema(stage)));
  noInternalKeys(z.toJSONSchema(structuredMappingModelSchema));
  const schema=structuredDiscoveryModelSchema('table');
  for(const key of ['evidenceReferences','evidenceCatalog','uncertainties','discoveryEvidence'])assert.equal(schema.safeParse({...wire(),[key]:[]}).success,false);
  const legacy=wire();Object.assign(legacy.types[0].properties[0],{sourceColumnIds:['column:bad']});
  assert.equal(schema.safeParse(legacy).success,false);
  const duplicate=wire();Object.assign(duplicate.types[0].properties[0].uncertainties[0],{memberId:'Log.created'});
  assert.equal(schema.safeParse(duplicate).success,false);
  const normalized=fromStructuredModel(wire(),'table');
  assert.equal(normalized.uncertainties[0].memberId,'created','the host associates the local warning, not a second model-written ID');
  const result=validateDiscovery(normalized,[source],discoveryInput([source],null).catalog,null);
  assert.ok(result.definition.discoveryEvidence.some(e=>e.memberId==='created'&&e.locator.kind==='column'));
  assert.equal(structuredMappingModelSchema.safeParse({csv:[],documents:[]}).success,false);
});

test('verified candidates, prior ontologies and source declarations project without internal references',()=>{
  const prepared=discoveryInput([source],null),internal=validateDiscoveryEvidence(fromStructuredModel(wire(),'table'),[source],prepared.catalog,null);
  const view=toStructuredModel(internal.candidate);
  noInternalKeys(view);noInternalKeys(structuredOntologyView(internal.proposed));noInternalKeys(structuredSourceView(source,true));
  assert.equal(structuredDiscoveryModelSchema('coordinate').safeParse(view).success,true,'host materializes source version before coordination');
  const local=wire();
  assert.equal(structuredDiscoveryModelSchema('coordinate').safeParse(local).success,false,'multi-table shorthand cannot guess a source');
});

test('actual staged discovery, coordination and native mapping payloads contain no internal evidence channel',async()=>{
  const second={...source,id:'00000000-0000-4000-8000-000000000002'};
  const query=async(sql:string)=>sql.startsWith('SELECT fingerprint')?{rows:[]}:{rows:[{id:'lease'}]};
  const core={db:{pool:{query},transaction:async(run:(sql:unknown)=>Promise<unknown>)=>run({query})}} as unknown as KnowledgeCore;
  const stages:string[]=[];
  const compiler=new StructuredCompiler({core,job:{id:'fixture',leaseToken:'lease'},policy:{},cached(){},async generate(_stage,task,input,schema){
    const modelInput=input as any;stages.push(modelInput.stage);
    noInternalKeys(input,task==='plan'?new Set(['memberId']):new Set());noInternalKeys(z.toJSONSchema(schema));
    assert.doesNotThrow(()=>assertStructuredModelRequest(task,input,schema));
    assert.ok(!JSON.stringify(input).includes('column:'));
    if(modelInput.stage==='table')return wire();
    if(modelInput.stage==='coordinate'){assert.ok(modelInput.sources.every((s:any)=>!('structuredCandidates' in s)&&!('rows' in s)));return retainedCoordination(modelInput);}
    return {csv:[{sourceVersionId:modelInput.sources[0].id,objects:[{id:'log',typeId:'Log',identityColumn:'id'}],properties:[{id:'time',object:'log',predicate:'created',column:'create_time'}],links:[]}]};
  }});
  const discovered=await compiler.discover([source,second],null);
  const result=validateDiscovery(discovered.raw,[source,second],discovered.catalog,null);
  assert.ok(result.definition.discoveryEvidence.some(e=>e.locator.kind==='column'));
  const plan=await compiler.plan(result.definition,[source,second],null,result.validation.uncertainties);
  assert.equal(plan.csv.length,2);assert.deepEqual(plan.documents,[]);
  assert.deepEqual(stages,['table','table','coordinate','table_mapping','table_mapping']);
});

test('native instructions never offer the generic citation path; an unstaged native request cannot call a driver',async()=>{
  assert.ok(!modelTaskInstructions('discover',{stage:'table'}).includes('evidenceReferences'));
  assert.ok(!modelTaskInstructions('plan',{stage:'table_mapping'}).includes('documents.claims'));
  let called=false;
  const driver:AgentDriver={async run(){called=true;return {text:'',status:'completed',runId:'fixture',sessionId:'fixture'};},async close(){},async stop(){}};
  const model=new DriverJsonModel('fixture',driver);
  await assert.rejects(model.generate('discover',{sources:[{kind:'table'}]},ontologySchema),/不能回退/);
  assert.equal(called,false);
});


test('provider boundary refuses legacy schemas and leaked metadata before any request',()=>{
  const input={stage:'table',sources:[structuredSourceView(source,true)],baseOntology:null};
  assert.doesNotThrow(()=>assertStructuredModelRequest('discover',input,structuredDiscoveryModelSchema('table')));
  assert.throws(()=>assertStructuredModelRequest('discover',input,ontologySchema),/输出契约/);
  assert.throws(()=>assertStructuredModelRequest('discover',{...input,evidenceCatalog:[]},structuredDiscoveryModelSchema('table')),/内部字段/);
  assert.throws(()=>assertStructuredModelRequest('discover',{...input,baseOntology:{discoveryEvidence:[]}},structuredDiscoveryModelSchema('table')),/内部字段/);
  assert.throws(()=>assertStructuredModelRequest('plan',{stage:'table_mapping',sources:input.sources,ontology:{discoveryEvidence:[]}},structuredMappingModelSchema),/内部字段/);
  assert.throws(()=>assertStructuredModelRequest('discover',{...input,sources:[...input.sources,{kind:'pdf'}]},structuredDiscoveryModelSchema('table')),/不能回退/);
});

test('unresolved relationship endpoints remain proposals until deferred filtering, never formal dangling links',()=>{
  const raw=wire();
  const proposal={...raw,links:[
    {id:'manager',name:'负责人',from:'Log',to:'User.Person',multiple:true,sourceColumns:[{column:'id'}],uncertainties:[{kind:'source_binding',question:'用户对象来源尚未明确'}]},
    {id:'unmarked',name:'未标注的外部对象',from:'Log',to:'OtherMissing',multiple:true,sourceColumns:[{column:'id'}]}
  ]};
  const candidate=fromStructuredModel(proposal,'table'),prepared=discoveryInput([source],null);
  const local=validateDiscoveryEvidence(candidate,[source],prepared.catalog,null);
  assert.equal(local.proposed.links.length,2,'both original candidates remain auditable');
  assert.ok(local.candidate.uncertainties.some(u=>u.memberId==='unmarked'&&u.kind==='source_binding'));
  const result=validateDiscovery(local.candidate,[source],prepared.catalog,null);
  assert.equal(result.definition.types[0].id,'Log');
  assert.equal(result.definition.links.length,0);
  assert.deepEqual(result.validation.deferred.filter(d=>'from' in d.member).map(d=>d.member.id),['manager','unmarked']);
  assert.equal(ontologySchema.safeParse({...result.definition,links:[{id:'bad',name:'坏关系',from:'Log',to:'Missing',multiple:true}]}).success,false,'published ontology endpoint validation is unchanged');
});

test('structural errors expose safe paths and categories instead of provider messages or source values',async()=>{
  const {knowledgeValidationMessage}=await import('../../src/knowledge/jobs.ts');
  const result=z.object({types:z.array(z.object({id:z.string()}))}).safeParse({types:[{id:12345}]});
  assert.equal(result.success,false);
  if(!result.success){
    const message=knowledgeValidationMessage(result.error);
    assert.match(message,/types\.0\.id/);assert.match(message,/字段类型不符/);assert.ok(!message.includes('12345'));
  }
});


test('coordination keeps all source declarations and complete candidates with compact key profiles and without raw rows',()=>{
  const prepared=discoveryInput([source],null);
  const candidate=validateDiscoveryEvidence(fromStructuredModel(wire(),'table'),[source],prepared.catalog,null).candidate;
  const view=structuredCoordinationSourceView({...source,metadata:{...source.metadata,primaryKey:['id'],foreignKeys:[{columns:['id'],referencedTable:'other',referencedColumns:['id']} ]}});
  assert.deepEqual(view.metadata.columns,source.metadata!.columns);
  assert.deepEqual(view.metadata.primaryKey,['id']);
  assert.equal((view.metadata.foreignKeys as unknown[]).length,1);
  assert.equal('structuredCandidates' in view,false);assert.equal('rows' in view,false);assert.equal('nativeValues' in view,false);
  assert.equal(toStructuredModel(candidate).types[0].properties.length,candidate.types[0].properties.length);
  const sources=Array.from({length:20},(_,i)=>({...source,id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,
    metadata:{...source.metadata,columns:Array.from({length:20},(_,j)=>({name:`field_${j}`,type:'varchar(50)',comment:'声明说明'}))},
    columns:Array.from({length:20},(_,j)=>`field_${j}`),rows:[],nativeValues:{},rowCount:0}));
  const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
  const oldSize=bytes(sources.map(s=>structuredSourceView(s))),newSize=bytes(sources.map(structuredCoordinationSourceView));
  assert.ok(newSize<oldSize,'coordination retains key profiles while removing repeated notes and raw record payloads');
  assert.ok(view.keyProfiles.profile.columns.every(c=>Object.hasOwn(c,'observedValues')));
  assert.equal('structureHash' in view.keyProfiles,false);
  assert.deepEqual(sources.map(structuredCoordinationSourceView).map(s=>s.metadata.columns),sources.map(s=>s.metadata!.columns));
});

test('a schema-valid paid response is retained after host validation fails and retry does not call the model again',async()=>{
  const receipts=new Map<string,{fingerprint:string;result:unknown}>();
  const query=async(sql:string,args:unknown[]=[])=>{
    if(sql.startsWith('SELECT fingerprint'))return {rows:receipts.has(String(args[1]))?[receipts.get(String(args[1]))]:[]};
    if(sql.startsWith('INSERT INTO'))receipts.set(String(args[1]),{fingerprint:String(args[2]),result:JSON.parse(String(args[3]))});
    return {rows:[{id:'lease'}]};
  };
  const core={db:{pool:{query},transaction:async(run:(sql:unknown)=>Promise<unknown>)=>run({query})}} as unknown as KnowledgeCore;
  let calls=0,cached=0;
  const compiler=new StructuredCompiler({core,job:{id:'fixture',leaseToken:'lease'},policy:{},cached(){cached++;},async generate(){
    calls++;
    return {name:'重复成员候选',types:[{id:'Log',name:'日志',properties:[
      {id:'duplicate',name:'A',valueType:'integer',sourceColumns:[{column:'id'}]},
      {id:'duplicate',name:'B',valueType:'integer',sourceColumns:[{column:'id'}]}
    ]}],links:[]};
  }});
  await assert.rejects(compiler.discover([source],null),/候选成员编号重复/);
  assert.equal(receipts.size,1,'raw schema-valid output survives a downstream host error');
  await assert.rejects(compiler.discover([source],null),/候选成员编号重复/);
  assert.equal(calls,1,'a local validation failure must not buy another response on retry');
  assert.equal(cached,1);
});

test('source-free coordination pages still enforce the native schema and forbid internal evidence fields',async()=>{
 const {compactCoordinationSchema}=await import('../../src/knowledge/compact-coordination-schema.ts');
 const input={stage:'coordinate',coordinationFormat:'references-v3',sources:[]};
 assert.doesNotThrow(()=>assertStructuredModelRequest('discover',input,compactCoordinationSchema));
 assert.throws(()=>assertStructuredModelRequest('discover',input,structuredDiscoveryModelSchema('coordinate')),/输出契约/);
 assert.throws(()=>assertStructuredModelRequest('discover',{...input,evidenceCatalog:[]},compactCoordinationSchema),/内部字段/);
});

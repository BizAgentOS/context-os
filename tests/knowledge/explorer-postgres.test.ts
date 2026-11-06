import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KnowledgeCore} from '../../src/knowledge/service.ts';
import {openDatabase} from '../../src/knowledge/database.ts';
import {prepareCsv,mapCsv} from '../../src/knowledge/sources.ts';
import {ontologySchema} from '../../src/knowledge/contracts.ts';
import {commitReviewedFixture} from './reviewed-fixture.ts';
const url=process.env.CONTEXT_OS_KNOWLEDGE_TEST_DATABASE_URL;
test('exploration: paginated identities and bidirectional projected relations preserve direction and dual time',{skip:!url},async()=>{
 const db=await openDatabase(url!),directory=await mkdtemp(join(tmpdir(),'context-os-explorer-'));let owns=false;
 try{
  assert.equal((await db.pool.query("SELECT 1 FROM pg_namespace WHERE nspname='knowledge'")).rows.length,0,'requires dedicated empty test DB');
  await db.initialize();owns=true;const core=new KnowledgeCore(db),admin={id:'fixture',role:'admin' as const},viewer={id:'reader',role:'viewer' as const};
  const definition=ontologySchema.parse(JSON.parse(await readFile(new URL('../../data/samples/knowledge-core/ontology.json',import.meta.url),'utf8')));
  definition.links.push({id:'contract_self',name:'自关联',from:'Contract',to:'Contract',multiple:true},{id:'contract_supplier',name:'供应企业',from:'Contract',to:'Company',multiple:true});
  const draft=await core.draft(admin,definition);await core.act(admin,{operationId:'publish-explorer',kind:'PublishOntologyVersion',targetId:draft.id,expectedRevision:1,reason:'isolated sample'});
  const mapping=JSON.parse(await readFile(new URL('../../data/samples/knowledge-core/mapping.json',import.meta.url),'utf8'));
  mapping.links.push({predicate:'contract_self',column:'contract_no',targetType:'Contract',targetNamespace:'contract_no'},{predicate:'contract_supplier',column:'company_code',targetType:'Company',targetNamespace:'company_code'});
  const template=await readFile(new URL('../../data/samples/knowledge-core/contracts.csv',import.meta.url),'utf8');
  const [header,row]=template.trim().split('\n');const csv=header+'\n'+Array.from({length:35},(_,i)=>row.replace('C001',`C${String(i+1).padStart(3,'0')}`)).join('\n');
  const source=await core.importSource(admin,'source-explorer','contracts','Synthetic contracts',await prepareCsv(directory,csv,'contract_no'));
  await commitReviewedFixture(core,admin,{operationId:'build-explorer',ontologyId:draft.id,sourceVersionId:source.version.id,configuration:{mapping},output:mapCsv(source.version.content,mapping,definition)});
  const first=await core.browseObjects(viewer,{type:'Contract',query:'C',limit:1});assert.equal(first.items.length,1);assert.equal(first.hasMore,true);assert.ok(first.items[0].summary);assert.ok(first.items[0].summary.properties.some(p=>p.name==='合同金额'));assert.equal(typeof first.items[0].summary.properties.find(p=>p.name==='合同金额')?.value,'string','decimal summary preserves precision');
  const second=await core.browseObjects(viewer,{type:'Contract',query:'C',limit:1,offset:1});assert.notEqual(first.items[0].id,second.items[0].id);
  assert.equal((await core.browseObjects(viewer,{query:"' OR 1=1"})).items.length,0);
  const validAt='2026-04-20T00:00:00Z',id=first.items[0].id;
  const outgoing=await core.neighborhood(viewer,id,{validAt});assert.ok(outgoing.edges.some(e=>e.from===id&&e.to===id),'self link remains visible');assert.ok(outgoing.edges.some(e=>e.predicate==='contract_supplier'),'parallel predicates are not collapsed');assert.equal((await core.publishedOntology(viewer))?.id,draft.id);
  for(const edge of outgoing.edges){const incoming=await core.neighborhood(viewer,edge.to,{validAt});let page=incoming;let found=page.edges.some(e=>e.from===edge.from&&e.to===edge.to&&e.predicate===edge.predicate);while(!found&&page.hasMore){page=await core.neighborhood(viewer,edge.to,{validAt,offset:page.nextOffset});found=page.edges.some(e=>e.from===edge.from&&e.to===edge.to&&e.predicate===edge.predicate);}assert.ok(found);if(edge.to!==id)assert.ok(incoming.hasMore,'35 incoming subjects require bounded pages');}
  const before=await core.neighborhood(viewer,id,{validAt:'2000-01-01T00:00:00Z'});assert.equal(before.edges.length,0,'future relations must not be current at an earlier business time');
  const knownAt=new Date().toISOString(),historic=await core.neighborhood(viewer,id,{validAt,knownAt});assert.equal(historic.knownAt,knownAt);assert.equal(historic.validAt,validAt);
  await assert.rejects(core.neighborhood(viewer,id,{offset:-1}));
 }finally{if(owns){await db.pool.query('DROP SCHEMA knowledge CASCADE');await db.pool.query('DELETE FROM knowledge_schema_versions WHERE version BETWEEN 1 AND 7');}await db.close();await rm(directory,{recursive:true,force:true});}
});

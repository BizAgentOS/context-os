/** Current public HTTP/MCP fusion chain. Deterministic protocol driver and explicit fixture decisions; never real-model acceptance. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {AddressInfo} from 'node:net';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {createServer} from '../../src/agent/server.ts';
import type {AgentDriver} from '../../src/agent/runtime.ts';
import {createFusionSources,primaryCapability,supplementCapability,fusionDefinition} from '../../tests/agent/fusion-fixture.ts';
import {createKnowledgeSource,knowledgeCapability} from '../../tests/agent/knowledge-fixture.ts';
import {createMetricSource,metricCapability} from '../../tests/agent/metrics-fixture.ts';

if(process.argv.includes('--real'))throw new Error('verify:chain 只做当前公共协议验收，不调用模型。真实模型验收须使用单独授权的验收流程。');
const directory=mkdtempSync(join(tmpdir(),'ade-fusion-chain-')),reportPath=join(directory,'acceptance.json'),authPath=join(directory,'private-access.json');
const keepOpen=process.argv.includes('--keep-open'),credentials=new Set<string>();
const report:any={startedAt:new Date().toISOString(),realModel:false,humanDecisions:'explicit_protocol_fixture',scope:'current HTTP/MCP; multi-source fusion, authenticated document evidence, publication, scoped upgrades, restart and revocation',checks:[],status:'running'};
let stage='start',service:Awaited<ReturnType<typeof createServer>>|undefined,records:Awaited<ReturnType<typeof createFusionSources>>|undefined,knowledge:Awaited<ReturnType<typeof createKnowledgeSource>>|undefined,metrics:Awaited<ReturnType<typeof createMetricSource>>|undefined,origin='';
let documentSource='',documentRuns=0;
const quote='投诉表示居民投诉，实际反馈描述用户感受，不能从工单办结推断恢复。';
// This driver exercises the actual model-visible tools, but supplies no model-quality evidence.
const driver:AgentDriver={async run(request){
 documentRuns++;assert(request.tools.some(tool=>tool.name==='change_propose'));
 const document=await request.onTool('foundation_document_read',{sourceId:documentSource}) as any;
 assert(document.text.includes(quote));
 const baseline=(await request.onTool('pending_list',{}) as any).baseline;
 const result=await request.onTool('change_propose',{operationId:'document-wording',type:'description',baseline,subject:{target:'concept',id:'complaint',description:'居民投诉',evidence:[{id:'uploaded-guidance',kind:'document',readId:document.readId,quote}]},evidence:'采用本轮读取原文作为既有含义的依据'}) as any;
 assert.equal(result.change.status,'adopted');
 return{text:'已保存原文依据，未发布或签发权限。',sessionId:'protocol-fixture',runId:'protocol-fixture'};
},async stop(){},async close(){}};
const save=()=>writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});
const checkpoint=(name:string,facts:Record<string,unknown>={})=>{report.checks.push({name,...facts});save();console.log(JSON.stringify({stage:name,...facts}));};
const ref=(artifact:{id:string;version:number})=>({id:artifact.id,version:artifact.version});
async function listen(){await new Promise<void>(resolve=>service!.server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${(service!.server.address() as AddressInfo).port}`;credentials.add(service!.adminToken);}
async function call(path:string,body?:unknown,key?:string){const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{...(key?{authorization:'Bearer '+key}:{'x-dataengine-token':service!.adminToken}),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(90000)});return{status:response.status,body:await response.json() as any};}
async function api(path:string,body?:unknown){const result=await call(path,body);assert(result.status<300,`${path}: ${JSON.stringify(result)}`);return result.body;}
const read=(path:string,key:string)=>call(path,undefined,key);
async function decide(type:string,subject:unknown){const operationId=randomUUID(),proposed=(await api('/api/changes/propose',{operationId,origin:'human',type,subject,baseline:(await api('/api/changes')).baseline})).change;
 const checked=(await api('/api/changes/verify',{...ref(proposed),operationId:operationId+'-verify'})).change;assert.equal(checked.status,'verified',JSON.stringify(checked.content.verification));
 return (await api('/api/changes/adopt',{...ref(checked),operationId:operationId+'-adopt',acknowledgeReview:true})).change;}
async function sync(operationId:string){const job=(await api('/api/data/sync',{operationId})).job;
 for(let i=0;i<300;i++){const current=(await api('/api/data')).jobs.find((item:any)=>item.id===job.id);if(current&&!['queued','running'].includes(current.status)){assert.equal(current.status,'completed',JSON.stringify(current));return;}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('快照同步超时');}
async function publish(name:string){const overview=await api('/api/releases'),checked=await api('/api/releases/check',{inputHash:overview.working.inputHash});assert.equal(checked.status,'ready',JSON.stringify(checked.content.issues));return(await api('/api/releases/publish',{operationId:name,checkRef:ref(checked),name})).release;}
async function close(){const results=await Promise.allSettled([service,records,knowledge,metrics].map(item=>item?.close()));try{unlinkSync(authPath);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')results.push({status:'rejected',reason:error});}if(results.some(item=>item.status==='rejected')){report.status='failed';report.cleanupFailed=true;save();process.exitCode=1;}}
try{
 records=await createFusionSources();knowledge=await createKnowledgeSource();metrics=await createMetricSource();records.state.mode='conflict';records.primary.forEach((row,index)=>Object.assign(row,{station:index===0?'清河站':'育新站'}));
 service=await createServer({directory,driver,automaticApi:false});await listen();console.log(JSON.stringify({directory,origin,reportPath,realModel:false}));
 stage='foundation_and_document';
 await decide('entity',{action:'add',entity:{id:'complaint',name:'投诉',description:'居民投诉',aliases:[],identityKeys:[],kind:'record'}});
 const uploaded=await api('/api/canvas/upload',{page:'setup',name:'服务说明.md',content:'# 虚构供热实验\n'+quote});
 documentSource=uploaded.sources.find((item:any)=>item.title==='服务说明.md').id;
 await api('/api/canvas/message',{page:'ontology',mode:'build',messageId:'document-request',text:'将服务说明中关于投诉的实际原文保存为已有投诉定义的依据。'});await service.app.idle();
 const foundation=(await api('/api/canvas')).foundation.adopted;assert.equal(documentRuns,1);assert(foundation.content.evidence.some((item:any)=>item.id==='uploaded-guidance'));
 const citation=await api('/api/foundation/evidence?'+new URLSearchParams({foundationId:foundation.id,version:String(foundation.version),evidenceId:'uploaded-guidance'}));assert(citation.text.includes(quote));assert.equal(citation.quote,quote);
 checkpoint(stage,{foundationRef:ref(foundation),documentProtocolRuns:1,exactQuotation:true});
 stage='source_and_fusion';
 const connect=async(name:string,protocol:string,url:string,capability:unknown)=>(await api('/api/live/connect',{name,protocol,url,capabilities:[capability]})).saved;
 const p=await connect('投诉业务系统','http',records.url,{...primaryCapability,fields:[...primaryCapability.fields,'station']});
 const s=await connect('工单执行系统','mcp',records.url+'/mcp',supplementCapability),k=await connect('服务知识库','http',knowledge.url,knowledgeCapability),bi=await connect('经营BI','mcp',metrics.mcpUrl,metricCapability);
 await sync('initial-snapshots');
 const definition=fusionDefinition(p.id,s.id);Object.assign(definition.types[0].fields,{所属站:'station'});
 const candidate=(await api('/api/live/propose',{...definition,foundationRef:ref(foundation),baseModelRef:null,types:definition.types.map(type=>({...type,conceptId:'complaint'}))})).saved;
 const base=(await api('/api/live/adopt',ref(candidate))).saved,query={modelId:base.id,modelVersion:base.version,type:'投诉',limit:20};
 const fused=await api('/api/live/query',query);assert.equal(fused.items[0].实际反馈,'未改善');assert.equal(fused.items[0].上门次数,0);assert.equal(fused.evidence[0].properties.状态.status,'conflict');assert.equal(fused.evidence[1].properties.实际反馈.status,'missing');
 checkpoint(stage,{modelRef:ref(base),conflict:true,zeroPreserved:true,missingPreserved:true});
 stage='shared_evidence';
 const metric=await api('/api/live/metrics/describe',{sourceId:bi.id,capability:'metrics',connectionVersion:bi.version});
 const bundle=(await api('/api/live/evidence/collect',{question:'投诉状态与实际反馈是否一致，服务说明和清河站2026年1月指标如何解释？',objects:{...query,id:'TS002',fields:['$id','状态','实际反馈','上门次数','所属站'],limit:10},documents:[{sourceId:k.id,capability:'documents',connectionVersion:k.version,segmentId:'guide-1',revision:'r1',limit:100,rationale:'提供流程背景'}],metrics:[{sourceId:bi.id,capability:'metrics',connectionVersion:bi.version,definitionHash:metric.definitionHash,start:'2026-01-01',end:'2026-02-01',where:{station:'清河站'},limit:1,rationale:'只作背景，不推断对象恢复',dimensionBindings:[]}]})).saved;
 assert.equal(bundle.content.objects.result.items[0].实际反馈,'未改善');assert.equal(bundle.content.objects.result.items[0].上门次数,0);assert.equal(bundle.content.objects.result.evidence[0].properties.状态.status,'conflict');
 assert.match(bundle.content.documents[0].result.text,/处理完成后安排回访/);assert.equal(bundle.content.documents[0].result.revision,'r1');
 const observation=bundle.content.metrics[0];assert.equal(observation.result.items[0].value,80);assert.equal(observation.result.definition.unit,'%');assert.equal(observation.result.definition.grain,'month');assert.deepEqual(observation.result.query.where,{station:'清河站'});assert.equal(observation.association.status,'context_only');
 checkpoint(stage,{bundleRef:ref(bundle),period:['2026-01-01','2026-02-01'],contextOnly:true});
 stage='published_scope';
 const first=await publish('融合发布一');assert.equal(first.content.definition.accessPolicy.consistency,'pinned_snapshot');
 const connectReader=async(operationId:string,fields:string[],evidenceFields:string[])=>{const result=await api('/api/releases/connect',{operationId,name:operationId,releaseRef:ref(first),conceptIds:['complaint'],relationIds:[],business:{grants:[{type:'投诉',fields,relations:[],evidence:{fields:evidenceFields,relations:[]}}]}});credentials.add(result.key);return result;};
 const a=await connectReader('服务Agent',['$id','状态','实际反馈','上门次数'],['状态','实际反馈']),b=await connectReader('审计Agent',['$id','状态'],[]);
 const objectPath='/v4/objects?'+new URLSearchParams({type:'投诉',id:'TS002'}),initial=await read(objectPath,a.key);assert.equal(initial.status,200);assert.equal(initial.body.items[0].properties.状态.status,'conflict');
 assert.equal((await read(objectPath+'&fields=$id,phone',a.key)).status,403);assert.equal((await read(objectPath+'&fields=$id,实际反馈',b.key)).status,403);
 const evidencePath='/v4/evidence?ref='+initial.body.items[0].properties.状态.evidenceRef;
 const evidence=await read(evidencePath,a.key);assert.equal(evidence.status,200);assert.equal(evidence.body.evidence.observations.length,2);assert.equal((await read(evidencePath,b.key)).status,403);
 assert.doesNotMatch(JSON.stringify([initial.body,evidence.body]),/private-138|private-detail|sourceId|sourceTitle|WO02/);
 for(const path of ['/v1/schema','/v2/schema','/v3/catalog'])assert.equal((await read(path,a.key)).status,410);
 checkpoint(stage,{releaseRef:ref(first),independentConnections:2,permissionDenied:403,retiredContracts:410});
 stage='snapshot_upgrade';records.state.outcome='已改善';records.state.visits=2;await sync('changed-snapshots');
 assert.equal((await read(objectPath,a.key)).body.items[0].properties.实际反馈.value,'未改善','an active release does not drift with upstream updates');
 const diff=await api('/api/releases/data-diff');assert(diff.datasets.some((item:any)=>item.changed===1));
 const second=await publish('融合发布二'),preview=await api('/api/releases/upgrade-preview?'+new URLSearchParams({connectionId:a.connection.id,connectionVersion:String(a.connection.version),releaseId:second.id,releaseVersion:String(second.version)}));assert.equal(preview.compatible,true);
 const upgrade={operationId:'upgrade-service',connectionRef:ref(a.connection),releaseRef:ref(second)},newA=await api('/api/releases/upgrade',upgrade);credentials.add(newA.key);
 assert.deepEqual(newA.connection.content.business,a.connection.content.business);assert.equal((await api('/api/releases/upgrade',upgrade)).key,null);
 assert.equal((await read(objectPath,a.key)).status,403);assert.equal((await read(evidencePath,newA.key)).status,403);assert.equal((await read(objectPath,newA.key)).body.items[0].properties.实际反馈.value,'已改善');assert.equal((await read(objectPath,b.key)).body.items[0].properties.状态.status,'conflict');
 const client=new Client({name:'independent-fusion-chain',version:'1'});
 try{await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dataengine-mcp.ts',import.meta.url))],env:{PATH:process.env.PATH!,DATAENGINE_URL:origin,DATAENGINE_CONSUMER_KEY:newA.key},stderr:'pipe'}));assert((await client.listTools()).tools.some(tool=>tool.name==='describe_dataset'));
  const result=await client.callTool({name:'query_objects',arguments:{type:'投诉',id:'TS002'}});assert.equal(result.isError,undefined);assert.equal((result.structuredContent as any).items[0].properties.实际反馈.value,'已改善');
  assert.equal((await client.callTool({name:'query_objects',arguments:{type:'投诉',fields:['$id','phone']}})).isError,true);
 }finally{await client.close();}
 checkpoint(stage,{newRelease:ref(second),oldKeyRevoked:true,sameScope:true,independentMcp:true});
 stage='restart_and_revoke';await service.close();service=await createServer({directory,driver,automaticApi:false});await listen();
 assert.equal((await read(objectPath,newA.key)).body.items[0].properties.实际反馈.value,'已改善');assert.equal((await read(objectPath,b.key)).status,200);
 const historical=await api('/api/live/evidence/read',ref(bundle));assert.equal(historical.artifact.content.objects.result.items[0].实际反馈,'未改善');assert.equal(historical.historical,true);
 await api('/api/releases/revoke',{operationId:'revoke-service',connectionRef:ref(newA.connection)});assert.equal((await read(objectPath,newA.key)).status,403);assert.equal((await read(evidencePath,newA.key)).status,403);assert.equal((await read(objectPath,b.key)).status,200);
 await api('/api/live/disable',ref(k));await assert.rejects(api('/api/live/evidence/collect',bundle.content.request),/停用|版本/);
 const savedBundle=await api('/api/live/evidence/read',ref(bundle));assert(savedBundle.dependencies.some((item:any)=>item.sourceId===k.id&&!item.available));
 checkpoint(stage,{savedHistoricalEvidence:true,connectionRevoked:true,otherConnectionPreserved:true,documentSourceRevocation:true});
 report.status='passed';report.completedAt=new Date().toISOString();save();console.log(JSON.stringify({status:'passed',reportPath,realModel:false}));
 if(keepOpen){writeFileSync(authPath,JSON.stringify({origin,adminToken:service.adminToken,consumerKey:b.key}),{mode:0o600});console.log(JSON.stringify({origin,privateAccess:authPath}));}
}catch(error){report.status='failed';report.failedStage=stage;let message=error instanceof Error?error.message:String(error);for(const secret of credentials)message=message.replaceAll(secret,'[redacted]');report.error=message;save();console.error(JSON.stringify({stage,error:message,reportPath}));process.exitCode=1;}
finally{if(keepOpen&&report.status==='passed')for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await close();process.exit(process.exitCode?Number(process.exitCode):0);});else await close();}

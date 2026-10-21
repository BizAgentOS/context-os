import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {identityWorkspace,ref} from './identity-release-fixture.ts';
import {QuestionAnswering} from '../../src/agent/qa-tools.ts';

test('an independent release client aggregates and traverses the exact scope used by consumer QA',async()=>{
  const w=await identityWorkspace(),app=w.service.app,client=new Client({name:'release-semantic-agent',version:'1'});
  try{
    const release=await w.publish('外部统计范围'),access=await w.manage('/api/releases/connect',{operationId:'limited-analysis',name:'账号统计',releaseRef:ref(release),conceptIds:['account','person'],relationIds:['account_owner'],business:{grants:[{type:'账号',fields:['$id','名称','邮箱'],relations:['所属人员']},{type:'人员',fields:['$id','邮箱'],relations:[]}]}});
    const spec=await w.manage('/api/releases/connection?id='+access.connection.id+'&version='+access.connection.version),config=Object.values(spec.mcp.mcpServers)[0] as any;
    await client.connect(new StdioClientTransport({command:config.command,args:config.args,env:{...config.env,DATAENGINE_CONSUMER_KEY:access.key},stderr:'pipe'}));
    const tools=(await client.listTools()).tools.map(tool=>tool.name);
    for(const name of ['traverse_relations','aggregate_objects','search_ontology'])assert.ok(tools.includes(name),`missing ${name}`);
    const call=async(name:string,args:Record<string,unknown>)=>{const result=await client.callTool({name,arguments:args});assert.notEqual(result.isError,true,JSON.stringify(result));return result.structuredContent as any;};
    const query={target:{entityTypeId:'account'},aggregate:{measures:[{op:'count',as:'accounts'}]}};
    const count=await call('aggregate_objects',query);assert.deepEqual(count.items,[{$id:'group:0',values:{accounts:3}}]);
    const qa=new QuestionAnswering(app.memory,app.foundation,app.live,app.snapshots,app.workspaceVersions,app.changes),run=qa.begin({question:'账号有几个',dataView:{kind:'consumer',releaseRef:ref(release),connectionRef:ref(access.connection)}});
    const internal=await run.execute('objects_aggregate',query);assert.deepEqual(count.items,(internal.result as any).items);assert.deepEqual(count.coverage,(internal.result as any).coverage);
    const search=await call('search_ontology',{query:'姓名'});assert.deepEqual(search.items,[]);
    const layered=app.live.readLayered(w.currentModel().id),email=layered.semantic.properties.find(item=>item.entityTypeId==='person'&&item.name==='姓名')!;
    const denied=await client.callTool({name:'aggregate_objects',arguments:{...query,filters:[{propertyId:email.id,op:'not_null'}]}});assert.equal(denied.isError,true);assert.equal((denied.structuredContent as any).status,403);
    const found=await call('query_objects',{type:'账号',filters:[{propertyId:layered.semantic.properties.find(item=>item.entityTypeId==='account'&&item.name==='名称')!.id,op:'eq',value:'工作账号'}],sort:[{propertyId:layered.semantic.properties.find(item=>item.entityTypeId==='account'&&item.name==='名称')!.id,direction:'asc'}]});assert.deepEqual(found.items,[{$id:'a-user',邮箱:'new@example.test',名称:'工作账号'}]);
    const path={target:{entityTypeId:'account',id:'a-user'},traverse:[{relationTypeId:'account_owner'}]};
    assert.equal((await call('traverse_relations',path)).items[0].$id,'P1');
    await w.decide('a-user','no_match',null,'exclude-after-release');
    assert.equal((await call('traverse_relations',path)).items[0].$id,'P1','old release keeps its identity-decision set');
    await w.manage('/api/releases/revoke',{operationId:'revoke-analysis',connectionRef:ref(access.connection)});
    assert.equal((await client.callTool({name:'aggregate_objects',arguments:query})).isError,true);
  }finally{await client.close();await w.close();}
});

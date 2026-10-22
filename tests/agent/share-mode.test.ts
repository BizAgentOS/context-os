import {test} from 'node:test';
import assert from 'node:assert/strict';

test('offline formal object reads preserve scope and paginate while write attempts never claim a saved change',async()=>{
 const {createShareMode}=await import(new URL('../../web/agent/share-mode.js',import.meta.url).href);
 const query={modelId:'model',modelVersion:1,conceptId:'complaint'},key=JSON.stringify(['model',1,'complaint',null,null]);
 const data={formatVersion:2,pages:{setup:{},ontology:{},consumption:{}},answers:{},routes:{'/api/ontology/workspace':{entities:[{id:'complaint',name:'投诉'}]},'/api/data/preview?datasetId=records':{rows:[{id:'C1'},{id:'C2'}],total:2}},liveQueries:{[key]:{model:{id:'model',version:1},items:[{$id:'C1',状态:'已办结'},{$id:'C2',状态:'未办结'}],coverage:{total:2,complete:true,shown:2,offset:0},evidence:[{objectId:'C1'},{objectId:'C2'}],reads:[],readMode:'active_snapshot'}}};
 const mode=createShareMode({getElementById:()=>({textContent:JSON.stringify(data)}),documentElement:{dataset:{}}});
 assert.equal((await mode.request('/api/ontology/workspace')).entities[0].name,'投诉');
 const result=await mode.request('/api/live/query',{...query,offset:1,limit:1});assert.deepEqual(result.items,[{$id:'C2',状态:'未办结'}]);assert.equal(result.coverage.offset,1);assert.equal(result.coverage.complete,false);
 const single=await mode.request('/api/live/query',{...query,id:'C1',fields:['状态']});assert.deepEqual(single.items,[{状态:'已办结'}]);
 await assert.rejects(mode.request('/api/live/query',{...query,modelVersion:2}),/未包含/);
 await assert.rejects(mode.request('/api/live/query',{...query,where:{状态:'已办结'}}),/不支持/);
 assert.deepEqual((await mode.request('/api/data/preview?datasetId=records&offset=1&limit=1')).rows,[{id:'C2'}]);
 await assert.rejects(mode.request('/api/changes/adopt',{id:'x',version:1}),error=>Boolean((error as any).simulated)&&/未保存/.test((error as Error).message));
 assert.deepEqual((await mode.request('/api/live/query',query)).items,data.liveQueries[key].items);
});

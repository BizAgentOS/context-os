import {test} from 'node:test';
import assert from 'node:assert/strict';
import {KnowledgeCore} from '../../src/knowledge/service.ts';
import {Database,type Pool} from '../../src/knowledge/database.ts';

test('object directory validates bounds and authorizes before reading; identifiers preserve missing names',async()=>{
  const calls:{sql:string;values:unknown[]|undefined}[]=[];
  const pool={async query(sql:string,values?:unknown[]){calls.push({sql,values});return {rows:[{id:'one',type_id:'Contract',identifiers:[{value:'C001'}]},{id:'two',type_id:'Contract',identifiers:[]}],rowCount:2};}} as unknown as Pool;
  const core=new KnowledgeCore(new Database(pool)),actor={id:'viewer',role:'viewer' as const};
  const page=await core.browseObjects(actor,{type:'Contract',query:"C'_%",limit:1});
  assert.equal(page.items.length,1);assert.equal(page.items[0].identifiers[0].value,'C001');assert.equal(page.hasMore,true);
  assert.deepEqual(calls[0].values,['Contract',"C'_%",2,0]);assert.ok(!calls[0].sql.includes("C'_%"));
  await assert.rejects(core.browseObjects(actor,{offset:-1}));await assert.rejects(core.browseObjects(actor,{limit:101}));
  await assert.rejects(core.browseObjects({id:'',role:'viewer'},{limit:1}));assert.equal(calls.length,1);
});

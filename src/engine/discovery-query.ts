import {randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {rm} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import type {Snapshots} from '../data/snapshots.ts';
import {resultFile} from '../data/executor/paths.ts';
import {timeLimit} from '../data/executor/limits.ts';
import type {Query} from './helix-discovery.ts';

/** Discovery reads one frozen input set. Large query results are computed once and paged from an owned file. */
export function discoveryQuery(snapshots:Snapshots,pins:Array<{datasetId:string;snapshotId:string}>):Query{
 const refs=(ids:string[])=>ids.map(id=>{const pin=pins.find(pin=>pin.datasetId===id);if(!pin)throw new Error('发现读取超出固定快照范围');return pin;});
 const query:Query=(ids,sql,options)=>snapshots.query(refs(ids),sql,options);
 query.scan=async function*(ids,sql){
  const version=randomUUID(),file=resultFile(snapshots.executor.root,'workspace',version);
  try{
   const inputs=snapshots.inputs(refs(ids)).map(({datasetId:_,...input})=>input);
   // Materialization is a storage optimization, not permission to exceed the query deadline.
   const result=await snapshots.executor.run({mode:'materialize',scope:'workspace',version,inputs,sql},{timeoutMs:timeLimit({mode:'query'}).ms});
   const input=createReadStream(file),lines=createInterface({input,crlfDelay:Infinity});let page:Record<string,unknown>[]=[],count=0;
   try{
    for await(const line of lines){if(!line)continue;page.push(JSON.parse(line));count++;if(page.length===1000){yield page;page=[];}}
    if(page.length)yield page;if(count!==result.count)throw new Error('发现结果未完整读取');
   }finally{lines.close();input.destroy();}
  }finally{await rm(file,{force:true});}
 };
 return query;
}

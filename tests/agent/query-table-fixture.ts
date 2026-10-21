import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {MemoryStore} from '../../src/agent/memory.ts';
import {LiveMemory} from '../../src/live/memory.ts';
import {Snapshots} from '../../src/data/snapshots.ts';
import {TableFiles} from '../../src/data/table-files.ts';
import {SemanticQuery} from '../../src/semantic/query.ts';
export async function queryTableFixture(csv:string){
  const directory=mkdtempSync(join(tmpdir(),'ade-semantic-query-')),memory=new MemoryStore(directory),live=new LiveMemory(directory,memory),snapshots=new Snapshots(memory,live,directory),files=new TableFiles(memory,directory);
  const close=async()=>{await snapshots.close();memory.close();rmSync(directory,{recursive:true,force:true});};
  try {
    const source=(await files.import({name:'objects.csv',input:Readable.from([Buffer.from(csv)])})).sources[0];
    const connection=live.sources.connectUpload(source.id,source.version,'id');
    await snapshots.sync({operationId:'initial'});
    const fields=Object.fromEntries((source.content.columns as string[]).map(c=>[c,c]));
    const candidate=await live.propose({purpose:'有界语义查询',rationale:'公共表格快照',types:[{name:'对象',description:'测试对象',sourceId:connection.id,capability:'records',fields}],relations:[]});
    const model=await live.adopt(candidate.id,candidate.version);
    return {memory,live,snapshots,files,connection,model,query:new SemanticQuery(memory,live,snapshots),close};
  }catch(error){await close();throw error;}
}

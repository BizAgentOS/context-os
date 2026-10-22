import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {BackupService} from '../../src/security/workspace-backup.ts';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MemoryStore} from '../../src/agent/memory.ts';

test('artifact category pages contain only the newest visible versions and preserve their order after restart',()=>{
 const directory=mkdtempSync(join(tmpdir(),'ade-memory-scale-'));let memory=new MemoryStore(directory);
 try{
  const a=memory.putArtifact({kind:'note',title:'甲',status:'ready',content:{value:1}}),b=memory.putArtifact({kind:'note',title:'乙',status:'ready',content:{value:2}}),c=memory.putArtifact({kind:'note',title:'丙',status:'ready',content:{value:3}});
  memory.putArtifact({...a,expectedVersion:a.version,title:'甲更新',content:{value:4}});
  for(let n=0;n<100;n++)memory.putArtifact({kind:'unrelated_run',title:String(n),status:'completed',content:{large:'不是目标类别'.repeat(1000)}});
  const source=memory.putArtifact({kind:'source',title:'已删除资料',status:'ready',content:{format:'text',raw:'旧资料'}});memory.putArtifact({...source,expectedVersion:source.version,status:'removed'});
  const page=()=>memory.listArtifacts('note',{limit:1,offset:1});
  assert.deepEqual(page().map(item=>[item.id,item.title]),[[c.id,'丙']]);
  assert.deepEqual(memory.listArtifacts('note',{limit:10,offset:2}).map(item=>item.id),[b.id]);
  assert.deepEqual(memory.listArtifacts('source',{limit:10}),[]);
  memory.close();memory=new MemoryStore(directory);assert.deepEqual(page().map(item=>item.id),[c.id]);assert.equal(memory.getArtifact(a.id).content.value,4);
 }finally{memory.close();rmSync(directory,{recursive:true,force:true});}
});


test('large source content migrates without semantic changes and compact lists stay bounded across backup restore',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-memory-content-')),directory=join(root,'workspace');let memory=new MemoryStore(directory);
 try{
  const raw='历史说明，保留原始字符与换行。\n'.repeat(10000),rows=Array.from({length:1000},(_,i)=>({id:`P${i}`,description:'完整来源'.repeat(20)}));
  const original=memory.putArtifact({kind:'source',title:'历史资料',status:'ready',content:{format:'csv',raw,rows,hash:'original-hash'}},undefined,'old-upload');
  memory.close();
  // Historical on-disk format is an input fixture, including its idempotent write receipt.
  const db=new DatabaseSync(join(directory,'memory.sqlite'));
  db.prepare('UPDATE artifacts SET body=? WHERE id=?').run(JSON.stringify(original),original.id);
  db.prepare('UPDATE operations SET body=? WHERE id=?').run(JSON.stringify(original),'user:old-upload');db.close();
  memory=new MemoryStore(directory);
  assert.deepEqual(memory.getArtifact(original.id),original);
  assert.deepEqual(memory.putArtifact({kind:'source',title:'ignored',status:'ready',content:{}},undefined,'old-upload'),original);
  const page=memory.listArtifacts('source',{content:'compact',limit:10});
  assert.equal(page[0].content.raw,undefined,'source lists must not load original text');
  assert.equal(page[0].content.rows,undefined,'source lists must not load original rows');
  assert(Buffer.byteLength(JSON.stringify(page))<2000,'source metadata is independent of content size');
  const stored=new DatabaseSync(join(directory,'memory.sqlite'),{readOnly:true});
  try{assert(Number(stored.prepare('SELECT length(body) bytes FROM artifacts WHERE id=?').get(original.id)!.bytes)<2000);assert(Number(stored.prepare('SELECT length(body) bytes FROM operations WHERE id=?').get('user:old-upload')!.bytes)<2000);}finally{stored.close();}
  const saved=await new BackupService(memory).create({destination:join(root,'backups'),operationId:'external-content'});
  const restored=await BackupService.restore({backup:saved.path,destination:join(root,'restored')}),copy=new MemoryStore(restored.directory);
  try{assert.deepEqual(copy.getArtifact(original.id),original);assert.deepEqual(copy.putArtifact({kind:'source',title:'ignored',status:'ready',content:{}},undefined,'old-upload'),original);}finally{copy.close();}
 }finally{memory.close();rmSync(root,{recursive:true,force:true});}
});

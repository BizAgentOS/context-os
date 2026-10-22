import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MemoryStore} from '../../src/agent/memory.ts';
import {Workspace} from '../../src/agent/workspace.ts';
import {LiveMemory} from '../../src/live/memory.ts';
import {Snapshots} from '../../src/data/snapshots.ts';
import {FoundationService} from '../../src/agent/foundation.ts';
import {ProgramBuilds} from '../../src/engine/program-builds.ts';
import {TableFiles} from '../../src/data/table-files.ts';
import {CredentialVault} from '../../src/security/credential-vault.ts';
import {BackupService} from '../../src/security/workspace-backup.ts';
import {SourceConnections} from '../../src/live/sources.ts';
import {createServer} from 'node:http';
import {FeishuConnector} from '../../src/connectors/feishu.ts';
import {TableCli,connected} from './feishu-tables-fixture.ts';

test('online backup restores a queryable workspace in a new directory without credentials and rejects tampered files',{timeout:30000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-backup-')),dir=join(root,'workspace'),prior=process.env.ADE_VAULT_KEY_DIRECTORY;process.env.ADE_VAULT_KEY_DIRECTORY=join(root,'keys');
 const memory=new MemoryStore(dir),live=new LiveMemory(dir,memory),snapshots=new Snapshots(memory,live,dir),foundation=new FoundationService(memory,live),engine=new ProgramBuilds(memory,foundation,live,snapshots);
 try{
  const sources=await new TableFiles(memory,dir).import({name:'产品.tsv',input:(async function*(){yield Buffer.from('编号\t名称\nP1\t原始产品\nP2\t另一个产品\n');})()});
  new Workspace(memory).upload('产品定义.md','产品是公司对外提供的商品。');
  await engine.build({operationId:'build'});const candidate=engine.overview().candidate!,checked=await engine.check({id:candidate.id,version:candidate.version}),adopted=await engine.adopt({id:checked.id,version:checked.version,operationId:'adopt'});
  const type=(adopted.model.content.types as any[])[0],before=await live.query({modelId:adopted.model.id,modelVersion:adopted.model.version,type:type.name,id:'P1'});
  new CredentialVault(dir).set('models',{FAKE_MODEL_KEY:'synthetic-never-in-backup'});
  const service=new BackupService(memory);await assert.rejects(service.create({destination:join(dir,'..backups'),operationId:'inside'}),/工作区之外/);
  const saved=await service.create({destination:join(root,'backups'),operationId:'backup-once'});
  assert.equal((await service.create({destination:join(root,'backups'),operationId:'backup-once'})).path,saved.path);
  assert(saved.manifest.files.some(file=>file.path.endsWith('.parquet')));assert(saved.manifest.files.some(file=>file.path.endsWith('.jsonl')));
  for(const file of saved.manifest.files)assert(!/credential|vault|\.key$/.test(file.path));
  assert.doesNotMatch(readFileSync(join(saved.path,'memory.sqlite')).toString('utf8'),/synthetic-never-in-backup/);
  const restored=await BackupService.restore({backup:saved.path,destination:join(root,'restored')});
  assert.equal(restored.reauthorizationRequired,true);assert.equal(existsSync(join(restored.directory,'credentials','vault.json')),false);
  const restoredMemory=new MemoryStore(restored.directory),restoredLive=new LiveMemory(restored.directory,restoredMemory),restoredSnapshots=new Snapshots(restoredMemory,restoredLive,restored.directory);
  try{const after=await restoredLive.query({modelId:adopted.model.id,modelVersion:adopted.model.version,type:type.name,id:'P1'});assert.deepEqual(after.items,before.items);assert.equal(restoredMemory.getArtifact(sources.sources[0].id).title,'产品.tsv');}
  finally{await restoredSnapshots.close();restoredMemory.close();}
  await assert.rejects(BackupService.restore({backup:saved.path,destination:restored.directory}),/新目录|已存在/);
  const snapshot=saved.manifest.files.find(file=>file.path.endsWith('.parquet'))!;appendFileSync(join(saved.path,snapshot.path),'tampered');
  await assert.rejects(BackupService.restore({backup:saved.path,destination:join(root,'corrupt-restored')}),/校验|完整/);
  assert.equal(existsSync(join(root,'corrupt-restored')),false);
 }finally{await engine.close();await snapshots.close();memory.close();if(prior===undefined)delete process.env.ADE_VAULT_KEY_DIRECTORY;else process.env.ADE_VAULT_KEY_DIRECTORY=prior;rmSync(root,{recursive:true,force:true});}
});

test('a restored Feishu table serves its saved snapshot without a CLI account and still blocks all remote reads',{timeout:30000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-backup-feishu-')),dir=join(root,'workspace'),memory=new MemoryStore(dir),live=new LiveMemory(dir,memory),snapshots=new Snapshots(memory,live,dir),engine=new ProgramBuilds(memory,new FoundationService(memory,live),live,snapshots),cli=new TableCli(),connector=new FeishuConnector(dir,cli);
 try{
  await connected(connector);const tables=live.sources.attachFeishu(connector),source=(await tables.select({operationId:'select',url:'https://team.feishu.cn/base/base_test',tableIds:['tbl_people']})).sources[0];
  const built=await engine.build({operationId:'build',autoAdopt:true});assert.equal(built.content.outcome,'adopted');
  const model=memory.listArtifacts('live_ontology').find(item=>item.status==='adopted')!,type=(model.content.types as any[])[0];
  const saved=await new BackupService(memory).create({destination:join(root,'backups'),operationId:'feishu'}),restored=await BackupService.restore({backup:saved.path,destination:join(root,'restored')}),copy=new MemoryStore(restored.directory),restoredLive=new LiveMemory(restored.directory,copy),restoredSnapshots=new Snapshots(copy,restoredLive,restored.directory);
  try{
   assert.equal(existsSync(join(restored.directory,'connectors','feishu','account.json')),false);
   const object=await restoredLive.query({modelId:model.id,type:type.name,id:'rec_204'});assert.equal(object.items.length,1);assert.equal(object.items[0].record_id??object.items[0].$id,'rec_204');
   await assert.rejects(restoredLive.sources.readRecords(source.id,'records'),/授权|凭据/);
  }finally{await restoredSnapshots.close();copy.close();}
 }finally{await connector.close();await engine.close();await snapshots.close();memory.close();rmSync(root,{recursive:true,force:true});}
});

test('restored authenticated sources require new credentials before any network read and config exports contain no secrets',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-backup-auth-')),dir=join(root,'workspace'),prior=process.env.ADE_VAULT_KEY_DIRECTORY;process.env.ADE_VAULT_KEY_DIRECTORY=join(root,'keys');
 let calls=0;const upstream=createServer((_req,res)=>{calls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({items:[{id:'P1'}]}));});await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const memory=new MemoryStore(dir);
 try{
  const sources=new SourceConnections(dir,memory),source=await sources.connect({name:'受权产品',protocol:'http',url:`http://127.0.0.1:${(upstream.address() as {port:number}).port}`,token:'synthetic-source-secret',capabilities:[{name:'products',path:'/products',fields:['id']}]});
  const backup=new BackupService(memory),config=await backup.exportConfig({destination:join(root,'configuration.json')});assert.doesNotMatch(readFileSync(config.path,'utf8'),/synthetic-source-secret|vault/);
  const saved=await backup.create({destination:join(root,'backups'),operationId:'auth'}),restored=await BackupService.restore({backup:saved.path,destination:join(root,'restored')}),copy=new MemoryStore(restored.directory);
  try{await assert.rejects(new SourceConnections(restored.directory,copy).readRecords(source.id,'products'),/凭据|授权/);assert.equal(calls,0,'restoring must not silently retry an authenticated connection as anonymous');}finally{copy.close();}
 }finally{memory.close();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));if(prior===undefined)delete process.env.ADE_VAULT_KEY_DIRECTORY;else process.env.ADE_VAULT_KEY_DIRECTORY=prior;rmSync(root,{recursive:true,force:true});}
});

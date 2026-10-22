import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../../src/agent/server.ts';

test('workspace settings expose retention and create a verified backup restored into a fresh directory through admin routes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-settings-http-')),service=await createServer({directory:join(root,'workspace'),automaticApi:false});
 await new Promise<void>(resolve=>service.server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(service.server.address() as {port:number}).port}`;
 const request=async(path:string,body?:unknown)=>{const r=await fetch(origin+path,{headers:{'X-DataEngine-Token':service.adminToken,...(body?{'Content-Type':'application/json'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json() as any};};
 try{
  assert.equal((await fetch(origin+'/api/settings/retention')).status,403);
  const settings=await request('/api/settings/retention');assert.equal(settings.status,200);assert.equal(settings.body.settings.rawDays,90);assert.equal(settings.body.settings.snapshotVersions,5);
  assert.equal((await request('/api/settings/retention',{rawDays:0,snapshotVersions:5})).status,400);
  assert.equal((await request('/api/settings/retention',{rawDays:120,snapshotVersions:7})).status,200);
  assert.equal((await request('/api/settings/retention')).body.settings.rawDays,120);
  assert.equal((await request('/api/settings/retention/preview')).status,200);
  service.app.memory.createTask('备份中保存的真实任务');
  const backup=await request('/api/backup',{destination:join(root,'backups'),operationId:'http-backup'});assert.equal(backup.status,200);assert.equal(backup.body.manifest.credentialsIncluded,false);
  assert.equal((await request('/api/backup/config',{destination:join(root,'export.json')})).status,200);assert(existsSync(join(root,'export.json')));
  const restored=await request('/api/restore',{backup:backup.body.path,destination:join(root,'restored')});assert.equal(restored.status,200);assert.equal(restored.body.reauthorizationRequired,true);assert(existsSync(join(root,'restored','memory.sqlite')));
  assert.equal((await request('/api/restore',{backup:backup.body.path,destination:join(root,'restored')})).status,400);
 }finally{await service.close();rmSync(root,{recursive:true,force:true});}
});

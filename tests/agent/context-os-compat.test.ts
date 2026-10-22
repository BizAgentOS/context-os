import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createCipheriv,randomBytes} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from '../../src/agent/server.ts';
import {modelKeyEnvironment,type ModelSettings} from '../../src/agent/runtime.ts';
import {CredentialVault} from '../../src/security/credential-vault.ts';
import {ModelCredentials} from '../../src/agent/model-credentials.ts';
import {MemoryStore} from '../../src/agent/memory.ts';
import {BackupService} from '../../src/security/workspace-backup.ts';
import {OntologyDatasets} from '../../src/live/ontology-datasets.ts';

const directory=()=>mkdtempSync(join(tmpdir(),'context-os-compat-'));
const idle={async run(){return{text:'空闲',sessionId:'compat',runId:'compat'};},async stop(){},async close(){}};
const legacyEnvelope=(root:string,provider:'keychain'|'file',key:Buffer,keyId:string,content:Record<string,unknown>)=>{
 const value={format:1,id:'f425bb0d-75ef-4ce6-b590-808c535e3678',provider,keyId},nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
 cipher.setAAD(Buffer.from(JSON.stringify(value)));const ciphertext=Buffer.concat([cipher.update(JSON.stringify(content)),cipher.final()]);mkdirSync(join(root,'credentials'),{recursive:true});
 writeFileSync(join(root,'credentials','vault.json'),JSON.stringify({...value,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}),{mode:0o600});
};

test('Context OS issues new management credentials and accepts existing admin headers and cookies without weakening authentication',async()=>{
 const root=directory();let service=await createServer({directory:root,automaticApi:false,driver:idle});
 const listen=async()=>{await new Promise<void>(resolve=>service.server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${(service.server.address() as {port:number}).port}`;};
 let origin=await listen();
 try{
  assert.match(service.adminToken,/^cos_admin_/);
  for(const header of ['X-ContextOS-Token','X-DataEngine-Token'])assert.equal((await fetch(origin+'/api/canvas/bootstrap',{headers:{[header]:service.adminToken}})).status,200);
  const result=await fetch(origin+'/api/canvas/bootstrap',{headers:{'X-ContextOS-Token':service.adminToken}});assert.match(result.headers.get('set-cookie')??'',/^context_os_session=.*HttpOnly; SameSite=Strict; Path=\/api/);
  assert.equal((await fetch(origin+'/api/canvas/bootstrap',{headers:{cookie:'context_os_session='+service.adminToken}})).status,200);
  assert.equal((await fetch(origin+'/api/canvas/bootstrap',{headers:{'X-ContextOS-Token':'invalid','X-DataEngine-Token':service.adminToken}})).status,403,'an explicit invalid primary header never falls back to a legacy credential');
  await service.close();const legacyToken='de_admin_'+randomBytes(32).toString('base64url');writeFileSync(join(root,'admin-token'),legacyToken,{mode:0o600});service=await createServer({directory:root,automaticApi:false,driver:idle});origin=await listen();
  assert.equal(service.adminToken,legacyToken);const cookie='dataengine_admin_'+createHash('sha256').update(legacyToken).digest('hex').slice(0,16);
  assert.equal((await fetch(origin+'/api/canvas/bootstrap',{headers:{cookie:cookie+'='+legacyToken}})).status,200);
  assert.equal((await fetch(origin+'/api/canvas/bootstrap',{headers:{cookie:cookie+'='+legacyToken+'; context_os_session=invalid'}})).status,403,'new session cookie takes precedence over an older administrator cookie');
  const logout=await fetch(origin+'/api/auth/logout',{method:'POST',headers:{'X-ContextOS-Token':legacyToken,'content-type':'application/json'},body:'{}'});assert.equal(logout.status,200);assert.equal(logout.headers.getSetCookie().length,2);assert(logout.headers.getSetCookie().every(value=>value.includes('Max-Age=0')));
  assert.equal((await fetch(origin+'/api/canvas/bootstrap',{headers:{cookie:'context_os_session=cos_admin_'+randomBytes(32).toString('base64url')}})).status,403);
 }finally{await service.close();rmSync(root,{recursive:true,force:true});}
});

test('new environment names take precedence while each previous supported namespace remains readable',async()=>{
 const {environment}=await import('../../src/config/brand.ts');
 assert.equal(environment('PORT',{CONTEXT_OS_PORT:'9000',DATAENGINE_PORT:'8788',ADE_PORT:'8000'}),'9000');
 assert.equal(environment('PORT',{DATAENGINE_PORT:'8788',ADE_PORT:'8000'}),'8788');
 assert.equal(environment('SNAPSHOT_MAX_ROWS',{ADE_SNAPSHOT_MAX_ROWS:'25'}),'25');
 assert.equal(environment('PORT',{CONTEXT_OS_PORT:'',DATAENGINE_PORT:'8788'}),'','an explicit new setting is not replaced by legacy state');
});

test('custom model credentials restore their old encrypted entry under the new environment and clearing the key stays cleared',()=>{
 const root=directory(),settings:ModelSettings={provider:'custom',model:'synthetic-model',protocol:'openai',baseUrl:'http://127.0.0.1:1/v1'},keyName=modelKeyEnvironment(settings),legacyName=keyName.replace('CONTEXT_OS_','DATAENGINE_'),prior={...process.env};
 process.env.CONTEXT_OS_VAULT_KEY_DIRECTORY=join(root,'keys');
 try{
  assert.match(keyName,/^CONTEXT_OS_CUSTOM_/);new CredentialVault(join(root,'workspace')).set('models',{[legacyName]:'synthetic-prior-model-key'});
  const credentials=new ModelCredentials(join(root,'workspace'));assert.equal(credentials.saved(settings),true);credentials.restore(settings);assert.equal(process.env[keyName],'synthetic-prior-model-key');
  process.env[legacyName]='synthetic-stale-environment';credentials.save(settings,null);assert.equal(credentials.saved(settings),false);credentials.restore(settings);assert.equal(process.env[keyName],undefined);assert.equal(process.env[legacyName],undefined);
 }finally{for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior);rmSync(root,{recursive:true,force:true});}
});

test('legacy keychain and file vaults keep their original encryption keys after the product rename',()=>{
 const root=directory(),key=Buffer.alloc(32,31),workspace=join(root,'workspace'),prior=process.env.CONTEXT_OS_VAULT_KEY_DIRECTORY;delete process.env.CONTEXT_OS_VAULT_KEY_DIRECTORY;
 try{
  legacyEnvelope(workspace,'keychain',key,'master-v1',{models:{preserved:'synthetic-old-secret'}});
  let newReads=0;const vault=new CredentialVault(workspace,{keychain:{read(){newReads++;throw new Error('new namespace has no old key');},create(){return Buffer.alloc(32,3);}},legacyKeychain:{read:()=>key,create:()=>key}});
  assert.equal(vault.get('models').preserved,'synthetic-old-secret');vault.set('models',{preserved:'synthetic-old-secret',another:'synthetic-new-entry'});assert.equal(newReads,0);assert.equal(JSON.parse(readFileSync(join(workspace,'credentials','vault.json'),'utf8')).keyId,'master-v1');
  const fileWorkspace=join(root,'file-workspace'),legacyKeys=join(root,'old-keys'),newKeys=join(root,'new-keys');mkdirSync(legacyKeys);writeFileSync(join(legacyKeys,'legacy-file-key.key'),key.toString('base64'),{mode:0o600});legacyEnvelope(fileWorkspace,'file',key,'legacy-file-key',{sources:{preserved:'synthetic-file-secret'}});
  assert.equal(new CredentialVault(fileWorkspace,{keyDirectory:newKeys,legacyKeyDirectory:legacyKeys,keychain:null}).get('sources').preserved,'synthetic-file-secret');
  const fresh=new CredentialVault(join(root,'fresh'),{keychain:{create:()=>key,read:()=>key}});fresh.set('models',{created:'synthetic-new-secret'});assert.equal(JSON.parse(readFileSync(join(root,'fresh','credentials','vault.json'),'utf8')).keyId,'context-os-master-v1');
 }finally{if(prior===undefined)delete process.env.CONTEXT_OS_VAULT_KEY_DIRECTORY;else process.env.CONTEXT_OS_VAULT_KEY_DIRECTORY=prior;rmSync(root,{recursive:true,force:true});}
});

test('new and existing consumer keys still require an active published dataset and retain revocation',()=>{
 const root=directory(),memory=new MemoryStore(root);try{
  const release=memory.putArtifact({kind:'data_release',title:'已发布',status:'published',content:{}}),datasets=new OntologyDatasets(memory,{} as never);
  for(const prefix of ['cos_dataset_','de_dataset_']){
   const key=prefix+randomBytes(32).toString('base64url'),dataset=memory.putArtifact({kind:'ontology_dataset',title:prefix,status:'active',content:{releaseRef:{id:release.id,version:release.version},keyHash:createHash('sha256').update(key).digest('hex')}});
   assert.equal(datasets.authenticate(key)?.id,dataset.id);assert.equal(datasets.authenticate(key+'x'),undefined);
   memory.putArtifact({...dataset,expectedVersion:dataset.version,status:'revoked'});assert.equal(datasets.authenticate(key),undefined);
  }
 }finally{memory.close();rmSync(root,{recursive:true,force:true});}
});


test('new backup packages use Context OS names and old packages remain restorable and idempotent',async()=>{
 const root=directory(),memory=new MemoryStore(join(root,'workspace'));
 try{
  memory.putArtifact({kind:'source',title:'保留的资料',status:'ready',content:{format:'text',raw:'产品改名不清空业务资料'}});
  const backup=new BackupService(memory),saved=await backup.create({destination:join(root,'backups'),operationId:'stable-backup'});
  assert.match(saved.path,/context-os-backup-/);assert.equal(saved.manifest.format,'context-os-backup-v1');
  const legacyPath=join(saved.path,'manifest.json');writeFileSync(legacyPath,JSON.stringify({...saved.manifest,format:'ade-backup-v1'}),{mode:0o600});
  assert.equal((await backup.create({destination:join(root,'backups'),operationId:'stable-backup'})).path,saved.path);
  const restored=await BackupService.restore({backup:saved.path,destination:join(root,'restored')}),copy=new MemoryStore(restored.directory);
  try{assert.equal(copy.listArtifacts('source')[0].content.raw,'产品改名不清空业务资料');}finally{copy.close();}
 }finally{memory.close();rmSync(root,{recursive:true,force:true});}
});

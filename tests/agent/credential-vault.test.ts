import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,statSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CredentialVault} from '../../src/security/credential-vault.ts';
import {ModelCredentials} from '../../src/agent/model-credentials.ts';
import {MemoryStore} from '../../src/agent/memory.ts';
import {SourceConnections} from '../../src/live/sources.ts';
import {AgentMcp} from '../../src/capabilities/mcp.ts';
import {createHeatingSources} from '../../src/live/heating-sources.ts';
import {SourceAuthorization,oauthSchema} from '../../src/live/source-auth.ts';
import {createServer} from 'node:http';

test('ADE credentials migrate to an encrypted vault and a missing local key fails closed without replacing the vault',()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-vault-')),workspace=join(root,'workspace'),keys=join(root,'machine-keys');
 try{
  mkdirSync(join(workspace,'credentials'),{recursive:true});
  const legacy=join(workspace,'credentials','models.json'),secret='synthetic-model-key-for-vault-test';
  writeFileSync(legacy,JSON.stringify({MODEL_TEST_KEY:secret}));
  const vault=new CredentialVault(workspace,{keyDirectory:keys,keychain:null});
  vault.migrateJson('models','credentials/models.json');
  assert.equal(existsSync(legacy),false);assert.deepEqual(vault.get('models'),{MODEL_TEST_KEY:secret});
  vault.set('sources',{connection:'synthetic-source-token'});
  const reopened=new CredentialVault(workspace,{keyDirectory:keys,keychain:null});
  assert.deepEqual(reopened.get('models'),{MODEL_TEST_KEY:secret});
  assert.deepEqual(reopened.get('sources'),{connection:'synthetic-source-token'});
  const encrypted=readFileSync(join(workspace,'credentials','vault.json'),'utf8');
  assert.doesNotMatch(encrypted,/synthetic-|MODEL_TEST_KEY/);
  rmSync(join(workspace,'credentials','vault.json'));assert.throws(()=>reopened.get('models'),/锁定|密钥/);writeFileSync(join(workspace,'credentials','vault.json'),encrypted,{mode:0o600});
  assert.equal(statSync(join(workspace,'credentials','vault.json')).mode&0o777,0o600);
  const key=join(keys,readdirSync(keys)[0]);assert.equal(statSync(key).mode&0o777,0o600);
  rmSync(key);
  assert.equal(reopened.status().status,'locked');
  assert.throws(()=>reopened.get('models'),/凭据.*锁定|密钥/);
  assert.throws(()=>reopened.set('sources',{}),/凭据.*锁定|密钥/);
  assert.equal(readFileSync(join(workspace,'credentials','vault.json'),'utf8'),encrypted);
  assert.deepEqual(readdirSync(keys),[],'a lost key is never silently replaced');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('vault migration preserves legacy data on a locked keychain and never writes keys through a workspace symlink',()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-vault-boundary-')),workspace=join(root,'workspace');let locked=false;const key=Buffer.alloc(32,7),keychain={create:()=>key,read:()=>{if(locked)throw new Error('locked');return key;}};
 try{
  const vault=new CredentialVault(workspace,{keychain});vault.set('models',{fake:'synthetic-keychain-secret'});assert.equal(vault.status().provider,'keychain');
  const legacy=join(workspace,'source-credentials.json');writeFileSync(legacy,JSON.stringify({source:'synthetic-legacy-secret'}));const encrypted=readFileSync(join(workspace,'credentials','vault.json'),'utf8');
  locked=true;assert.throws(()=>vault.migrateJson('sources','source-credentials.json'),/锁定/);assert.equal(existsSync(legacy),true);assert.equal(readFileSync(join(workspace,'credentials','vault.json'),'utf8'),encrypted);
  const fresh=join(root,'fresh');mkdirSync(join(fresh,'not-outside'),{recursive:true});symlinkSync(join(fresh,'not-outside'),join(root,'parent-link'));
  assert.throws(()=>new CredentialVault(fresh,{keyDirectory:join(root,'parent-link','nested'),keychain:null}).set('models',{}),/工作区之外|锁定/);
  assert.equal(existsSync(join(fresh,'credentials','vault.json')),false);
  assert.throws(()=>new CredentialVault(fresh,{keyDirectory:join(fresh,'..keys'),keychain:null}).set('models',{}),/工作区之外/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('MCP headers survive restart only through the vault and a locked vault blocks an already connected manager',{timeout:20000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-vault-mcp-')),workspace=join(root,'workspace'),keys=join(root,'keys'),prior=process.env.ADE_VAULT_KEY_DIRECTORY;
 process.env.ADE_VAULT_KEY_DIRECTORY=keys;const source=await createHeatingSources();let mcp=new AgentMcp(workspace);
 try{
  await mcp.connect({name:'callbacks',url:source.mcpUrl,headers:{'X-Example':'synthetic-mcp-header'}});
  const id=mcp.list()[0].capabilities[0].id;mcp.grant('callbacks',[id]);
  assert.doesNotMatch(readFileSync(join(workspace,'capabilities','mcp.json'),'utf8'),/synthetic-mcp-header/);
  await mcp.close();mcp=new AgentMcp(workspace);
  assert.match(JSON.stringify(await mcp.call(id,{limit:20,offset:0})),/未改善/);
  const encrypted=readFileSync(join(workspace,'credentials','vault.json'),'utf8');assert.doesNotMatch(encrypted,/synthetic-mcp-header/);
  for(const key of readdirSync(keys))rmSync(join(keys,key));
  await assert.rejects(mcp.call(id,{limit:20,offset:0}),/凭据.*锁定|密钥/);
  assert.equal(readFileSync(join(workspace,'credentials','vault.json'),'utf8'),encrypted);
 }finally{await mcp.close();await source.close();if(prior===undefined)delete process.env.ADE_VAULT_KEY_DIRECTORY;else process.env.ADE_VAULT_KEY_DIRECTORY=prior;rmSync(root,{recursive:true,force:true});}
});

test('an OAuth response from before revocation cannot restore the same re-registered credentials',{timeout:10000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-vault-oauth-')),prior=process.env.ADE_VAULT_KEY_DIRECTORY;process.env.ADE_VAULT_KEY_DIRECTORY=join(root,'keys');
 let release:()=>void=()=>{},entered:()=>void=()=>{};const waiting=new Promise<void>(resolve=>{entered=resolve;});
 const server=createServer(async(_req,res)=>{entered();await new Promise<void>(resolve=>{release=resolve;});res.setHeader('content-type','application/json');res.end(JSON.stringify({access_token:'synthetic-late-token',token_type:'Bearer',expires_in:300}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const config=oauthSchema.parse({tokenUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/token`,clientId:'fixture',clientSecret:'synthetic-client'}),auth=new SourceAuthorization(join(root,'workspace'));
  auth.register('source',config);const pending=auth.token(config,false,'source');const rejected=assert.rejects(pending,/OAuth 认证失败/);
  await waiting;auth.forget('source');auth.register('source',config);release();await rejected;
  assert.equal(new CredentialVault(join(root,'workspace')).get('oauth').source&&JSON.stringify(new CredentialVault(join(root,'workspace')).get('oauth')).includes('synthetic-late-token'),false);
 }finally{release();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));if(prior===undefined)delete process.env.ADE_VAULT_KEY_DIRECTORY;else process.env.ADE_VAULT_KEY_DIRECTORY=prior;rmSync(root,{recursive:true,force:true});}
});

test('opening ADE model and source services migrates all four own plaintext credential stores without touching unrelated files',()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-vault-services-')),workspace=join(root,'workspace'),prior=process.env.ADE_VAULT_KEY_DIRECTORY;
 process.env.ADE_VAULT_KEY_DIRECTORY=join(root,'keys');
 const memory=new MemoryStore(workspace);
 try{
  mkdirSync(join(workspace,'credentials'),{recursive:true});
  const fixtures={'credentials/models.json':{MODEL_TEST_KEY:'synthetic-model'},'source-credentials.json':{test:'synthetic-bearer'},'source-oauth.json':{test:{clientSecret:'synthetic-client',refreshToken:'synthetic-refresh'}},'database-credentials.json':{test:'synthetic-database'}};
  for(const [file,body] of Object.entries(fixtures))writeFileSync(join(workspace,file),JSON.stringify(body));
  writeFileSync(join(root,'unrelated-account.json'),'unrelated synthetic content');
  new ModelCredentials(workspace);new SourceConnections(workspace,memory);
  for(const file of Object.keys(fixtures))assert.equal(existsSync(join(workspace,file)),false,`${file} is migrated`);
  const vault=new CredentialVault(workspace);
  assert.deepEqual(vault.get('models'),fixtures['credentials/models.json']);assert.deepEqual(vault.get('sources'),fixtures['source-credentials.json']);
  assert.deepEqual(vault.get('oauth'),fixtures['source-oauth.json']);assert.deepEqual(vault.get('database'),fixtures['database-credentials.json']);
  assert.equal(readFileSync(join(root,'unrelated-account.json'),'utf8'),'unrelated synthetic content');
 }finally{memory.close();if(prior===undefined)delete process.env.ADE_VAULT_KEY_DIRECTORY;else process.env.ADE_VAULT_KEY_DIRECTORY=prior;rmSync(root,{recursive:true,force:true});}
});

test('a migrated legacy source cannot become anonymous when the entire credential directory is lost',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-vault-legacy-source-')),workspace=join(root,'workspace'),prior=process.env.ADE_VAULT_KEY_DIRECTORY;process.env.ADE_VAULT_KEY_DIRECTORY=join(root,'keys');const memory=new MemoryStore(workspace);
 let calls=0;const server=createServer((_req,res)=>{calls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({items:[{id:'1'}]}));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const original=await new SourceConnections(workspace,memory).connect({name:'旧来源',protocol:'http',url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,capabilities:[{name:'records',path:'/records',fields:['id']}]});
  writeFileSync(join(workspace,'source-credentials.json'),JSON.stringify({[original.id]:'synthetic-legacy-bearer'}));new SourceConnections(workspace,memory);
  rmSync(join(workspace,'credentials'),{recursive:true});const reopened=new SourceConnections(workspace,memory);
  await assert.rejects(reopened.readRecords(original.id,'records'),/凭据|授权/);assert.equal(calls,0);
 }finally{memory.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));if(prior===undefined)delete process.env.ADE_VAULT_KEY_DIRECTORY;else process.env.ADE_VAULT_KEY_DIRECTORY=prior;rmSync(root,{recursive:true,force:true});}
});

import {environment} from "../config/brand.ts";
import {createCipheriv,createDecipheriv,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {chmodSync,closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {z} from 'zod';

const envelope=z.object({format:z.literal(1),id:z.string().uuid(),provider:z.enum(['keychain','file']),keyId:z.string().regex(/^[a-zA-Z0-9-]+$/),nonce:z.string(),tag:z.string(),ciphertext:z.string()}).strict();
type Envelope=z.infer<typeof envelope>;
export interface VaultKeychain {read():Buffer;create():Buffer;}
export class VaultLocked extends Error {constructor(){super('凭据保险库已锁定或密钥不可用，请恢复本机密钥或解锁系统钥匙串；现有凭据未被替换');this.name='VaultLocked';}}
const keyBytes=(value:string)=>{const key=Buffer.from(value.trim(),'base64');if(key.length!==32)throw new VaultLocked();return key;};

/** Uses only this product's explicitly named keychain item; no account discovery. */
export class SystemVaultKeychain implements VaultKeychain {
 private account='master-v1';private service:string;
 constructor(service='com.context-os.workspace-vault'){this.service=service;}
 read(){
  if(process.platform!=='darwin')throw new VaultLocked();
  try{return keyBytes(execFileSync('/usr/bin/security',['find-generic-password','-s',this.service,'-a',this.account,'-w'],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','pipe']}));}catch{throw new VaultLocked();}
 }
 create(){
  if(process.platform!=='darwin')throw new VaultLocked();
  try{return this.read();}catch{}
  const key=randomBytes(32);
  try{
   // Interactive command input keeps the generated master key out of process arguments.
   execFileSync('/usr/bin/security',['-i'],{input:`add-generic-password -s ${this.service} -a ${this.account} -w ${key.toString('base64')}\n`,timeout:3000,stdio:['pipe','pipe','pipe']});
   const saved=this.read();if(!timingSafeEqual(saved,key))throw new VaultLocked();return saved;
  }catch{throw new VaultLocked();}
 }
}

const legacyFiles=new Set(['credentials/models.json','source-credentials.json','source-oauth.json','database-credentials.json']);
const object=z.record(z.string(),z.unknown());
const atomicFile=(file:string,content:string)=>{
 const temporary=`${file}.${randomUUID()}.tmp`;let descriptor:number|undefined;
 try{descriptor=openSync(temporary,'wx',0o600);writeFileSync(descriptor,content);fsyncSync(descriptor);closeSync(descriptor);descriptor=undefined;renameSync(temporary,file);chmodSync(file,0o600);}
 finally{if(descriptor!==undefined)closeSync(descriptor);rmSync(temporary,{force:true});}
};
const ordinaryFile=(file:string)=>{if(lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile())throw new VaultLocked();};

/** Workspace stores authenticated ciphertext; the encryption key is always outside it. */
export class CredentialVault {
 private directory:string;private file:string;private keys:string;private legacyKeys?:string;private keychain:VaultKeychain|null;private legacyKeychain:VaultKeychain|null;
 constructor(directory:string,options:{keyDirectory?:string;legacyKeyDirectory?:string;keychain?:VaultKeychain|null;legacyKeychain?:VaultKeychain|null}={}){
  mkdirSync(directory,{recursive:true,mode:0o700});this.directory=realpathSync(directory);this.file=join(this.directory,'credentials','vault.json');
  const configuredKeys=options.keyDirectory??environment('VAULT_KEY_DIRECTORY');
  this.keys=resolve(configuredKeys??join(homedir(),'.local','share','context-os','keys'));
  // Old file envelopes keep their exact keyId; new installations never write into the legacy directory.
  this.legacyKeys=options.legacyKeyDirectory??(configuredKeys===undefined?join(homedir(),'.local','share','dataengine','keys'):undefined);
  const inside=relative(this.directory,this.keys);if(!(inside==='..'||inside.startsWith('..'+sep)||isAbsolute(inside)))throw new Error('保险库密钥目录必须位于工作区之外');
  this.keychain=options.keychain===undefined?(configuredKeys!==undefined?null:new SystemVaultKeychain()):options.keychain;
  // An old envelope is bound to the old service, even if the new service already has another key.
  this.legacyKeychain=options.legacyKeychain===undefined?(options.keychain!==undefined?options.keychain:configuredKeys!==undefined?null:new SystemVaultKeychain('com.dataengine.workspace-vault')):options.legacyKeychain;
  if(existsSync(dirname(this.file))&&lstatSync(dirname(this.file)).isSymbolicLink())throw new VaultLocked();
  mkdirSync(dirname(this.file),{recursive:true,mode:0o700});chmodSync(dirname(this.file),0o700);
 }
 private keyDirectory(directory=this.keys){const path=realpathSync(directory),inside=relative(this.directory,path);if(!(inside==='..'||inside.startsWith('..'+sep)||isAbsolute(inside)))throw new Error('保险库密钥目录必须位于工作区之外');return path;}
 private stored():Envelope|null{
  const marker=join(dirname(this.file),'vault-state.json');
  if(!existsSync(this.file)){if(existsSync(marker))throw new VaultLocked();return null;}
  try{ordinaryFile(this.file);const value=envelope.parse(JSON.parse(readFileSync(this.file,'utf8')));if(existsSync(marker)){ordinaryFile(marker);if(JSON.parse(readFileSync(marker,'utf8')).id!==value.id)throw new VaultLocked();}return value;}catch{throw new VaultLocked();}
 }
 private key(value:Envelope){
  try{
   if(value.provider==='keychain'){const keychain=value.keyId==='master-v1'?this.legacyKeychain:this.keychain;if(!keychain)throw new VaultLocked();return keychain.read();}
   const directory=!existsSync(join(this.keys,`${value.keyId}.key`))&&this.legacyKeys&&existsSync(join(this.legacyKeys,`${value.keyId}.key`))?this.legacyKeys:this.keys;
   const path=join(this.keyDirectory(directory),`${value.keyId}.key`);ordinaryFile(path);if((lstatSync(path).mode&0o077)!==0)throw new VaultLocked();return keyBytes(readFileSync(path,'utf8'));
  }catch{throw new VaultLocked();}
 }
 private aad(value:Envelope){return Buffer.from(JSON.stringify({format:value.format,id:value.id,provider:value.provider,keyId:value.keyId}));}
 private decrypt(value:Envelope){
  try{const decipher=createDecipheriv('aes-256-gcm',this.key(value),Buffer.from(value.nonce,'base64'));decipher.setAAD(this.aad(value));decipher.setAuthTag(Buffer.from(value.tag,'base64'));return object.parse(JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext,'base64')),decipher.final()]).toString('utf8')));}
  catch{throw new VaultLocked();}
 }
 status(){try{const value=this.stored();if(value)this.decrypt(value);return{status:value?'ready':'empty',provider:value?.provider??null};}catch{return{status:'locked',provider:null};}}
 get(namespace:string):Record<string,unknown>{const value=this.stored();return structuredClone(object.parse((value?this.decrypt(value)[namespace]:undefined)??{}));}
 set(namespace:string,content:Record<string,unknown>){
  z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).parse(namespace);object.parse(content);
  let value=this.stored(),key:Buffer;const data=value?this.decrypt(value):{};
  if(value)key=this.key(value);
  else{
   let provider:'keychain'|'file'='keychain',keyId='context-os-master-v1';
   try{if(!this.keychain)throw new VaultLocked();key=this.keychain.create();}
   catch{provider='file';keyId=randomUUID();key=randomBytes(32);mkdirSync(this.keys,{recursive:true,mode:0o700});if(lstatSync(this.keys).isSymbolicLink())throw new VaultLocked();const keys=this.keyDirectory();chmodSync(keys,0o700);atomicFile(join(keys,`${keyId}.key`),key.toString('base64'));}
   value={format:1,id:randomUUID(),provider,keyId,nonce:'',tag:'',ciphertext:''};
  }
  data[namespace]=structuredClone(content);const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(this.aad(value));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(data),'utf8'),cipher.final()]);
  const next={...value,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
  this.decrypt(next);atomicFile(this.file,JSON.stringify(next));atomicFile(join(dirname(this.file),'vault-state.json'),JSON.stringify({format:1,id:next.id}));
 }
 delete(namespace:string){this.set(namespace,{});}
 migrateJson(namespace:string,path:string){
  if(!legacyFiles.has(path))throw new Error('只允许迁移 Context OS 自有凭据文件');
  const source=join(this.directory,path);if(!existsSync(source))return;
  ordinaryFile(source);const before=readFileSync(source,'utf8'),legacy=object.parse(JSON.parse(before));
  const combined={...legacy,...this.get(namespace)};this.set(namespace,combined);
  if(JSON.stringify(this.get(namespace))!==JSON.stringify(combined))throw new VaultLocked();
  if(readFileSync(source,'utf8')!==before)throw new Error('迁移期间凭据文件已变化，旧文件保留供重试');
  rmSync(source);
 }
}

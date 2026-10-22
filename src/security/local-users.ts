import {createHash,randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import type {MemoryStore} from '../agent/memory.ts';
import type {Artifact,Data} from '../agent/contracts.ts';
import {CredentialVault} from './credential-vault.ts';
import {assertRole,roleSchema,type Actor} from './actors.ts';
import {fingerprint} from '../engine/release-diff.ts';
import {jsonData} from '../live/sources.ts';

const username=z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.@-]{1,79}$/),name=z.string().trim().min(1).max(100),password=z.string().min(10).max(200),operation=z.string().trim().min(1).max(200);
const create=z.object({operationId:operation,username,name,password,role:roleSchema}).strict();
const update=z.object({id:z.string().min(1),version:z.number().int().positive(),operationId:operation,name:name.optional(),role:roleSchema.optional(),enabled:z.boolean().optional(),password:password.optional()}).strict();
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const encode=(password:string,salt:string)=>scryptSync(password,salt,32).toString('hex');
type Credential={salt:string;hash:string;version:number};
type Session={userId:string;version:number;expiresAt:string};
type State={credentials:Record<string,Credential>;sessions:Record<string,Session>;operations:Record<string,{signature:string;userId:string;version:number}>};
const publicUser=(item:Artifact)=>({id:item.id,version:item.version,username:String(item.content.username),name:item.title,role:roleSchema.parse(item.content.role),enabled:item.status==='active'});

/** Password verifiers and session hashes are private vault entries, never public artifacts or exported config. */
export class LocalUsers {
  private memory:MemoryStore;private vault:CredentialVault;
  constructor(memory:MemoryStore,options:{vault?:CredentialVault}={}){this.memory=memory;this.vault=options.vault??new CredentialVault(memory.directory);}
  private state():State{
    const data=this.vault.get('local-users');
    return {credentials:(data.credentials??{}) as State['credentials'],sessions:(data.sessions??{}) as State['sessions'],operations:(data.operations??{}) as State['operations']};
  }
  list(){assertRole('users');return this.memory.listArtifacts('local_user').map(publicUser);}
  private replay(state:State,operationId:string,args:unknown){
    const previous=state.operations[operationId];if(!previous)return;
    if(previous.signature!==fingerprint(args))throw new Error('同一操作标识已用于不同账号请求');
    return publicUser(this.memory.getArtifact(previous.userId,previous.version));
  }
  private save(args:{operationId:string;password?:string},prior:Artifact|undefined,content:Data,title:string,status:string){
    const state=this.state(),previous=this.replay(state,args.operationId,args);if(previous)return previous;
    return this.memory.atomic(()=>{
      const item=this.memory.putArtifact({...(prior?{id:prior.id,expectedVersion:prior.version}:{}),kind:'local_user',title,status,content});
      const existing=state.credentials[item.id];
      if(args.password){const salt=randomBytes(32).toString('hex');state.credentials[item.id]={salt,hash:encode(args.password,salt),version:item.version};}
      else if(existing)state.credentials[item.id]={...existing,version:item.version};
      for(const [key,session] of Object.entries(state.sessions))if(session.userId===item.id||Date.parse(session.expiresAt)<=Date.now())delete state.sessions[key];
      state.operations[args.operationId]={signature:fingerprint(args),userId:item.id,version:item.version};
      const entries=Object.entries(state.operations);if(entries.length>1000)state.operations=Object.fromEntries(entries.slice(-1000));
      // If the enclosing DB commit fails after this write, the version mismatch denies login rather than granting stale authority.
      this.vault.set('local-users',state);return publicUser(item);
    });
  }
  create(input:unknown){
    assertRole('users');const args=create.parse(input),previous=this.replay(this.state(),args.operationId,args);if(previous)return previous;
    if(this.memory.listArtifacts('local_user').some(item=>item.content.username===args.username))throw new Error('用户名已存在');
    return this.save(args,undefined,jsonData({username:args.username,role:args.role}),args.name,'active');
  }
  update(input:unknown){
    assertRole('users');const args=update.parse(input),previous=this.replay(this.state(),args.operationId,args);if(previous)return previous;
    const user=this.memory.getArtifact(args.id);if(user.kind!=='local_user'||user.version!==args.version)throw new Error('用户状态或版本已变化');
    return this.save(args,user,{...user.content,...(args.role?{role:args.role}:{})},args.name??user.title,args.enabled===undefined?user.status:args.enabled?'active':'disabled');
  }
  login(input:unknown){
    const args=z.object({username,password:z.string().min(1).max(200)}).strict().parse(input),state=this.state();
    const user=this.memory.listArtifacts('local_user').find(item=>item.content.username===args.username),credential=user?state.credentials[user.id]:undefined;
    const actual=encode(args.password,credential?.salt??'invalid-local-user'),expected=credential?.hash??'0'.repeat(64);
    if(!user||user.status!=='active'||credential?.version!==user.version||!timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex')))throw new Error('用户名或密码不正确');
    const token=randomBytes(32).toString('base64url'),expiresAt=new Date(Date.now()+86400000).toISOString();
    state.sessions=Object.fromEntries(Object.entries(state.sessions).filter(([,session])=>Date.parse(session.expiresAt)>Date.now()).slice(-499));
    state.sessions[digest(token)]={userId:user.id,version:user.version,expiresAt};this.vault.set('local-users',state);
    return {token,expiresAt,user:publicUser(user)};
  }
  authenticate(token:string):Actor{
    if(typeof token!=='string'||token.length>200)throw new Error('登录已失效，请重新登录');
    const state=this.state(),session=state.sessions[digest(token)];if(!session||Date.parse(session.expiresAt)<=Date.now())throw new Error('登录已失效，请重新登录');
    const user=this.memory.getArtifact(session.userId);
    if(user.kind!=='local_user'||user.status!=='active'||user.version!==session.version||state.credentials[user.id]?.version!==user.version)throw new Error('登录授权已变化，请重新登录');
    return {kind:'human',id:user.id,name:user.title,role:roleSchema.parse(user.content.role),version:user.version};
  }
  assertCurrent(actor:Actor){
    const principal=actor.kind==='human'?actor:actor.initiatedBy;if(!principal||principal.id==='local-admin')return;
    const user=this.memory.getArtifact(principal.id);
    if(user.kind!=='local_user'||user.status!=='active'||user.version!==principal.version||user.content.role!==principal.role)throw new Error('登录授权已变化，请重新登录');
  }
  logout(token:string){const state=this.state();delete state.sessions[digest(token)];this.vault.set('local-users',state);return {loggedOut:true};}
}

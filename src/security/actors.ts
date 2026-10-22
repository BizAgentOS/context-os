import {AsyncLocalStorage} from 'node:async_hooks';
import {z} from 'zod';

export const roleSchema=z.enum(['admin','maintainer','viewer']);
const identity=z.object({id:z.string().min(1).max(240),name:z.string().min(1).max(200),role:roleSchema.optional(),version:z.number().int().positive().optional()}).strict();
export const actorSchema=identity.extend({kind:z.enum(['human','agent','program','external']),initiatedBy:identity.optional()}).strict();
export type Actor=z.infer<typeof actorSchema>;
export type Role=z.infer<typeof roleSchema>;
export type RoleAction='browse'|'qa'|'build'|'source'|'change'|'gap'|'publish'|'connection'|'settings'|'users';
const storage=new AsyncLocalStorage<{actor:Actor;validate?:()=>void}>();
const administrator:Actor=Object.freeze({kind:'human',id:'local-admin',name:'本地管理员',role:'admin'});
export class RoleDenied extends Error {readonly status=403;readonly code='role_denied';}
export const currentActor=():Actor=>{const context=storage.getStore();context?.validate?.();return structuredClone(context?.actor??administrator);};
export function withActor<T>(actor:Actor,run:()=>T,validate?:()=>void):T{return storage.run({actor:Object.freeze(actorSchema.parse(actor)),validate:validate??storage.getStore()?.validate},run);}
export function rolePolicy(role:Role,action:RoleAction){
  if(role==='admin')return true;
  if(['browse','qa'].includes(action))return true;
  return role==='maintainer'&&['build','source','change','gap'].includes(action);
}
export function assertRole(action:RoleAction){
  const actor=currentActor(),role=actor.role??(actor.kind==='program'?'admin':'viewer');
  if(!rolePolicy(role,action))throw new RoleDenied('当前角色没有执行此操作的权限');
}
export function agentActor(executionId:string):Actor{
  const caller=currentActor(),principal=caller.kind==='human'?{id:caller.id,name:caller.name,role:caller.role,version:caller.version}:caller.initiatedBy;
  return {kind:'agent',id:`agent:${executionId}`,name:'ADE 助手',role:caller.role??'admin',...(principal?{initiatedBy:principal}:{})};
}
export const programActor=(id:string):Actor=>({kind:'program',id:`program:${id}`,name:'ADE 程序'});
export const externalActor=(id:string,name='外部接入方'):Actor=>({kind:'external',id:`external:${id}`,name,role:'viewer'});

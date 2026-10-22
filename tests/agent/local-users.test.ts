import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MemoryStore} from '../../src/agent/memory.ts';
import {CredentialVault} from '../../src/security/credential-vault.ts';
import {LocalUsers} from '../../src/security/local-users.ts';
import {withActor,assertRole,currentActor} from '../../src/security/actors.ts';
import {AuditTrail} from '../../src/security/audit-trail.ts';
import {createServer} from '../../src/agent/server.ts';
import {Workspace} from '../../src/agent/workspace.ts';

test('local users authenticate without exposing secrets and role changes immediately revoke old sessions',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ade-local-users-')),memory=new MemoryStore(join(root,'workspace'));
  try{
    const users=new LocalUsers(memory,{vault:new CredentialVault(memory.directory,{keyDirectory:join(root,'keys'),keychain:null})});
    const created=users.create({operationId:'create',username:'reader',name:'只读同事',role:'viewer',password:'private-password-01'});
    assert.equal(created.role,'viewer');assert.doesNotMatch(JSON.stringify(users.list()),/private-password|salt|hash|token/);
    assert.deepEqual(users.create({operationId:'create',username:'reader',name:'只读同事',role:'viewer',password:'private-password-01'}),created);
    assert.throws(()=>users.login({username:'reader',password:'wrong-password'}),/用户名或密码/);
    const login=users.login({username:'reader',password:'private-password-01'}),actor=users.authenticate(login.token);
    assert.equal(actor.role,'viewer');assert.equal(actor.name,'只读同事');
    await withActor(actor,async()=>{
      assertRole('browse');assertRole('qa');
      for(const action of ['build','source','change','publish','connection','settings','users','gap'] as const)assert.throws(()=>assertRole(action),/权限/);
      assert.throws(()=>users.create({operationId:'escalate',username:'admin',name:'越权',role:'admin',password:'password-secret'}),/权限/);
      await Promise.resolve();assert.equal(currentActor().id,created.id,'actor authority survives awaits');
    });
    const promoted=users.update({id:created.id,version:created.version,operationId:'promote',role:'maintainer'});
    assert.equal(promoted.role,'maintainer');assert.throws(()=>users.authenticate(login.token),/登录|变化|失效/);
    const maintainer=users.login({username:'reader',password:'private-password-01'});
    withActor(users.authenticate(maintainer.token),()=>{assertRole('source');assertRole('build');assertRole('change');assert.throws(()=>assertRole('publish'),/权限/);assert.throws(()=>assertRole('connection'),/权限/);});
    users.logout(maintainer.token);assert.throws(()=>users.authenticate(maintainer.token),/登录|失效/);
    assert.doesNotMatch(JSON.stringify(memory.listArtifacts()),/private-password|passwordHash|sessionHash/);
  }finally{memory.close();rmSync(root,{recursive:true,force:true});}
});

test('adoption and rejection preserve the real maintainer actor across awaits and audit only committed decisions',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'ade-actor-audit-')),service=await createServer({directory,automaticApi:false}),app=service.app;
  try{
    const audit=new AuditTrail(app.memory),actor={kind:'human' as const,id:'maintainer-case',name:'维护同事',role:'maintainer' as const};
    await withActor(actor,async()=>{
      const change=(await app.changes.propose({operationId:'actor-propose',origin:'human',type:'enterprise_profile',baseline:app.changes.currentBaseline(),subject:{profileRef:null,updates:[{key:'company.goal',text:'考虑扩展服务',kind:'suggestion'}]}})).change;
      assert.equal(change.content.proposedBy,actor.id);
      const checked=await app.changes.verify({id:change.id,version:change.version,operationId:'actor-verify'});
      const adopted=await app.changes.adopt({id:checked.id,version:checked.version,operationId:'actor-adopt',acknowledgeReview:true});
      assert.equal((adopted.content.decision as any).actor,actor.id);assert.equal(adopted.actor?.id,actor.id);
      const profile=app.memory.listArtifacts('profile')[0];assert.equal((profile.content.statements as any[])[0].confirmation.actor,actor.id);
      const next=(await app.changes.propose({operationId:'actor-reject-propose',origin:'human',type:'enterprise_profile',baseline:app.changes.currentBaseline(),subject:{profileRef:{id:profile.id,version:profile.version},updates:[{key:'company.goal',text:'另一建议',kind:'suggestion'}]}})).change;
      const rejected=app.changes.reject({id:next.id,version:next.version,operationId:'actor-reject',reason:'暂不采用'});assert.equal(rejected.content.closedBy,actor.id);
    });
    const records=audit.list({actorId:actor.id,limit:100});
    assert.ok(records.items.some(item=>item.content.action==='ontology_change:adopted'));assert.ok(records.items.some(item=>item.content.action==='ontology_change:rejected'));
    assert.ok(records.items.every(item=>(item.content.actor as any).id===actor.id));
    const before=records.total;
    assert.throws(()=>withActor(actor,()=>app.memory.atomic(()=>{app.memory.putArtifact({kind:'data_release',title:'不得留下审计成功',status:'published',content:{}});throw new Error('rollback');})),/rollback/);
    assert.equal(audit.list({actorId:actor.id,limit:100}).total,before);
    await withActor({...actor,role:'viewer'},async()=>{
      await assert.rejects(app.changes.propose({operationId:'viewer-write',origin:'human',type:'enterprise_profile',baseline:app.changes.currentBaseline(),subject:{profileRef:null,updates:[]}}),/权限/);
    });
  }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});

test('uploaded sources have the same durable actor audit as source connections',()=>{
  const directory=mkdtempSync(join(tmpdir(),'ade-source-actor-')),memory=new MemoryStore(directory),audit=new AuditTrail(memory);
  try{
    const actor={kind:'human' as const,id:'upload-maintainer',name:'接入同事',role:'maintainer' as const};
    const source=withActor(actor,()=>new Workspace(memory).upload('真实说明.md','上传资料的接入操作者必须可追溯。'));
    const entries=audit.list({targetId:source.id});assert.equal(entries.total,1);assert.equal((entries.items[0].content.actor as any).id,actor.id);assert.equal(entries.items[0].content.action,'source:ready');
  }finally{memory.close();rmSync(directory,{recursive:true,force:true});}
});

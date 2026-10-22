import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestRoleAction} from '../../src/security/http-role-policy.ts';
import {rolePolicy} from '../../src/security/actors.ts';

test('a viewer can browse and ask explicitly in QA mode but cannot disguise governance as a message',()=>{
  for(const path of ['/api/bootstrap','/api/canvas/bootstrap','/api/ontology/workspace','/api/releases','/api/sessions/session/messages','/api/artifacts/object','/api/usage','/api/auth/me'])assert.equal(rolePolicy('viewer',requestRoleAction('GET',path)),true,path);
  for(const path of ['/api/canvas/message','/api/messages']){
    assert.equal(rolePolicy('viewer',requestRoleAction('POST',path,{mode:'qa'})),true);
    for(const body of [{},{mode:'build'},{mode:'qa ',role:'admin'},{mode:null}])assert.equal(rolePolicy('viewer',requestRoleAction('POST',path,body)),false);
  }
  for(const path of ['/api/semantic/query','/api/canvas/navigate','/api/canvas/stop','/api/canvas/context/read','/api/sessions','/api/auth/logout'])assert.equal(rolePolicy('viewer',requestRoleAction('POST',path)),true,path);
  assert.equal(rolePolicy('viewer',requestRoleAction('PATCH','/api/sessions/session',{title:'问答'})),true);
  for(const path of ['/api/gaps/handoff','/api/gaps/dismiss','/api/canvas/decision','/api/profile','/api/changes/adopt'])assert.equal(rolePolicy('viewer',requestRoleAction('POST',path,{mode:'qa'})),false,path);
});

test('maintainers can connect sources and govern the working version without publishing or managing consumers',()=>{
  for(const path of ['/api/canvas/upload/table','/api/canvas/upload/document','/api/canvas/upload/batch/finalize','/api/databases/test','/api/databases/connect','/api/databases/select','/api/live/connect','/api/live/openapi/commit','/api/connectors/feishu/authorize-tables','/api/connectors/feishu/tables/select','/api/data/sync','/api/data/issues/resolve','/api/sources/manage','/api/engine/build','/api/engine/adopt','/api/changes/batch-reject','/api/foundation/adjudication/propose','/api/gaps/reask'])assert.equal(rolePolicy('maintainer',requestRoleAction('POST',path)),true,path);
  for(const path of ['/api/releases/check','/api/releases/publish','/api/releases/connect','/api/releases/upgrade','/api/releases/revoke','/api/releases/gap-feedback','/api/datasets/publish','/api/datasets/test','/api/live/views/activate','/api/consumers/activate','/api/settings/test','/api/capabilities/mcp/connect','/api/backup','/api/restore','/api/users','/api/usage'])assert.equal(rolePolicy('maintainer',requestRoleAction('POST',path)),false,path);
  assert.equal(requestRoleAction('POST','/api/releases/publish'),'publish');assert.equal(requestRoleAction('POST','/api/releases/connect'),'connection');
});

test('GET discovery and verification are not granted by the read verb, and unknown routes fail closed',()=>{
  for(const path of ['/api/databases/tables','/api/connectors/feishu','/api/changes/impact'])assert.equal(rolePolicy('viewer',requestRoleAction('GET',path)),false,path);
  for(const path of ['/api/users','/api/audit','/api/settings/retention/preview','/api/capabilities/mcp'])assert.equal(rolePolicy('maintainer',requestRoleAction('GET',path)),false,path);
  assert.equal(requestRoleAction('POST','/api/usage/policy'),'settings');
  for(const method of ['GET','POST','PATCH','DELETE'])for(const path of ['/api/future-write','/api/changes/adopt/','/api/sessions/id/messages','/api/changes/%61dopt']){
    if(method==='GET'&&path==='/api/sessions/id/messages')continue;
    const action=requestRoleAction(method,path,{mode:'qa',role:'admin'});assert.equal(rolePolicy('viewer',action),false);assert.equal(rolePolicy('maintainer',action),false);assert.equal(rolePolicy('admin',action),true);
  }
});

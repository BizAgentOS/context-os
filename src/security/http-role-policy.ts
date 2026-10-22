import type {RoleAction} from './actors.ts';

const routes=new Map<string,RoleAction>();
function allow(method:string,action:RoleAction,paths:string[]){for(const path of paths)routes.set(`${method} ${path}`,action);}

// This table classifies actual endpoint behavior. GET alone is not evidence that an endpoint is read-only.
allow('GET','browse',[
  '/api/bootstrap','/api/canvas/bootstrap','/api/canvas','/api/canvas/messages','/api/canvas/history',
  '/api/state','/api/snapshot','/api/events','/api/sessions','/api/objects','/api/onboarding','/api/onboarding/examples','/api/usage','/api/auth/me',
  '/api/ontology/workspace','/api/ontology/detail','/api/ontology/model',
  '/api/sources/summary','/api/sources/rows','/api/sources/impact','/api/canvas/upload/batch/read','/api/canvas/upload/table-batch/read',
  '/api/foundation/evidence','/api/foundation/evidence-list','/api/foundation/adjudication','/api/foundation/adjudication/read',
  '/api/pending','/api/pending/read','/api/changes','/api/changes/read','/api/naming/batches/read',
  '/api/workspace-versions','/api/workspace-versions/read','/api/engine',
  '/api/data','/api/data/sync-policy','/api/data/issues/read','/api/data/preview',
  '/api/qa/views','/api/gaps','/api/gaps/read','/api/releases','/api/releases/read','/api/releases/compare','/api/releases/data-diff',
  '/api/releases/connection','/api/releases/connection-detail','/api/releases/upgrade-preview','/api/releases/gap-feedback',
  '/api/datasets','/api/datasets/connection','/api/consumers','/api/consumers/history','/api/consumers/connection',
  '/api/live/views/evidence-options','/api/live/views/connection','/api/connectors/feishu/document',
]);
allow('GET','source',['/api/databases/tables','/api/connectors/feishu']);
allow('GET','change',['/api/changes/impact']);
allow('GET','settings',['/api/settings/retention','/api/settings/retention/preview','/api/capabilities','/api/capabilities/mcp']);
allow('GET','users',['/api/users','/api/audit']);

allow('POST','qa',[
  '/api/semantic/query','/api/canvas/navigate','/api/canvas/stop','/api/stop','/api/sessions',
  '/api/canvas/message/receipt','/api/canvas/context','/api/canvas/context/read','/api/auth/logout',
]);
allow('POST','browse',[
  '/api/live/query','/api/live/read','/api/live/catalog','/api/live/metrics/describe','/api/live/metrics/query',
  '/api/live/knowledge/query','/api/live/knowledge/read','/api/live/evidence/read',
  '/api/live/changes/list','/api/live/changes/read','/api/live/changes/issues',
  '/api/live/corrections/list','/api/live/corrections/read',
]);
allow('POST','source',[
  '/api/upload','/api/canvas/upload','/api/canvas/upload/table','/api/canvas/upload/document',
  '/api/canvas/upload/batch/start','/api/canvas/upload/batch/file','/api/canvas/upload/batch/finalize','/api/canvas/upload/reparse','/api/canvas/upload/remove',
  '/api/canvas/upload/table-batch/start','/api/canvas/upload/table-batch/finalize',
  '/api/databases/test','/api/databases/connect','/api/databases/select',
  '/api/live/connect','/api/live/disable','/api/live/openapi/parse','/api/live/openapi/preview','/api/live/openapi/commit',
  '/api/connectors/feishu/start','/api/connectors/feishu/authorize-tables','/api/connectors/feishu/cancel','/api/connectors/feishu/disconnect',
  '/api/connectors/feishu/read','/api/connectors/feishu/directory','/api/connectors/feishu/tables/browse','/api/connectors/feishu/tables/describe','/api/connectors/feishu/tables/select',
  '/api/data/sync','/api/data/accept','/api/data/policy','/api/data/sync-policy','/api/data/issues/resolve','/api/sources/policy','/api/sources/manage',
]);
allow('POST','build',[
  '/api/engine/build','/api/engine/check','/api/engine/cancel','/api/refresh',
  '/api/naming/retry',
  '/api/canvas/foundation/automatic','/api/connectors/feishu/prepare','/api/sample',
  '/api/onboarding/start','/api/onboarding/suspend','/api/onboarding/step','/api/onboarding/pack','/api/onboarding/complete','/api/onboarding/research',
]);
allow('POST','change',[
  '/api/changes/propose','/api/changes/verify','/api/changes/adopt','/api/changes/reject','/api/changes/withdraw','/api/changes/batch-adopt','/api/changes/batch-reject',
  '/api/foundation/adjudication/propose','/api/naming/batches/edit','/api/engine/adopt','/api/canvas/foundation/adopt',
  '/api/live/propose','/api/live/adopt','/api/live/evidence/collect',
  '/api/live/changes/propose','/api/live/changes/check','/api/live/changes/adopt','/api/live/changes/cancel',
  '/api/live/corrections/propose','/api/live/corrections/check','/api/live/corrections/adopt','/api/live/corrections/cancel',
  '/api/profile','/api/onboarding/company','/api/decision','/api/canvas/decision','/api/verifications/review',
]);
allow('POST','gap',['/api/gaps/handoff','/api/gaps/preview','/api/gaps/link','/api/gaps/dismiss','/api/gaps/reask']);
allow('POST','publish',['/api/releases/check','/api/releases/publish']);
allow('POST','connection',[
  '/api/releases/connect','/api/releases/upgrade','/api/releases/revoke','/api/releases/gap-feedback',
  '/api/datasets/test','/api/datasets/publish','/api/datasets/revoke',
  '/api/live/prepare','/api/live/activate','/api/live/revoke','/api/live/views/propose','/api/live/views/activate','/api/live/views/revoke',
  '/api/live/migrations/impact','/api/live/migrations/list','/api/live/migrations/read','/api/live/migrations/preview','/api/live/migrations/commit',
  '/api/consumers/prepare','/api/consumers/activate','/api/consumers/data-preview','/api/consumers/data-publish','/api/consumers/revoke',
]);
allow('POST','settings',[
  '/api/settings','/api/settings/key/delete','/api/settings/test','/api/settings/retention','/api/settings/retention/run',
  '/api/backup','/api/backup/config','/api/restore','/api/usage','/api/usage/policy',
  '/api/capabilities/mcp/connect','/api/capabilities/mcp/disconnect','/api/capabilities/mcp/refresh','/api/capabilities/mcp/grant','/api/capabilities/skill/install',
]);
allow('POST','users',['/api/users','/api/users/create','/api/users/update']);

/** Authentication, external API keys, and artifact-kind privacy remain host responsibilities. */
export function requestRoleAction(method:string,path:string,body?:unknown):RoleAction {
  if(method==='POST'&&(path==='/api/canvas/message'||path==='/api/messages'))return body!==null&&typeof body==='object'&&!Array.isArray(body)&&(body as {mode?:unknown}).mode==='qa'?'qa':'build';
  if(method==='GET'&&(/^\/api\/sessions\/[^/]+(?:\/messages)?$/.test(path)||/^\/api\/artifacts\/[^/]+$/.test(path)))return'browse';
  if(method==='PATCH'&&/^\/api\/sessions\/[^/]+$/.test(path))return'qa';
  return routes.get(`${method} ${path}`)??'settings';
}

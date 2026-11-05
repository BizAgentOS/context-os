import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/knowledge/database.ts';
import { KnowledgeCore } from '../../src/knowledge/service.ts';
import { BuildPlans } from '../../src/knowledge/build-plans.ts';
import { ConnectedSources } from '../../src/knowledge/connected-sources.ts';
import {locateEvidence} from '../../src/knowledge/sources.ts';
import { CredentialVault } from '../../src/security/credential-vault.ts';

const pg = process.env.CONTEXT_OS_KNOWLEDGE_TEST_DATABASE_URL, mysql = process.env.CONTEXT_OS_KNOWLEDGE_TEST_MYSQL_URL;
test('connected table capture is immutable and staged; only approved build replaces active knowledge', { skip: !pg || !mysql }, async () => {
  const db = await openDatabase(pg!), root = await mkdtemp(join(tmpdir(), 'knowledge-native-'));
  const admin = { id: 'operator', role: 'admin' as const }, viewer = { id: 'reader', role: 'viewer' as const };
  const { createConnection } = await import('mysql2/promise'); const remote = await createConnection(mysql!); let owns = false, ownsRemote = false;
  try {
    assert.equal((await db.pool.query("SELECT 1 FROM pg_namespace WHERE nspname='knowledge'")).rows.length, 0);
    await db.initialize(); owns = true;
    await remote.query('CREATE TABLE native_contracts (id varchar(20) PRIMARY KEY, amount decimal(20,2), effective date, note varchar(20)) ENGINE=InnoDB');
    ownsRemote = true;
    await remote.query("INSERT INTO native_contracts VALUES ('C1',100.00,'2026-04-01',NULL),('C2',200.00,'2026-04-01','')");
    const core = new KnowledgeCore(db), plans = new BuildPlans(core);
    const connections = new ConnectedSources(core, new CredentialVault(join(root, 'vault'), { keyDirectory: join(root, 'keys'), keychain: null }));
    await assert.rejects(connections.create(viewer, { operationId: 'bad', name: 'source', config: { url: mysql }, tables: ['native_contracts'] }), /权限|管理员/);
    const connection = await connections.create(admin, { operationId: 'connect', name: '业务库', config: { url: mysql }, tables: ['native_contracts'] });
    assert.ok(!JSON.stringify(await connections.list(admin)).includes('local-autonomy-test-only'));
    const first = await connections.capture(admin, connection.id, { operationId: 'read-1', table: 'native_contracts', maxRows: 10 });
    const version = await core.sourceVersion(admin, first.sourceVersionId);
    assert.equal(version.content.kind, 'table'); assert.equal(version.content.rows.length, 2);
    assert.equal(version.content.metadata.profile.coverage,'complete_observation');
    assert.equal(version.content.metadata.profile.rows,2);
    const noteProfile=version.content.metadata.profile.columns.find((c:any)=>c.column==='note');
    assert.equal(noteProfile.nulls,1);assert.equal(noteProfile.empty,1);
    const keys=version.content.rows.map((r:any)=>r.__context_record_key);
    const missing=locateEvidence(version.content,{kind:'field',recordKey:keys[0],field:'note'}), empty=locateEvidence(version.content,{kind:'field',recordKey:keys[1],field:'note'});
    assert.equal(missing.kind,'field');assert.equal(empty.kind,'field');
    if(missing.kind==='field'&&empty.kind==='field'){assert.equal(missing.value,null);assert.equal(empty.value,'');}
    const ontology = await core.draft(admin, { name: 'Contracts', types: [{ id: 'Contract', name: '合同', properties: [{ id: 'amount', name: '金额', valueType: 'decimal' }] }] });
    await core.act(admin, { operationId: 'publish', kind: 'PublishOntologyVersion', targetId: ontology.id, expectedRevision: 1, reason: '范围确认' });
    const proposal = (id: string) => ({ csv: [{ sourceVersionId: id, objects: [{ id: 'c', typeId: 'Contract', identityColumn: 'id' }], properties: [{ id: 'a', object: 'c', predicate: 'amount', column: 'amount', time:{mode:'columns',fromColumn:'effective',reason:'金额自此业务日期生效'} }], links: [] }] });
    let plan = await plans.create(admin, ontology.id, [version.id], proposal(version.id)); plan = await plans.preflight(admin, plan.id, plan.revision);
    await plans.build(admin, plan.id);
    const before = (await core.list(admin, 'objects'))[0];
    const oldView = await core.object(admin, before.id);
    const oldAssertion = oldView.assertions[0].id;
    const ref = (await core.evidence(admin, oldAssertion))[0].locator;
    assert.equal(ref.kind, 'field'); if (ref.kind === 'field' && 'sourceKind' in ref) assert.equal(ref.sourceKind, 'table');
    await remote.query("UPDATE native_contracts SET amount=300.00 WHERE id='C1'");
    const second = await connections.capture(admin, connection.id, { operationId: 'read-2', table: 'native_contracts', maxRows: 10 });
    assert.notEqual(second.sourceVersionId, first.sourceVersionId);
    assert.ok((await core.object(admin, before.id)).assertions.some((a: any) => a.status === 'accepted'), 'capture must not retire current knowledge');
    await assert.rejects(connections.capture(admin, connection.id, { operationId: 'read-over-limit', table: 'native_contracts', maxRows: 1 }), /上限|完整/);
    assert.equal((await core.sourceVersion(admin, second.sourceVersionId)).content.rows.length, 2);
    const repeated = await connections.capture(admin, connection.id, { operationId: 'read-2', table: 'native_contracts', maxRows: 10 });
    assert.equal(repeated.sourceVersionId, second.sourceVersionId);
    await assert.rejects(plans.build(admin, plan.id), /更新|版本/);
    let next = await plans.create(admin, ontology.id, [second.sourceVersionId], proposal(second.sourceVersionId)); next = await plans.preflight(admin, next.id, next.revision);
    assert.equal(next.preview!.events.some(e=>e.kind==='fact_conflict'),false,'a staged source update must not conflict with its own replaced contribution');
    assert.equal(next.preview!.ready,true);
    await plans.build(admin, next.id);
    assert.equal((await core.list(admin, 'objects')).length, 2, 'stable source object identities survive resync');
    assert.equal((await core.evidence(admin, oldAssertion))[0].source_version_id, first.sourceVersionId);
    await connections.revoke(admin, connection.id, connection.revision);
    await assert.rejects(connections.capture(admin, connection.id, { operationId: 'revoked', table: 'native_contracts', maxRows: 10 }), /停用|权限/);
  } finally {
    if(ownsRemote)await remote.query('DROP TABLE native_contracts'); await remote.end();
    if (owns) { await db.pool.query('DROP SCHEMA knowledge CASCADE'); await db.pool.query('DELETE FROM knowledge_schema_versions WHERE version BETWEEN 1 AND 7'); }
    await db.close(); await rm(root, { recursive: true, force: true });
  }
});

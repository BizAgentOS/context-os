import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityWorkspace, ref } from './identity-fixture.ts';
import { NamingBatches } from '../../src/engine/naming-batches.ts';
import type { Data } from '../../src/agent/contracts.ts';

test('first naming is one durable pending change, individual edits invalidate verification and whole adoption is atomic', async () => {
  const w = await identityWorkspace();
  try {
    const app = w.service.app, naming = new NamingBatches(app.memory, app.foundation, app.live, app.snapshots, app.changes);
    const job = naming.ensure()!;
    assert.equal(naming.ensure()!.id, job.id);
    const context = await naming.readContext(job.id, { offset: 0, limit: 30 });
    const targets = context.items as Data[];
    assert.ok(targets.some(item => item.target === 'property'));
    const proposal = { items: targets.map((item, index) => ({ key: item.key, name: item.id === 'person' ? '员工' : item.name,
      aliases: [], description: `业务说明 ${index}`, evidence: '根据本轮字段和实际样本核对' })), finalize: true };
    const submitted = naming.propose(job.id, proposal);
    assert.deepEqual(naming.propose(job.id, proposal), submitted, 'repeated final submission returns the original receipt');
    assert.equal(submitted.change!.content.type, 'naming');
    assert.equal(app.changes.list({ type: 'naming' }).total, 1);
    assert.equal((app.foundation.read().adopted!.content.concepts as Data[]).find(item => item.id === 'person')!.name, '人员');
    let checked = await app.changes.verify({ ...ref(submitted.change!), operationId: 'first-check' });
    assert.equal(checked.status, 'verified', JSON.stringify(checked.content.verification));
    const edited = naming.edit({ ...ref(submitted.candidate!), items: [{ key: 'concept:person', name: '同事' }] });
    assert.equal(edited.change.id, checked.id);
    assert.equal(edited.change.status, 'proposed');
    assert.equal(edited.change.content.verification, undefined);
    await assert.rejects(app.changes.adopt({ ...ref(checked), operationId: 'stale-adoption', acknowledgeReview: true }), /版本/);
    checked = await app.changes.verify({ ...ref(edited.change), operationId: 'edited-check' });
    const count = app.workspaceVersions.list().length;
    const input = { ...ref(checked), operationId: 'whole-adoption', acknowledgeReview: true };
    const adopted = await app.changes.adopt(input);
    assert.equal(adopted.status, 'adopted');
    assert.equal(app.workspaceVersions.list().length, count + 1);
    assert.equal((app.foundation.read().adopted!.content.concepts as Data[]).find(item => item.id === 'person')!.name, '同事');
    assert.ok(((app.foundation.read().adopted!.content.concepts as Data[]).find(item => item.id === 'person')!.aliases as string[]).includes('人员'));
    assert.equal((await app.live.query({ modelId: w.model.id, type: '同事', id: 'P1' })).items[0].姓名, '甲');
    assert.deepEqual(await app.changes.adopt(input), adopted);
    assert.equal(new NamingBatches(app.memory, app.foundation, app.live, app.snapshots, app.changes).ensure()!.id, job.id);
  } finally { await w.close(); }
});

test('partial drafts, joint naming conflicts and source drift cannot partially adopt the batch', async () => {
  const w = await identityWorkspace();
  try {
    const app = w.service.app, naming = new NamingBatches(app.memory, app.foundation, app.live, app.snapshots, app.changes), job = naming.ensure()!;
    const { items } = await naming.readContext(job.id, { limit: 30 });
    const proposed = items.map((item, i) => ({ key: item.key, name: item.name, aliases: [], description: `说明 ${i}`, evidence: '实际读取样本' }));
    assert.throws(() => naming.propose(job.id, { items: proposed.slice(0, 1), finalize: true }), /全部/);
    naming.propose(job.id, { items: proposed.slice(0, 1), finalize: false });
    const saved = naming.propose(job.id, { items: proposed.slice(1), finalize: true });
    const before = app.changes.currentBaseline();
    const conflicting = naming.edit({ ...ref(saved.candidate!), items: [{ key: 'concept:person', name: '重复名称' }, { key: 'concept:staff', name: '重复名称' }] });
    const invalid = await app.changes.verify({ ...ref(conflicting.change), operationId: 'conflicting-names' });
    assert.equal(invalid.status, 'failed');
    assert.deepEqual(app.changes.currentBaseline(), before);
    const repaired = naming.edit({ ...ref(conflicting.candidate), items: [{ key: 'concept:person', name: '正式成员' }, { key: 'concept:staff', name: '外部联系人' }] });
    const checked = await app.changes.verify({ ...ref(repaired.change), operationId: 'repaired-names' });
    assert.equal(checked.status, 'verified');
    w.rows.staff[0].phone = '20000'; await app.snapshots.sync({ operationId: 'changed-after-review', sourceIds: [w.sources.staff.id] });
    await assert.rejects(app.changes.adopt({ ...ref(checked), operationId: 'stale-facts', acknowledgeReview: true }), /快照.*变化|依据.*变化/);
    assert.deepEqual(app.changes.currentBaseline(), before);
  } finally { await w.close(); }
});

test('confirmed names stay protected and pending relation wording is adopted only when the relation is explicitly adopted', async () => {
  const w = await identityWorkspace();
  try {
    const app = w.service.app;
    await w.adopt('naming', { target: 'concept', id: 'person', name: '团队成员' });
    const dataset = (sourceId: string) => app.snapshots.datasets().find(item => item.content.sourceId === sourceId)!.id;
    const subject = { from: { datasetId: dataset(w.sources.staff.id), column: 'email' }, to: { datasetId: dataset(w.sources.people.id), column: 'email' } };
    const relation = (await app.changes.propose({ operationId: 'pending-relation', origin: 'human', type: 'relation', subject, baseline: app.changes.currentBaseline() })).change;
    const naming = new NamingBatches(app.memory, app.foundation, app.live, app.snapshots, app.changes), job = naming.ensure()!;
    const { items } = await naming.readContext(job.id, { limit: 30 });
    const person = items.find(item => item.id === 'person')!, deferred = items.find(item => item.target === 'pending_relation')!;
    assert.equal(person.protected, true); assert.ok(deferred);
    assert.throws(() => naming.propose(job.id, { items: [{ key: person.key, name: '人员被覆盖', aliases: [], description: '说明', evidence: '样本' }], finalize: false }), /人工.*名称/);
    assert.throws(() => naming.propose(job.id, { items: [{ key: 'invented', name: '伪对象', aliases: [], description: '说明', evidence: '样本' }], finalize: false }), /本轮|对象/);
    const { change } = naming.propose(job.id, { items: items.map((item, i) => ({ key: item.key, name: item === deferred ? '对应人员' : item.name,
      aliases: [], description: `业务说明 ${i}`, evidence: '本轮已读取的结构与样本' })), finalize: true });
    const checked = await app.changes.verify({ ...ref(change!), operationId: 'naming-check' });
    await app.changes.adopt({ ...ref(checked), operationId: 'naming-adopt', acknowledgeReview: true });
    assert.equal(app.live.readLayered(w.model.id).semantic.relationTypes.length, 0);
    assert.equal(app.changes.read(relation.id).status, 'proposed');
    // The structural decision still needs a fresh proposal against the newly named working version.
    await w.adopt('relation', subject);
    const layer = app.live.readLayered(w.model.id);
    assert.equal(layer.semantic.relationTypes[0].name, '对应人员');
    assert.match(layer.semantic.relationTypes[0].description, /外部人员.*团队成员/);
    assert.equal((await app.live.query({ modelId: w.model.id, type: '外部人员', id: 'H1', relation: '对应人员' })).items[0].$id, 'P1');
    assert.equal(layer.semantic.entityTypes.find(item => item.id === 'person')!.name, '团队成员');
  } finally { await w.close(); }
});

test('a completely saved draft can finalize without resubmitting a page, while incomplete drafts stay pending', async () => {
  const w = await identityWorkspace();
  try {
    const app = w.service.app, naming = new NamingBatches(app.memory, app.foundation, app.live, app.snapshots, app.changes), job = naming.ensure()!;
    await assert.rejects(naming.readAgentContext(job.id, { offset: -1 }));
    assert.throws(() => naming.propose(job.id, { items: [], finalize: true }), /全部/);
    const page = await naming.readAgentContext(job.id, { limit: 30 });
    naming.propose(job.id, { items: page.items.map(item => ({ key: item.key, name: item.name, aliases: item.aliases, description: '当前字段说明', evidence: '本轮快照样本' })), finalize: false });
    const pending = await naming.readAgentContext(job.id);
    assert.equal(pending.remaining, 0); assert.deepEqual(pending.items, []);
    const finalized = naming.propose(job.id, { items: [], finalize: true });
    assert.equal(finalized.change!.status, 'proposed');
    assert.deepEqual(naming.propose(job.id, { items: [], finalize: true }), finalized);
    assert.equal(app.memory.listArtifacts('naming_batch').length, 1);
  } finally { await w.close(); }
});

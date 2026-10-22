import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityWorkspace } from './identity-fixture.ts';
import { NamingBatches } from '../../src/engine/naming-batches.ts';
import { AutomaticNaming } from '../../src/agent/automatic-naming.ts';
import type { AgentDriver } from '../../src/agent/runtime.ts';
import type { Data } from '../../src/agent/contracts.ts';
import { AgentApplication } from '../../src/agent/app.ts';
import { Workspace } from '../../src/agent/workspace.ts';
import { seedFoundation } from './program-foundation-fixture.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('one background naming run reads bounded real context, submits one pending batch and reports unknown usage', async () => {
  const w = await identityWorkspace();
  try {
    const app = w.service.app, batches = new NamingBatches(app.memory, app.foundation, app.live, app.snapshots, app.changes), automatic = new AutomaticNaming(app.memory, batches);
    batches.ensure();
    let runs = 0;
    const driver: AgentDriver = { async run(request) {
      runs++; assert.deepEqual(request.nativeTools, []);
      assert.deepEqual(request.tools.map(tool => tool.name), ['naming_context_read', 'naming_batch_propose']);
      assert.doesNotMatch(request.input, /alice@example.test/);
      const page = await request.onTool('naming_context_read', { offset: 0, limit: 30 }) as Data;
      assert.ok((page.sources as Data[]).some(source => JSON.stringify(source.sample).includes('alice@example.test')));
      const result = await request.onTool('naming_batch_propose', { items: (page.items as Data[]).map((item, i) => ({ key: item.key, name: item.name, aliases: [], description: `核对说明${i}`, evidence: '字段与当前快照样本' })), finalize: true }) as Data;
      assert.equal((result.change as Data).status, 'proposed');
      return { text: '已提出命名', sessionId: 'test', runId: 'test' };
    }, async stop() {}, async close() {} };
    const task = app.memory.createTask('首次业务命名'), context = app.memory.beginExecution(task.id);
    await automatic.run(automatic.pending()!, context, driver, error => (error as Error).message);
    assert.equal(runs, 1); assert.equal(automatic.pending(), undefined);
    assert.equal(batches.ensure()!.status, 'completed');
    assert.equal(app.changes.list({ type: 'naming' }).total, 1);
    const card = app.memory.listArtifacts('agent_run').find(run => run.content.taskId === task.id)!;
    assert.equal((card.content.usage as Data).status, 'unknown');
    assert.equal((card.content.changeList as Data[]).length, 1);
    assert.equal(new AutomaticNaming(app.memory, batches).pending(), undefined);
  } finally { await w.close(); }
});

test('first-build enrollment never queues naming for a manually adopted model', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'context-os-naming-enrollment-')), app = new AgentApplication(directory, undefined, undefined, false);
  try {
    const batches = new NamingBatches(app.memory, app.foundation, app.live, app.snapshots, app.changes);
    batches.connectBuilds(app.programBuilds);
    const source = new Workspace(app.memory).upload('people.csv', 'id,name\n001,甲\n'), connection = app.live.sources.connectUpload(source.id, source.version, 'id');
    const base = seedFoundation(app.memory, app.foundation, { enterprise: '手工模型', concepts: [{ id: 'person', name: '人员', description: '手工实体' }] });
    await app.snapshots.sync({ operationId: 'manual-source' });
    const candidate = await app.live.propose({ purpose: '手工映射', rationale: '明确管理员定义', foundationRef: { id: base.id, version: base.version }, baseModelRef: null, types: [{ conceptId: 'person', name: '人员', description: '手工实体', sourceId: connection.id, capability: 'records', fields: { 姓名: 'name' } }], relations: [] });
    await app.live.adopt(candidate.id, candidate.version);
    await app.programBuilds.idle();
    assert.equal(batches.jobs().length, 0);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('the first program build queues once, wakes the shared pool and survives restart without another job', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'context-os-naming-first-'));
  let app = new AgentApplication(directory, undefined, undefined, false);
  try {
    const batches = app.namingBatches, onQueued = batches.onQueued;
    let wakeups = 0; batches.onQueued = () => { wakeups++; onQueued?.(); };
    new Workspace(app.memory).upload('people.csv', 'person_id,name\n001,甲\n002,乙\n');
    const build = await app.programBuilds.build({ operationId: 'first-program-build', autoAdopt: true });
    assert.equal(build.content.outcome, 'adopted', JSON.stringify(build.content.issues));
    assert.equal(batches.jobs().length, 1); assert.equal(wakeups, 1);
    const jobId = batches.jobs()[0].id;
    await app.programBuilds.build({ operationId: 'same-input-again', autoAdopt: true });
    assert.equal(batches.jobs().length, 1); assert.equal(wakeups, 1);
    await app.close(); app = new AgentApplication(directory, undefined, undefined, false);
    const restored = app.namingBatches;
    await app.programBuilds.idle();
    assert.equal(restored.jobs().length, 1); assert.equal(restored.jobs()[0].id, jobId);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('stopping a background run rejects its late tools and retry reuses the durable job', { timeout: 15000 }, async () => {
  const w = await identityWorkspace();
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const app = w.service.app, batches = new NamingBatches(app.memory, app.foundation, app.live, app.snapshots, app.changes), automatic = new AutomaticNaming(app.memory, batches);
    const job = batches.ensure()!, task = app.memory.createTask('可停止命名'), context = app.memory.beginExecution(task.id);
    const driver: AgentDriver = { async run(request) {
      entered(); await barrier;
      await assert.rejects(request.onTool('naming_context_read', { offset: 0, limit: 1 }), /停止|暂停|运行|执行/);
      return { text: '', status: 'stopped', sessionId: 'test', runId: 'test' };
    }, async stop() {}, async close() {} };
    const running = automatic.run(job, context, driver, error => (error as Error).message);
    await started; app.memory.pauseTask(task.id, '用户暂停'); release(); await running;
    assert.equal(app.changes.list({ type: 'naming' }).total, 0);
    assert.equal(batches.jobs()[0].status, 'stopped'); automatic.retry();
    assert.equal(automatic.pending()!.id, job.id); assert.equal(batches.jobs().length, 1);
  } finally { release?.(); await w.close(); }
});

test('naming tools use short keys, recover invalid submissions and resume only the unsubmitted pages', async () => {
  const w = await identityWorkspace();
  try {
    const app = w.service.app, batches = new NamingBatches(app.memory, app.foundation, app.live, app.snapshots, app.changes), automatic = new AutomaticNaming(app.memory, batches);
    const job = batches.ensure()!, baseline = app.changes.currentBaseline();
    let savedFirst: string[] = [], calls = 0;
    const propose = (items: Data[]) => items.map(item => ({ key: item.key, name: item.name, aliases: item.aliases ?? [], description: '依据当前字段与样本核对的说明', evidence: '本次工具返回的实际来源和样本；协议测试不代表模型质量' }));
    const run = async (driver: AgentDriver) => {
      const task = app.memory.createTask('分页恢复命名'), context = app.memory.beginExecution(task.id);
      await automatic.run(automatic.pending()!, context, driver, error => (error as Error).message);
    };
    await run({ async run(request) {
      const page = await request.onTool('naming_context_read', { limit: 2 }) as Data;
      const items = page.items as Data[];
      assert.deepEqual(items.map(item => item.key), ['n1', 'n2']);
      assert.ok(items.every(item => !('id' in item) && !('bindingIds' in item) && !('before' in item)));
      assert.ok((page.sources as Data[]).some(source => JSON.stringify(source.sample).includes('alice@example.test')));
      assert.ok((page.sources as Data[]).every(source => !('sourceId' in source) && !('datasetId' in source) && !('snapshotId' in source)));
      const invalid = await request.onTool('naming_batch_propose', { items: [{ ...propose(items)[0], key: 'n999' }] }) as Data;
      assert.equal(invalid.status, 'needs_correction');
      assert.deepEqual(invalid.invalidKeys, ['n999']);
      assert.equal(invalid.remaining, (job.content.items as Data[]).length);
      const duplicate = await request.onTool('naming_batch_propose', { items: [propose(items)[0], propose(items)[0]] }) as Data;
      assert.deepEqual(duplicate.duplicateKeys, ['n1']);
      const saved = await request.onTool('naming_batch_propose', { items: propose(items) }) as Data;
      assert.equal(saved.remaining, (job.content.items as Data[]).length - 2);
      savedFirst = items.map(item => String(item.key));
      return { text: '', status: 'completed', sessionId: 'protocol', runId: 'partial' };
    }, async stop() {}, async close() {} });
    assert.deepEqual(savedFirst, ['n1', 'n2'], 'the first run validates and saves its short-key page');
    assert.equal(batches.jobs()[0].status, 'failed');
    assert.equal(app.changes.list({ type: 'naming' }).total, 0);
    automatic.retry();
    await run({ async run(request) {
      for (;;) {
        const page = await request.onTool('naming_context_read', { limit: 3 }) as Data; calls++;
        const items = page.items as Data[];
        assert.ok(items.length > 0 && items.length <= 3);
        assert.ok(items.every(item => !savedFirst.includes(String(item.key))), 'already saved pages are not reread after retry');
        const final = Number(page.remaining) === items.length;
        const saved = await request.onTool('naming_batch_propose', { items: propose(items), finalize: final }) as Data; calls++;
        if (final) { assert.equal((saved.change as Data).status, 'proposed'); break; }
        assert.ok(calls < 24);
      }
      return { text: '已保存一项完整待处理命名', status: 'completed', sessionId: 'protocol', runId: 'resumed' };
    }, async stop() {}, async close() {} });
    assert.equal(batches.jobs()[0].status, 'completed');
    const candidates = app.memory.listArtifacts('naming_batch');
    assert.equal(candidates.length, 1);
    assert.equal((candidates[0].content.items as Data[]).length, (job.content.items as Data[]).length);
    assert.ok((candidates[0].content.items as Data[]).every(item => !/^n\d+$/.test(String(item.key))), 'canonical object references stay in the durable batch');
    assert.deepEqual(app.changes.currentBaseline(), baseline, 'proposals never adopt names or structure');
  } finally { await w.close(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DriverJsonModel } from '../../src/knowledge/model.ts';
import { extractionSchema, ontologySchema } from '../../src/knowledge/contracts.ts';
import type { AgentDriver, RunRequest } from '../../src/agent/runtime.ts';

function driver(run: (request: RunRequest) => Promise<void>): AgentDriver {
  return { async run(request) { await run(request); return { text: '', status: 'completed', runId: 'fixture', sessionId: 'fixture' }; }, async stop() {}, async close() {} };
}
test('model adapter exposes only a schema-constrained submission, not native tools', async () => {
  const model = new DriverJsonModel('fixture', driver(async request => {
    assert.deepEqual(request.nativeTools, []);
    assert.equal(request.tools.length, 1);
    assert.ok(request.tools[0].inputSchema);
    await request.onTool('submit_result', { json: JSON.stringify({ claims: [] }) });
    await assert.rejects(request.onTool('submit_result', { json: JSON.stringify({ claims: [] }) }));
  }));
  assert.deepEqual(await model.generate('extract', { text: 'source only' }, extractionSchema), { claims: [] });
});
test('no structured result or malformed submission cannot become successful knowledge', async () => {
  await assert.rejects(new DriverJsonModel('empty', driver(async () => {})).generate('extract', {}, extractionSchema));
  await assert.rejects(new DriverJsonModel('invalid', driver(async request => { await request.onTool('submit_result', { json: JSON.stringify({ name: 'not an ontology' }) }); })).generate('discover', {}, ontologySchema));
});

test('diagnostics classify timeout and expose schema paths without source values', async () => {
  const events: unknown[] = [];
  const timed: AgentDriver = { async run(request) {
    request.onEvent('run.timed_out', { reason: 'private-provider-content' });
    return { text: 'private-source', status: 'timed_out', runId: 'fixture', sessionId: 'fixture' };
  }, async stop() {}, async close() {} };
  const model = new DriverJsonModel('fixture', timed);
  model.onDiagnostic = e => events.push(e);
  await assert.rejects(model.generate('extract', {}, extractionSchema), /超时/);
  assert.ok(JSON.stringify(events).includes('timed_out'));
  assert.ok(!JSON.stringify(events).includes('private-'));
  const invalid = new DriverJsonModel('fixture', driver(async request => {
    await request.onTool('submit_result', { json: JSON.stringify({ claims: 'private-source' }) });
  }));
  invalid.onDiagnostic = e => events.push(e);
  await assert.rejects(invalid.generate('extract', {}, extractionSchema));
  assert.ok(JSON.stringify(events).includes('submission.rejected'));
  assert.ok(JSON.stringify(events).includes('claims'));
  assert.ok(!JSON.stringify(events).includes('private-source'));
});

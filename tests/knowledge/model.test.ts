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

test('model configuration errors identify the variable and limits without disclosing values', async () => {
  const { configuredModel, ModelConfigurationError } = await import('../../src/knowledge/model.ts');
  const keys = ['CONTEXT_OS_KNOWLEDGE_MODEL_PROVIDER', 'CONTEXT_OS_KNOWLEDGE_MODEL', 'CONTEXT_OS_KNOWLEDGE_MODEL_PROTOCOL', 'CONTEXT_OS_KNOWLEDGE_MODEL_TIMEOUT_MS', 'CONTEXT_OS_KNOWLEDGE_MODEL_MAX_ITERATIONS'];
  const prior = keys.map(k => process.env[k]);
  try {
    process.env[keys[0]] = 'custom'; process.env[keys[1]] = 'fixture'; process.env[keys[2]] = 'openai';
    process.env[keys[3]] = '2400000'; process.env[keys[4]] = '4';
    assert.throws(() => configuredModel('unused'), e => e instanceof ModelConfigurationError && /CONTEXT_OS_KNOWLEDGE_MODEL_TIMEOUT_MS/.test(e.message) && /1800000/.test(e.message) && /毫秒/.test(e.message));
    process.env[keys[3]] = '600000'; process.env[keys[4]] = '25';
    assert.throws(() => configuredModel('unused'), /CONTEXT_OS_KNOWLEDGE_MODEL_MAX_ITERATIONS/);
    process.env[keys[0]] = 'private-secret-value';
    assert.throws(() => configuredModel('unused'), e => e instanceof ModelConfigurationError && /MODEL_PROVIDER/.test(e.message) && !e.message.includes('private-secret-value'));
  } finally { keys.forEach((k, i) => { if (prior[i] === undefined) delete process.env[k]; else process.env[k] = prior[i]; }); }
});

test('opt-in trace freezes request, submissions and failed outcome', async () => {
  const { mkdtemp, readFile, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'model-trace-'));
  try {
    const model = new DriverJsonModel('fixture', driver(async request => {
      request.onEvent('run.progress', { iteration: 1 });
      request.onEvent('assistant.delta', { text: 'visible-model-response' });
      await request.onTool('submit_result', { json: JSON.stringify({ claims: [] }) });
    }), {}, { trace: true, directory: dir });
    model.diagnosticContext = { jobId: 'job-fixture', attempt: 2 };
    await model.generate('extract', { text: 'actual source text' }, extractionSchema);
    const path = join(dir, (await readdir(dir))[0]);
    const request = JSON.parse(await readFile(join(path, 'request.json'), 'utf8'));
    assert.equal(JSON.parse(request.input).input.text, 'actual source text');
    assert.equal(request.context.jobId, 'job-fixture');
    assert.equal(request.tools[0].name, 'submit_result');
    const summary = JSON.parse(await readFile(join(path, 'summary.json'), 'utf8'));
    assert.equal(summary.submitted, true); assert.equal(summary.submissions, 1);
    assert.equal(summary.iterations, 1);
    const events = await readFile(join(path, 'events.jsonl'), 'utf8');
    assert.ok(events.includes('visible-model-response')); assert.ok(events.includes('submission.accepted'));
    const failed = new DriverJsonModel('fixture', driver(async request => {
      await request.onTool('submit_result', { json: '{broken' });
    }), {}, { trace: true, directory: dir });
    await assert.rejects(failed.generate('extract', {}, extractionSchema));
    const summaries = await Promise.all((await readdir(dir)).map(async id => JSON.parse(await readFile(join(dir, id, 'summary.json'), 'utf8'))));
    assert.ok(summaries.some(s => s.status === 'exception' && s.rejections === 1));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model trace scopes HTTP observation and preserves per-iteration and raw usage separately', async () => {
  const { mkdtemp, readFile, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { traceModelFetch } = await import('../../src/observability/model-http-trace.ts');
  const dir = await mkdtemp(join(tmpdir(), 'model-wire-'));
  try {
    const model = new DriverJsonModel('fixture', driver(async request => {
      const response = await traceModelFetch('https://example.test/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'fixture', max_tokens: 6500 }) }, (async () => new Response('{"usage":{"completion_tokens":12,"completion_tokens_details":{"reasoning_tokens":10}}}', { headers: { 'content-type': 'application/json' } })) as typeof fetch);
      await response.text();
      request.onEvent('run.usage', { sampleId: 'one', usage: { inputTokens: 4, outputTokens: 12, totalTokens: 16 } });
      request.onEvent('run.usage', { sampleId: 'one', usage: { inputTokens: 4, outputTokens: 12, totalTokens: 16 } });
      await request.onTool('submit_result', { json: '{"claims":[]}' });
    }), {}, { trace: true, directory: dir });
    await model.generate('extract', {}, extractionSchema);
    const path = join(dir, (await readdir(dir))[0]);
    const summary = JSON.parse(await readFile(join(path, 'summary.json'), 'utf8'));
    assert.equal(summary.httpRequests, 1);
    assert.equal(summary.sdkUsageTotals.outputTokens, 12);
    assert.equal(summary.iterationUsage.length, 1);
    assert.equal(summary.httpUsage[0].usage.completion_tokens_details.reasoning_tokens, 10);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model deadline returns before SDK cleanup and blocks late structured writes', async t => {
  let ready!: () => void, submit!: () => Promise<unknown>, stops = 0;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const hanging: AgentDriver = {
    async run(request) { submit = () => request.onTool('submit_result', { json: '{"claims":[]}' }); ready(); return new Promise(() => {}); },
    async stop() { stops++; }, async close() {},
  };
  const model = new DriverJsonModel('fixture', hanging, { timeoutMs: 1000 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const running = model.generate('extract', {}, extractionSchema);
    const rejected = assert.rejects(running, /总运行预算/);
    await started;
    t.mock.timers.tick(1000);
    await rejected;
    assert.equal(stops, 1);
    await assert.rejects(submit(), /运行已结束/);
    await assert.rejects(model.generate('extract', {}, extractionSchema), /仍在取消/);
  } finally { t.mock.timers.reset(); await model.close(); }
});

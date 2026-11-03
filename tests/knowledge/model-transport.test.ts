import { AsyncLocalStorage } from 'node:async_hooks';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlledModelFetch, withModelTransport, ModelTransportError } from '../../src/observability/model-transport.ts';
const policy = { timeoutMs: 500, idleTimeoutMs: 30, reasoning: 'auto' as const };
const noop = () => {};

test('stalled response is cancelled, subsequent SDK retry cannot reach transport', async () => {
  let sends = 0, cancelled = false;
  const send = (async () => { sends++; return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: first\n\n')); }, cancel() { cancelled = true; } })); }) as typeof fetch;
  let late!: () => Promise<Response>;
  await assert.rejects(withModelTransport(policy, noop, async () => {}, async () => {
    late = AsyncLocalStorage.bind(() => controlledModelFetch('https://example.test', undefined, send));
    const response = await late();
    await response.text();
  }), (e: unknown) => e instanceof ModelTransportError && e.code === 'MODEL_IDLE_TIMEOUT');
  await assert.rejects(late(), /无数据|停止|取消/);
  assert.equal(sends, 1); assert.equal(cancelled, true);
});

test('deadline does not await an uncooperative SDK abort and rejects late submission', async () => {
  let stops = 0;
  const started = Date.now();
  await assert.rejects(withModelTransport({ ...policy, timeoutMs: 30 }, noop, async () => { stops++; await new Promise(() => {}); }, async () => new Promise(() => {})), (e: unknown) => e instanceof ModelTransportError && e.code === 'MODEL_DEADLINE');
  assert.ok(Date.now() - started < 400); assert.equal(stops, 1);
});

test('GLM 5.3 reasoning is explicit low, while other model routing is unchanged', async () => {
  for (const model of ['glm/glm-5.3', 'glm-5.3', 'other-model']) {
    await withModelTransport(policy, noop, async () => {}, async () => {
      const response = await controlledModelFetch('https://example.test/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model, max_completion_tokens: 6500 }) }, (async request => {
        const body = await (request as Request).json();
        assert.equal(body.model, model);
        assert.equal(body.max_completion_tokens, 6500);
        if (model.includes('glm')) { assert.deepEqual(body.thinking, { type: 'enabled' }); assert.equal(body.reasoning_effort, 'low'); }
        else assert.equal(body.thinking, undefined);
        return new Response('ok');
      }) as typeof fetch);
      assert.equal(await response.text(), 'ok');
    });
  }
});

test('HTTP failure ends the run instead of starting a second paid request', async () => {
  let calls = 0;
  await assert.rejects(withModelTransport(policy, noop, async () => {}, async () => {
    await controlledModelFetch('https://example.test', undefined, (async () => { calls++; return new Response('{}', { status: 429 }); }) as typeof fetch);
  }), (e: unknown) => e instanceof ModelTransportError && e.code === 'MODEL_HTTP_429');
  assert.equal(calls, 1);
});

test('header wait respects deadline even when a fake transport ignores AbortSignal', async () => {
  let aborted = false;
  await assert.rejects(withModelTransport({ ...policy, timeoutMs: 30, idleTimeoutMs: 500 }, noop, async () => {}, async () => {
    await controlledModelFetch('https://example.test', undefined, (async (_request, init) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; });
      return new Promise(() => {});
    }) as typeof fetch);
  }), (e: unknown) => e instanceof ModelTransportError && e.code === 'MODEL_DEADLINE');
  assert.equal(aborted, true);
});

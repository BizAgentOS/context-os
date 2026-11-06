import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceModelFetch, withModelHttpTrace } from '../../src/observability/model-http-trace.ts';

test('transport trace preserves fragmented SSE and records timings/usage without auth or reasoning text', async () => {
  const events: { kind: string; data: Record<string, unknown> }[] = [];
  const text = 'data: {"choices":[{"delta":{"reasoning_content":"hidden reasoning"}}]}\n\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
    'data: {"choices":[],"usage":{"completion_tokens":15,"completion_tokens_details":{"reasoning_tokens":12}}}\n\ndata: [DONE]\n\n';
  const encoder = new TextEncoder();
  const fake = (async (request: Request) => {
    assert.equal(request.headers.get('authorization'), 'Bearer private-key');
    return new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode(text.slice(0, 37))); c.enqueue(encoder.encode(text.slice(37))); c.close(); } }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-id' } });
  }) as typeof fetch;
  const received = await withModelHttpTrace((kind, data) => events.push({ kind, data }), async () => {
    const r = await traceModelFetch('https://example.test/v1/chat/completions?secret=private-query', { method: 'POST', headers: { authorization: 'Bearer private-key' }, body: JSON.stringify({ model: 'fixture', thinking: { type: 'disabled' }, api_key: 'private-body-key', max_tokens: 6500 }) }, fake);
    return r.text();
  });
  assert.equal(received, text);
  assert.ok(events.some(e => e.kind === 'http.first_reasoning_delta'));
  assert.ok(events.some(e => e.kind === 'http.first_tool_delta'));
  assert.ok(events.some(e => e.kind === 'http.usage' && (e.data.usage as any).completion_tokens_details.reasoning_tokens === 12));
  assert.ok(events.some(e => e.kind === 'http.end'));
  assert.ok(!JSON.stringify(events).includes('private-'));
  assert.ok(!JSON.stringify(events).includes('hidden reasoning'));
  assert.equal((events.find(e => e.kind === 'http.request')?.data.body as any).max_tokens, 6500);
});

test('transport request counters are scoped and record failed attempts without raw error text', async () => {
  const events: Record<string, unknown>[] = [];
  await withModelHttpTrace((kind, data) => events.push({ kind, ...data }), async () => {
    await assert.rejects(traceModelFetch('https://example.test', undefined, (async () => { throw new Error('private secret'); }) as typeof fetch));
    const r = await traceModelFetch('https://example.test', undefined, (async () => new Response('{"usage":{"input_tokens":4,"output_tokens":2}}', { headers: { 'content-type': 'application/json' } })) as typeof fetch);
    await r.text();
  });
  assert.deepEqual(events.filter(e => e.kind === 'http.request').map(e => e.httpRequest), [1, 2]);
  assert.ok(!JSON.stringify(events).includes('private secret'));
  assert.ok(events.some(e => e.kind === 'http.usage'));
  let calls = 0;
  const r = await traceModelFetch('https://example.test', undefined, (async () => { calls++; return new Response('unchanged'); }) as typeof fetch);
  assert.equal(await r.text(), 'unchanged'); assert.equal(calls, 1);
});

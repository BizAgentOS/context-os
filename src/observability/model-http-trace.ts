import { AsyncLocalStorage } from 'node:async_hooks';

type Sink = (kind: string, data: Record<string, unknown>) => void;
const scope = new AsyncLocalStorage<{ emit: Sink; sequence: number }>();
export const withModelHttpTrace = <T>(emit: Sink, run: () => Promise<T>): Promise<T> => scope.run({ emit, sequence: 0 }, run);
function safeBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeBody);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, /^(authorization|api[_-]?key|password|access_token|secret)$/i.test(k) ? '[REDACTED]' : safeBody(v)]));
  return value;
}
/** Scoped custom-provider transport observation; no global fetch replacement. */
export async function traceModelFetch(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1], send: typeof fetch): Promise<Response> {
  const current = scope.getStore();
  if (!current) return send(input, init);
  const request = new Request(input, init);
  const id = ++current.sequence, started = performance.now();
  const emit = (kind: string, data: Record<string, unknown> = {}) => current.emit(kind, { httpRequest: id, requestElapsedMs: Math.round(performance.now() - started), ...data });
  const url = new URL(request.url);
  // Never emit URL query, credentials, authorization or arbitrary headers.
  let body: unknown = null;
  try { body = safeBody(JSON.parse(await request.clone().text())); } catch { body = { unavailable: 'non_json_body' }; }
  emit('http.request', { method: request.method, endpoint: `${url.origin}${url.pathname}`, body, sdkRetryCount: request.headers.get('x-stainless-retry-count') });
  let response: Response;
  try { response = await send(request); }
  catch (error) { emit('http.failed', { errorType: error instanceof Error ? error.name : 'unknown' }); throw error; }
  emit('http.headers', { status: response.status, contentType: response.headers.get('content-type'), requestId: response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? response.headers.get('x-amzn-requestid'), retryAfter: response.headers.get('retry-after') });
  if (!response.body) { emit('http.end', { bytes: 0 }); return response; }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const sse = response.headers.get('content-type')?.includes('text/event-stream');
  let bytes = 0, chunks = 0, buffer = '', json = '', dropped = false;
  let firstText = false, firstTool = false, firstReasoning = false;
  function frame(text: string) {
    if (text === '[DONE]') { emit('http.sse_done'); return; }
    try {
      const packet = JSON.parse(text);
      if (packet.error) emit('http.provider_error', { type: typeof packet.error.type === 'string' ? packet.error.type.slice(0, 100) : null, code: typeof packet.error.code === 'string' || typeof packet.error.code === 'number' ? packet.error.code : null });
      if (packet.usage || packet.message?.usage) emit('http.usage', { usage: packet.usage ?? packet.message.usage });
      for (const choice of packet.choices ?? []) {
        const delta = choice.delta ?? {};
        if (!firstText && delta.content) { firstText = true; emit('http.first_text'); }
        if (!firstTool && delta.tool_calls?.length) { firstTool = true; emit('http.first_tool_delta'); }
        if (!firstReasoning && (delta.reasoning_content || delta.reasoning)) { firstReasoning = true; emit('http.first_reasoning_delta'); }
        if (choice.finish_reason) emit('http.finish_reason', { finishReason: choice.finish_reason });
      }
      if (packet.type === 'content_block_delta') {
        if (!firstText && packet.delta?.type === 'text_delta') { firstText = true; emit('http.first_text'); }
        if (!firstTool && packet.delta?.type === 'input_json_delta') { firstTool = true; emit('http.first_tool_delta'); }
        if (!firstReasoning && packet.delta?.type === 'thinking_delta') { firstReasoning = true; emit('http.first_reasoning_delta'); }
      }
      if (packet.delta?.stop_reason) emit('http.finish_reason', { finishReason: packet.delta.stop_reason });
    } catch { /* Ignore non-JSON SSE keepalive frames. Original bytes pass through unchanged. */ }
  }
  function consume(text: string, final = false) {
    if (!sse) { if (json.length + text.length <= 4_000_000) json += text; else dropped = true; return; }
    buffer += text;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
      if (line.startsWith('data:')) frame(line.slice(5).trimStart());
    }
    if (final && buffer.startsWith('data:')) frame(buffer.slice(5).trim());
    if (buffer.length > 4_000_000) { buffer = ''; emit('http.parser_limit'); }
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          consume(decoder.decode(), true);
          if (!sse && !dropped) frame(json);
          emit('http.end', { bytes, chunks, jsonCaptureLimited: dropped });
          controller.close(); reader.releaseLock(); return;
        }
        bytes += next.value.byteLength; chunks++;
        emit(chunks === 1 ? 'http.first_chunk' : 'http.chunk', { bytes: next.value.byteLength, chunk: chunks });
        consume(decoder.decode(next.value, { stream: true }));
        controller.enqueue(next.value);
      } catch (error) { emit('http.stream_failed', { errorType: error instanceof Error ? error.name : 'unknown' }); controller.error(error); }
    },
    async cancel(reason) { emit('http.cancelled', { bytes, chunks }); await reader.cancel(reason); },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

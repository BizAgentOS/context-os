import { AsyncLocalStorage } from 'node:async_hooks';

export class ModelTransportError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'ModelTransportError'; this.code = code; }
}
type Policy = { timeoutMs: number; idleTimeoutMs: number; reasoning: 'auto' | 'default' | 'low' | 'high' | 'max' };
type State = { policy: Policy; deadline: number; abort: AbortController; failure?: ModelTransportError; fail: (error: ModelTransportError) => void; emit: (kind: string, data: Record<string, unknown>) => void };
const state = new AsyncLocalStorage<State>();
export const hasModelTransport = () => !!state.getStore();
export function assertModelTransportActive() {
  const current = state.getStore();
  if (!current) return;
  if (!current.failure && Date.now() >= current.deadline) current.fail(new ModelTransportError('MODEL_DEADLINE', '模型总运行预算已耗尽，已取消请求并禁止自动重发'));
  if (current.failure) throw current.failure;
  if (current.abort.signal.aborted) throw new ModelTransportError('MODEL_RUN_ENDED', '模型运行已结束，不允许继续发起请求或提交');
}
export async function withModelTransport<T>(policy: Policy, emit: State['emit'], stop: () => Promise<void>, run: () => Promise<T>): Promise<T> {
  const abort = new AbortController();
  let reject!: (error: ModelTransportError) => void;
  const failure = new Promise<never>((_, fail) => { reject = fail; });
  const current: State = { policy, deadline: Date.now() + policy.timeoutMs, abort, emit, fail(error) {
    if (current.failure) return;
    current.failure = error; emit('transport.failed', { code: error.code });
    abort.abort(error); reject(error);
    void stop().catch(() => {});
  } };
  const timer = setTimeout(() => current.fail(new ModelTransportError('MODEL_DEADLINE', '模型总运行预算已耗尽，已取消请求并禁止自动重发')), policy.timeoutMs);
  try { return await state.run(current, () => Promise.race([Promise.resolve().then(run), failure])); }
  finally { clearTimeout(timer); if (!current.failure) abort.abort(); }
}
export async function controlledModelFetch(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1], send: typeof fetch): Promise<Response> {
  const current = state.getStore();
  if (!current) return send(input, init);
  assertModelTransportActive();
  let request = new Request(input, init);
  // The provider-specific parameters are explicit and visible in HTTP traces.
  if (new URL(request.url).pathname.endsWith('/chat/completions')) {
    const body = await request.clone().json() as Record<string, unknown>;
    const glm53 = typeof body.model === 'string' && /(?:^|\/)glm-5\.3(?:$|[-:])/i.test(body.model);
    if (glm53 && current.policy.reasoning !== 'default') {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = current.policy.reasoning === 'auto' ? 'low' : current.policy.reasoning;
      request = new Request(request, { body: JSON.stringify(body) });
      current.emit('transport.reasoning', { thinking: 'enabled', effort: body.reasoning_effort, reason: 'GLM-5.3 requires thinking; auto uses low' });
    }
  }
  assertModelTransportActive();
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, current.abort.signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout>;
  let lastActivity = Date.now();
  let rejectIdle!: (error: ModelTransportError) => void;
  const idle = new Promise<never>((_, reject) => { rejectIdle = reject; });
  // Attach a rejection handler even while callers are between stream reads.
  void idle.catch(() => {});
  const arm = () => {
    clearTimeout(timer);
    lastActivity = Date.now();
    timer = setTimeout(() => {
      const error = new ModelTransportError('MODEL_IDLE_TIMEOUT', `模型 HTTP 请求连续 ${current.policy.idleTimeoutMs / 1000} 秒无数据，已取消并禁止自动重发`);
      controller.abort(error); rejectIdle(error); current.fail(error);
    }, current.policy.idleTimeoutMs);
  };
  const onRunAbort = () => {
    clearTimeout(timer); controller.abort(current.failure);
    rejectIdle(current.failure ?? new ModelTransportError('MODEL_RUN_ENDED', '模型运行已结束'));
  };
  current.abort.signal.addEventListener('abort', onRunAbort, { once: true });
  const clean = () => { clearTimeout(timer); current.abort.signal.removeEventListener('abort', onRunAbort); };
  arm();
  try {
    const response = await Promise.race([send(request, { signal }), idle]);
    assertModelTransportActive();
    if (!response.ok) {
      clean();
      const error = new ModelTransportError(`MODEL_HTTP_${response.status}`, `模型 HTTP 返回 ${response.status}，本次任务停止自动重试；请检查请求日志`);
      void response.body?.cancel().catch(() => {}); current.fail(error); throw error;
    }
    if (!response.body) { clean(); return response; }
    const reader = response.body.getReader();
    const onAbort = () => { clean(); void reader.cancel().catch(() => {}); };
    current.abort.signal.addEventListener('abort', onAbort, { once: true });
    arm();
    const stream = new ReadableStream<Uint8Array>({
      async pull(c) {
        try {
          assertModelTransportActive();
          const next = await Promise.race([reader.read(), idle]);
          assertModelTransportActive();
          if (Date.now() - lastActivity >= current.policy.idleTimeoutMs) {
            const error = new ModelTransportError('MODEL_IDLE_TIMEOUT', '模型 HTTP 长时间无数据，已停止自动重试');
            current.fail(error); throw error;
          }
          if (next.done) { clean(); current.abort.signal.removeEventListener('abort', onAbort); reader.releaseLock(); c.close(); }
          else { arm(); c.enqueue(next.value); }
        } catch (error) {
          clean(); current.abort.signal.removeEventListener('abort', onAbort);
          const failure = current.failure ?? new ModelTransportError('MODEL_STREAM_FAILED', '模型响应流中断，已停止本次任务；请查看 HTTP 追踪后手动重试');
          current.fail(failure); void reader.cancel().catch(() => {}); c.error(failure);
        }
      },
      async cancel(reason) { clean(); current.abort.signal.removeEventListener('abort', onAbort); controller.abort(); await reader.cancel(reason); },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    clean();
    const failure = current.failure ?? new ModelTransportError('MODEL_CONNECTION_FAILED', '模型 HTTP 连接失败，已停止自动重试；请检查接口和网络');
    current.fail(failure); throw failure;
  }
}

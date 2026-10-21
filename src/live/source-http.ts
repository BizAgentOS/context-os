/** Shared limits for source reads and OpenAPI document retrieval. */
export function sourceUrl(value: string, allowInsecureHttp = false) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("源地址需为不含凭据、查询和片段的 HTTP(S) 地址");
  if (
    !allowInsecureHttp && url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("远端来源必须使用 HTTPS");
  return url;
}

export async function fetchSource(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const attempts = ["GET", "HEAD"].includes(method) ? 4 : 1;
  let response: Response | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      response = await fetch(input, { ...init, redirect: "error",
        signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
      if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === attempts - 1) break;
      await response.body?.cancel();
    } catch (error) { if (init?.signal?.aborted || attempt === attempts - 1) throw error; }
    await new Promise<void>((resolve, reject) => {
      const finish = () => { init?.signal?.removeEventListener("abort", abort); resolve(); };
      const timer = setTimeout(finish, 100 * 2 ** attempt);
      const abort = () => { clearTimeout(timer); reject(init?.signal?.reason); };
      init?.signal?.addEventListener("abort", abort, { once: true });
    });
  }
  if (!response) throw new Error("来源请求失败");
  if (!response.body) return response;
  let size = 0;
  const bounded = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.length;
        if (size > 20_000_000) throw new Error("来源响应超过 20 MB");
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(bounded, {
    status: response.status,
    headers: response.headers,
  });
}

export function redactSource(value: unknown, secret?: string): unknown {
  return secret
    ? JSON.parse(
        JSON.stringify(value, (_key, item) =>
          typeof item === "string"
            ? item.replaceAll(secret, "[redacted]")
            : item,
        ),
      )
    : value;
}

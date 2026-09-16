/** Shared limits for source reads and OpenAPI document retrieval. */
export function sourceUrl(value: string) {
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
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("远端来源必须使用 HTTPS");
  return url;
}

export async function fetchSource(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, {
    ...init,
    redirect: "error",
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(12000)])
      : AbortSignal.timeout(12000),
  });
  if (!response.body) return response;
  let size = 0;
  const bounded = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.length;
        if (size > 2_000_000) throw new Error("来源响应超过 2 MB");
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

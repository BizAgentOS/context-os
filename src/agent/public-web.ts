import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

const reserved = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  reserved.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
reserved.addSubnet("2001::", 23, "ipv6");
reserved.addSubnet("2001:db8::", 32, "ipv6");
reserved.addSubnet("2002::", 16, "ipv6");
export function publicWebUrl(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("网页地址必须为不带凭据的 HTTP(S) URL");
  url.hash = "";
  return url;
}

/** Resolve once, validate every address, then pin the socket lookup (including redirects). */
export async function readPublicResponse(
  url: URL,
  signal: AbortSignal,
  testOrigins: ReadonlySet<string>,
) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  const isPublic = (item: { address: string; family: number }) =>
    item.family === 4
      ? !reserved.check(item.address, "ipv4")
      : globalV6.check(item.address, "ipv6") &&
        !reserved.check(item.address, "ipv6");
  if (
    !addresses.length ||
    (!testOrigins.has(url.origin) && addresses.some((a) => !isPublic(a)))
  )
    throw new Error(
      "公开研究不能访问本机、私网或保留网络地址，请通过已授权数据源接入",
    );
  signal.throwIfAborted();
  const address = addresses[0]!;
  return new Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    raw: Buffer;
    truncated: boolean;
  }>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        signal,
        family: address.family,
        lookup: (_host, _options, callback) =>
          callback(null, address.address, address.family),
        headers: {
          accept: "text/html,text/plain;q=0.9",
          "user-agent": "ContextOS/0.1 enterprise research",
          "accept-encoding": "identity",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.destroy();
          resolve({
            status,
            headers: response.headers,
            raw: Buffer.alloc(0),
            truncated: false,
          });
          return;
        }
        const parts: Buffer[] = [];
        let bytes = 0,
          settled = false;
        response.on("data", (chunk: Buffer) => {
          const room = 512 * 1024 - bytes;
          if (chunk.length > room) {
            parts.push(chunk.subarray(0, room));
            settled = true;
            response.destroy();
            resolve({
              status,
              headers: response.headers,
              raw: Buffer.concat(parts),
              truncated: true,
            });
            return;
          }
          parts.push(chunk);
          bytes += chunk.length;
        });
        response.on("end", () => {
          if (!settled)
            resolve({
              status,
              headers: response.headers,
              raw: Buffer.concat(parts),
              truncated: false,
            });
        });
        response.on("error", (error) => {
          if (!settled) reject(error);
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

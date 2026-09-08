import { createServer as httpServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { AgentApplication } from "./app.ts";
import type { AgentDriver } from "./runtime.ts";

const webRoot = fileURLToPath(new URL("../../web/agent/", import.meta.url));
const staticFiles: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

async function readBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new Error("请使用 JSON 请求");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 6_000_000) throw new Error("请求过大，单份资料最多 5 MB");
    chunks.push(Buffer.from(chunk));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("请求需要对象");
  return value as Record<string, unknown>;
}

export async function createServer(
  options: { directory?: string; driver?: AgentDriver } = {},
) {
  const app = new AgentApplication(
    options.directory ?? resolve("local-state/agent"),
    options.driver,
  );
  const token = randomBytes(32).toString("hex");
  let closed = false;
  let mutation = Promise.resolve<unknown>(undefined);
  const queue = <T>(operation: () => Promise<T>) => {
    const next = mutation.then(operation, operation);
    mutation = next.catch(() => {});
    return next;
  };
  const server = httpServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    const send = (status: number, body: unknown) => {
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(body));
    };
    try {
      const host = request.headers.host ?? "";
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
        send(403, { error: "仅支持本地访问" });
        return;
      }
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (request.method === "GET") {
        if (url.pathname === "/api/canvas/bootstrap") {
          send(200, { token, ...app.canvasState() });
          return;
        }
        if (url.pathname === "/api/canvas") {
          send(200, app.canvasState(url.searchParams.get("page") ?? undefined));
          return;
        }
        if (url.pathname === "/api/bootstrap") {
          send(200, { token, ...app.state() });
          return;
        }
        if (url.pathname === "/api/state") {
          send(200, app.state(url.searchParams.get("taskId") ?? undefined));
          return;
        }
        if (url.pathname === "/api/objects") {
          send(200, app.objectDetails(url.searchParams));
          return;
        }
        if (url.pathname.startsWith("/api/artifacts/")) {
          const version = url.searchParams.has("version")
            ? Number(url.searchParams.get("version"))
            : undefined;
          if (
            version !== undefined &&
            (!Number.isInteger(version) || version < 1)
          )
            throw new Error("无效版本");
          send(
            200,
            app.memory.getArtifact(
              decodeURIComponent(url.pathname.slice("/api/artifacts/".length)),
              version,
            ),
          );
          return;
        }
        const normalized = url.pathname.startsWith("/agent/")
          ? url.pathname.slice("/agent".length)
          : url.pathname;
        const entry = staticFiles[normalized];
        if (!entry) {
          send(404, { error: "页面不存在" });
          return;
        }
        const contents = await readFile(join(webRoot, entry.file));
        response.writeHead(200, { "Content-Type": entry.type });
        response.end(contents);
        return;
      }
      if (request.method !== "POST") {
        send(405, { error: "不支持的请求方式" });
        return;
      }
      const provided = request.headers["x-dataengine-token"];
      const origin = request.headers.origin;
      if (
        typeof provided !== "string" ||
        provided.length !== token.length ||
        !timingSafeEqual(Buffer.from(provided), Buffer.from(token)) ||
        (origin && origin !== `http://${host}`)
      ) {
        send(403, { error: "会话已失效，请刷新页面" });
        return;
      }
      const body = await readBody(request);
      let result: unknown;
      switch (url.pathname) {
        case "/api/canvas/message":
          result = await queue(() => app.canvasMessage(body));
          send(202, result);
          return;
        case "/api/canvas/upload":
          result = await queue(() => app.canvasUpload(body));
          break;
        case "/api/canvas/navigate":
          result = await queue(() => app.canvasNavigate(body));
          break;
        case "/api/canvas/stop":
          result = await app.canvasStop(body);
          break;
        case "/api/canvas/decision":
          result = await queue(() => app.canvasDecision(body));
          break;
        case "/api/messages":
          result = await queue(() => app.message(body));
          send(202, result);
          return;
        case "/api/upload":
          result = await queue(() => app.upload(body));
          break;
        case "/api/sample":
          result = await queue(() => app.sample(body));
          break;
        case "/api/stop":
          if (typeof body.taskId !== "string") throw new Error("需要任务标识");
          result = await app.stop(body.taskId);
          break;
        case "/api/decision":
          result = await queue(() => app.decision(body));
          break;
        case "/api/profile":
          result = await queue(() => app.editProfile(body));
          break;
        case "/api/refresh":
          result = await queue(() => app.refresh(body));
          break;
        case "/api/settings":
          result = await queue(() => app.configure(body));
          break;
        case "/api/settings/test":
          result = await app.testConnection();
          break;
        default:
          send(404, { error: "接口不存在" });
          return;
      }
      send(200, result);
    } catch (error) {
      const message = app.safeError(error);
      // Never include request bodies, provider credentials or raw SDK objects in HTTP errors.
      send(/不存在/.test(message) ? 404 : 400, {
        error: message.slice(0, 600),
      });
    }
  });
  return {
    app,
    server,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
      await app.close();
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const port = Number(process.env.DATAENGINE_PORT ?? 8788);
  const service = await createServer({
    directory: process.env.DATAENGINE_STATE_DIR,
  });
  service.server.listen(port, "127.0.0.1", () => {
    console.log(`DataEngine Agent: http://127.0.0.1:${port}`);
  });
  const shutdown = () => {
    void service.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

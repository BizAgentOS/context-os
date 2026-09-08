import { createServer as httpServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AgentApplication } from "./app.ts";
import { SourcePolicyService } from "./source-policy.ts";
import { reviewVerification } from "./maintenance.ts";
import type { AgentDriver } from "./runtime.ts";

const webRoot = fileURLToPath(new URL("../../web/agent/", import.meta.url));
const staticFiles: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/ontology-workspace.js": {
    file: "ontology-workspace.js",
    type: "text/javascript; charset=utf-8",
  },
  "/memory-graph.js": {
    file: "memory-graph.js",
    type: "text/javascript; charset=utf-8",
  },
  "/memory-graph.css": {
    file: "memory-graph.css",
    type: "text/css; charset=utf-8",
  },
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
  options: {
    directory?: string;
    driver?: AgentDriver;
    demo?: { name: string };
  } = {},
) {
  const directory = options.directory ?? resolve("local-state/agent");
  const app = new AgentApplication(directory, options.driver);
  const tokenFile = join(directory, "admin-token");
  try {
    writeFileSync(
      tokenFile,
      `de_admin_${randomBytes(32).toString("base64url")}`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      await app.close();
      throw error;
    }
  }
  chmodSync(tokenFile, 0o600);
  const token = readFileSync(tokenFile, "utf8").trim();
  if (!/^de_admin_[A-Za-z0-9_-]{43}$/.test(token)) {
    await app.close();
    throw new Error("管理员凭据文件无效");
  }
  const cookieName = `dataengine_admin_${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
  const matchesToken = (value: unknown) => {
    if (typeof value !== "string") return false;
    const bytes = Buffer.from(value);
    const expected = Buffer.from(token);
    return bytes.length === expected.length && timingSafeEqual(bytes, expected);
  };
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
      const payload =
        options.demo &&
        body &&
        typeof body === "object" &&
        "currentPage" in body
          ? { ...body, demo: options.demo }
          : body;
      response.end(JSON.stringify(payload));
    };
    try {
      const host = request.headers.host ?? "";
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
        send(403, { error: "仅支持本地访问" });
        return;
      }
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
        const result = app.consumption.handle({
          method: request.method ?? "",
          path: url.pathname,
          query: url.searchParams,
          authorization: request.headers.authorization,
        });
        send(result.status, result.body);
        return;
      }
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        const supplied = request.headers["x-dataengine-token"];
        const cookie = request.headers.cookie
          ?.split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith(`${cookieName}=`))
          ?.slice(cookieName.length + 1);
        const origin = request.headers.origin;
        const authorized =
          supplied !== undefined
            ? matchesToken(supplied)
            : request.method === "GET" && matchesToken(cookie);
        // Consumer credentials never establish a management session, even if a browser also has an admin cookie.
        if (
          !authorized ||
          request.headers.authorization !== undefined ||
          (origin && origin !== `http://${host}`)
        ) {
          send(403, {
            error: "需要管理员入口，请使用本机启动时提供的管理链接",
          });
          return;
        }
        if (
          request.method === "GET" &&
          (url.pathname === "/api/bootstrap" ||
            url.pathname === "/api/canvas/bootstrap")
        )
          response.setHeader(
            "Set-Cookie",
            `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/api`,
          );
      }
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
        if (url.pathname === "/api/consumers") {
          send(200, {
            consumers: app.consumption.list(),
            audit: app.consumption.logs(
              url.searchParams.get("consumerId") ?? undefined,
            ),
          });
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
      if (!url.pathname.startsWith("/api/")) {
        send(404, { error: "接口不存在" });
        return;
      }
      const body = await readBody(request);
      let result: unknown;
      switch (url.pathname) {
        case "/api/sources/policy":
          result = await queue(async () => {
            const policy = new SourcePolicyService(app.memory).update(body);
            return { ...app.canvasState(), policy };
          });
          break;
        case "/api/verifications/review":
          result = await queue(async () => {
            if (app.canvasState().busy)
              throw new Error("请等待当前整理完成或先停止，再确认验证结果");
            const verification = reviewVerification(app.memory, body);
            return { ...app.canvasState(), verification };
          });
          break;
        case "/api/consumers/activate":
          result = await queue(() => app.activateConsumer(body));
          break;
        case "/api/consumers/revoke":
          result = await app.revokeConsumer(body);
          break;
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
    adminToken: token,
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
    console.log(
      `DataEngine: http://127.0.0.1:${port}/#access=${service.adminToken}`,
    );
  });
  const shutdown = () => {
    void service.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

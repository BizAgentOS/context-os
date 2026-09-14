import { MetricReader } from "./metrics.ts";
import { KnowledgeReader, sourceCatalog } from "./knowledge.ts";
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
  "/capabilities.js": {
    file: "capabilities.js",
    type: "text/javascript; charset=utf-8",
  },
  "/fusion.js": { file: "fusion.js", type: "text/javascript; charset=utf-8" },
  "/foundation-bindings.js": {
    file: "foundation-bindings.js",
    type: "text/javascript; charset=utf-8",
  },
  "/metrics.js": { file: "metrics.js", type: "text/javascript; charset=utf-8" },
  "/foundation.js": {
    file: "foundation.js",
    type: "text/javascript; charset=utf-8",
  },
  "/drafts.js": { file: "drafts.js", type: "text/javascript; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/live-workspace.js": {
    file: "live-workspace.js",
    type: "text/javascript; charset=utf-8",
  },
  "/share-mode.js": {
    file: "share-mode.js",
    type: "text/javascript; charset=utf-8",
  },
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
    researchTestOrigins?: ReadonlySet<string>;
    demo?: { name: string };
  } = {},
) {
  const directory = options.directory ?? resolve("local-state/agent");
  const app = new AgentApplication(
    directory,
    options.driver,
    options.researchTestOrigins,
  );
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
      if (url.pathname.startsWith("/v2/")) {
        if (request.method !== "GET") {
          send(405, { error: "仅支持只读请求" });
          return;
        }
        const result = await app.live.handle(
          url.pathname,
          url.searchParams,
          request.headers.authorization,
        );
        send(result.status, result.body);
        return;
      }
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
        if (url.pathname === "/api/foundation/evidence") {
          send(
            200,
            app.foundation.evidence(
              url.searchParams.get("foundationId") ?? "",
              Number(url.searchParams.get("version")),
              url.searchParams.get("evidenceId") ?? "",
            ),
          );
          return;
        }
        if (url.pathname === "/api/canvas/history") {
          send(200, app.canvasHistory(url.searchParams.get("section")));
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
        if (url.pathname === "/api/capabilities") {
          send(200, await app.capabilities.overview());
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
        if (url.pathname === "/api/consumers/connection") {
          const origin = `http://${host}`;
          send(200, {
            mcp: {
              mcpServers: {
                dataengine: {
                  command: process.execPath,
                  args: [
                    fileURLToPath(
                      new URL(
                        "../../scripts/dataengine-mcp.ts",
                        import.meta.url,
                      ),
                    ),
                  ],
                  env: {
                    DATAENGINE_URL: origin,
                    DATAENGINE_CONSUMER_KEY: "<本调用方 API Key>",
                  },
                },
              },
            },
            http: {
              schema: `${origin}/v1/schema`,
              objects: `${origin}/v1/objects`,
            },
            localOnly: true,
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
        case "/api/capabilities/mcp/disconnect":
          await app.capabilities.mcp.disconnect(String(body.name));
          result = await app.capabilities.overview();
          break;
        case "/api/capabilities/mcp/grant":
          if (
            !Array.isArray(body.ids) ||
            body.ids.some((id) => typeof id !== "string")
          )
            throw new Error("请选择具体能力");
          if (!Number.isInteger(body.revision))
            throw new Error("缺少能力目录版本，请重新打开设置");
          app.capabilities.mcp.grant(
            String(body.name),
            body.ids as string[],
            Number(body.revision),
          );
          result = await app.capabilities.overview();
          break;
        case "/api/capabilities/mcp/refresh":
        case "/api/capabilities/mcp/connect":
        case "/api/capabilities/skill/install":
          result = await queue(async () => {
            if (app.canvasState().busy)
              throw new Error("请先停止当前整理，再添加能力");
            if (url.pathname.endsWith("/refresh"))
              await app.capabilities.mcp.refresh(String(body.name));
            else if (url.pathname.endsWith("/connect"))
              await app.capabilities.mcp.connect(body);
            else
              await app.capabilities.installSkill(
                String(body.name),
                String(body.content),
              );
            return app.capabilities.overview();
          });
          break;
        case "/api/live/connect":
        case "/api/live/propose":
        case "/api/live/adopt":
        case "/api/live/prepare":
        case "/api/live/activate":
          result = await queue(async () => {
            if (app.canvasState().busy)
              throw new Error("请先停止当前整理，再修改连接或本体");
            let saved: unknown;
            switch (url.pathname) {
              case "/api/live/connect":
                saved = await app.live.sources.connect(body);
                break;
              case "/api/live/propose":
                saved = await app.live.propose(body);
                break;
              case "/api/live/adopt":
                saved = await app.adoptLive(
                  String(body.id),
                  Number(body.version),
                );
                break;
              case "/api/live/prepare":
                saved = app.live.prepare(body);
                break;
              case "/api/live/activate":
                saved = app.live.activate(
                  String(body.id),
                  Number(body.version),
                );
                break;
            }
            return { ...app.canvasState(), saved };
          });
          break;
        case "/api/live/disable": {
          const saved = app.live.sources.disable(
            String(body.id),
            Number(body.version),
          );
          result = { ...app.canvasState(), saved };
          break;
        }
        case "/api/live/revoke": {
          const saved = app.live.revoke(String(body.id), Number(body.version));
          result = { ...app.canvasState(), saved };
          break;
        }
        case "/api/live/read":
          result = await app.live.sources.readRecords(
            String(body.sourceId),
            String(body.capability),
            (body.where ?? {}) as import("./contracts.ts").Data,
            Number(body.offset ?? 0),
            Number(body.limit ?? 3),
          );
          break;
        case "/api/live/metrics/describe":
          result = await new MetricReader(app.live.sources).describe(body);
          break;
        case "/api/live/metrics/query":
          result = await new MetricReader(app.live.sources).query(body);
          break;
        case "/api/live/catalog":
          result = sourceCatalog(app.memory, body);
          break;
        case "/api/live/knowledge/query":
          result = await new KnowledgeReader(app.live.sources).query(body);
          break;
        case "/api/live/knowledge/read":
          result = await new KnowledgeReader(app.live.sources).read(body);
          break;
        case "/api/live/query":
          result = await app.live.query(body);
          break;
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
        case "/api/consumers/prepare":
          result = await queue(async () => app.prepareConsumer(body));
          break;
        case "/api/consumers/data-preview":
          result = app.consumption.previewDataUpdate(
            String(body.id ?? ""),
            Number(body.version),
          );
          break;
        case "/api/consumers/data-publish":
          result = await queue(async () => {
            const consumer = app.consumption.publishDataUpdate(
              String(body.id ?? ""),
              Number(body.version),
              body.sourceVersions as Record<string, number>,
            );
            return { ...app.canvasState(), consumer };
          });
          break;
        case "/api/consumers/revoke":
          result = await app.revokeConsumer(body);
          break;
        case "/api/canvas/message/receipt":
          result = app.canvasMessageReceipt(body);
          break;
        case "/api/canvas/context":
          result = app.canvasContext(body);
          break;
        case "/api/canvas/context/read":
          result = await app.contexts.read(app.canvasContext(body).context);
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
        case "/api/canvas/foundation/adopt":
          result = await queue(() => app.canvasFoundationAdopt(body));
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

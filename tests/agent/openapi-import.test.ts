import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { SourceConnections } from "../../src/live/sources.ts";
import { OpenApiImports } from "../../src/live/openapi-import.ts";

export function apiSpec(url: string) {
  return {
    openapi: "3.0.3",
    info: { title: "Customer system", version: "v1" },
    servers: [{ url: url + "/v1" }],
    components: {
      schemas: {
        Customer: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" } },
        },
      },
      securitySchemes: {
        key: { type: "apiKey", in: "header", name: "X-Api-Key" },
      },
    },
    security: [{ key: [] }],
    paths: {
      "/customers": {
        get: {
          operationId: "customers",
          summary: "客户",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer" } },
            { name: "offset", in: "query", schema: { type: "integer" } },
          ],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Customer" },
                      },
                      total: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/customers/delete": {
        post: {
          summary: "删除客户",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

test("OpenAPI preview does not save; committing imports only selected GET capabilities with base path and private credentials", async () => {
  let value = "Alice";
  const requests: string[] = [];
  const upstream = createServer((req, res) => {
    requests.push(req.url!);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/openapi.json") {
      res.end(JSON.stringify(apiSpec(origin)));
      return;
    }
    assert.equal(req.headers["x-api-key"], "fixture-private-key");
    assert.equal(req.method, "GET");
    assert.match(req.url!, /^\/v1\/customers\?limit=3&offset=0$/);
    res.end(JSON.stringify({ items: [{ id: "C1", name: value }], total: 1 }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), "openapi-import-"));
  const repo = new MemoryStore(dir);
  const sources = new SourceConnections(dir, repo);
  const imports = new OpenApiImports(sources);
  try {
    const catalog = await imports.parse({ url: origin + "/openapi.json" });
    assert.equal(catalog.title, "Customer system");
    const operation = catalog.operations.find((o) => o.method === "GET")!;
    assert.equal(operation.supported, true);
    assert.equal(
      catalog.operations.find((o) => o.method === "POST")?.supported,
      false,
    );
    assert.equal(sources.list().length, 0);
    const preview = await imports.preview({
      draftId: catalog.draftId,
      name: "客户API",
      baseUrl: origin + "/v1",
      auth: {
        type: "apiKey",
        headerName: "X-Api-Key",
        secret: "fixture-private-key",
      },
      operations: [{ id: operation.id, ...operation.defaults }],
    });
    assert.equal(preview.results[0].sample.items[0].name, "Alice");
    assert.equal(sources.list().length, 0);
    const saved = await imports.commit({ receiptId: preview.receiptId });
    assert.equal(saved.content.protocol, "http");
    assert.equal((saved.content.capabilities as unknown[]).length, 1);
    assert.equal(
      (await imports.commit({ receiptId: preview.receiptId })).id,
      saved.id,
    );
    value = "Changed";
    assert.equal(
      (await sources.readRecords(saved.id, "customers", {}, 0, 3)).items[0]
        .name,
      "Changed",
    );
    assert.equal(requests.filter((p) => p.startsWith("/v1/")).length, 2);
    assert.ok(
      !JSON.stringify([catalog, preview, saved, repo.listArtifacts()]).includes(
        "fixture-private-key",
      ),
    );
  } finally {
    imports.close();
    repo.close();
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Swagger YAML supports root arrays; unsafe and unsupported operations remain unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openapi-parse-"));
  const repo = new MemoryStore(dir);
  const imports = new OpenApiImports(new SourceConnections(dir, repo));
  try {
    const catalog = await imports.parse({
      text: `swagger: '2.0'
info: {title: Inventory, version: '1'}
host: example.com
basePath: /api
schemes: [https]
paths:
  /products:
    get:
      parameters:
        - {name: limit, in: query, type: integer}
        - {name: offset, in: query, type: integer}
      responses:
        '200':
          description: Products
          schema:
            type: array
            items:
              type: object
              properties:
                productId: {type: integer}
                title: {type: string}
`,
    });
    assert.equal(catalog.baseUrl, "https://example.com/api");
    assert.equal(catalog.operations[0].defaults?.itemsPath, "");
    assert.equal(catalog.operations[0].defaults?.idType, "number");
    const spec = apiSpec("https://example.com");
    // External refs are described as unsupported, not followed over the network.
    spec.paths["/customers"].get.responses["200"].content[
      "application/json"
    ].schema.properties.items.items.$ref = "https://example.com/private.json";
    const unsupported = await imports.parse({ text: JSON.stringify(spec) });
    assert.equal(unsupported.operations[0].supported, false);
    assert.match(unsupported.operations[0].reason!, /外部/);
    await assert.rejects(
      imports.parse({ text: "openapi: 3.0.3\nopenapi: 3.1.0" }),
      /解析/,
    );
    await assert.rejects(imports.parse({ text: "a: &a [*a]" }), /解析/);
    await assert.rejects(
      imports.parse({ url: "https://user:password@example.com/openapi.json" }),
      /凭据/,
    );
    await assert.rejects(
      imports.commit({ receiptId: "00000000-0000-4000-8000-000000000000" }),
      /过期/,
    );
    assert.equal(repo.listArtifacts("source_connection").length, 0);
  } finally {
    imports.close();
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preview rejects unapproved methods and forged mapping before I/O; empty or oversized samples cannot be committed", async () => {
  let mode = "empty",
    hits = 0;
  const upstream = createServer((_req, res) => {
    hits++;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        items:
          mode === "empty"
            ? []
            : Array.from({ length: 4 }, (_, i) => ({
                id: String(i),
                name: "record",
              })),
        total: mode === "empty" ? 0 : 4,
      }),
    );
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), "openapi-preview-"));
  const repo = new MemoryStore(dir);
  const imports = new OpenApiImports(new SourceConnections(dir, repo));
  try {
    const catalog = await imports.parse({
      text: JSON.stringify(apiSpec(origin)),
    });
    const op = catalog.operations[0];
    const request = {
      draftId: catalog.draftId,
      name: "test",
      baseUrl: origin + "/v1",
      auth: { type: "apiKey", headerName: "X-Api-Key", secret: "test-key" },
      operations: [{ id: op.id, ...op.defaults }],
    };
    await assert.rejects(
      imports.preview({
        ...request,
        operations: [
          { ...request.operations[0], id: "POST /customers/delete" },
        ],
      }),
      /不能导入/,
    );
    await assert.rejects(
      imports.preview({
        ...request,
        operations: [{ ...request.operations[0], itemsPath: "secret" }],
      }),
      /文档不一致/,
    );
    await assert.rejects(
      imports.preview({ ...request, auth: { type: "none" } }),
      /认证方式/,
    );
    assert.equal(hits, 0);
    await assert.rejects(imports.preview(request), /未返回记录/);
    mode = "large";
    await assert.rejects(imports.preview(request), /分页契约/);
    assert.equal(repo.listArtifacts("source_connection").length, 0);
  } finally {
    imports.close();
    repo.close();
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP import endpoints require admin identity and preserve tested connection across restart", async () => {
  const { createServer: appServer } = await import("../../src/agent/server.ts");
  const upstream = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ items: [{ id: "1", name: "customer" }], total: 1 }),
    );
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), "openapi-http-"));
  let service = await appServer({ directory: dir });
  const start = async () => {
    await new Promise<void>((r) => service.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(service.server.address() as { port: number }).port}`;
  };
  let url = await start();
  const post = async (path: string, body: unknown, authorized = true) =>
    fetch(url + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorized ? { "X-ContextOS-Token": service.adminToken } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    for (const path of ["parse", "preview", "commit"])
      assert.equal(
        (await post("/api/live/openapi/" + path, {}, false)).status,
        403,
      );
    const parsed = await post("/api/live/openapi/parse", {
      text: JSON.stringify(apiSpec(origin)),
    });
    assert.equal(parsed.status, 200);
    const catalog = await parsed.json();
    const op = catalog.operations[0];
    const previewResponse = await post("/api/live/openapi/preview", {
      draftId: catalog.draftId,
      name: "Customer API",
      baseUrl: origin + "/v1",
      auth: {
        type: "apiKey",
        headerName: "X-Api-Key",
        secret: "private-fixture",
      },
      operations: [{ id: op.id, ...op.defaults }],
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    const savedResponse = await post("/api/live/openapi/commit", {
      receiptId: preview.receiptId,
    });
    assert.equal(savedResponse.status, 200);
    const { saved } = await savedResponse.json();
    assert.equal(saved.status, "ready");
    assert.equal(
      (
        await post("/api/live/openapi/commit", {
          receiptId: preview.receiptId,
          baseUrl: "https://another.example",
        })
      ).status,
      400,
    );
    await service.close();
    service = await appServer({ directory: dir });
    url = await start();
    const result = await post("/api/live/read", {
      sourceId: saved.id,
      capability: "customers",
      limit: 3,
    });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).items[0].name, "customer");
    assert.equal(
      (await post("/api/live/openapi/commit", { receiptId: preview.receiptId }))
        .status,
      400,
    );
    assert.equal(service.app.live.sources.list().length, 1);
  } finally {
    await service.close();
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("undocumented limit/offset names can be supplied and explicit page parameters are recognized", async () => {
  const upstream = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    assert.equal(req.url, "/v1/customers?take=3&start=0");
    res.end(JSON.stringify({ items: [{ id: "1", name: "sample" }], total: 1 }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), "openapi-pagination-"));
  const repo = new MemoryStore(dir);
  const imports = new OpenApiImports(new SourceConnections(dir, repo));
  try {
    const spec = apiSpec(origin);
    spec.paths["/customers"].get.parameters = [];
    const catalog = await imports.parse({ text: JSON.stringify(spec) });
    const op = catalog.operations[0];
    assert.equal(op.supported, true);
    const result = await imports.preview({
      draftId: catalog.draftId,
      name: "API",
      baseUrl: origin + "/v1",
      auth: { type: "apiKey", headerName: "X-Api-Key", secret: "fixture" },
      operations: [
        { id: op.id, ...op.defaults, limitParam: "take", offsetParam: "start" },
      ],
    });
    assert.equal(result.results[0].sample.coverage.complete, true);
    spec.paths["/customers"].get.parameters = [
      { name: "page", in: "query", schema: { type: "integer" } },
    ];
    const paged = (await imports.parse({ text: JSON.stringify(spec) })).operations[0];
    assert.equal(paged.supported, true);
    assert.deepEqual(paged.defaults!.pagination, { type: "page", pageParam: "page", startPage: 1 });
  } finally {
    imports.close();
    repo.close();
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shared allOf references have bounded expansion and long GET paths remain importable", async () => {
  const schemas: Record<string, unknown> = {
    Leaf: {
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" } },
    },
  };
  let previous = "Leaf";
  for (let level = 0; level < 8; level++) {
    const key = `Level${level}`;
    schemas[key] = {
      allOf: Array.from({ length: 10 }, () => ({
        $ref: `#/components/schemas/${previous}`,
      })),
    };
    previous = key;
  }
  const spec = apiSpec("https://example.com");
  Object.assign(spec.components.schemas, schemas);
  spec.paths["/customers"].get.responses["200"].content[
    "application/json"
  ].schema.properties.items.items.$ref = `#/components/schemas/${previous}`;
  const longPath = "/" + "customers".repeat(26);
  const { operationId: _omitted, ...getWithoutId } =
    spec.paths["/customers"].get;
  const document = { ...spec, paths: { [longPath]: { get: getWithoutId } } };
  const upstream = createServer((req, res) => {
    assert.equal(req.url?.split("?")[0], "/v1" + longPath);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ items: [{ id: "1", name: "ok" }], total: 1 }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "openapi-refs-"));
  const repo = new MemoryStore(dir);
  const imports = new OpenApiImports(new SourceConnections(dir, repo));
  try {
    const catalog = await imports.parse({ text: JSON.stringify(document) });
    const op = catalog.operations[0];
    assert.equal(
      op.supported,
      true,
      op.reason || "operation should be supported",
    );
    const preview = await imports.preview({
      draftId: catalog.draftId,
      name: "Long path",
      baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
      auth: { type: "apiKey", headerName: "X-Api-Key", secret: "fixture" },
      operations: [{ id: op.id, ...op.defaults }],
    });
    assert.equal(
      (await imports.commit({ receiptId: preview.receiptId })).status,
      "ready",
    );
  } finally {
    imports.close();
    repo.close();
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wide repeated allOf merges stop at the total work budget", async () => {
  const spec = apiSpec("https://example.com");
  const leaf = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 4000 }, (_, i) => [`field${i}`, { type: "string" }]),
    ),
  };
  Object.assign(spec.components.schemas, {
    Leaf: leaf,
    Combined: {
      allOf: Array.from({ length: 4000 }, () => ({
        $ref: "#/components/schemas/Leaf",
      })),
    },
  });
  spec.paths["/customers"].get.responses["200"].content[
    "application/json"
  ].schema.properties.items.items.$ref = "#/components/schemas/Combined";
  const dir = mkdtempSync(join(tmpdir(), "openapi-budget-"));
  const repo = new MemoryStore(dir);
  const imports = new OpenApiImports(new SourceConnections(dir, repo));
  try {
    const op = (await imports.parse({ text: JSON.stringify(spec) }))
      .operations[0];
    assert.equal(op.supported, false);
    assert.match(op.reason!, /预算/);
  } finally {
    imports.close();
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("none/Bearer/Basic previews use the selected authentication and receipts expire", async (t) => {
  let expected: string | undefined;
  const upstream = createServer((req, res) => {
    assert.equal(req.headers.authorization, expected);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        items: [{ id: "1", name: expected?.split(" ")[1] || "public" }],
        total: 1,
      }),
    );
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), "openapi-auth-"));
  const repo = new MemoryStore(dir);
  const sources = new SourceConnections(dir, repo);
  const imports = new OpenApiImports(sources);
  try {
    const spec = { ...apiSpec(origin), security: [] };
    for (const type of ["none", "bearer", "basic"] as const) {
      const secret =
        type === "basic"
          ? Buffer.from("fixture:password").toString("base64")
          : type === "bearer"
            ? "private-fixture-token"
            : undefined;
      expected = secret
        ? `${type === "basic" ? "Basic" : "Bearer"} ${secret}`
        : undefined;
      const catalog = await imports.parse({ text: JSON.stringify(spec) });
      const op = catalog.operations[0];
      const preview = await imports.preview({
        draftId: catalog.draftId,
        name: "test",
        baseUrl: origin + "/v1",
        auth: { type, ...(secret ? { secret } : {}) },
        operations: [{ id: op.id, ...op.defaults }],
      });
      assert.equal(
        preview.results[0].sample.items[0].name,
        secret ? "[redacted]" : "public",
      );
      const future = Date.now() + 31 * 60 * 1000;
      t.mock.method(Date, "now", () => future);
      await assert.rejects(
        imports.commit({ receiptId: preview.receiptId }),
        /过期/,
      );
      t.mock.restoreAll();
    }
    assert.equal(sources.list().length, 0);
  } finally {
    t.mock.restoreAll();
    imports.close();
    repo.close();
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("document and authenticated sample redirects are never followed; response size is bounded", async () => {
  let hits = 0;
  const destination = createServer((_req, res) => {
    hits++;
    res.end("{}");
  });
  await new Promise<void>((r) => destination.listen(0, "127.0.0.1", r));
  const target = `http://127.0.0.1:${(destination.address() as { port: number }).port}`;
  const upstream = createServer((req, res) => {
    if (req.url === "/large.json") {
      res.end("x".repeat(2_000_001));
      return;
    }
    res.writeHead(302, { Location: target });
    res.end();
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), "openapi-redirect-"));
  const repo = new MemoryStore(dir);
  const sources = new SourceConnections(dir, repo);
  const imports = new OpenApiImports(sources);
  try {
    await assert.rejects(
      imports.parse({ url: origin + "/openapi.json" }),
      /文档读取失败/,
    );
    await assert.rejects(
      imports.parse({ url: origin + "/large.json" }),
      /文档读取失败/,
    );
    const catalog = await imports.parse({
      text: JSON.stringify(apiSpec(origin)),
    });
    const op = catalog.operations[0];
    await assert.rejects(
      imports.preview({
        draftId: catalog.draftId,
        name: "test",
        baseUrl: origin,
        auth: {
          type: "apiKey",
          headerName: "X-Api-Key",
          secret: "private-key",
        },
        operations: [{ id: op.id, ...op.defaults }],
      }),
      /来源读取失败/,
    );
    assert.equal(hits, 0);
    assert.equal(sources.list().length, 0);
  } finally {
    imports.close();
    repo.close();
    upstream.closeAllConnections();
    destination.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => upstream.close(() => r())),
      new Promise<void>((r) => destination.close(() => r())),
    ]);
    rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";

test("custom API uses the actual configured gateway and isolates keys on endpoint changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-custom-model-"));
  const originalEnv = { ...process.env };
  const requests: any[] = [];
  const leaked: unknown[] = [];
  const other = httpServer((req, res) => {
    leaked.push(req.headers);
    res.writeHead(401);
    res.end();
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  const otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  const gateway = httpServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({
      path: req.url,
      key: req.headers.authorization,
      anthropicKey: req.headers["x-api-key"],
      body,
    });
    if (body.model === "redirect-model") {
      res.writeHead(307, { location: otherUrl + "/stolen" });
      res.end();
      return;
    }
    if (body.model === "error-model") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "Rejected " + req.headers.authorization,
            type: "authentication_error",
          },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (req.url?.endsWith("/messages")) {
      const events = [
        {
          type: "message_start",
          message: {
            id: "fixture",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "连接成功。" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 4 },
        },
        { type: "message_stop" },
      ];
      for (const event of events)
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
      return;
    }
    for (const [delta, finish] of [
      [{ role: "assistant", content: "连接成功。" }, null],
      [{}, "stop"],
    ])
      res.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const primary = () =>
    requests.filter((r) => {
      const content = r.body.messages.at(-1)?.content;
      return (
        content === "只回复：连接成功。" ||
        (Array.isArray(content) &&
          content.some((c) => c.text === "只回复：连接成功。"))
      );
    });
  const url = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  let service = await createServer({ directory });
  const start = async () => {
    await new Promise<void>((resolve) =>
      service.server.listen(0, "127.0.0.1", resolve),
    );
    return `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  };
  let origin = await start();
  const api = async (path: string, body?: unknown) => {
    const r = await fetch(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        "x-dataengine-token": service.adminToken,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  try {
    const settings = {
      provider: "custom",
      protocol: "openai",
      baseUrl: url + "/first/v1/",
      model: "fixture-model",
    };
    const saved = await api("/api/settings", {
      ...settings,
      apiKey: "fixture-first-key",
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.model.baseUrl, url + "/first/v1");
    const firstCheck = await api("/api/settings/test", {});
    assert.equal(firstCheck.body.ok, true, JSON.stringify(firstCheck));
    assert.equal(primary()[0].path, "/first/v1/chat/completions");
    assert.equal(primary()[0].body.model, "fixture-model");
    assert.equal(primary()[0].key, "Bearer fixture-first-key");
    const next = {
      ...settings,
      baseUrl: url + "/second/v1",
      model: "second-model",
    };
    const noKey = await api("/api/settings", next);
    assert.equal(noKey.status, 200);
    assert.equal(noKey.body.model.configured, false);
    assert.equal((await api("/api/settings/test", {})).status, 400);
    assert.equal(primary().length, 1);
    await api("/api/settings", { ...next, apiKey: "fixture-second-key" });
    assert.equal((await api("/api/settings/test", {})).body.ok, true);
    assert.equal(primary()[1].path, "/second/v1/chat/completions");
    assert.equal(primary()[1].body.model, "second-model");
    assert.equal(primary()[1].key, "Bearer fixture-second-key");
    const anthropic = { ...next, protocol: "anthropic" };
    assert.equal(
      (await api("/api/settings", anthropic)).body.model.configured,
      false,
    );
    assert.equal((await api("/api/settings/test", {})).status, 400);
    await api("/api/settings", {
      ...anthropic,
      baseUrl: url + "/second",
      apiKey: "fixture-anthropic-key",
    });
    const anthropicResult = await api("/api/settings/test", {});
    assert.equal(
      anthropicResult.body.ok,
      true,
      JSON.stringify(anthropicResult),
    );
    assert.equal(primary()[2].path, "/second/v1/messages");
    assert.equal(primary()[2].anthropicKey, "fixture-anthropic-key");
    // Return to the already configured OpenAI endpoint without copying the Anthropic key.
    assert.equal(
      (await api("/api/settings", next)).body.model.configured,
      true,
    );
    for (const invalid of [
      "file:///tmp/model",
      "https://example.com/v1?",
      "https://example.com/v1#",
      "https://example.com/v1/chat/completions?",
      "https://user:secret@example.com/v1",
      "https://example.com/v1?key=secret",
      "https://example.com/v1#secret",
      url + "/v1/chat/completions",
    ]) {
      const bad = await api("/api/settings", {
        ...next,
        baseUrl: invalid,
        apiKey: "invalid-key",
      });
      assert.equal(bad.status, 400);
      assert(!JSON.stringify(bad).includes("secret"));
    }
    const current = await api("/api/canvas");
    assert.equal(current.body.model.baseUrl, next.baseUrl);
    assert(!JSON.stringify(current).includes("fixture-second-key"));
    await service.close();
    service = await createServer({ directory });
    origin = await start();
    const restored = await api("/api/canvas");
    assert.equal(restored.body.model.baseUrl, next.baseUrl);
    assert.equal(restored.body.model.protocol, "openai");
    assert.equal((await api("/api/settings/test", {})).body.ok, true);
    assert.equal(primary()[3].key, "Bearer fixture-second-key");
    await api("/api/settings", { ...next, model: "error-model" });
    const failed = await api("/api/settings/test", {});
    assert.equal(failed.status, 400);
    assert(!JSON.stringify(failed).includes("fixture-second-key"));
    for (const protocol of ["openai", "anthropic"]) {
      await api("/api/settings", {
        ...next,
        protocol,
        baseUrl: protocol === "openai" ? next.baseUrl : url + "/second",
        model: "redirect-model",
      });
      const redirected = await api("/api/settings/test", {});
      assert.equal(redirected.status, 400);
      assert.equal(
        leaked.length,
        0,
        "redirects must never forward credentials to another origin",
      );
    }
    for (const r of requests) {
      if (r.path === "/first/v1/chat/completions")
        assert.equal(r.key, "Bearer fixture-first-key");
      else if (r.path === "/second/v1/chat/completions")
        assert.equal(r.key, "Bearer fixture-second-key");
      else {
        assert.equal(r.path, "/second/v1/messages");
        assert.equal(r.anthropicKey, "fixture-anthropic-key");
      }
    }
  } finally {
    await service.close();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => other.close(() => resolve()));
    for (const key of Object.keys(process.env))
      if (key.startsWith("DATAENGINE_CUSTOM_")) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
      }
    rmSync(directory, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";

test("GLM providers keep distinct credentials and persist model selection across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-glm-"));
  const variants = [
    ["zhipu", "ZHIPU_API_KEY"],
    ["zhipu-coding", "ZHIPU_CODING_API_KEY"],
    ["zai-coding", "ZAI_CODING_API_KEY"],
  ];
  const previous = variants.map(([, env]) => process.env[env]);
  for (const [, env] of variants) delete process.env[env];
  let service = await createServer({ directory });
  const start = async () => {
    await new Promise<void>((resolve) =>
      service.server.listen(0, "127.0.0.1", resolve),
    );
    return `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  };
  let origin = await start();
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        "x-dataengine-token": service.adminToken,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    for (const [provider] of variants) {
      const missing = await request("/api/settings", {
        provider,
        model: "glm-4.7",
      });
      assert.equal(missing.status, 200);
      assert.equal(missing.body.model.configured, false);
      const configured = await request("/api/settings", {
        provider,
        model: "glm-4.7",
        apiKey: "fake-test-key-" + provider,
      });
      assert.equal(configured.status, 200);
      assert.equal(configured.body.model.configured, true);
      assert(!JSON.stringify(configured).includes("fake-test-key"));
    }
    assert.equal(
      (
        await request("/api/settings", {
          provider: "unsupported",
          model: "glm-4.7",
        })
      ).status,
      400,
    );
    await service.close();
    service = await createServer({ directory });
    origin = await start();
    const state = await request("/api/canvas");
    assert.equal(state.body.model.provider, "zai-coding");
    assert.equal(state.body.model.model, "glm-4.7");
  } finally {
    await service.close();
    variants.forEach(([, env], i) => {
      if (previous[i] === undefined) delete process.env[env];
      else process.env[env] = previous[i];
    });
    rmSync(directory, { recursive: true, force: true });
  }
});

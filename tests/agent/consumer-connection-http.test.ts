import { historicalConsumers } from "./historical-consumers-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createHeatingDemo } from "../../src/demo/server.ts";
import { Workspace } from "../../src/agent/workspace.ts";

test("historical HTTP access remains scoped, pinned and revocable after legacy creation freezes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-agent-connection-"));
  const service = await createHeatingDemo(directory);
  try {
    await new Promise<void>((resolve) =>
      service.server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    const admin = async (path: string, body?: object) => {
      const response = await fetch(`${base}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "X-DataEngine-Token": service.adminToken,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      return data;
    };
    assert.equal((await fetch(`${base}/api/consumers/connection`)).status, 403);
    const config = await admin("/api/consumers/connection");
    assert.equal(config.mcp.mcpServers.dataengine.env.DATAENGINE_URL, base);
    assert.equal(
      config.mcp.mcpServers.dataengine.env.DATAENGINE_CONSUMER_KEY,
      "<本调用方 API Key>",
    );
    assert.equal(config.localOnly, true);
    assert(!JSON.stringify(config).includes(service.adminToken));

    await admin("/api/canvas/navigate", { page: "consumption" });
    const model = service.app.memory.listArtifacts("ontology").find(a => a.status === "adopted")!;
    const draft = historicalConsumers(service.app.consumption, service.app.memory, directory).propose({
      name: "历史第三方 Agent", purpose: "读取旧版本", modelId: model.id, modelVersion: model.version,
      grants: [{ type: "投诉", fields: ["$id", "处理状态"], relations: ["居民回访"] }, { type: "回访", fields: ["$id", "投诉编号", "反馈结果"], relations: [] }],
    });
    const { consumer: active, apiKey: credential } = historicalConsumers(service.app.consumption, service.app.memory, directory).activate(draft.id, draft.version);
    for (const path of ["/api/consumers/prepare", "/api/consumers/activate"]) {
      const frozen = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-dataengine-token": service.adminToken }, body: JSON.stringify({ id: active.id, version: active.version }) });
      assert.equal(frozen.status, 409);
    }
    const read = async (path: string, params: Record<string, string> = {}) => {
      const response = await fetch(
        `${base}${path}?${new URLSearchParams(params)}`,
        { headers: { Authorization: `Bearer ${credential}` } },
      );
      return { status: response.status, body: await response.json() };
    };
    const schema = await read("/v1/schema");
    assert.equal(schema.status, 200);
    assert.equal(schema.body.dataVersion, active.version);
    assert(!JSON.stringify(schema.body).includes("联系手机"));
    assert(!JSON.stringify(schema.body).includes("sourceId"));
    assert.equal(
      (
        await fetch(`${base}/api/consumers/connection`, {
          headers: { Authorization: `Bearer ${credential}` },
        })
      ).status,
      403,
    );

    const args = {
      type: "投诉",
      id: "TS002",
      relation: "居民回访",
      fields: "反馈结果",
    };
    assert.equal(
      (await read("/v1/objects", args)).body.items[0].fields.反馈结果,
      "未改善",
    );
    const source = service.app.memory
      .listArtifacts("source")
      .find((item) => item.title === "客服回访.csv")!;
    const updatedRaw = String(source.content.raw)
      .replace("未改善", "已改善")
      .replace("居民反馈过滤器清理后室内仍偏冷", "居民确认室温恢复");
    const updated = new Workspace(service.app.memory).upload(
      source.title,
      updatedRaw,
    );
    assert.equal(updated.id, source.id);
    assert.equal(
      (await read("/v1/objects", args)).body.items[0].fields.反馈结果,
      "未改善",
    );
    const preview = await admin("/api/consumers/data-preview", {
      id: active.id,
      version: active.version,
    });
    assert.equal(preview.valid, true);
    assert.equal(preview.changedSources.length, 1);
    assert.equal(preview.nextSourceVersions[source.id], updated.version);
    const frozen = await fetch(base + "/api/consumers/data-publish", { method: "POST", headers: { "content-type": "application/json", "x-dataengine-token": service.adminToken }, body: JSON.stringify({ id: active.id, version: active.version, sourceVersions: preview.nextSourceVersions }) });
    assert.equal(frozen.status, 409);
    const after = await read("/v1/objects", args);
    assert.equal(after.status, 200); assert.equal(after.body.items[0].fields.反馈结果, "未改善");
    assert.equal(after.body.dataVersion, active.version);
    const original = service.app.objectDetails(
      new URLSearchParams({
        artifactId: String(active.content.modelId),
        version: String(active.content.modelVersion),
        type: "回访",
        id: "HF002",
      }),
    );
    assert.equal(
      (original.result as { fields: Record<string, unknown> }).fields.反馈结果,
      "未改善",
    );
    assert(
      !JSON.stringify(service.app.consumption.logs()).includes(credential),
    );
    await admin("/api/consumers/revoke", {
      id: active.id,
      version: active.version,
    });
    assert.equal((await read("/v1/schema")).status, 401);
    assert.equal((await read("/v1/objects", args)).status, 401);
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

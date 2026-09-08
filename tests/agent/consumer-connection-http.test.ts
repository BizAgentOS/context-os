import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createHeatingDemo } from "../../src/demo/server.ts";
import { Workspace } from "../../src/agent/workspace.ts";

test("independent Agent connection is reviewed and its same key sees only explicitly published records", async () => {
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
    const template = service.app.consumption
      .list()
      .find((item) => item.title === "客服工作台")!;
    const draftState = await admin("/api/consumers/prepare", {
      templateId: template.id,
      templateVersion: template.version,
      name: "测试第三方 Agent",
      purpose: "使用已确认的客服读取范围",
      grants: [{ type: "投诉", fields: ["联系手机"], relations: [] }],
    });
    const draft = draftState.consumers.find(
      (item: { id: string }) => item.id === draftState.preparedConsumerId,
    );
    assert.equal(draft.status, "draft");
    assert.deepEqual(draft.content.grants, template.content.grants);
    assert.equal(draftState.pending.consumerId, draft.id);
    assert(!JSON.stringify(draftState).includes("de_consumer_"));
    const activated = await admin("/api/consumers/activate", {
      id: draft.id,
      version: draft.version,
    });
    const credential = activated.credential.apiKey;
    const active = activated.consumers.find(
      (item: { id: string }) => item.id === draft.id,
    );
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
    const published = await admin("/api/consumers/data-publish", {
      id: active.id,
      version: active.version,
      sourceVersions: preview.nextSourceVersions,
    });
    assert.deepEqual(published.consumer.content.grants, active.content.grants);
    assert.equal(
      published.consumer.content.modelVersion,
      active.content.modelVersion,
    );
    const after = await read("/v1/objects", args);
    assert.equal(after.status, 200);
    assert.equal(after.body.items[0].fields.反馈结果, "已改善");
    assert.equal(after.body.dataVersion, published.consumer.version);
    assert.equal(
      (
        await read("/v1/objects", {
          ...args,
          dataVersion: String(active.version),
        })
      ).status,
      409,
    );
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
    assert.equal(
      service.app.memory.getArtifact(template.id).version,
      template.version,
    );
    assert(
      !JSON.stringify(service.app.consumption.logs()).includes(credential),
    );
    await admin("/api/consumers/revoke", {
      id: active.id,
      version: published.consumer.version,
    });
    assert.equal((await read("/v1/schema")).status, 401);
    assert.equal((await read("/v1/objects", args)).status, 401);
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

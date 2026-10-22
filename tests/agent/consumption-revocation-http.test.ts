import { historicalConsumers } from "./historical-consumers-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import type { Artifact } from "../../src/agent/contracts.ts";

test(
  "HTTP revocation bypasses an explicit stop waiting for the model",
  { timeout: 3000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "de-revoke-http-"));
    let finishRun!: () => void;
    let finishStop!: () => void;
    let enteredStop!: () => void;
    const runFinished = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    const stopFinished = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const stopping = new Promise<void>((resolve) => {
      enteredStop = resolve;
    });
    const service = await createServer({
      directory,
      driver: {
        async run() {
          await runFinished;
          return {
            text: "",
            runId: "revocation-http-test",
            sessionId: "isolated-revocation",
          };
        },
        async stop() {
          enteredStop();
          await stopFinished;
        },
        async close() {},
      },
    });
    await new Promise<void>((resolve) =>
      service.server.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    const post = (path: string, body: Record<string, unknown>) =>
      fetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          "x-dataengine-token": service.adminToken,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    let navigation: Promise<Response> | undefined;
    let revocation: Promise<Response> | undefined;
    try {
      const workspace = new Workspace(service.app.memory);
      const source = workspace.upload("投诉.csv", "id,status\nC1,closed\n");
      const candidate = (await workspace.execute("ontology_propose", {
        title: "投诉记忆",
        purpose: "查询处理状态",
        types: [
          {
            name: "投诉",
            description: "一条投诉",
            sourceId: source.id,
            idField: "id",
            fields: { 状态: "status" },
          },
        ],
        relations: [],
        functions: [],
        evidence: [{ sourceId: source.id, version: source.version }],
      })) as unknown as Artifact;
      const preview = (await workspace.execute("ontology_preview", {
        id: candidate.id,
        version: candidate.version,
      })) as unknown as Artifact;
      const model = workspace.adopt(preview.id, preview.version);
      const draft = historicalConsumers(service.app.consumption, service.app.memory, directory).propose({
        name: "客服助手",
        purpose: "读取投诉状态",
        modelId: model.id,
        modelVersion: model.version,
        grants: [{ type: "投诉", fields: ["状态"], relations: [] }],
      });
      const active = historicalConsumers(service.app.consumption, service.app.memory, directory).activate(draft.id, draft.version);
      assert.equal(
        (await post("/api/canvas/navigate", { page: "consumption" })).status,
        200,
      );
      assert.equal(
        (
          await post("/api/canvas/message", {
            page: "consumption",
            text: "查看当前调用方",
            messageId: "review-access",
          })
        ).status,
        202,
      );

      navigation = post("/api/canvas/stop", { page: "consumption" });
      await stopping;
      revocation = post("/api/consumers/revoke", {
        id: active.consumer.id,
        version: active.consumer.version,
      });
      const result = await Promise.race([
        revocation,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("撤销等待了模型停止")),
            500,
          ).unref(),
        ),
      ]);
      assert.equal(result.status, 200);
      assert.equal((await result.json()).consumers[0].status, "revoked");
      const read = await fetch(
        `${origin}/v1/objects?${new URLSearchParams({ type: "投诉" })}`,
        {
          headers: { authorization: `Bearer ${active.apiKey}` },
        },
      );
      assert.equal(read.status, 410, "the retired route cannot regain access after historical revocation");
    } finally {
      finishRun();
      finishStop();
      await Promise.allSettled([navigation, revocation]);
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

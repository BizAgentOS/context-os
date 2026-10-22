import { historicalConsumers } from "./historical-consumers-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentApplication } from "../../src/agent/app.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import type { Artifact } from "../../src/agent/contracts.ts";
import type { AgentDriver, RunRequest } from "../../src/agent/runtime.ts";

async function modelFor(app: AgentApplication) {
  const workspace = new Workspace(app.memory);
  const source = workspace.upload(
    "投诉.csv",
    "id,status,phone\nT1,closed,13800000000\n",
  );
  const candidate = (await workspace.execute("ontology_propose", {
    title: "投诉记忆",
    purpose: "处理投诉",
    types: [
      {
        name: "投诉",
        description: "一条投诉",
        sourceId: source.id,
        idField: "id",
        fields: { 状态: "status", 联系电话: "phone" },
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
  return workspace.adopt(preview.id, preview.version);
}

test("the release assistant exposes only the current release path and refuses legacy creation tools", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-release-tools-"));
  let runs = 0;
  const driver: AgentDriver = {
    async run(request) {
      runs++;
      for (const name of ["consumer_propose", "live_consumer_propose", "consumer_view_propose", "consumer_migration_preview"]) {
        assert.equal(request.tools.some(tool => tool.name === name), false, name);
        await assert.rejects(request.onTool(name, {}), /没有这项能力/);
      }
      assert.ok(request.tools.some(tool => tool.name === "release_overview"));
      return { text: "请先发布版本，再创建接入方。", runId: "frozen", sessionId: "s" };
    }, async stop() {}, async close() {},
  };
  const app = new AgentApplication(directory, driver);
  try {
    await app.canvasNavigate({ page: "consumption" });
    await app.canvasMessage({ page: "consumption", text: "创建旧消费授权", messageId: "legacy" });
    await app.idle(); assert.equal(runs, 1);
    for (const kind of ["consumer", "live_consumer", "consumer_view"]) assert.equal(app.memory.listArtifacts(kind).length, 0);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const stopBehavior of ["throws", "hangs"] as const) {
  test(
    `revocation denies the next read even when the model stop ${stopBehavior}`,
    { timeout: 2000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "de-consumption-stop-"));
      let release!: () => void;
      let request!: RunRequest;
      const finished = new Promise<void>((resolve) => {
        release = resolve;
      });
      const driver: AgentDriver = {
        async run(current) {
          request = current;
          await finished;
          return {
            text: "已结束",
            runId: "slow-run",
            sessionId: "slow-session",
          };
        },
        async stop() {
          if (stopBehavior === "throws")
            throw new Error("provider unavailable");
          await new Promise<void>(() => {});
        },
        async close() {},
      };
      const app = new AgentApplication(dir, driver);
      try {
        const model = await modelFor(app);
        await app.canvasNavigate({ page: "consumption" });
        const proposal = {
          name: "停用验收客户端",
          purpose: "读状态",
          modelId: model.id,
          modelVersion: model.version,
          grants: [{ type: "投诉", fields: ["$id", "状态"], relations: [] }],
        };
        const draft = historicalConsumers(app.consumption, app.memory, dir).propose(proposal);
        const active = historicalConsumers(app.consumption, app.memory, dir).activate(draft.id, draft.version);
        await app.canvasMessage({
          page: "consumption",
          text: "查看当前访问情况",
          messageId: `slow-${stopBehavior}`,
        });
        const revoked = await app.revokeConsumer({
          id: active.consumer.id,
          version: active.consumer.version,
        });
        assert.equal(revoked.consumers[0].status, "revoked");
        assert.equal(
          app.consumption.handle({
            method: "GET",
            path: "/v1/objects",
            query: new URLSearchParams({ type: "投诉" }),
            authorization: `Bearer ${active.apiKey}`,
          }).status,
          401,
        );
        await assert.rejects(
          request.onTool("consumer_propose", {
            ...proposal,
            name: "迟到的修改",
          }),
          /已暂停|失效|结束|变化|运行/,
        );
      } finally {
        release();
        await app.idle();
        await app.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}

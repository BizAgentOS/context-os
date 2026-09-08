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

test("the fourth canvas proposes a visible grant but only the host can enable it and disclose a credential", async () => {
  const dir = mkdtempSync(join(tmpdir(), "de-consumption-canvas-"));
  let model: Artifact;
  let draft: Artifact;
  const requests: RunRequest[] = [];
  const driver: AgentDriver = {
    async run(request) {
      requests.push(request);
      const input = JSON.parse(request.input);
      assert.equal(input.page, "consumption");
      assert.equal(request.sessionId, undefined);
      assert(
        !request.tools.some((tool) =>
          [
            "consumer_activate",
            "consumer_revoke",
            "profile_update",
            "ontology_propose",
            "report_save",
            "page_complete",
          ].includes(tool.name),
        ),
      );
      await assert.rejects(
        request.onTool("consumer_activate", {}),
        /没有这项能力/,
      );
      draft = (await request.onTool("consumer_propose", {
        name: "客服助手",
        purpose: "查询处理状态",
        modelId: model.id,
        modelVersion: model.version,
        grants: [{ type: "投诉", fields: ["$id", "状态"], relations: [] }],
      })) as unknown as Artifact;
      await request.onTool("task_ask", {
        question: "只允许读取投诉编号与状态，启用吗？",
        reason: "确认具体范围",
        consumerId: draft.id,
        version: draft.version,
      });
      return {
        text: "访问范围已列在画布中，请查看后启用。",
        runId: "consumption-proposal",
        sessionId: "bounded-consumption",
      };
    },
    async stop() {},
    async close() {},
  };
  let app = new AgentApplication(dir, driver);
  try {
    assert.equal(
      app.canvasState().pages.find((page) => page.id === "consumption")
        ?.available,
      true,
    );
    assert.equal(
      app.canvasState().pages.find((page) => page.id === "consumption")?.ready,
      false,
    );
    model = await modelFor(app);
    // Upgrade a previously saved three-page space without replacing its memory or chats.
    const reached = app.canvasState();
    assert.equal(
      reached.pages.find((page) => page.id === "consumption")?.available,
      true,
    );
    await app.canvasNavigate({ page: "consumption" });
    await app.canvasMessage({
      page: "consumption",
      text: "让客服助手查询投诉编号和状态，不给联系电话。",
      messageId: "consumer-intent",
    });
    await app.idle();
    const pending = app.canvasState();
    assert.equal(pending.consumers[0].status, "draft");
    assert.equal(pending.pending?.consumerId, draft!.id);
    assert(!JSON.stringify(pending).includes("de_consumer_"));
    await assert.rejects(
      app.activateConsumer({ id: draft!.id, version: draft!.version + 1 }),
      /版本|待确认/,
    );
    const enabled = await app.activateConsumer({
      id: draft!.id,
      version: draft!.version,
    });
    assert.match(enabled.credential.apiKey, /^de_consumer_/);
    assert.equal(enabled.consumers[0].status, "active");
    assert.equal(enabled.pending, null);
    assert(
      !JSON.stringify(app.canvasState()).includes(enabled.credential.apiKey),
    );
    assert(!JSON.stringify(requests).includes(enabled.credential.apiKey));
    await app.revokeConsumer({
      id: enabled.consumers[0].id,
      version: enabled.consumers[0].version,
    });
    assert.equal(app.canvasState().consumers[0].status, "revoked");
    assert.equal(app.memory.listTasks().length, 1);
    await app.close();
    app = new AgentApplication(dir, driver);
    assert.equal(app.canvasState().page, "consumption");
    assert.equal(app.canvasState().consumers[0].status, "revoked");
    assert.equal(requests.length, 1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
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
        const draft = app.consumption.propose(proposal);
        const active = app.consumption.activate(draft.id, draft.version);
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

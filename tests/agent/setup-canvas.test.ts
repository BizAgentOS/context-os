import { historicalConsumers } from "./historical-consumers-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import { seedHeatingDemo } from "../../src/demo/heating-seed.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";

test("one setup page saves company facts, reads a source and stays open after completion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-setup-"));
  let runs = 0;
  const driver: AgentDriver = {
    async run(request) {
      runs++;
      const input = JSON.parse(request.input);
      assert(!request.tools.some((t) => t.name === "live_consumer_propose"));
      if (runs === 1) {
        assert.equal(input.page, "setup");
        assert(request.tools.some((t) => t.name === "live_read"));
        const message = input.recentMessages.at(-1);
        await request.onTool("profile_update", {
          statements: [
            {
              key: "company.name",
              text: "澄川热力",
              origin: "user",
              messageId: message.id,
              quote: "澄川热力",
            },
            {
              key: "company.business",
              text: "居民供热",
              origin: "user",
              messageId: message.id,
              quote: "居民供热",
            },
          ],
        });
        await assert.rejects(request.onTool("page_complete", {}), /来源|资料/);
        return {
          text: "企业信息已保存，可以继续接入资料。",
          sessionId: "one",
          runId: "one",
        };
      }
      assert.equal(input.mode, "automatic-document-ontology");
      const part = await request.onTool("foundation_document_read", { sourceId: input.sources[0].id }) as any;
      await request.onTool("foundation_propose", {
        baseVersion: ((await request.onTool("foundation_read", {})) as any).current.version, enterprise: {name: "澄川热力", evidenceRefs: ["doc"]},
        concepts: [{id: "resident", name: "居民", description: "供热客户", evidenceRefs: ["doc"]}], relations: [],
        evidence: [{id: "doc", kind: "document", readId: part.readId, quote: part.text}], unknowns: [], conflicts: []
      });
      return {
        text: "已检查资料，可以查看本体。",
        sessionId: "two",
        runId: "two",
      };
    },
    async stop() {},
    async close() {},
  };
  const service = await createServer({ directory, driver });
  try {
    await new Promise<void>((resolve) =>
      service.server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    const headers = {
      "x-dataengine-token": service.adminToken,
      "content-type": "application/json",
    };
    const read = async () =>
      (await fetch(`${base}/api/canvas`, { headers })).json();
    const post = async (path: string, body: unknown) => {
      const response = await fetch(base + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      assert(response.ok, await response.clone().text());
      return response.json();
    };
    const initial = await read();
    assert.equal(initial.currentPage, "setup");
    assert.deepEqual(
      initial.pages.map((p: { id: string }) => p.id),
      ["setup", "ontology", "consumption"],
    );
    assert.equal(initial.layoutVersion, 2);
    await post("/api/canvas/message", {
      page: "company",
      text: "澄川热力主营居民供热",
      messageId: "company-first",
    });
    await service.app.idle();
    assert.equal((await read()).currentPage, "setup");
    const navigation = await post("/api/canvas/navigate", { page: "sources" });
    assert.equal(navigation.currentPage, "setup");
    assert.equal(navigation.setupSection, "sources");
    seedFoundation(service.app.memory, service.app.foundation, {
      enterprise: "澄川热力",
      concepts: [
        { id: "resident", name: "居民", description: "来自居民表的记录，业务含义待核对。" },
      ],
    });
    await post("/api/canvas/upload", {
      page: "setup",
      name: "业务.md",
      content: "澄川热力为居民提供供热服务。",
    });
    await service.app.idle();
    const final = await read();
    assert.equal(final.currentPage, "setup");
    assert.equal(final.sources.length, 1);
    assert.equal(final.foundation.current.status, "adopted");
    assert.deepEqual(final.foundation.current.content.concepts.map((item: any) => [item.id, item.origin]), [["resident", "program"]]);
    assert.equal(final.automaticBuild.status, "completed");
    assert.equal(
      final.messages.filter((m: { role: string }) => m.role === "user").length,
      2,
    );
    assert.equal(runs, 2);
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy pages migrate once without replaying work or rewriting history and artifacts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-migration-"));
  let continuation = false;
  let resumed = false;
  const driver: AgentDriver = {
    async run(request) {
      assert(continuation, "migration must not run the model");
      const input = JSON.parse(request.input);
      assert.equal(input.page, "setup");
      assert(
        input.priorSections.some(
          (section: { recentMessages: { id: string }[] }) =>
            section.recentMessages.some(
              (message) => message.id === "old-company-message",
            ),
        ),
      );
      const history = (await request.onTool("canvas_history_read", {
        section: "company",
      })) as { messages: { id: string; content: string }[] };
      assert.equal(history.messages[0].id, "old-company-message");
      assert.equal(history.messages[0].content, "旧企业信息");
      await assert.rejects(
        request.onTool("canvas_history_read", {
          section: "company",
          offset: -1,
        }),
        /分页/,
      );
      resumed = true;
      return {
        text: "旧信息已找到，请确认具体修改。",
        sessionId: "resumed",
        runId: "resumed",
      };
    },
    async stop() {},
    async close() {},
  };
  let service = await createServer({ directory, driver });
  try {
    seedHeatingDemo(service.app);
    const memory = service.app.memory;
    const originalCanvas = memory.getCanvas()!;
    const model = memory
      .listArtifacts("ontology")
      .find((item) => item.status === "adopted")!;
    const grant = historicalConsumers(service.app.consumption, service.app.memory, directory).propose({
      name: "迁移验收",
      purpose: "验证旧凭据",
      modelId: model.id,
      modelVersion: model.version,
      grants: [{ type: "投诉", fields: ["$id", "处理状态"], relations: [] }],
    });
    const credential = historicalConsumers(service.app.consumption, service.app.memory, directory).activate(
      grant.id,
      grant.version,
    ).apiKey;
    const company = memory.createTask("旧企业页");
    const sources = memory.createTask("旧来源页");
    memory.addMessage(company.id, "user", "旧企业信息", "old-company-message");
    memory.addMessage(sources.id, "assistant", "请确认资料范围");
    const pendingContext = memory.beginExecution(sources.id);
    memory.ask(pendingContext, {
      question: "请确认资料范围",
      reason: "旧页面未决事项",
    });
    memory.endExecution(pendingContext);
    memory.attachArtifact(company.id, memory.listArtifacts("profile")[0]);
    const beforeTasks = memory.listTasks();
    memory.saveCanvas({
      currentPage: "sources",
      reached: ["company", "sources"],
      completed: ["company"],
      taskIds: {
        company: company.id,
        sources: sources.id,
        ontology: originalCanvas.taskIds.ontology,
        consumption: originalCanvas.taskIds.consumption,
      },
    });
    const beforeArtifacts = memory.listArtifacts();
    const oldVersions = beforeArtifacts.flatMap((item) =>
      Array.from({ length: item.version }, (_, i) =>
        memory.getArtifact(item.id, i + 1),
      ),
    );
    await service.close();
    service = await createServer({ directory, driver });
    await new Promise<void>((resolve) =>
      service.server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    const headers = {
      "x-dataengine-token": service.adminToken,
      "content-type": "application/json",
    };
    const read = async (path: string) =>
      (await fetch(base + path, { headers })).json();
    const state = await read("/api/canvas");
    assert.equal(state.currentPage, "setup");
    assert.equal(state.setupSection, "sources");
    assert.equal(state.pages[0].ready, false);
    assert.equal(state.legacyHistory.length, 2);
    assert.equal(
      state.legacyHistory.find(
        (item: { section: string }) => item.section === "sources",
      ).pending.question,
      "请确认资料范围",
    );
    const history = await read("/api/canvas/history?section=company");
    assert.equal(history.messages[0].content, "旧企业信息");
    assert.equal(
      (await fetch(base + "/api/canvas/history?section=company")).status,
      403,
    );
    assert.deepEqual(service.app.memory.listTasks(), beforeTasks);
    assert.deepEqual(service.app.memory.listArtifacts(), beforeArtifacts);
    for (const version of oldVersions)
      assert.deepEqual(
        service.app.memory.getArtifact(version.id, version.version),
        version,
      );
    const consumerHeaders = { authorization: `Bearer ${credential}` };
    const allowed = await fetch(
      base + "/v1/objects?type=" + encodeURIComponent("投诉"),
      { headers: consumerHeaders },
    );
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).items.length, 6);
    assert.equal(
      (
        await fetch(
          base +
            "/v1/objects?type=" +
            encodeURIComponent("投诉") +
            "&fields=" +
            encodeURIComponent("联系手机"),
          { headers: consumerHeaders },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/api/canvas/history?section=company", {
          headers: consumerHeaders,
        })
      ).status,
      403,
    );
    const saved = service.app.memory.getCanvas();
    assert.equal(saved?.layoutVersion, 2);
    await read("/api/canvas");
    assert.deepEqual(service.app.memory.getCanvas(), saved);
    const retry = await fetch(base + "/api/canvas/message", {
      method: "POST",
      headers,
      body: JSON.stringify({
        page: "company",
        text: "旧企业信息",
        messageId: "old-company-message",
      }),
    });
    assert.equal(retry.status, 202);
    assert.deepEqual(service.app.memory.listTasks(), beforeTasks);
    continuation = true;
    await service.app.canvasMessage({
      page: "setup",
      text: "继续核对旧企业信息",
    });
    await service.app.idle();
    assert(resumed);
    for (const task of beforeTasks)
      assert.deepEqual(service.app.memory.getTask(task.id), task);
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reopening a legacy in-flight task invalidates its write identity before migration", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "dataengine-interrupted-migration-"),
  );
  const driver: AgentDriver = {
    async run() {
      throw new Error("must not resume");
    },
    async stop() {},
    async close() {},
  };
  let service = await createServer({ directory, driver });
  try {
    const task = service.app.memory.createTask("旧页面运行");
    service.app.memory.saveCanvas({
      currentPage: "company",
      completed: [],
      reached: ["company"],
      taskIds: { company: task.id },
    });
    const context = service.app.memory.beginExecution(task.id);
    await service.close();
    service = await createServer({ directory, driver });
    assert.equal(service.app.canvasState().currentPage, "setup");
    assert.equal(service.app.canvasState().busy, false);
    assert.equal(service.app.memory.getTask(task.id).status, "paused");
    assert.throws(() => service.app.memory.assertWritable(context));
    assert.deepEqual(service.app.memory.listArtifacts(), []);
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

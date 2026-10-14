import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import type { AgentDriver, RunRequest } from "../../src/agent/runtime.ts";
import { createServer } from "../../src/agent/server.ts";
import { AgentApplication } from "../../src/agent/app.ts";
import type { Artifact } from "../../src/agent/contracts.ts";

test("a failed message save can be retried with the same id and then really executes", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "dataengine-canvas-write-failure-"),
  );
  let runs = 0;
  const driver: AgentDriver = {
    async run(request) {
      runs++;
      await request.onTool("task_ask", {
        question: "企业主要做什么？",
        reason: "了解业务",
      });
      return { text: "企业主要做什么？", sessionId: "retry", runId: "retry" };
    },
    async stop() {},
    async close() {},
  };
  const service = await createServer({ directory, driver });
  // The storage fixture rejects the actual message insert after the receipt write.
  // Assertions stay on the public HTTP seam: failure, retry, visible message, execution.
  const fault = new DatabaseSync(join(directory, "memory.sqlite"));
  fault.exec(`CREATE TRIGGER reject_message_once BEFORE INSERT ON messages
    WHEN NEW.id='retry-after-save-failure' BEGIN SELECT RAISE(ABORT, 'simulated message storage failure'); END;`);
  try {
    await new Promise<void>((resolve) =>
      service.server.listen(0, "127.0.0.1", resolve),
    );
    const url = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    const bootstrap = await (
      await fetch(`${url}/api/canvas/bootstrap`, {
        headers: { "x-dataengine-token": service.adminToken },
      })
    ).json();
    const request = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dataengine-token": bootstrap.token,
      },
      body: JSON.stringify({
        page: "company",
        text: "澄川热力",
        messageId: "retry-after-save-failure",
      }),
    };
    const failed = await fetch(`${url}/api/canvas/message`, request);
    assert.equal(failed.status, 400);
    assert.equal(runs, 0);
    const beforeRetry = await (
      await fetch(`${url}/api/canvas`, {
        headers: { "x-dataengine-token": service.adminToken },
      })
    ).json();
    assert.equal(beforeRetry.messages.length, 0);
    fault.exec("DROP TRIGGER reject_message_once");
    const retried = await fetch(`${url}/api/canvas/message`, request);
    assert.equal(retried.status, 202);
    await service.app.idle();
    const afterRetry = await (
      await fetch(`${url}/api/canvas`, {
        headers: { "x-dataengine-token": service.adminToken },
      })
    ).json();
    assert.equal(runs, 1);
    assert.equal(
      afterRetry.messages.filter(
        (message: { role: string }) => message.role === "user",
      ).length,
      1,
    );
    assert.equal(afterRetry.messages[0].content, "澄川热力");
    await fetch(`${url}/api/canvas/message`, request);
    await service.app.idle();
    assert.equal(runs, 1);
  } finally {
    fault.close();
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the canvas saves real company facts and remains on setup after the run settles", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-canvas-"));
  let finish!: () => void;
  let saved!: () => void;
  const savedPromise = new Promise<void>((resolve) => {
    saved = resolve;
  });
  const finishPromise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const requests: RunRequest[] = [];
  const driver: AgentDriver = {
    async run(request) {
      requests.push(request);
      assert(
        !request.tools.some((tool) =>
          ["report_save", "task_complete", "ontology_propose"].includes(
            tool.name,
          ),
        ),
      );
      await assert.rejects(
        request.onTool("page_complete", {}),
        /企业名称.*业务/,
      );
      const input = JSON.parse(request.input);
      const user = input.recentMessages.at(-1);
      await request.onTool("profile_update", {
        statements: [
          {
            key: "company.name",
            text: "澄川热力",
            origin: "user",
            messageId: user.id,
            quote: "澄川热力",
          },
          {
            key: "company.business",
            text: "居民供热",
            origin: "user",
            messageId: user.id,
            quote: "居民供热",
          },
        ],
      });
      await assert.rejects(request.onTool("page_complete", {}), /来源|资料/);
      saved();
      await finishPromise;
      return {
        text: "企业已建立，接下来添加资料。",
        sessionId: "canvas-one",
        runId: "canvas-run",
      };
    },
    async stop() {
      finish();
    },
    async close() {},
  };
  let service = await createServer({ directory, driver });
  const start = async () => {
    await new Promise<void>((resolve) =>
      service.server.listen(0, "127.0.0.1", resolve),
    );
    return `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  };
  try {
    let url = await start();
    const initialResponse = await fetch(`${url}/api/canvas/bootstrap`, {
      headers: { "x-dataengine-token": service.adminToken },
    });
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json();
    assert.equal(initial.currentPage, "setup");
    assert.equal(initial.profile, null);
    assert.equal(requests.length, 0);
    assert(!("tasks" in initial) && !("events" in initial));
    const headers = {
      "content-type": "application/json",
      "x-dataengine-token": initial.token,
    };
    const visited = await fetch(`${url}/api/canvas/navigate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ page: "ontology" }),
    });
    assert.equal(visited.status, 200);
    assert.equal(requests.length, 0);
    await fetch(`${url}/api/canvas/navigate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ page: "company" }),
    });
    await fetch(`${url}/api/canvas/message`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        page: "company",
        text: "公司叫澄川热力，主营居民供热。",
        messageId: "company-one",
      }),
    });
    await savedPromise;
    const during = await (
      await fetch(`${url}/api/canvas`, {
        headers: { "x-dataengine-token": service.adminToken },
      })
    ).json();
    assert.equal(during.currentPage, "setup");
    assert.match(JSON.stringify(during.profile), /澄川热力/);
    const section = await service.app.canvasNavigate({
      page: "setup",
      section: "sources",
    });
    assert.equal(
      section.busy,
      true,
      "same-page navigation must not stop the active run",
    );
    finish();
    await service.app.idle();
    const after = await (
      await fetch(`${url}/api/canvas`, {
        headers: { "x-dataengine-token": service.adminToken },
      })
    ).json();
    assert.equal(after.currentPage, "setup");
    assert.equal(after.page, "setup");
    assert.equal(after.messages.length, 2);
    assert.match(after.prompt, /接入/);
    assert.equal(
      after.pages.find((page: { id: string }) => page.id === "setup").ready,
      false,
    );
    assert.equal(service.app.memory.listTasks().length, 1);
    await service.close();
    service = await createServer({ directory, driver });
    url = await start();
    const reopened = await (
      await fetch(`${url}/api/canvas/bootstrap`, {
        headers: { "x-dataengine-token": service.adminToken },
      })
    ).json();
    assert.equal(reopened.currentPage, "setup");
    assert.match(JSON.stringify(reopened.profile), /居民供热/);
    assert.equal(requests.length, 1);
  } finally {
    finish();
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("each page has bounded chat and a fresh model context while saved enterprise memory survives trimming", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-canvas-context-"));
  const requests: RunRequest[] = [];
  const driver: AgentDriver = {
    async run(request) {
      requests.push(request);
      request.onSession(`session-${requests.length}`);
      const input = JSON.parse(request.input);
      if (requests.length === 1) {
        const user = input.recentMessages.at(-1);
        await request.onTool("profile_update", {
          statements: [
            {
              key: "company.name",
              text: "澄川热力",
              origin: "user",
              messageId: user.id,
              quote: "澄川热力",
            },
          ],
        });
      }
      await request.onTool("task_ask", {
        question: "主要提供什么服务？",
        reason: "还需要了解企业业务",
      });
      return {
        text: "主要提供什么服务？",
        sessionId: `session-${requests.length}`,
        runId: `run-${requests.length}`,
      };
    },
    async stop() {},
    async close() {},
  };
  let app = new AgentApplication(directory, driver);
  try {
    await app.canvasMessage({
      page: "company",
      text: "澄川热力",
      messageId: "first-user-fact",
    });
    await app.idle();
    for (let index = 0; index < 18; index++) {
      await app.canvasMessage({
        page: "company",
        text: `补充 ${index}：${"内容".repeat(500)}`,
        messageId: `followup-${index}`,
      });
      await app.idle();
    }
    const canvas = app.canvasState();
    assert(canvas.messages.length <= 12);
    assert(
      canvas.messages.reduce(
        (sum, message) => sum + message.content.length,
        0,
      ) <= 12000,
    );
    assert(
      !canvas.messages.some((message) => message.id === "first-user-fact"),
    );
    assert.equal(app.memory.getMessage("first-user-fact"), null);
    assert.equal(app.memory.listTasks().length, 1);
    const latestInput = JSON.parse(requests.at(-1)!.input);
    assert(latestInput.recentMessages.length <= 12);
    assert(
      !latestInput.recentMessages.some(
        (message: { id: string }) => message.id === "first-user-fact",
      ),
    );
    assert(requests.every((request) => request.sessionId === undefined));
    assert.match(JSON.stringify(canvas.profile), /澄川热力/);
    assert.match(JSON.stringify(canvas.profile), /first-user-fact/);
    // Network retries stay idempotent even after the old raw message is discarded.
    await app.canvasMessage({
      page: "company",
      text: "澄川热力",
      messageId: "first-user-fact",
    });
    await app.idle();
    assert.equal(requests.length, 19);
    await app.close();
    app = new AgentApplication(directory, driver);
    assert.match(JSON.stringify(app.canvasState().profile), /澄川热力/);
    assert.equal(app.canvasState().messages.length, canvas.messages.length);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sources require inspected records, and ontology adoption remains bound to the displayed candidate version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-canvas-stages-"));
  let candidate: Artifact;
  const driver: AgentDriver = {
    async run(request) {
      const input = JSON.parse(request.input);
      assert(
        !request.tools.some((tool) =>
          ["report_save", "task_complete"].includes(tool.name),
        ),
      );
      if (input.page === "setup" && !input.focus) {
        const user = input.recentMessages.at(-1);
        await request.onTool("profile_update", {
          statements: [
            {
              key: "company.name",
              text: "澄川热力",
              origin: "user",
              messageId: user.id,
              quote: "澄川热力",
            },
            {
              key: "company.business",
              text: "居民供热",
              origin: "user",
              messageId: user.id,
              quote: "居民供热",
            },
          ],
        });
        await assert.rejects(request.onTool("page_complete", {}), /来源|资料/);
      } else if (input.page === "setup") {
        assert(
          input.recentMessages.some((message: { content: string }) =>
            message.content.includes("公司叫"),
          ),
        );
        await assert.rejects(
          request.onTool("page_complete", {}),
          /读取.*来源|资料/,
        );
        const source = (await request.onTool("memory_read", {
          id: input.focus.id,
        })) as unknown as Artifact;
        if (
          source.content.format === "csv" &&
          Array.isArray(source.content.rows) &&
          source.content.rows.length
        )
          await request.onTool("page_complete", {});
        else
          await request.onTool("task_ask", {
            question: "请再上传一份有业务记录的 CSV。",
            reason: "需要实际记录来创建对象",
          });
      } else {
        const source = input.enterprise.sources.find(
          (item: { title: string }) => item.title === "tickets.csv",
        );
        await request.onTool("memory_read", { id: source.id });
        const proposed = (await request.onTool("ontology_propose", {
          title: "投诉模型",
          purpose: "记录投诉状态",
          types: [
            {
              name: "Ticket",
              description: "一条投诉",
              sourceId: source.id,
              idField: "id",
              fields: { status: "status" },
            },
          ],
          relations: [],
          functions: [],
          evidence: [{ sourceId: source.id, version: source.version }],
        })) as unknown as Artifact;
        candidate = (await request.onTool("ontology_preview", {
          id: proposed.id,
          version: proposed.version,
        })) as unknown as Artifact;
        await request.onTool("task_ask", {
          question: "是否采用这版投诉定义？",
          reason: "请确认业务含义",
          candidateId: candidate.id,
          version: candidate.version,
        });
      }
      return {
        text: "已保存本页内容。",
        sessionId: "stages",
        runId: "stages-run",
      };
    },
    async stop() {},
    async close() {},
  };
  const app = new AgentApplication(directory, driver, new Set(), false);
  try {
    await app.canvasMessage({
      page: "company",
      text: "公司叫澄川热力，业务是居民供热。",
    });
    await app.idle();
    await app.canvasUpload({
      page: "sources",
      name: "说明.md",
      content: "这是居民供热企业的投诉记录。",
    });
    await app.idle();
    assert.equal(app.canvasState().currentPage, "setup");
    await app.canvasUpload({
      page: "sources",
      name: "empty.csv",
      content: "id,status\n",
    });
    await app.idle();
    assert.equal(app.canvasState().currentPage, "setup");
    await app.canvasUpload({
      page: "sources",
      name: "tickets.csv",
      content: "id,status\nT1,closed\n",
    });
    await app.idle();
    assert.equal(app.canvasState().currentPage, "setup");
    await app.canvasNavigate({ page: "ontology" });
    assert.equal(app.canvasState().messages.length, 0);
    await app.canvasMessage({ page: "ontology", text: "建立投诉对象。" });
    await app.idle();
    assert.equal(app.canvasState().pending?.candidateId, candidate!.id);
    await assert.rejects(
      app.canvasMessage({
        page: "ontology",
        text: "采用这版",
        focusId: candidate!.id,
        focusVersion: candidate!.version - 1,
      }),
      /待决定/,
    );
    assert.equal(app.memory.getArtifact(candidate!.id).status, "candidate");
    await app.canvasDecision({
      page: "ontology",
      candidateId: candidate!.id,
      version: candidate!.version,
      decision: "adopt",
    });
    assert.equal(app.canvasState().ontologies[0].status, "adopted");
    assert.equal(app.canvasState().pending, null);
    assert.equal(app.canvasState().pages[1].ready, true);
    assert.equal(app.memory.listTasks().length, 2);
    await app.canvasNavigate({ page: "company" });
    assert.match(JSON.stringify(app.canvasState().profile), /居民供热/);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explicit cancellation after navigation invalidates pending writes, and failed completion cannot advance the canvas", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-canvas-stop-"));
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let mode: "company" | "late" | "failed" = "company";
  let lateRejected = false;
  const driver: AgentDriver = {
    async run(request) {
      const input = JSON.parse(request.input);
      if (mode === "company") {
        const user = input.recentMessages.at(-1);
        await request.onTool("profile_update", {
          statements: [
            {
              key: "company.name",
              text: "澄川热力",
              origin: "user",
              messageId: user.id,
              quote: "澄川热力",
            },
            {
              key: "company.business",
              text: "居民供热",
              origin: "user",
              messageId: user.id,
              quote: "居民供热",
            },
          ],
        });
        await assert.rejects(request.onTool("page_complete", {}), /来源|资料/);
      } else if (mode === "late") {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        try {
          await request.onTool("profile_update", {
            statements: [
              {
                key: "company.goal",
                text: "不应保存的迟到内容",
                origin: "suggestion",
              },
            ],
          });
        } catch {
          lateRejected = true;
        }
      } else {
        const source = input.sources[0];
        await request.onTool("foundation_document_read", { sourceId: source.id });
        return {
          text: "已完成",
          error: "provider interrupted",
          sessionId: "failed",
          runId: "failed",
        };
      }
      return { text: "已保存", sessionId: "stop", runId: "stop" };
    },
    async stop() {
      release?.();
    },
    async close() {},
  };
  const app = new AgentApplication(directory, driver);
  try {
    await app.canvasMessage({ page: "company", text: "澄川热力，居民供热" });
    await app.idle();
    mode = "late";
    await app.canvasMessage({ page: "sources", text: "查看已有资料" });
    await enteredPromise;
    await app.canvasNavigate({ page: "company" });
    assert.equal(app.canvasState().busy, true);
    await app.canvasStop({ page: "company" });
    assert.equal(lateRejected, true);
    assert.equal(app.canvasState().currentPage, "setup");
    assert.doesNotMatch(JSON.stringify(app.canvasState().profile), /迟到内容/);
    await app.canvasNavigate({ page: "sources" });
    assert.equal(
      app
        .canvasState()
        .messages.some(
          (message) =>
            message.role === "assistant" && message.content === "已完成",
        ),
      false,
    );
    mode = "failed";
    await app.canvasUpload({
      page: "sources",
      name: "company.md",
      content: "企业主营供热服务。",
    });
    await app.idle();
    assert.equal(app.canvasState().currentPage, "setup");
    assert.equal(app.canvasState().pages[2].available, true);
    assert.equal(app.canvasState().pages[1].ready, false);
    assert.equal(app.canvasState().sources.length, 1);
    assert.equal(app.canvasState().automaticBuild.status, "failed");
    assert.match(app.canvasState().automaticBuild.errors[0].message, /provider interrupted/);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

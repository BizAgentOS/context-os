import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { AgentDriver, RunRequest } from "../../src/agent/runtime.ts";
import type { Artifact } from "../../src/agent/contracts.ts";
import { createServer } from "../../src/agent/server.ts";
import { AgentApplication } from "../../src/agent/app.ts";
import { Workspace } from "../../src/agent/workspace.ts";

test("separate A to B to A writes stay distinct while consecutive retries return the saved result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-retry-"));
  const saved: Artifact[] = [];
  const driver: AgentDriver = {
    async run(request) {
      for (const text of ["居民供热", "工业供热", "居民供热", "居民供热"])
        saved.push(
          (await request.onTool("profile_update", {
            statements: [{ key: "business", text, origin: "suggestion" }],
          })) as unknown as Artifact,
        );
      return {
        text: "已保存居民供热",
        sessionId: "retry-session",
        runId: "retry-run",
      };
    },
    async stop() {},
    async close() {},
  };
  const app = new AgentApplication(directory, driver);
  try {
    await app.message({ text: "修改企业理解" });
    await app.idle();
    assert.deepEqual(
      saved.map((a) => a.version),
      [1, 2, 3, 3],
    );
    assert.match(
      JSON.stringify(app.memory.getArtifact(saved[0].id)),
      /居民供热/,
    );
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an explicit chat adoption uses the waiting version; stale adoption keeps the pending decision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-adoption-"));
  let candidate: Artifact;
  let asking = true;
  const driver: AgentDriver = {
    async run(request) {
      if (asking)
        await request.onTool("task_ask", {
          question: "是否采用这版投诉模型？",
          reason: "已完成预览",
          candidateId: candidate.id,
          version: candidate.version,
        });
      return {
        text: "等待你的决定",
        sessionId: "adoption-session",
        runId: "adoption-run",
      };
    },
    async stop() {},
    async close() {},
  };
  const app = new AgentApplication(directory, driver);
  try {
    const workspace = new Workspace(app.memory);
    const source = workspace.upload("tickets.csv", "id,status\nT1,closed\n");
    const propose = () =>
      workspace.execute("ontology_propose", {
        title: "投诉模型",
        purpose: "区分办结与恢复",
        types: [
          {
            name: "Ticket",
            description: "投诉",
            sourceId: source.id,
            idField: "id",
            fields: { status: "status" },
          },
        ],
        relations: [],
        functions: [],
        evidence: [
          {
            sourceId: source.id,
            version: app.memory.getArtifact(source.id).version,
          },
        ],
      }) as unknown as Artifact;
    let draft = propose();
    candidate = workspace.execute("ontology_preview", {
      id: draft.id,
      version: draft.version,
    }) as unknown as Artifact;
    const first = await app.message({ text: "检查模型" });
    await app.idle();
    asking = false;
    await assert.rejects(
      app.message({
        taskId: first.task.id,
        text: "采用这版",
        focusId: draft.id,
        focusVersion: draft.version,
      }),
      /当前引用.*待决定/,
    );
    assert.equal(app.state().task?.status, "waiting");
    assert.equal(app.memory.getArtifact(candidate.id).status, "candidate");
    await app.message({
      taskId: first.task.id,
      text: "采用这版",
      messageId: "adopt-once",
    });
    await app.idle();
    const adopted = app.memory.getArtifact(candidate.id);
    assert.equal(adopted.status, "adopted");
    await app.message({
      taskId: first.task.id,
      text: "采用这版",
      messageId: "adopt-once",
    });
    await app.idle();
    assert.equal(app.memory.getArtifact(candidate.id).version, adopted.version);
    workspace.upload("tickets.csv", "id,status\nT1,open\nT2,closed\n");
    const objects = app.objectDetails(
      new URLSearchParams({
        artifactId: adopted.id,
        version: String(adopted.version),
        type: "Ticket",
      }),
    );
    assert.equal((objects.result as { total: number }).total, 1);
    assert.match(JSON.stringify(objects.result), /closed/);
    draft = propose();
    candidate = workspace.execute("ontology_preview", {
      id: draft.id,
      version: draft.version,
    }) as unknown as Artifact;
    asking = true;
    await app.message({ taskId: first.task.id, text: "检查另一个候选" });
    await app.idle();
    workspace.upload("tickets.csv", "id,status\nT1,open\nT2,open\n");
    await assert.rejects(
      app.decision({
        taskId: first.task.id,
        candidateId: candidate.id,
        version: candidate.version,
        decision: "adopt",
      }),
      /来源版本已变化/,
    );
    assert.equal(app.state().task?.status, "waiting");
    assert.equal(app.state().task?.pending?.candidateId, candidate.id);
    assert.equal(app.memory.getArtifact(adopted.id).status, "adopted");
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid focus does not strand a running task; historical focus and stale user edits keep exact versions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-focus-"));
  let input = "";
  const driver: AgentDriver = {
    async run(request) {
      input = request.input;
      return { text: "已查看", sessionId: "focus-session", runId: "focus-run" };
    },
    async stop() {},
    async close() {},
  };
  const app = new AgentApplication(directory, driver);
  try {
    await assert.rejects(
      app.message({ text: "看这份资料", focusId: "missing" }),
      /成果不存在/,
    );
    assert.equal(app.state().busy, false);
    const first = app.memory.putArtifact({
      kind: "source",
      title: "说明.txt",
      status: "ready",
      content: { format: "text", raw: "旧说明", columns: [], rows: [] },
    });
    app.memory.putArtifact({
      id: first.id,
      expectedVersion: 1,
      kind: first.kind,
      title: first.title,
      status: "ready",
      content: { ...first.content, raw: "新说明" },
    });
    await app.message({
      text: "解释我打开的历史资料",
      focusId: first.id,
      focusVersion: 1,
    });
    await app.idle();
    assert.equal(JSON.parse(input).focus.version, 1);
    const initial = app.memory.putArtifact({
      kind: "profile",
      title: "企业理解",
      status: "draft",
      content: {
        statements: [{ key: "scope", text: "居民供热", origin: "suggestion" }],
        conflicts: [],
      },
    });
    await app.editProfile({
      id: initial.id,
      expectedVersion: 1,
      key: "scope",
      text: "居民与园区供热",
    });
    await assert.rejects(
      app.editProfile({
        id: initial.id,
        expectedVersion: 1,
        key: "scope",
        text: "过期修改",
      }),
      /版本已变化/,
    );
    assert.match(
      JSON.stringify(app.memory.getArtifact(initial.id)),
      /居民与园区供热/,
    );
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stopping invalidates a late model write and task waiting freezes subsequent tools", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-stop-"));
  let release: () => void = () => {};
  let started: () => void = () => {};
  let writesBlocked = 0;
  let mode = "stop";
  const hasStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const driver: AgentDriver = {
    async run(request) {
      if (mode === "stop") {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      } else
        await request.onTool("task_ask", {
          question: "请补充企业服务范围",
          reason: "目前资料不足",
        });
      await assert.rejects(
        request.onTool("profile_update", {
          statements: [{ key: "late", text: "不应保存", origin: "suggestion" }],
        }),
        /已失效|等待用户/,
      );
      writesBlocked++;
      return { text: "已暂停", sessionId: "stop-session", runId: "stop-run" };
    },
    async stop() {
      release();
    },
    async close() {},
  };
  const app = new AgentApplication(directory, driver);
  try {
    const first = await app.message({ text: "开始" });
    await hasStarted;
    await app.stop(first.task.id);
    assert.equal(app.state().task?.status, "paused");
    assert.equal(app.state().artifacts.length, 0);
    mode = "ask";
    await app.message({ taskId: first.task.id, text: "继续" });
    await app.idle();
    assert.equal(app.state().task?.status, "waiting");
    assert.equal(app.state().task?.executionId, null);
    assert.equal(app.state().artifacts.length, 0);
    assert.equal(writesBlocked, 2);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a user message executes tools, saves a visible artifact and survives reopening; duplicate messages do not run twice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-api-"));
  let calls = 0;
  const driver: AgentDriver = {
    async run(request: RunRequest) {
      calls++;
      request.onSession("test-session");
      const profile = (await request.onTool("profile_update", {
        statements: [
          { key: "business", text: "居民供热", origin: "suggestion" },
        ],
      })) as unknown as Artifact;
      await request.onTool("task_complete", {
        artifactIds: [profile.id],
        summary: "企业理解初稿已保存",
      });
      return {
        text: "企业理解初稿已保存。",
        sessionId: "test-session",
        runId: "test-run",
      };
    },
    async stop() {},
    async close() {},
  };
  let service = await createServer({ directory, driver });
  try {
    await new Promise<void>((resolve) =>
      service.server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    const initial = await (await fetch(`${base}/api/bootstrap`)).json();
    const denied = await fetch(`${base}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "不应执行" }),
    });
    assert.equal(denied.status, 403);
    const body = {
      text: "我们是一家热力公司，帮我建立企业理解",
      messageId: "first-message",
    };
    const send = () =>
      fetch(`${base}/api/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-DataEngine-Token": initial.token,
        },
        body: JSON.stringify(body),
      });
    assert.equal((await send()).status, 202);
    await service.app.idle();
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.task.status, "completed");
    assert.equal(state.artifacts[0].kind, "profile");
    assert.match(state.messages.at(-1).content, /已保存/);
    assert.equal((await send()).status, 202);
    await service.app.idle();
    assert.equal(calls, 1);
    const taskId = state.task.id;
    const artifactId = state.artifacts[0].id;
    await service.close();
    service = await createServer({ directory, driver });
    assert.equal(service.app.state(taskId).task?.status, "completed");
    assert.equal(
      service.app.memory.getArtifact(artifactId).content.statements instanceof
        Array,
      true,
    );
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

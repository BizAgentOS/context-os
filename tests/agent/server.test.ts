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
import { seedFoundation } from "./program-foundation-fixture.ts";

test("separate A to B to A writes stay distinct while consecutive retries return the saved result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-retry-"));
  const saved: Artifact[] = [];
  const driver: AgentDriver = {
    async run(request) {
      let previous = "", args: any;
      for (const [index, text] of ["居民供热", "工业供热", "居民供热", "居民供热"].entries()) {
        if (text !== previous) args = { operationId: "business-" + index, type: "description", baseline: (await request.onTool("pending_list", {}) as any).baseline,
          subject: { target: "concept", id: "service", description: text }, evidence: "本轮用户指定修改企业业务定义" };
        saved.push((await request.onTool("change_propose", args) as any).change); previous = text;
      }
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
  seedFoundation(app.memory, app.foundation, { enterprise: "热力企业", concepts: [{ id: "service", name: "业务", description: "待明确业务" }] });
  try {
    await app.message({ text: "修改企业理解" });
    await app.idle();
    assert.deepEqual(
      saved.map((a) => a.status),
      ["adopted", "adopted", "adopted", "adopted"],
    );
    assert.equal(new Set(saved.map(item => item.id)).size, 3);
    assert.deepEqual(saved[2], saved[3]);
    assert.match(
      JSON.stringify(app.foundation.read().adopted),
      /居民供热/,
    );
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("free text never adopts a waiting proposal; a human decision validates its exact verified version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-adoption-"));
  let candidate: Artifact;
  const driver: AgentDriver = {
    async run(request) {
      if (candidate.status === "proposed") candidate = await request.onTool("change_verify", {
        id: candidate.id, version: candidate.version, operationId: "verify",
      }) as unknown as Artifact;
      await request.onTool("decision_request", {
        question: "是否采用投诉定义？", reason: "已核对定义结构，尚未采用",
        refs: [{ id: candidate.id, version: candidate.version }],
      });
      return { text: "等待你的决定", sessionId: "adoption-session", runId: "adoption-run" };
    }, async stop() {}, async close() {},
  };
  const app = new AgentApplication(directory, driver);
  try {
    candidate = (await app.changes.propose({ operationId: "ticket", type: "entity", origin: "human", baseline: app.changes.currentBaseline(),
      subject: { action: "add", entity: { id: "ticket", name: "投诉", description: "居民提出的一次投诉" } }, evidence: "用户核对投诉定义" })).change;
    const proposed = candidate;
    const first = await app.message({ text: "检查模型" });
    await app.idle();
    await app.message({ taskId: first.task.id, text: "采用这版", messageId: "chat-is-not-a-decision" });
    await app.idle();
    assert.equal(app.changes.read(candidate.id).status, "verified");
    assert.equal(app.changes.currentBaseline().foundationRef, null);
    await assert.rejects(app.changes.adopt({ id: candidate.id, version: proposed.version, operationId: "stale-adopt" }), /版本|变化/);
    assert.equal(app.state().task?.status, "waiting");
    assert.deepEqual(app.state().task?.pending?.refs, [{ id: candidate.id, version: candidate.version }]);
    const adopted = await app.changes.adopt({ id: candidate.id, version: candidate.version, operationId: "human-adopt" });
    assert.equal(adopted.status, "adopted");
    assert.match(JSON.stringify(app.foundation.read().adopted), /居民提出的一次投诉/);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("legacy upload model adoption keeps pinned data and rejects changed source facts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-pinned-adoption-"));
  const app = new AgentApplication(directory, { async run() { return { text: "idle", sessionId: "s", runId: "r" }; }, async stop() {}, async close() {} });
  try {
    const workspace = new Workspace(app.memory), source = workspace.upload("tickets.csv", "id,status\nT1,closed\n");
    const propose = () => workspace.execute("ontology_propose", {
      title: "投诉模型", purpose: "区分办结与恢复",
      types: [{ name: "Ticket", description: "投诉", sourceId: source.id, idField: "id", fields: { status: "status" } }],
      relations: [], functions: [], evidence: [{ sourceId: source.id, version: app.memory.getArtifact(source.id).version }],
    }) as unknown as Artifact;
    let draft = propose(), candidate = workspace.execute("ontology_preview", { id: draft.id, version: draft.version }) as unknown as Artifact;
    const adopted = workspace.adopt(candidate.id, candidate.version);
    workspace.upload("tickets.csv", "id,status\nT1,open\nT2,closed\n");
    const objects = app.objectDetails(new URLSearchParams({ artifactId: adopted.id, version: String(adopted.version), type: "Ticket" }));
    assert.equal((objects.result as { total: number }).total, 1);
    assert.match(JSON.stringify(objects.result), /closed/);
    draft = propose(); candidate = workspace.execute("ontology_preview", { id: draft.id, version: draft.version }) as unknown as Artifact;
    workspace.upload("tickets.csv", "id,status\nT1,open\nT2,open\n");
    assert.throws(() => workspace.adopt(candidate.id, candidate.version), /来源版本已变化/);
    assert.equal(app.memory.getArtifact(candidate.id).status, "candidate");
    assert.equal(app.memory.getArtifact(adopted.id).status, "adopted");
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
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
        await request.onTool("decision_request", {
          question: "请补充企业服务范围",
          reason: "目前资料不足",
        });
      await assert.rejects(
        request.onTool("task_checkpoint", { nextStep: "不应保存" }),
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
    assert.notEqual(app.memory.getTask(first.task.id).nextStep, "不应保存");
    mode = "ask";
    await app.message({ taskId: first.task.id, text: "继续" });
    await app.idle();
    assert.equal(app.state().task?.status, "waiting");
    assert.equal(app.state().task?.executionId, null);
    assert.notEqual(app.memory.getTask(first.task.id).nextStep, "不应保存");
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
      const result = await request.onTool("change_propose", { operationId: "business-definition", type: "entity", baseline: (await request.onTool("pending_list", {}) as any).baseline,
        subject: { action: "add", entity: { id: "heating_service", name: "供热业务", description: "居民供热服务" } }, evidence: "用户说明企业从事居民供热" }) as any;
      assert.equal(result.change.status, "proposed");
      await request.onTool("task_checkpoint", { nextStep: "已保存定义提议，待用户核对" });
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
    const initial = await (
      await fetch(`${base}/api/bootstrap`, {
        headers: { "x-dataengine-token": service.adminToken },
      })
    ).json();
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
    const state = await (
      await fetch(`${base}/api/state`, {
        headers: { "x-dataengine-token": service.adminToken },
      })
    ).json();
    assert.equal(state.task.status, "paused");
    assert.equal(state.artifacts.find((item: any) => item.kind === "agent_run").status, "completed", "the run completes while the task remains resumable");
    const artifact = state.artifacts.find((item: any) => item.kind === "ontology_change");
    assert.equal(artifact.status, "proposed");
    assert.match(state.messages.at(-1).content, /已保存/);
    assert.equal((await send()).status, 202);
    await service.app.idle();
    assert.equal(calls, 1);
    const taskId = state.task.id;
    const artifactId = artifact.id;
    await service.close();
    service = await createServer({ directory, driver });
    assert.equal(service.app.state(taskId).task?.status, "paused");
    assert.equal(service.app.memory.listArtifacts("agent_run")[0].status, "completed");
    assert.equal(
      service.app.memory.getArtifact(artifactId).content.type,
      "entity",
    );
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

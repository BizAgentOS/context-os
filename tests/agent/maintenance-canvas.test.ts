import { seedFoundation } from "./program-foundation-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentApplication } from "../../src/agent/app.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { reviewVerification } from "../../src/agent/maintenance.ts";
import type { Artifact } from "../../src/agent/contracts.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";

test("three pages and legacy aliases can be visited without inventing memory or completing creation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-maintenance-navigation-"));
  let calls = 0;
  const driver: AgentDriver = {
    async run() {
      calls++;
      throw new Error("navigation must not call the model");
    },
    async stop() {},
    async close() {},
  };
  let app = new AgentApplication(directory, driver);
  try {
    for (const page of [
      "ontology",
      "consumption",
      "sources",
      "company",
    ] as const) {
      const state = await app.canvasNavigate({ page });
      assert.equal(
        state.currentPage,
        ["company", "sources"].includes(page) ? "setup" : page,
      );
      assert(state.pages.every((item) => item.available && !item.ready));
      assert.equal(state.messages.length, 0);
      assert.equal(state.profile, null);
      assert.deepEqual(state.sources, []);
      assert.deepEqual(state.ontologies, []);
      assert.deepEqual(state.consumers, []);
    }
    assert.equal(calls, 0);
    assert.equal(app.memory.listTasks().length, 1, "navigation creates only an idle default conversation");
    assert.equal(app.memory.listArtifacts().length, 0);
    await app.close();
    app = new AgentApplication(directory, driver);
    assert(
      app.canvasState().pages.every((page) => page.available && !page.ready),
    );
    assert.equal(calls, 0);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("maintenance attention follows saved evidence and persists across page visits and restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-maintenance-attention-"));
  const driver: AgentDriver = {
    async run(request) {
      await request.onTool("decision_request", {
        question: "办结是否代表供暖恢复？",
        reason: "请确认业务含义",
      });
      return {
        text: "请确认定义。",
        sessionId: "attention",
        runId: "attention",
      };
    },
    async stop() {},
    async close() {},
  };
  let app = new AgentApplication(directory, driver);
  try {
    const workspace = new Workspace(app.memory);
    workspace.editProfile("company.name", "澄川热力");
    await workspace.execute("profile_update", {
      statements: [
        { key: "company.name", text: "另一家企业", origin: "suggestion" },
        { key: "company.goal", text: "了解投诉恢复情况", origin: "suggestion" },
      ],
    });
    const source = workspace.upload("投诉.csv", "id,status\nT1,closed\n");
    const proposed = (await workspace.execute("ontology_propose", {
      title: "投诉定义",
      purpose: "了解投诉处理情况",
      types: [
        {
          name: "投诉",
          description: "一次居民投诉",
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
      id: proposed.id,
      version: proposed.version,
    })) as unknown as Artifact;
    workspace.adopt(preview.id, preview.version);
    workspace.upload("投诉.csv", "id,status\nT1,closed\nT2,open\n");
    const newSource = workspace.upload("回访.md", "T1 回访时仍然低温。");
    const failed = workspace.upload("坏表.csv", 'id,status\nT1,"未闭合\n');
    await app.canvasNavigate({ page: "ontology" });
    await app.canvasMessage({ page: "ontology", text: "核对投诉定义" });
    await app.idle();
    const attention = app.canvasState().attention;
    assert(
      attention.some(
        (item) =>
          item.kind === "source_changed" && item.artifactId === source.id,
      ),
    );
    assert(
      attention.some(
        (item) =>
          item.kind === "source_unreviewed" && item.artifactId === newSource.id,
      ),
    );
    assert(
      attention.some(
        (item) =>
          item.kind === "source_failed" && item.artifactId === failed.id,
      ),
    );
    assert(attention.some((item) => item.kind === "profile_conflict"));
    assert(attention.some((item) => item.kind === "profile_suggestion"));
    assert(
      attention.some(
        (item) =>
          item.kind === "pending" && item.title === "办结是否代表供暖恢复？",
      ),
    );
    assert.equal(
      new Set(attention.map((item) => item.id)).size,
      attention.length,
    );
    const state = await app.canvasNavigate({ page: "consumption" });
    assert.deepEqual(state.attention, attention);
    await app.close();
    app = new AgentApplication(directory, driver);
    assert.deepEqual(app.canvasState().attention, attention);
    // Correcting a failed source updates the same saved artifact, not a chat-only notice.
    new Workspace(app.memory).upload("坏表.csv", "id,status\nT3,open\n");
    assert(
      !app
        .canvasState()
        .attention.some(
          (item) =>
            item.kind === "source_failed" && item.artifactId === failed.id,
        ),
    );
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reading documents preserves actual contents without claiming adopted concepts or page completion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-maintenance-documents-"));
  const errors: string[] = [];
  const driver: AgentDriver = {
    async run(request) {
      const input = JSON.parse(request.input);
      assert.equal(input.page, "setup");
      assert(!request.tools.some(tool => tool.name === "page_complete"));
      const source = await request.onTool("memory_read", { id: app.memory.listArtifacts("source")[0].id });
      errors.push((source as { content: { raw: string } }).content.raw.trim() ? "read" : "empty");
      return {
        text: "已检查资料。",
        sessionId: "documents",
        runId: "documents",
      };
    },
    async stop() {},
    async close() {},
  };
  const app = new AgentApplication(directory, driver);
  try {
    const workspace = new Workspace(app.memory);
    workspace.editProfile("company.name", "澄川热力");
    workspace.editProfile("company.business", "居民供热");
    await app.canvasNavigate({ page: "sources" });
    workspace.upload("empty.md", "  \n");
    await app.canvasMessage({ page: "sources", text: "检查当前资料" });
    await app.idle();
    assert.equal(app.canvasState().currentPage, "setup");
    assert.equal(
      app.canvasState().pages.find((page) => page.id === "setup")?.ready,
      false,
    );
    workspace.upload("业务规则.txt", "工单办结表示客服流程完成，供暖恢复需要回访证据。");
    await app.canvasMessage({ page: "sources", text: "检查当前资料" });
    await app.idle();
    const state = app.canvasState();
    assert.equal(state.currentPage, "setup");
    assert.equal(state.pages.find((page) => page.id === "setup")?.ready, false, "reading alone does not adopt a business definition");
    assert.equal(
      state.pages.find((page) => page.id === "ontology")?.ready,
      false,
    );
    assert.deepEqual(state.ontologies, []);
    assert.deepEqual(state.consumers, []);
    assert.equal(errors.length, 2);
    await app.canvasNavigate({ page: "sources" });
    workspace.upload("更新.md", "小区由指定换热站供热。");
    await app.canvasMessage({ page: "sources", text: "检查当前资料" });
    await app.idle();
    assert.equal(
      app.canvasState().currentPage,
      "setup",
      "maintenance does not automatically leave an already completed page",
    );
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explicit re-verification refreshes source evidence within one page conversation and preserves prior results", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-maintenance-refresh-"));
  const driver: AgentDriver = {
    async run(request) {
      assert(request.tools.some((tool) => tool.name === "object_execute"));
      // Rule-built structure removes the old creation tools; verification of adopted mappings remains available.
      assert(!request.tools.some((tool) => tool.name === "ontology_verify" || tool.name === "ontology_propose"));
      await request.onTool("object_execute", {
        question: "现在记录了多少条投诉？",
        operations: [
          { op: "query", type: "投诉", as: "tickets" },
          { op: "aggregate", input: "$tickets", as: "count" },
        ],
      });
      return {
        text: "查证结果已保存，请核对业务含义。",
        sessionId: "refresh",
        runId: "refresh",
      };
    },
    async stop() {},
    async close() {},
  };
  const app = new AgentApplication(directory, driver);
  seedFoundation(app.memory, app.foundation, { enterprise: "澄川热力", concepts: [{ id: "complaint", name: "投诉", description: "来自投诉表的记录，业务含义待核对。" }] });
  const seedTaskIds = new Set(app.memory.listTasks().map((task) => task.id));
  try {
    const workspace = new Workspace(app.memory);
    const source = workspace.upload("投诉.csv", "id,status\nT1,closed\n");
    const proposed = (await workspace.execute("ontology_propose", {
      title: "投诉定义",
      purpose: "了解投诉处理情况",
      types: [
        {
          name: "投诉",
          description: "一次居民投诉",
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
      id: proposed.id,
      version: proposed.version,
    })) as unknown as Artifact;
    const adopted = workspace.adopt(preview.id, preview.version);
    await app.canvasNavigate({ page: "ontology" });
    await app.canvasMessage({ page: "ontology", text: "验证投诉总数" });
    await app.idle();
    const saveLegacyCheck = () => {
      const context = app.memory.beginExecution(app.canvasState().session.taskId);
      try { return new Workspace(app.memory, context).execute("ontology_verify", {
        question: "现在记录了多少条投诉？", operations: [{ op: "query", type: "投诉", as: "tickets" }, { op: "aggregate", input: "$tickets", as: "count" }],
      }) as unknown as Artifact; } finally { app.memory.endExecution(context); }
    };
    // Historical verification remains covered through its domain service; the Agent uses read-only execution.
    saveLegacyCheck();
    const first = app.canvasState().verifications[0];
    assert.equal(
      (first.content.sourceVersions as Record<string, number>)[source.id],
      1,
    );
    workspace.upload("投诉.csv", "id,status\nT1,closed\nT2,open\n");
    await app.canvasMessage({ page: "ontology", text: "继续核对刚才的结果" });
    await app.idle();
    saveLegacyCheck();
    const pinned = app.canvasState().verifications[0];
    assert.equal(
      (pinned.content.sourceVersions as Record<string, number>)[source.id],
      1,
    );
    await app.canvasMessage({
      page: "ontology",
      text: "用新资料重新验证",
      refreshSources: true,
    });
    await app.idle();
    saveLegacyCheck();
    const refreshed = app.canvasState().verifications[0];
    assert.equal(
      (refreshed.content.sourceVersions as Record<string, number>)[source.id],
      2,
    );
    assert.notEqual(refreshed.content.snapshot, first.content.snapshot);
    assert.deepEqual(app.memory.getArtifact(first.id), first);
    assert.equal(app.canvasState().ontologies[0].version, adopted.version);
    assert.equal(app.memory.listTasks().filter((task) => !seedTaskIds.has(task.id)).length, 1);
    const readObjects = (artifact: Artifact) =>
      app.objectDetails(
        new URLSearchParams({
          artifactId: artifact.id,
          version: String(artifact.version),
          type: "投诉",
        }),
      );
    const oldObjects = readObjects(first);
    const freshObjects = readObjects(refreshed);
    assert.equal(oldObjects.snapshot, first.content.snapshot);
    assert.equal(freshObjects.snapshot, refreshed.content.snapshot);
    assert.deepEqual(
      (oldObjects.result as { items: { id: string }[] }).items.map(
        (item) => item.id,
      ),
      ["T1"],
    );
    assert.deepEqual(
      (freshObjects.result as { items: { id: string }[] }).items.map(
        (item) => item.id,
      ),
      ["T1", "T2"],
    );
    assert.equal(oldObjects.sourceVersions[source.id], 1);
    assert.equal(freshObjects.sourceVersions[source.id], 2);
    const defaultObjects = readObjects(adopted);
    assert.equal(defaultObjects.sourceVersions[source.id], 1);
    assert.deepEqual(app.memory.getArtifact(first.id), first);
    assert.deepEqual(app.memory.getArtifact(refreshed.id), refreshed);
    assert.deepEqual(app.memory.getArtifact(adopted.id), adopted);
    assert.deepEqual(
      app
        .canvasState()
        .attention.filter((item) => item.kind === "verification_unreviewed")
        .map((item) => item.artifactId),
      [refreshed.id],
    );
    // Reviewing an older run cannot make it the current check again.
    reviewVerification(app.memory, {
      id: first.id,
      version: first.version,
      status: "needs_adjustment",
    });
    assert(
      !app.canvasState().attention.some((item) => item.artifactId === first.id),
    );
    reviewVerification(app.memory, {
      id: refreshed.id,
      version: refreshed.version,
      status: "matches_expectation",
    });
    assert(
      !app
        .canvasState()
        .attention.some((item) => item.kind.startsWith("verification_")),
    );
    assert(
      !app
        .canvasState()
        .attention.some(
          (item) =>
            item.kind === "source_changed" && item.artifactId === source.id,
        ),
    );
    assert.equal(app.canvasState().ontologies[0].version, adopted.version);
    await app.canvasNavigate({ page: "company" });
    await assert.rejects(
      app.canvasMessage({
        page: "company",
        text: "刷新资料",
        refreshSources: true,
      }),
      /本体/,
    );
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a source update remains visible while working from document-only concept definitions", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "de-maintenance-outline-update-"),
  );
  const driver: AgentDriver = {
    async run() {
      throw new Error("not needed");
    },
    async stop() {},
    async close() {},
  };
  const app = new AgentApplication(directory, driver);
  try {
    const workspace = new Workspace(app.memory);
    const source = workspace.upload(
      "业务口径.md",
      "投诉办结表示客服流程完成。",
    );
    await workspace.execute("ontology_outline", {
      title: "投诉处理",
      purpose: "区分办结与恢复",
      concepts: [
        {
          name: "投诉办结",
          description: "客服流程完成",
          evidence: [
            {
              sourceId: source.id,
              version: 1,
              quote: "投诉办结表示客服流程完成。",
            },
          ],
        },
      ],
      relations: [],
    });
    workspace.upload(
      "业务口径.md",
      "投诉办结表示客服流程完成。恢复供暖需要独立回访。",
    );
    const state = app.canvasState();
    assert.equal(state.ontologies.length, 0);
    assert.equal(state.outlines.length, 1);
    assert(
      state.attention.some(
        (item) =>
          item.kind === "source_changed" && item.artifactId === source.id,
      ),
    );
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explicitly keeping the existing enterprise value resolves its conflict reminder after reopening", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "de-maintenance-conflict-resolution-"),
  );
  const driver: AgentDriver = {
    async run() {
      throw new Error("not needed");
    },
    async stop() {},
    async close() {},
  };
  let app = new AgentApplication(directory, driver);
  try {
    const workspace = new Workspace(app.memory);
    workspace.editProfile("company.name", "澄川热力");
    await workspace.execute("profile_update", {
      statements: [
        { key: "company.name", text: "另一家企业", origin: "suggestion" },
      ],
    });
    const state = app.canvasState();
    assert(state.attention.some((item) => item.kind === "profile_conflict"));
    await app.editProfile({
      id: state.profile!.id,
      expectedVersion: state.profile!.version,
      key: "company.name",
      text: "澄川热力",
    });
    assert(
      !app
        .canvasState()
        .attention.some((item) => item.kind === "profile_conflict"),
    );
    assert.match(JSON.stringify(app.canvasState().profile), /另一家企业/);
    await app.close();
    app = new AgentApplication(directory, driver);
    assert(
      !app
        .canvasState()
        .attention.some((item) => item.kind === "profile_conflict"),
    );
    assert.match(JSON.stringify(app.canvasState().profile), /澄川热力/);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

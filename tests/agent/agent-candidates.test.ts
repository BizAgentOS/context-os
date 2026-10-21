import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentApplication } from "../../src/agent/app.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import type { Artifact, Data } from "../../src/agent/contracts.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";

test("revised unified proposals preserve history and deliver the exact pending decision without adopting structure", { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-candidates-"));
  const saved: Artifact[] = [], verified: Artifact[] = [];
  let subject: Data;
  const driver: AgentDriver = {
    async run(request) {
      const pending = await request.onTool("pending_list", {}) as any;
      const proposal = { operationId: "relation", type: "relation", baseline: pending.baseline, subject, evidence: "任务项目编号对应项目目录" };
      const first = (await request.onTool("change_propose", proposal) as any).change as Artifact;
      saved.push(first);
      const replay = (await request.onTool("change_propose", proposal) as any).change as Artifact;
      assert.deepEqual({ id: replay.id, version: replay.version }, { id: first.id, version: first.version }, "network retries keep one proposal");
      await assert.rejects(request.onTool("change_propose", { ...proposal, operationId: "invalid", subject: { from: {} } }));
      const second = (await request.onTool("change_propose", { ...proposal, operationId: "revised", subject: { ...subject, cardinality: "1:1" }, evidence: "两边编号均唯一，补充一对一约束" }) as any).change as Artifact;
      saved.push(second);
      await request.onTool("change_withdraw", { operationId: "withdraw-old", id: first.id, version: first.version, reason: "已补充明确基数的新提议" });
      const checked = await request.onTool("change_verify", { operationId: "verify", id: second.id, version: second.version }) as unknown as Artifact;
      verified.push(checked);
      await request.onTool("decision_request", { question: "采用任务所属项目关系吗？", reason: "来源与一对一约束均已复验", refs: [{ id: checked.id, version: checked.version }] });
      return { text: "已核对关系。", sessionId: "fixture", runId: "fixture" };
    }, async stop() {}, async close() {},
  };
  const app = new AgentApplication(directory, driver, new Set(), false);
  try {
    const workspace = new Workspace(app.memory);
    workspace.upload("projects.csv", "project_id,title\nP1,交付项目\nP2,测试项目\n");
    workspace.upload("tasks.csv", "task_id,project_id,title\nT1,P1,交付\nT2,P2,测试\n");
    await app.snapshots.sync({ operationId: "sync" });
    await app.programBuilds.build({ operationId: "build", autoAdopt: false });
    const candidate = app.programBuilds.overview().candidate!, checked = await app.programBuilds.check({ id: candidate.id, version: candidate.version });
    await app.programBuilds.adopt({ id: checked.id, version: checked.version, operationId: "entities", selection: { entities: (checked.content.diff as Data).addedConcepts, relations: [], merges: [] } });
    const datasets = app.snapshots.datasets();
    subject = { from: { datasetId: datasets.find(d => String(d.content.name).includes("tasks"))!.id, column: "project_id" }, to: { datasetId: datasets.find(d => String(d.content.name).includes("projects"))!.id, column: "project_id" } };
    const baseline = app.changes.currentBaseline();
    await app.canvasMessage({ page: "ontology", text: "检查并修订任务所属项目关系", messageId: "repair-1" });
    await app.idle();
    assert.equal(saved.length, 2);
    assert.notEqual(saved[0].id, saved[1].id, "a revised scope is a new inspectable proposal");
    assert.equal(app.changes.read(saved[0].id).content.disposition, "withdrawn");
    assert.equal(app.changes.read(saved[0].id, saved[0].version).status, "proposed", "the earlier proposal remains in history");
    assert.equal(verified[0].status, "verified");
    await assert.rejects(app.changes.verify({ id: saved[1].id, version: saved[1].version, operationId: "stale-check" }), /变化/);
    const state = app.canvasState();
    assert.deepEqual((state.agentRuns.at(-1)!.decisions[0].refs), [{ id: verified[0].id, version: verified[0].version }]);
    assert.match(state.messages.at(-1)!.content, /尚未采用|待采用/);
    assert.match(state.messages.at(-1)!.content, /待处理中心/);
    assert.deepEqual(app.changes.currentBaseline(), baseline);
    const previousVersion = app.changes.read(saved[0].id).version;
    await app.canvasMessage({ page: "ontology", text: "另外检查一次", messageId: "repair-2" });
    await app.idle();
    assert.notEqual(saved[2].id, saved[0].id, "separate turns cannot overwrite an earlier decision");
    assert.equal(app.changes.read(saved[0].id).version, previousVersion);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

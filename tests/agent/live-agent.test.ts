import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentApplication } from "../../src/agent/app.ts";
import {
  createHeatingSources,
  connectHeatingSources,
} from "../../src/live/heating-sources.ts";
import type { Artifact, Data } from "../../src/agent/contracts.ts";

test("build Agent reads approved HTTP and MCP capabilities and proposes a relationship without adopting it", { timeout: 20000 }, async () => {
  const upstream = await createHeatingSources();
  const directory = mkdtempSync(join(tmpdir(), "live-agent-"));
  let candidate: Artifact | undefined;
  let subject: Data;
  const app = new AgentApplication(directory, {
    async run(request) {
      assert.ok(request.tools.some((t) => t.name === "live_read"));
      assert.ok(!request.tools.some((t) => ["live_adopt", "live_propose", "change_adopt"].includes(t.name)));
      const overview = (await request.onTool(
        "live_overview",
        {},
      )) as unknown as { connections: Artifact[] };
      const api = overview.connections.find(
          (a) => a.content.protocol === "http",
        )!,
        mcp = overview.connections.find((a) => a.content.protocol === "mcp")!;
      const sample = await request.onTool("live_read", {
        sourceId: mcp.id,
        capability: "list_callbacks",
        limit: 3,
      });
      assert.match(JSON.stringify(sample), /HF002/);
      const pending = await request.onTool("pending_list", {}) as any;
      candidate = (await request.onTool("change_propose", { operationId: "callback-complaint", type: "relation", baseline: pending.baseline, subject, evidence: "回访记录中的投诉编号指向投诉系统的工单编号" }) as any).change;
      return {
        text: "候选已形成，请在本体页确认业务含义后采用。",
        sessionId: "test",
        runId: "test",
      };
    },
    async stop() {},
    async close() {},
  }, new Set(), false);
  try {
    const { api, mcp } = await connectHeatingSources(app.live.sources, upstream);
    await app.snapshots.sync({ operationId: "sync" });
    await app.programBuilds.build({ operationId: "build", autoAdopt: false });
    const built = app.programBuilds.overview().candidate!, checked = await app.programBuilds.check({ id: built.id, version: built.version });
    await app.programBuilds.adopt({ id: checked.id, version: checked.version, operationId: "entities", selection: { entities: (checked.content.diff as Data).addedConcepts, relations: [], merges: [] } });
    const callbacks = app.snapshots.bindingDataset(mcp.id, "list_callbacks")!, complaints = app.snapshots.bindingDataset(api.id, "complaints")!;
    subject = { from: { datasetId: callbacks.id, column: "complaintId" }, to: { datasetId: complaints.id, column: "id" } };
    const baseline = app.changes.currentBaseline();
    await app.canvasNavigate({ page: "ontology" });
    await app.canvasMessage({
      page: "ontology",
      text: "依据投诉和回访构建本体",
    });
    await app.idle();
    assert.equal(candidate?.status, "proposed");
    assert.equal(candidate?.content.origin, "agent");
    assert.deepEqual(app.changes.currentBaseline(), baseline);
    assert.equal(app.pendingCenter.read(candidate!.id).status, "proposed");
  } finally {
    await app.close();
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

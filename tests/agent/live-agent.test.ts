import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentApplication } from "../../src/agent/app.ts";
import {
  createHeatingSources,
  connectHeatingSources,
  heatingDefinition,
} from "../../src/live/heating-sources.ts";
import type { Artifact } from "../../src/agent/contracts.ts";

test("page Agent uses approved live capabilities to create a candidate but cannot activate it", async () => {
  const upstream = await createHeatingSources();
  const directory = mkdtempSync(join(tmpdir(), "live-agent-"));
  let candidate: Artifact | undefined;
  const app = new AgentApplication(directory, {
    async run(request) {
      assert.ok(request.tools.some((t) => t.name === "live_read"));
      assert.ok(!request.tools.some((t) => t.name === "live_adopt"));
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
      candidate = (await request.onTool(
        "live_propose",
        heatingDefinition(api.id, mcp.id),
      )) as unknown as Artifact;
      return {
        text: "候选已形成，请在本体页确认业务含义后采用。",
        sessionId: "test",
        runId: "test",
      };
    },
    async stop() {},
    async close() {},
  });
  try {
    await connectHeatingSources(app.live.sources, upstream);
    await app.canvasNavigate({ page: "ontology" });
    await app.canvasMessage({
      page: "ontology",
      text: "依据投诉和回访构建本体",
    });
    await app.idle();
    assert.equal(candidate?.status, "candidate");
    assert.equal(app.canvasState().live.models[0].status, "candidate");
    assert.ok(
      !app.canvasState().live.models.some((a) => a.status === "adopted"),
    );
  } finally {
    await app.close();
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

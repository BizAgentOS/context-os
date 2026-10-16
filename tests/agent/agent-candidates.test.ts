import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentApplication } from "../../src/agent/app.ts";
import type { Artifact } from "../../src/agent/contracts.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";

test("repeated complete mapping revisions in one run replace its candidate and deliver the exact version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-candidates-"));
  const saved: Artifact[] = [];
  const driver: AgentDriver = {
    async run(request) {
      const overview = await request.onTool("live_overview", {}) as any;
      const adopted = overview.models.find((m: Artifact) => m.status === "adopted");
      const proposal = { purpose: "公司查询修订", foundationRef: adopted.content.foundationRef,
        baseModelRef: { id: adopted.id, version: adopted.version }, types: adopted.content.types,
        relations: adopted.content.relations, rationale: "核对当前公司记录" };
      saved.push(await request.onTool("live_propose", proposal) as unknown as Artifact);
      saved.push(await request.onTool("live_propose", { ...proposal, rationale: "核对当前公司记录及字段" }) as unknown as Artifact);
      await assert.rejects(request.onTool("live_propose", { ...proposal, types: [] }));
      return { text: "已核对映射。", sessionId: "fixture", runId: "fixture" };
    }, async stop() {}, async close() {},
  };
  const app = new AgentApplication(directory, driver);
  try {
    await app.canvasUpload({ page: "setup", name: "companies.csv", content: "id,name\nA,Example\n" });
    await app.idle();
    const adopted = app.live.overview().models.find(m => m.status === "adopted")!;
    await app.canvasNavigate({ page: "ontology" });
    await app.canvasMessage({ page: "ontology", text: "检查并修订公司映射", messageId: "repair-1" });
    await app.idle();
    assert.equal(saved.length, 2);
    assert.equal(saved[1].id, saved[0].id);
    assert.equal(saved[1].version, saved[0].version + 1);
    assert.equal(app.live.overview().models.filter(m => m.status === "candidate").length, 1);
    assert.equal(app.memory.getArtifact(saved[0].id, saved[0].version).content.rationale, "核对当前公司记录");
    assert.equal(app.memory.getArtifact(adopted.id).status, "adopted");
    assert.throws(() => app.live.candidate(saved[0].id, saved[0].version), /变化/);
    const answer = app.canvasState().messages.at(-1)!.content;
    assert.match(answer, /尚未采用|待采用/);
    assert(answer.includes(`v${saved[1].version}`));
    assert(answer.includes(saved[1].title));
    await app.canvasMessage({ page: "ontology", text: "另外检查一次", messageId: "repair-2" });
    await app.idle();
    assert.notEqual(saved[2].id, saved[0].id, "separate user turns must not silently overwrite earlier decisions");
    assert.equal(app.memory.getArtifact(saved[0].id).version, saved[1].version);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

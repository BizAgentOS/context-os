import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentApplication } from "../../src/agent/app.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";
import type { Artifact } from "../../src/agent/contracts.ts";
import { Releases } from "../../src/engine/releases.ts";
import { proposeWording } from "./unified-wording-fixture.ts";

test("Agent repairs a program-built concept without inventing an enterprise identity or publishing it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-engine-repair-"));
  let candidate: Artifact | undefined;
  const driver: AgentDriver = {
    async run(request) {
      const input = JSON.parse(request.input);
      if (input.page === "consumption") {
        assert(request.tools.some(t => t.name === "release_overview"));
        assert(!request.tools.some(t => ["engine_build", "release_publish"].includes(t.name)));
        const result = await request.onTool("release_overview", {}) as any;
        assert.equal(result.releases.length, 0);
        assert.equal(result.latestCheck.status, "blocked");
        assert(result.latestCheck.issues.length > 0);
        assert.equal(typeof result.latestCheck.id, "string");
      } else {
        assert(request.tools.some(t => t.name === "engine_overview"));
        assert(request.tools.some(t => t.name === "change_propose"));
        const overview = await request.onTool("engine_overview", {}) as any;
        assert.equal(overview.jobs[0].content.outcome, "adopted");
        assert.doesNotMatch(JSON.stringify(overview), /Example|apiSnapshot/, "discovery must not resend source rows or evidence snapshots");
        await request.onTool("skill_use", { name: "company-foundation-ontology" });
        const foundation = (await request.onTool("foundation_read", {}) as any).current;
        assert(!request.tools.some(t => t.name === "foundation_propose"));
        candidate = await proposeWording(request, "concept", foundation.content.concepts[0].id, { name: "公司", description: "公司业务记录" }, "user-repair");
      }
      return { text: "已核对当前工作版本。", sessionId: "fixture", runId: "fixture" };
    }, async stop() {}, async close() {},
  };
  const app = new AgentApplication(directory, driver);
  try {
    await app.canvasUpload({ page: "setup", name: "companies.csv", content: "id,name\nA,Example\n" });
    await app.idle();
    const built = app.foundation.read().adopted!;
    assert.deepEqual(built.content.enterprise, { name: "未设置企业", evidenceRefs: [] });
    await app.canvasNavigate({ page: "ontology" });
    await app.canvasMessage({ page: "ontology", text: "把这个概念叫公司，含义为公司业务记录。", messageId: "repair-message" });
    await app.idle();
    assert.equal(candidate?.status, "adopted");
    const repaired = app.foundation.read().adopted!;
    assert.equal((repaired.content.concepts as any[])[0].id, (built.content.concepts as any[])[0].id);
    assert.equal((repaired.content.concepts as any[])[0].name, "公司");
    assert.deepEqual(repaired.content.enterprise, built.content.enterprise);
    const releases = new Releases(app.memory, app.live);
    assert.equal(releases.overview().releases.length, 0);
    await releases.check({ inputHash: releases.overview().working.inputHash });
    await app.canvasNavigate({ page: "consumption" });
    await app.canvasMessage({ page: "consumption", text: "查看发布状态", messageId: "release-read" });
    await app.idle();
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("release comparisons use both selected versions, including skipped upgrades and rollback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-release-compare-"));
  const app = new AgentApplication(directory, undefined, new Set(), false);
  try {
    const releases = new Releases(app.memory, app.live);
    let f = app.memory.putArtifact({ kind: "foundation", title: "界面验收", status: "adopted", content: { enterprise: { name: "界面验收" }, concepts: [{ id: "company", name: "公司", description: "原含义" }], relations: [], evidence: [], unknowns: [], conflicts: [] } });
    const publish = async (id: string) => {
      const check = await releases.check({ inputHash: releases.overview().working.inputHash });
      return releases.publish({ operationId: id, name: id, checkRef: { id: check.id, version: check.version } }).release;
    };
    const first = await publish("v1");
    f = app.memory.putArtifact({ ...f, expectedVersion: f.version, content: { ...f.content, concepts: [{ id: "company", name: "公司", description: "修订含义" }] } });
    await publish("v2");
    app.memory.putArtifact({ ...f, expectedVersion: f.version, content: { ...f.content, concepts: [...f.content.concepts as any[], { id: "contact", name: "联系人", description: "公司联系人" }] } });
    const third = await publish("v3");
    const ref = (a: Artifact) => ({ id: a.id, version: a.version });
    const forward = releases.compare({ from: ref(first), to: ref(third) });
    assert(forward.diff.some(d => d.path === "/concepts/company/description" && d.after === "修订含义"));
    assert(forward.diff.some(d => d.path === "/concepts/contact" && d.kind === "added"));
    const back = releases.compare({ from: ref(third), to: ref(first) });
    assert(back.diff.some(d => d.path === "/concepts/company/description" && d.after === "原含义"));
    assert(back.diff.some(d => d.path === "/concepts/contact" && d.kind === "removed"));
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

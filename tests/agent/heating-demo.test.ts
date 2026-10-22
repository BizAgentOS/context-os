import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createHeatingDemo } from "../../src/demo/server.ts";
import { seedHeatingDemo } from "../../src/demo/heating-seed.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import type { Data } from "../../src/agent/contracts.ts";

test("heating demo opens three populated pages, runs evidence checks locally and preserves edits on restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-heating-demo-"));
  let service = await createHeatingDemo(directory);
  try {
    await new Promise<void>((resolve) => service.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${base}/api/canvas/bootstrap`)).status, 403);
    const bootstrap = await fetch(`${base}/api/canvas/bootstrap`, {
      headers: {"X-ContextOS-Token": service.adminToken},
    }).then((response) => response.json());
    assert.equal(bootstrap.demo.name, "澄川热力");
    assert.equal(bootstrap.model.configured, true);
    assert.equal(bootstrap.currentPage, "setup");
    assert.equal(bootstrap.sources.length, 8);
    assert(bootstrap.pages.every((page: {available: boolean}) => page.available));

    await service.app.canvasNavigate({page: "ontology"});
    const before = service.app.memory.listArtifacts("verification").length;
    await service.app.canvasMessage({page: "ontology", text: "哪些投诉还缺恢复依据？", refreshSources: true});
    await service.app.idle();
    const records = service.app.memory.listArtifacts("verification");
    assert.equal(records.length, before, "a read-only demonstration query does not create a governance verification");
    const run = service.app.canvasState().agentRuns.at(-1)!;
    assert.equal(run.status, "completed");
    const items = run.tables.at(-1)!.rows as Data[];
    assert.equal(items.length, 6);
    assert.equal(items.filter((item) => item.status === "positive_callback_evidence").length, 2);
    assert.equal(items.filter((item) => item.status === "negative_callback_evidence").length, 2);
    assert.equal(items.filter((item) => item.status === "no_evidence").length, 1);
    assert.equal(items.filter((item) => item.status === "unknown_callback_evidence").length, 1);

    await service.app.canvasMessage({page: "ontology", text: "请用已保存的本体与真实对象验证这个业务问题：预计下月收入？。请保存实际查询结果和依据；如果资料不足，保留具体缺口。"});
    await service.app.idle();
    assert.equal(service.app.memory.listArtifacts("verification").length, before);
    assert.match(service.app.canvasState().messages.at(-1)!.content, /自定义问题需要接入真实模型/);
    assert.equal(service.app.consumption.list().length, 0, "fresh demos do not create frozen v1 grants");
    assert.equal(service.app.consumption.logs().length, 0);

    new Workspace(service.app.memory).editProfile("company.goal", "保留这次演示中的修改");
    assert.equal(seedHeatingDemo(service.app).seeded, false);
    await service.close();
    service = await createHeatingDemo(directory);
    const statements = service.app.canvasState().profile!.content.statements as Data[];
    assert.equal(statements.find((item) => item.key === "company.goal")!.text, "保留这次演示中的修改");
    assert.equal(service.app.memory.listArtifacts("verification").length, before);
  } finally {
    await service.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

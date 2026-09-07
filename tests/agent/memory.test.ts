import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";

test("saved enterprise understanding reopens with its task; a stopped run cannot overwrite it", () => {
  const dir = mkdtempSync(join(tmpdir(), "dataengine-memory-"));
  try {
    let memory = new MemoryStore(dir);
    const task = memory.createTask("建立热力公司理解");
    const context = memory.beginExecution(task.id);
    const artifact = memory.putArtifact(
      {
        kind: "profile",
        title: "企业理解",
        status: "draft",
        content: { business: "供热" },
      },
      context,
      "save-profile",
    );
    assert.deepEqual(
      memory.putArtifact(
        {
          kind: "profile",
          title: "企业理解",
          status: "draft",
          content: { business: "供热" },
        },
        context,
        "save-profile",
      ),
      artifact,
    );
    memory.pauseTask(task.id);
    assert.throws(
      () =>
        memory.putArtifact(
          {
            id: artifact.id,
            expectedVersion: 1,
            kind: "profile",
            title: "错误更新",
            status: "draft",
            content: {},
          },
          context,
        ),
      /运行|任务|失效/,
    );
    memory.close();
    memory = new MemoryStore(dir);
    assert.equal(memory.getArtifact(artifact.id).content.business, "供热");
    assert.deepEqual(memory.getTask(task.id).artifactRefs, [
      { id: artifact.id, version: 1 },
    ]);
    assert.equal(memory.getTask(task.id).status, "paused");
    memory.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

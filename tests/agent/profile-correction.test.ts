import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import type { Artifact, Data } from "../../src/agent/contracts.ts";

test("a user's new quoted correction replaces their earlier statement and preserves both versions", () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-profile-correction-"));
  let repo = new MemoryStore(directory);
  try {
    const task = repo.createTask("建立企业信息");
    const initialMessage = repo.addMessage(task.id, "user", "企业名叫澄川热力。");
    const initialContext = repo.beginExecution(task.id);
    const initial = new Workspace(repo, initialContext).execute("profile_update", {
      statements: [{
        key: "company.name",
        text: "澄川热力",
        origin: "user",
        messageId: initialMessage.id,
        quote: "澄川热力",
      }],
    }) as unknown as Artifact;
    repo.endExecution(initialContext);

    const correctionMessage = repo.addMessage(task.id, "user", "刚才的名称需要改正，企业名是澄川城市热力。");
    const correctionContext = repo.beginExecution(task.id);
    const corrected = new Workspace(repo, correctionContext).execute("profile_update", {
      statements: [{
        key: "company.name",
        text: "澄川城市热力",
        origin: "user",
        messageId: correctionMessage.id,
        quote: "澄川城市热力",
      }],
    }) as unknown as Artifact;
    assert.equal(corrected.id, initial.id);
    assert.equal(corrected.version, initial.version + 1);
    assert.deepEqual(corrected.content.statements, [{
      key: "company.name",
      text: "澄川城市热力",
      origin: "user",
      evidence: [],
      userEdited: true,
      userEvidence: { messageId: correctionMessage.id, quote: "澄川城市热力" },
    }]);
    assert.deepEqual(corrected.content.conflicts, []);
    repo.endExecution(correctionContext);

    repo.close();
    repo = new MemoryStore(directory);
    const reopened = new Workspace(repo).execute("memory_read", { id: initial.id }) as unknown as Artifact;
    assert.deepEqual(reopened.content.statements, corrected.content.statements);
    const historical = new Workspace(repo).execute("memory_read", { id: initial.id, version: initial.version }) as unknown as Artifact;
    assert.equal((historical.content.statements as Data[])[0].text, "澄川热力");
    assert.deepEqual((historical.content.statements as Data[])[0].userEvidence, {
      messageId: initialMessage.id,
      quote: "澄川热力",
    });
  } finally {
    repo.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source evidence and model suggestions remain conflicts after a user's quoted correction", () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-profile-protection-"));
  const repo = new MemoryStore(directory);
  try {
    const host = new Workspace(repo);
    host.editProfile("company.name", "澄川热力");
    const source = host.upload("企业介绍.md", "企业名称：澄川供热。");
    const task = repo.createTask("更正企业名称");
    const message = repo.addMessage(task.id, "user", "企业名称改正为澄川城市热力。");
    const workspace = new Workspace(repo, repo.beginExecution(task.id));
    const corrected = workspace.execute("profile_update", {
      statements: [{
        key: "company.name",
        text: "澄川城市热力",
        origin: "user",
        messageId: message.id,
        quote: "澄川城市热力",
      }],
    }) as unknown as Artifact;
    assert.equal((corrected.content.statements as Data[])[0].text, "澄川城市热力");

    const conflicting = workspace.execute("profile_update", {
      statements: [
        { key: "company.name", text: "澄川供热", origin: "source", evidence: [{ sourceId: source.id, version: 1 }] },
        { key: "company.name", text: "澄川能源", origin: "suggestion" },
      ],
    }) as unknown as Artifact;
    assert.deepEqual(conflicting.content.statements, corrected.content.statements);
    const conflicts = conflicting.content.conflicts as Data[];
    assert.equal(conflicts.length, 2);
    assert.deepEqual(conflicts.map((conflict) => ({ retained: conflict.retained, proposed: conflict.proposed })), [
      { retained: "澄川城市热力", proposed: "澄川供热" },
      { retained: "澄川城市热力", proposed: "澄川能源" },
    ]);
    assert.equal((conflicts[0].evidence as Data[])[0].sourceId, source.id);
  } finally {
    repo.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unverified user corrections cannot change a saved statement or its provenance", () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-profile-invalid-quote-"));
  const repo = new MemoryStore(directory);
  try {
    const task = repo.createTask("检查用户纠正");
    const userMessage = repo.addMessage(task.id, "user", "企业名称应为澄川城市热力。");
    const assistantMessage = repo.addMessage(task.id, "assistant", "企业名称应为澄川城市热力。");
    const otherTask = repo.createTask("其他页面");
    const otherMessage = repo.addMessage(otherTask.id, "user", "企业名称应为澄川城市热力。");
    const initial = new Workspace(repo).editProfile("company.name", "已确认企业名称");
    const workspace = new Workspace(repo, repo.beginExecution(task.id));
    const quoted = {
      key: "company.name",
      text: "澄川城市热力",
      origin: "user",
      messageId: userMessage.id,
      quote: "澄川城市热力",
    };
    const invalidUpdates = [
      { ...quoted, messageId: "nonexistent-user-message" },
      { ...quoted, messageId: assistantMessage.id },
      { ...quoted, messageId: otherMessage.id },
      { ...quoted, quote: "用户没有说过的名称", text: "用户没有说过的名称" },
      { ...quoted, text: "模型改写出的企业名称" },
      { key: "company.name", text: "澄川城市热力", origin: "user", userEvidence: { messageId: userMessage.id, quote: "澄川城市热力" } },
    ];
    for (const update of invalidUpdates) {
      assert.throws(() => workspace.execute("profile_update", { statements: [update] }), /用户消息|原话|引用/);
      assert.deepEqual(workspace.execute("memory_read", { id: initial.id }), initial);
    }
  } finally {
    repo.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";

test("model history windows never delete stored messages and older pages survive reopening", () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-history-"));
  let memory = new MemoryStore(directory);
  try {
    const task = memory.createTask("历史保留");
    for (let i = 1; i <= 65; i++) memory.addMessage(task.id, "user", `消息 ${i}`, `message-${i}`);
    assert.equal(memory.trimMessages(task.id).length, 12);
    assert.equal(memory.messages(task.id).length, 65);
    memory.close();
    memory = new MemoryStore(directory);
    const newest = memory.messagePage(task.id, { limit: 20 });
    assert.equal(newest.messages[0].content, "消息 46");
    assert.equal(newest.messages.at(-1)?.content, "消息 65");
    const older = memory.messagePage(task.id, { limit: 20, before: newest.nextBefore! });
    assert.equal(older.messages[0].content, "消息 26");
    assert.equal(older.messages.at(-1)?.content, "消息 45");
    const other = memory.createTask("另一任务");
    assert.throws(() => memory.messagePage(other.id, { before: newest.nextBefore! }), /分页/);
    assert.throws(() => memory.messagePage(task.id, { limit: -1 }), /分页/);
  } finally {
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

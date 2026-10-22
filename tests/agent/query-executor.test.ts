import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Executor } from "../../src/data/executor/jobs.ts";

test("bounded reads page a 100,000-row query without computing a data profile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-query-executor-")), executor = new Executor(directory);
  try {
    const result = await executor.run({ mode: "read", scope: "workspace", inputs: [], sql: "SELECT range AS id, range * 2 AS score FROM range(100000) WHERE range >= 99900 ORDER BY range DESC", offset: 10, limit: 3 });
    assert.equal(result.total, 100);
    assert.deepEqual(result.rows, [{ id: "99989", score: "199978" }, { id: "99988", score: "199976" }, { id: "99987", score: "199974" }]);
    assert.deepEqual(result.columns, [{ name: "id", type: "BIGINT" }, { name: "score", type: "BIGINT" }]);
    assert.equal("profile" in result, false);
  } finally { await executor.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test("a cancelled read releases its execution slot and a read deadline interrupts expensive work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-query-cancel-")), executor = new Executor(directory);
  try {
    const controller = new AbortController(), started = Date.now();
    const reading = executor.run({ mode: "read", scope: "workspace", sql: "SELECT sum(sin(range)) FROM range(1000000000)" }, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 100);
    try { await assert.rejects(reading, /取消/); } finally { clearTimeout(timer); }
    assert.ok(Date.now() - started < 2500);
    await assert.rejects(executor.run({ mode: "read", scope: "workspace", sql: "SELECT sum(sin(range)) FROM range(1000000000)" }, { timeoutMs: 100 }), /时限/);
    assert.equal((await executor.run({ mode: "read", scope: "workspace", sql: "SELECT 1 AS ready" })).rows[0].ready, 1);
  } finally { await executor.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('cancelling a queued read removes it without consuming the next execution slot',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'context-os-query-queue-')),executor=new Executor(directory);
  const controllers=[new AbortController(),new AbortController(),new AbortController()];
  try{
    const running=controllers.slice(0,2).map(controller=>executor.run({mode:'read',scope:'workspace',sql:'SELECT sum(sin(range)) FROM range(1000000000)'},{signal:controller.signal}).catch(error=>error));
    const waiting=executor.run({mode:'read',scope:'workspace',sql:'SELECT 2 AS queued'},{signal:controllers[2].signal});
    controllers[2].abort();await assert.rejects(waiting,/取消/);
    for(const controller of controllers.slice(0,2))controller.abort();await Promise.all(running);
    assert.equal((await executor.run({mode:'read',scope:'workspace',sql:'SELECT 3 AS ready'})).rows[0].ready,3);
  }finally{await executor.stop();rmSync(directory,{recursive:true,force:true});}
});

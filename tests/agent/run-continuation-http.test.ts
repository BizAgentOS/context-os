import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {AddressInfo} from "node:net";
import {createServer} from "../../src/agent/server.ts";
import type {AgentDriver} from "../../src/agent/runtime.ts";

test("stopping an existing build session before its first model step retains the submitted goal for continuation", {timeout: 15000}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-run-goal-"));
  const goal = "请核对账号所属人员的关系，保留机器人与无法对应的记录。";
  let invocation = 0, continuedGoal: unknown, release: (() => void) | undefined, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const driver: AgentDriver = {
    async run(request) {
      invocation++;
      if (invocation === 2) {
        await new Promise<void>(resolve => { release = resolve; entered(); });
        return {text: "", status: "stopped", sessionId: "goal", runId: "stop"};
      }
      if (invocation === 3) continuedGoal = JSON.parse(request.input).continuation?.goal;
      return {text: "当前运行结束。", sessionId: "goal", runId: String(invocation)};
    },
    async stop() { release?.(); },
    async close() {},
  };
  const service = await createServer({directory, driver, automaticApi: false});
  try {
    await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    const call = async (path: string, body?: unknown) => {
      const response = await fetch(origin + path, {method: body === undefined ? "GET" : "POST",
        headers: {"x-contextos-token": service.adminToken, "content-type": "application/json"},
        ...(body === undefined ? {} : {body: JSON.stringify(body)})});
      assert(response.ok, await response.clone().text());
      return response.json() as Promise<any>;
    };
    const {session} = await call("/api/sessions", {});
    await call("/api/canvas/message", {sessionId: session.id, page: "ontology", mode: "build", messageId: "old-goal", text: "先了解已有企业资料。"});
    await service.app.idle();
    await call("/api/canvas/message", {sessionId: session.id, page: "ontology", mode: "build", messageId: "new-goal", text: goal});
    await started;
    const stopped = await call("/api/canvas/stop", {sessionId: session.id, page: "ontology"});
    const run = stopped.agentRuns.at(-1);
    assert.equal(run.status, "stopped");
    assert.deepEqual(run.steps, [], "no model step has run before cancellation");
    assert.equal(run.goal, goal);
    assert.equal(run.continuation.goal, goal);
    const reread = await call(`/api/canvas?page=ontology&sessionId=${session.id}`);
    assert.equal(reread.agentRuns.at(-1).continuation.goal, goal);
    await call("/api/canvas/message", {sessionId: session.id, page: "ontology", mode: "build", messageId: "continue-goal", text: `继续处理：${run.continuation.goal}`, continuationRunId: run.id});
    await service.app.idle();
    assert.equal(invocation, 3);
    assert.equal(continuedGoal, goal, "continuation must reach the model with the original submitted goal");
    assert.equal((await call(`/api/canvas?page=ontology&sessionId=${session.id}`)).agentRuns.at(-1).status, "completed");
  } finally { release?.(); await service.close(); rmSync(directory, {recursive: true, force: true}); }
});

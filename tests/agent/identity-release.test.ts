import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { identityWorkspace, ref } from "./identity-release-fixture.ts";

test("identity decisions advance one working version and are fixed by each release for HTTP and MCP consumers", async () => {
  const w = await identityWorkspace();
  const client = new Client({ name: "identity-release-reader", version: "1" });
  try {
    const first = await w.publish("规则基线"), firstReader = await w.connect(first, "初始接入");
    assert.equal((await w.external(firstReader.key, "a-bot")).body.items[0].objectRef.id, "P2");
    const before = await w.manage("/api/workspace-versions");
    const change = await w.decide("a-bot", "no_match", null, "exclude-bot");
    const decisionRef = change.content.effect.decisionRef;
    const after = await w.manage("/api/workspace-versions");
    assert.equal(after.versions[0].number, before.versions[0].number + 1);
    assert.deepEqual(after.composition.identityDecisions, [`${decisionRef.id}@${decisionRef.version}`]);
    const working = (await w.manage("/api/releases")).working;
    assert.deepEqual(working.definition.identityDecisions.map(ref), [decisionRef]);
    assert.ok(working.diff.some((entry: any) => entry.path.startsWith("/identityDecisions/")));
    const second = await w.publish("排除机器人"), secondReader = await w.connect(second, "排除后接入");
    assert.deepEqual((await w.external(secondReader.key, "a-bot")).body.items, []);
    assert.equal((await w.external(firstReader.key, "a-bot")).body.items[0].objectRef.id, "P2", "the prior release has an explicit empty decision set");

    await w.decide("a-bot", "match", "P2", "replace-decision");
    const third = await w.publish("新的核对决定"), thirdReader = await w.connect(third, "最新接入");
    assert.equal((await w.external(thirdReader.key, "a-bot")).body.items[0].objectRef.id, "P2");
    assert.deepEqual((await w.external(secondReader.key, "a-bot")).body.items, [], "a superseded decision stays fixed for its release");
    const spec = await w.manage(`/api/releases/connection?id=${secondReader.connection.id}&version=${secondReader.connection.version}`);
    const config = Object.values(spec.mcp.mcpServers)[0] as any;
    await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: { ...config.env, DATAENGINE_CONSUMER_KEY: secondReader.key }, stderr: "pipe" }));
    const result = await client.callTool({ name: "query_objects", arguments: { type: "账号", id: "a-bot", relation: "所属人员" } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.deepEqual((result.structuredContent as any).items, [], "MCP uses the same pinned decisions as HTTP");
  } finally { await client.close(); await w.close(); }
});

test("an explicit identity match is published and current source revocation still blocks a pinned consumer", async () => {
  const w = await identityWorkspace();
  try {
    await w.decide("a-old", "match", "P1", "old-mailbox");
    const release = await w.publish("核对旧邮箱"), reader = await w.connect(release, "旧邮箱接入");
    const result = await w.external(reader.key, "a-old");
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.items[0].objectRef.id, "P1", "explicit identity evidence can override a changed mailbox");
    const source = w.service.app.memory.getArtifact(w.people.id);
    w.service.app.live.sources.disable(source.id, source.version);
    const denied = await w.external(reader.key, "a-old");
    assert.ok(denied.status >= 400, JSON.stringify(denied.body));
    assert.equal(denied.body.items, undefined, "pinned decisions do not retain revoked source authority");
  } finally { await w.close(); }
});

test("a historical release without identity metadata cannot inherit later working decisions", async () => {
  const w = await identityWorkspace();
  try {
    const published = await w.publish("历史发布样本");
    // Imported historical storage shape predates the optional identity-decision field.
    const definition = { ...published.content.definition };
    delete definition.identityDecisions;
    const historical = w.service.app.memory.putArtifact({ kind: "data_release", title: "旧格式发布", status: "published", content: { ...published.content, definition } });
    await w.decide("a-bot", "no_match", null, "new-decision-after-old-format");
    const reader = await w.connect(historical, "旧格式接入");
    const result = await w.external(reader.key, "a-bot");
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.items[0].objectRef.id, "P2", "absence is the empty historical decision set");
  } finally { await w.close(); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { AgentCapabilities } from "../../src/capabilities/service.ts";

test("agent discovers and uses a KodaX Skill without granting embedded shell execution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "de-cap-"));
  const repo = new MemoryStore(dir);
  const hub = new AgentCapabilities(dir);
  try {
    const found = await hub.search("本体");
    assert.match(JSON.stringify(found), /ontology-modeling/);
    const result = await hub.useSkill("ontology-modeling", "验证投诉");
    assert.match(result.content, /验证投诉/);
    assert.match(result.content, /change_propose/);
    assert.doesNotMatch(result.content, /live_propose|foundation_propose/);
    await assert.rejects(hub.useSkill("../secret", ""));
    await assert.rejects(
      hub.installSkill(
        "bad",
        "---\nname: bad\ndescription: bad\n---\n!`echo nope`",
      ),
      /动态/,
    );
  } finally {
    await hub.close();
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import { createHeatingSources } from "../../src/live/heating-sources.ts";
import { readFileSync, statSync } from "node:fs";
import { BusinessSdkRegistry } from "../../src/capabilities/sdk.ts";
import { Octokit } from "@octokit/rest";

test("MCP SDK discovers real tools, requires exact grants, reads live data and persists revocation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "de-mcp-cap-"));
  const repo = new MemoryStore(dir);
  const source = await createHeatingSources();
  let hub = new AgentCapabilities(dir);
  try {
    await hub.mcp.connect({
      name: "callbacks",
      url: source.mcpUrl,
      headers: { "X-Example": "secret-value" },
    });
    const state = await hub.overview();
    assert.doesNotMatch(JSON.stringify(state), /secret-value/);
    const id = state.servers[0].capabilities[0].id;
    await assert.rejects(hub.mcp.call(id, { limit: 20, offset: 0 }), /授权/);
    hub.mcp.grant("callbacks", [id]);
    assert.match(
      JSON.stringify(await hub.mcp.call(id, { limit: 20, offset: 0 })),
      /未改善/,
    );
    source.setOutcome("已改善");
    assert.match(
      JSON.stringify(await hub.mcp.call(id, { limit: 20, offset: 0 })),
      /已改善/,
    );
    assert.doesNotMatch(
      JSON.stringify(repo.listArtifacts()),
      /HF002|secret-value/,
    );
    hub.mcp.grant("callbacks", []);
    await hub.close();
    hub = new AgentCapabilities(dir);
    await assert.rejects(hub.mcp.call(id, { limit: 20, offset: 0 }), /授权/);
    assert.equal(
      statSync(join(dir, "capabilities", "mcp.json")).mode & 0o777,
      0o600,
    );
  } finally {
    await hub.close();
    await source.close();
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("business SDK calls the actual Octokit adapter and rejects unregistered methods and invalid input", async () => {
  let requested = "";
  const sdk = new BusinessSdkRegistry(
    new Octokit({
      request: {
        fetch: async (input: string | URL | Request) => {
          requested = String(input);
          return new Response(
            JSON.stringify({
              full_name: "icetomoyo/KodaX",
              html_url: "https://github.com/icetomoyo/KodaX",
              default_branch: "main",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    }),
  );
  assert.match(
    JSON.stringify(
      await sdk.call("github.repository", {
        owner: "icetomoyo",
        repo: "KodaX",
      }),
    ),
    /icetomoyo\/KodaX/,
  );
  assert.match(requested, /api.github.com\/repos\/icetomoyo\/KodaX/);
  await assert.rejects(sdk.call("process.exec", { command: "whoami" }));
  await assert.rejects(
    sdk.call("github.repository", { owner: "../../", repo: "x" }),
  );
});

import { AgentApplication } from "../../src/agent/app.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";

test("canvas agent can discover and load skills through the same ephemeral run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "de-cap-canvas-"));
  let ran = false;
  const driver: AgentDriver = {
    async run(r) {
      assert(r.ephemeral);
      assert(r.nativeTools?.includes("web_search"));
      assert(r.nativeTools?.includes("web_fetch"));
      const discovery = await r.onTool("capability_search", { query: "本体" });
      assert.match(JSON.stringify(discovery), /ontology-modeling/);
      assert.match(
        JSON.stringify(
          await r.onTool("skill_use", {
            name: "ontology-modeling",
            args: "投诉问题",
          }),
        ),
        /投诉问题/,
      );
      await assert.rejects(r.onTool("sdk_call", { id: "eval", args: {} }));
      ran = true;
      return {
        text: "已加载本体建模方法，请说明希望解决的业务问题。",
        sessionId: "test",
        runId: "test",
      };
    },
    async stop() {},
    async close() {},
  };
  const app = new AgentApplication(dir, driver);
  try {
    await app.canvasMessage({
      page: "company",
      text: "加载本体建模方法",
      messageId: "capability-test",
    });
    await app.idle();
    assert(ran);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP discovery filters a complete catalog, refresh clears grants and disconnect removes access", async () => {
  const dir = mkdtempSync(join(tmpdir(), "de-mcp-maintain-"));
  const repo = new MemoryStore(dir);
  const hub = new AgentCapabilities(dir);
  const source = await createHeatingSources();
  try {
    await hub.mcp.connect({ name: "first", url: source.mcpUrl });
    const id = hub.mcp.list()[0].capabilities[0].id;
    const originalRevision = hub.mcp.list()[0].revision;
    hub.mcp.grant("first", [id]);
    const revision = hub.mcp.list()[0].revision;
    const refreshing = hub.mcp.refresh("first");
    try {
      assert.throws(() => hub.mcp.grant("first", [id]), /刷新/);
    } finally {
      await refreshing;
    }
    await assert.rejects(hub.mcp.call(id, { limit: 20, offset: 0 }), /授权/);
    assert.throws(() => hub.mcp.grant("first", [id], revision), /已改变/);
    assert.equal(
      hub.mcp.snapshot("", { server: "first", kind: "tool" }).items.length,
      1,
    );
    await hub.mcp.disconnect("first");
    assert.equal(hub.mcp.list().length, 0);
    await assert.rejects(hub.mcp.call(id, { limit: 20, offset: 0 }), /授权/);
    await hub.mcp.connect({ name: "first", url: source.mcpUrl });
    assert.throws(
      () => hub.mcp.grant("first", [id], originalRevision),
      /已改变/,
    );
  } finally {
    await hub.close();
    await source.close();
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import { capabilityFixture } from "./capabilities-fixture.ts";
test("MCP finds later services beyond 40 entries, reads resources/prompts and rejects an in-flight revoked result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "de-mcp-catalog-"));
  const repo = new MemoryStore(dir),
    hub = new AgentCapabilities(dir),
    fixture = await capabilityFixture();
  try {
    await hub.mcp.connect({ name: "first", url: fixture.url });
    await hub.mcp.connect({ name: "second", url: fixture.url });
    const found = hub.mcp.snapshot("", { server: "second", kind: "prompt" });
    assert.equal(found.items.length, 1);
    assert.equal(found.items[0].name, "research");
    const caps = hub.mcp.list()[1].capabilities;
    const prompt = caps.find((c) => c.kind === "prompt")!,
      resource = caps.find((c) => c.kind === "resource")!,
      delayed = caps.find((c) => c.name === "delayed")!;
    hub.mcp.grant("second", [prompt.id, resource.id, delayed.id]);
    assert.match(
      JSON.stringify(await hub.mcp.call(prompt.id, { topic: "回访" })),
      /核查 回访/,
    );
    assert.match(
      JSON.stringify(await hub.mcp.call(resource.id)),
      /供热企业业务说明/,
    );
    const pending = hub.mcp.call(delayed.id);
    await fixture.invoked;
    hub.mcp.grant("second", []);
    fixture.release();
    await assert.rejects(pending, /授权已改变/);
  } finally {
    fixture.release();
    await hub.close();
    await fixture.close();
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installed Skill is immediately usable and survives restart; malformed and model-disabled skills are rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "de-skill-install-"));
  let hub = new AgentCapabilities(dir);
  try {
    await hub.installSkill(
      "heating-guide",
      '---\nname: "heating-guide"\ndescription: 检查热力业务\n---\n先核查回访。目标：$ARGUMENTS',
    );
    assert.match(
      (await hub.useSkill("heating-guide", "投诉")).content,
      /先核查回访。目标：投诉/,
    );
    await hub.close();
    hub = new AgentCapabilities(dir);
    assert.match((await hub.useSkill("heating-guide", "供暖")).content, /供暖/);
    await assert.rejects(
      hub.installSkill(
        "broken-guide",
        "---\nname: broken-guide\ndescription: bad\nmissing delimiter",
      ),
    );
    await assert.rejects(
      hub.installSkill(
        "disabled-guide",
        "---\nname: disabled-guide\ndescription: bad\ndisable-model-invocation: true\n---\nmanual only",
      ),
      /禁止/,
    );
    await assert.rejects(
      hub.skills.read("enterprise-research", "../../../package.json"),
      /只能/,
    );
  } finally {
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

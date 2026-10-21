import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentApplication } from "../../src/agent/app.ts";
import type { AgentDriver, RunRequest } from "../../src/agent/runtime.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";

// Prompts use snake_case for tool names; JSON parameter names remain camelCase.
const toolReferences = (text: string) =>
  [...new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])];

function assertPromptContract(text: string, request: RunRequest, label: string) {
  const available = new Set([
    ...request.tools.map((tool) => tool.name),
    ...(request.nativeTools ?? []),
    "same_as", "belongs_to", "no_match", // Semantic rule/decision values, not callable tools.
  ]);
  for (const name of toolReferences(text)) {
    assert(available.has(name), `${label} mentions unavailable tool ${name}`);
  }
  assert.doesNotMatch(text, /企业与数据|本体工作区|消费与治理|report_save/);
  assert.match(text, /回执/);
}

test("identity and shared rules refer only to tools offered by each actual run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-prompt-contract-"));
  const requests: RunRequest[] = [];
  const driver: AgentDriver = {
    async run(request) {
      requests.push(request);
      return { text: "已核对当前范围。", sessionId: "prompt", runId: "prompt" };
    },
    async stop() {},
    async close() {},
  };
  const app = new AgentApplication(directory, driver, new Set(), false);
  try {
    for (const page of ["setup", "ontology", "consumption"] as const) {
      await app.canvasNavigate({ page });
      await app.canvasMessage({ page, text: "查看当前本体与依据。" });
      await app.idle();
      const request = requests.at(-1)!;
      assertPromptContract(request.system, request, page);
      assert.match(request.system, /身份/);
      assert.match(request.system, /通用规则/);
      assert.match(request.system, /构建模式/);
      assert.match(request.system, /change_propose/);
      assert.doesNotMatch(request.system, /gap_report|自动切换模式/);
    }
    await app.message({ text: "查看已有成果。" });
    await app.idle();
    const request = requests.at(-1)!;
    assertPromptContract(request.system, request, "legacy task");
    assert.match(request.system, /结构变化|所有结构修改/);
    await app.message({ text: "查询已有业务数据。", mode: "qa" });
    await app.idle();
    const qa = requests.at(-1)!;
    assertPromptContract(qa.system, qa, "question-answer mode");
    assert.match(qa.system, /问答模式/);
    assert.doesNotMatch(qa.system, /change_propose/);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bundled methods remain compatible with interactive and document-only tool scopes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-skill-contract-"));
  const requests: RunRequest[] = [];
  const driver: AgentDriver = {
    async run(request) {
      requests.push(request);
      return { text: "已读取范围。", sessionId: "skill", runId: "skill" };
    },
    async stop() {},
    async close() {},
  };
  const app = new AgentApplication(directory, driver);
  try {
    for (const page of ["setup", "ontology"] as const) {
      await app.canvasNavigate({ page });
      await app.canvasMessage({ page, text: "核对已有本体。" });
      await app.idle();
      const request = requests.at(-1)!;
      for (const { name } of await app.capabilities.skills.list()) {
        const skill = await app.capabilities.useSkill(name, "核对已有定义");
        assertPromptContract(skill.content, request, `${page}/${name}`);
      }
    }
    seedFoundation(app.memory, app.foundation, {
      enterprise: "回归企业",
      concepts: [{ id: "task", name: "任务", description: "任务记录" }],
      program: true,
    });
    await app.canvasNavigate({ page: "setup" });
    await app.canvasUpload({ page: "setup", name: "说明.md", content: "回归企业的任务记录用于安排负责人。" });
    await app.idle();
    const automatic = requests.find((request) => JSON.parse(request.input).mode === "automatic-document-ontology");
    assert(automatic, "the real document queue must assemble an automatic run");
    const method = readFileSync(new URL("../../config/agent/automatic-document.md", import.meta.url), "utf8");
    assertPromptContract(method, automatic, "document-only method");
    assert.doesNotMatch(method, /新概念按需增加|明确确认采用|直接形成基础候选/);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

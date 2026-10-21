import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { foundationSession, runFoundationSession, type FoundationSession } from "./foundation-domain-fixture.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";

test("host domain evidence and quoted conversation refine the rule-built foundation while preserving unmapped structure across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-foundation-"));
  let ran = false;
  const run = async (session: FoundationSession) => {
      const input = { foundation: session.read().current, recentMessages: service.app.memory.messages(session.taskId) };
      const message = session.message;
      assert.match(readFileSync("config/skills/company-foundation-ontology/SKILL.md", "utf8"), /change_propose/);
      const saved = (await session.propose( {
        baseVersion: input.foundation?.version ?? 0,
        enterprise: { name: "澄川热力", evidenceRefs: ["e1"] },
        concepts: [
          {
            id: "heating",
            name: "供热服务",
            description: "企业向居民提供的供热服务",
            evidenceRefs: ["e1"],
          },
          {
            id: "resident",
            name: "居民",
            description: "供热服务的服务对象",
            evidenceRefs: ["e1"],
          },
        ],
        relations: [
          {
            id: "serves",
            name: "服务于",
            from: "heating",
            to: "resident",
            description: "供热服务面向居民",
            evidenceRefs: ["e1"],
          },
        ],
        evidence: [
          { id: "e1", messageId: message.id, quote: "澄川热力主营居民供热" },
        ],
        unknowns: [{ id: "area", description: "服务区域尚未提供" }],
        conflicts: [],
      })) as any;
      assert.equal(saved.status, "candidate");
      ran = true;
      return {
        text: "基础候选已保存，尚未绑定数据来源。",
        sessionId: "foundation",
        runId: "foundation",
      };
  };
  let service = await createServer({ directory });
  seedFoundation(service.app.memory, service.app.foundation, { enterprise: "澄川热力", concepts: [{ id: "heating", name: "供热服务", description: "来自供热表的记录。" }, { id: "resident", name: "居民", description: "来自居民表的记录。" }], relations: [{ id: "serves", name: "服务于", from: "heating", to: "resident", description: "供热表关联居民表。" }] });
  const start = async () => {
    await new Promise<void>((resolve) =>
      service.server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    return async (path = "/api/canvas", body?: unknown) => {
      const response = await fetch(base + path, {
        method: body ? "POST" : "GET",
        headers: {
          "x-dataengine-token": service.adminToken,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert(response.ok, await response.clone().text());
      return response.json();
    };
  };
  try {
    let api = await start();
    await runFoundationSession(service.app, "澄川热力主营居民供热", run, { messageId: "foundation-user" });
    assert(ran, JSON.stringify((await api()).messages));
    const before = await api();
    const candidate = before.foundation.current;
    assert.equal(before.sources.length, 0);
    assert.notEqual(before.foundation.adopted.version, candidate.version, "the rule-built version stays adopted until the user decides");
    assert.equal(candidate.content.checks.valid, true);
    assert.deepEqual(candidate.content.concepts.map((item: any) => [item.id, item.origin]), [["heating", "program"], ["resident", "program"]]);
    assert.deepEqual(candidate.content.relations.map((item: any) => [item.id, item.from, item.to, item.origin]), [["serves", "heating", "resident", "program"]]);
    assert.equal(candidate.content.concepts[0].mappingStatus, "unbound");
    const decision = {
      page: "setup",
      id: candidate.id,
      version: candidate.version,
    };
    // Failure at the real storage boundary must not commit adoption without its decision receipt.
    const fault = new DatabaseSync(join(directory, "memory.sqlite"));
    try {
      fault.exec(`CREATE TRIGGER reject_foundation_decision BEFORE INSERT ON messages
        WHEN NEW.id='foundation-adoption' BEGIN SELECT RAISE(ABORT, 'decision save failed'); END;`);
      await assert.rejects(
        api("/api/canvas/foundation/adopt", {
          ...decision,
          messageId: "foundation-adoption",
        }),
        /decision save failed/,
      );
      assert.equal((await api()).foundation.current.status, "candidate");
      fault.exec("DROP TRIGGER reject_foundation_decision");
    } finally {
      fault.close();
    }
    const adopted = await api("/api/canvas/foundation/adopt", {
      ...decision,
      messageId: "foundation-adoption",
    });
    assert.equal(
      adopted.messages.filter((message: any) => message.role === "user").length,
      1,
    );
    assert.equal(
      adopted.messages.filter(
        (message: any) => message.id === "foundation-adoption",
      ).length,
      1,
    );
    await api("/api/canvas/foundation/adopt", {
      ...decision,
      messageId: "foundation-adoption",
    });
    assert.equal(adopted.foundation.adopted.status, "adopted");
    assert.equal(
      adopted.foundation.adopted.content.consumerReadiness.objectsQueryable,
      false,
    );
    assert.equal(adopted.pages.find((p: any) => p.id === "setup").ready, true);
    assert.equal(
      adopted.pages.find((p: any) => p.id === "ontology").ready,
      false,
    );
    assert.equal(
      (await api("/api/canvas/foundation/adopt", decision)).foundation.adopted
        .version,
      candidate.version + 1,
    );
    await service.close();
    service = await createServer({ directory });
    api = await start();
    const restored = await api("/api/canvas/navigate", { page: "ontology" });
    assert.equal(restored.foundation.adopted.id, candidate.id);
    assert.equal(
      restored.foundation.adopted.content.evidence.find((item: any) => item.id === "e1").quote,
      "澄川热力主营居民供热",
    );
    assert.equal(restored.foundation.adopted.content.concepts[0].id, "heating");
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("foundation revisions preserve adopted meaning and unknowns, rejecting fake evidence and stale decisions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-foundation-revision-"));
  let runs = 0;
  let checked = 0;
  const run = async (session: FoundationSession) => {
      const round = ++runs;
      const input = { foundation: session.read().current, recentMessages: service.app.memory.messages(session.taskId) };
      const message = session.message;
      const draft: any = {
        baseVersion: input.foundation?.version ?? 0,
        enterprise: { name: "澄川热力", evidenceRefs: ["e1"] },
        concepts: [
          {
            id: "resident",
            name: "居民",
            description: "居民供热服务的客户",
            evidenceRefs: ["e1"],
          },
        ],
        relations: [],
        evidence:
          round === 1
            ? [
                {
                  id: "e1",
                  messageId: message.id,
                  quote: "澄川热力主营居民供热",
                },
              ]
            : [],
        unknowns:
          round === 1 ? [{ id: "area", description: "服务区域尚未提供" }] : [],
        conflicts: [],
      };
      await assert.rejects(session.propose(draft, ""), /加载/);
      if (round === 1) {
        new Workspace(service.app.memory).editProfile("company.name", "澄川热力");
        await assert.rejects(
          session.propose( {
            ...draft,
            evidence: [
              {
                id: "e1",
                messageId: message.id,
                quote: "澄川热力拥有十万用户",
              },
            ],
          }),
          /真实用户原话/,
        );
        await assert.rejects(
          session.propose( {
            ...draft,
            relations: [
              {
                id: "bad",
                name: "关联",
                description: "无端点",
                from: "missing",
                to: "resident",
                evidenceRefs: ["e1"],
              },
            ],
          }),
          /端点|数据程序/,
        );
        const saved = (await session.propose(draft)) as any;
        assert.equal(
          ((await session.propose( draft)) as any).version,
          saved.version,
        );
      } else {
        const assistant = service.app.memory.addMessage(session.taskId, "assistant", "未经用户确认的推测");
        await assert.rejects(
          session.propose( {
            ...draft,
            evidence: [
              { id: "fake", messageId: assistant.id, quote: assistant.content },
            ],
          }),
          /真实用户原话/,
        );
        await assert.rejects(
          session.propose( {
            ...draft,
            evidence: [
              { id: "e1", messageId: message.id, quote: message.content },
            ],
          }),
          /不可改写/,
        );
        await assert.rejects(
          session.propose( {
            ...draft,
            unknowns: [
              {
                id: "area",
                description: "服务区域尚未提供",
                resolvedBy: ["e1"],
              },
            ],
          }),
          /新.*原话/,
        );
        draft.concepts = [
          {
            id: "ticket",
            name: "维修工单",
            description: "客服派发的维修工作记录",
            evidenceRefs: ["e2"],
          },
        ];
        draft.evidence = [
          { id: "e2", messageId: message.id, quote: "客服派发维修工单" },
        ];
        const saved = (await session.propose(draft)) as any;
        assert.equal(saved.version, draft.baseVersion + 1);
        const visible = (await session.read()) as any;
        assert.equal(visible.adopted.version, draft.baseVersion);
        assert.equal(visible.current.content.concepts.length, 2);
        assert.equal(
          visible.current.content.unknowns[0].description,
          "服务区域尚未提供",
        );
        assert.equal(visible.current.content.changes[0].after.name, "维修工单");
        await assert.rejects(
          session.propose( { ...draft, concepts: [] }),
          /版本已变化/,
        );
      }
      checked++;
      return {
        text: "已保存，未绑定来源。",
        sessionId: "revision",
        runId: "revision",
      };
  };
  const service = await createServer({ directory });
  seedFoundation(service.app.memory, service.app.foundation, { enterprise: "澄川热力", concepts: [{ id: "resident", name: "居民", description: "来自居民表的记录。" }, { id: "ticket", name: "工单", description: "来自工单表的记录。" }], relations: [] });
  try {
    await runFoundationSession(service.app, "澄川热力主营居民供热", run, { messageId: "revision-1" });
    assert.equal(
      checked,
      1,
      JSON.stringify(service.app.canvasState().messages),
    );
    const initial = service.app.canvasState().foundation.current!;
    await service.app.canvasFoundationAdopt({
      page: "setup",
      id: initial.id,
      version: initial.version,
    });
    await runFoundationSession(service.app, "客服派发维修工单", run, { messageId: "revision-2" });
    assert.equal(
      checked,
      2,
      JSON.stringify(service.app.canvasState().messages),
    );
    await assert.rejects(
      service.app.canvasFoundationAdopt({
        page: "setup",
        id: initial.id,
        version: 1,
      }),
      /版本已变化/,
    );
    assert.equal(service.app.canvasState().foundation.adopted!.version, initial.version + 1);
    const profile = service.app.canvasState().profile!;
    await service.app.editProfile({
      id: profile.id,
      expectedVersion: profile.version,
      key: "company.name",
      text: "另一家企业",
    });
    await assert.rejects(
      service.app.canvasFoundationAdopt({
        page: "setup",
        id: initial.id,
        version: service.app.canvasState().foundation.current!.version,
      }),
      /企业信息已变化/,
    );
    assert.equal(service.app.canvasState().foundation.adopted!.version, initial.version + 1);
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stopping a host foundation execution prevents late saves; unresolved conflicts block adoption", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-foundation-stop-"));
  const service = await createServer({ directory });
  const seeded = seedFoundation(service.app.memory, service.app.foundation, { enterprise: "澄川热力", concepts: [{ id: "resident", name: "居民", description: "来自居民表的记录。" }] });
  const draft = (session: FoundationSession) => ({ baseVersion: session.read().current!.version,
    enterprise: { name: "澄川热力", evidenceRefs: ["e1"] },
    concepts: [{ id: "resident", name: "居民", description: "供热用户", evidenceRefs: ["e1"] }], relations: [],
    evidence: [{ id: "e1", messageId: session.message.id, quote: session.message.content }], unknowns: [],
    conflicts: [{ id: "area", description: "服务区域尚待核对两个说法" }],
  });
  try {
    const stopped = foundationSession(service.app, "澄川热力主营居民供热");
    service.app.memory.pauseTask(stopped.taskId, "用户已停止");
    await assert.rejects(stopped.propose(draft(stopped)), /暂停|失效|结束|有效|中断/);
    stopped.close();
    assert.equal(service.app.foundation.read().current!.version, seeded.version);
    const candidate = await runFoundationSession(service.app, "澄川热力主营居民供热", session => session.propose(draft(session))) as any;
    await assert.rejects(service.app.canvasFoundationAdopt({ page: "setup", id: candidate.id, version: candidate.version }), /冲突/);
    assert.equal(service.app.foundation.read().adopted!.version, seeded.version);
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("an explicit same-enterprise name correction retains semantic identity and awaits adoption", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-foundation-name-"));
  let checked = 0;
  const run = async (session: FoundationSession) => {
      const input = { foundation: session.read().current, recentMessages: service.app.memory.messages(session.taskId) };
      const message = session.message;
      const revision = message.id !== "name-1";
      const name = revision ? "澄川热力有限公司" : "澄川热力";
      new Workspace(service.app.memory).editProfile("company.name", name);
      const draft: any = {
        baseVersion: input.foundation?.version ?? 0,
        enterprise: { name, evidenceRefs: [revision ? "e2" : "e1"] },
        concepts: revision
          ? []
          : [
              {
                id: "resident",
                name: "居民",
                description: "供热用户",
                evidenceRefs: ["e1"],
              },
            ],
        relations: [],
        evidence: [
          {
            id: revision ? "e2" : "e1",
            messageId: message.id,
            quote: message.content,
          },
        ],
        unknowns: [],
        conflicts: [],
      };
      if (revision) {
        await assert.rejects(
          session.propose( draft),
          /主体|名称/,
        );
        draft.identityCorrection = {
          previousName: "澄川热力",
          evidenceRefs: ["e2"],
        };
      } else {
        await assert.rejects(
          session.propose( {
            ...draft,
            relations: [{ id: "resident", name: "认识", description: "同类关系", from: "resident", to: "resident", evidenceRefs: ["e1"] }],
          }),
          /数据程序/,
        );
        await assert.rejects(
          session.propose( {
            ...draft,
            // The duplicate must use an existing concept: new relations fail the structure lock first.
            concepts: [draft.concepts[0], { ...draft.concepts[0] }],
          }),
          /标识重复/,
        );
      }
      await session.propose( draft);
      checked++;
      return { text: "已保存名称纠正候选。", runId: "name", sessionId: "name" };
  };
  const service = await createServer({ directory });
  seedFoundation(service.app.memory, service.app.foundation, { enterprise: "澄川热力", concepts: [{ id: "resident", name: "居民", description: "来自居民表的记录。" }], relations: [] });
  try {
    await runFoundationSession(service.app, "澄川热力主营居民供热", run, { messageId: "name-1" });
    assert.equal(
      checked,
      1,
      JSON.stringify(service.app.canvasState().messages),
    );
    const initial = service.app.canvasState().foundation.current!;
    await service.app.canvasFoundationAdopt({
      page: "setup",
      id: initial.id,
      version: initial.version,
    });
    await runFoundationSession(service.app, "还是同一家企业，正式全称是澄川热力有限公司，请把简称改成全称。", run, { messageId: "name-2" });
    assert.equal(
      checked,
      2,
      JSON.stringify(service.app.canvasState().messages),
    );
    const revised = service.app.canvasState().foundation;
    assert.equal(revised.current!.id, initial.id);
    assert.equal(
      revised.adopted!.content.enterprise &&
        (revised.adopted!.content.enterprise as any).name,
      "澄川热力",
    );
    assert.equal(
      (revised.current!.content.enterpriseChange as any).before,
      "澄川热力",
    );
    const adopted = await service.app.canvasFoundationAdopt({
      page: "setup",
      id: initial.id,
      version: service.app.canvasState().foundation.current!.version,
    });
    assert.equal(
      (adopted.foundation.adopted!.content.enterprise as any).name,
      "澄川热力有限公司",
    );
    assert.equal(
      (adopted.foundation.adopted!.content.concepts as any[])[0].id,
      "resident",
    );
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

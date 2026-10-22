import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";
import { runFoundationSession } from "./foundation-domain-fixture.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";

test("uploaded enterprise text is read before citation and its versioned excerpt reopens after replacement and restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-foundation-docs-"));
  const original =
    "# 澄川热力\n澄川热力为居民提供供热服务。\n客服部门受理居民投诉。\n";
  let saved = false;
  let sourceId = "";
  const driver: AgentDriver = {
    async run(request) {
      const input = JSON.parse(request.input);
      sourceId = input.sources[0].id;
      if (input.mode !== "automatic-document-ontology") await request.onTool("skill_use", {
        name: "company-foundation-ontology",
      });
      const excerpt = (await request.onTool("foundation_document_read", {
        sourceId,
        limit: 6000,
      })) as any;
      assert.equal(excerpt.text, original);
      assert.equal(excerpt.coverage.complete, true);
      const draft = {
        baseVersion: ((await request.onTool("foundation_read", {})) as any).current.version,
        enterprise: { name: "澄川热力", evidenceRefs: ["doc-1"] },
        concepts: [
          {
            id: "resident",
            name: "居民",
            description: "供热服务的客户",
            evidenceRefs: ["doc-1"],
          },
        ],
        relations: [],
        evidence: [
          {
            id: "doc-1",
            kind: "document",
            readId: excerpt.readId,
            quote: "澄川热力为居民提供供热服务。",
          },
        ],
        unknowns: [],
        conflicts: [],
      };
      await assert.rejects(
        request.onTool("foundation_propose", {
          ...draft,
          evidence: [{ ...draft.evidence[0], readId: "invented" }],
        }),
        /读取/,
      );
      await assert.rejects(
        request.onTool("foundation_propose", {
          ...draft,
          evidence: [{ ...draft.evidence[0], quote: "企业拥有十万用户" }],
        }),
        /片段|原文/,
      );
      const candidate = (await request.onTool(
        "foundation_propose",
        draft,
      )) as any;
      assert.equal(candidate.staged, true);
      assert.deepEqual(candidate.updated.concepts, ["resident"]);
      saved = true;
      return { text: "资料候选已保存。", sessionId: "docs", runId: "docs" };
    },
    async stop() {},
    async close() {},
  };
  let service = await createServer({ directory, driver });
  seedFoundation(service.app.memory, service.app.foundation, {
    enterprise: "澄川热力",
    concepts: [
      { id: "resident", name: "居民", description: "来自居民表的记录，业务含义待核对。" },
    ],
  });
  const start = async () => {
    await new Promise<void>((resolve) =>
      service.server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    return async (path: string, body?: unknown) => {
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
    await api("/api/canvas/upload", {
      page: "setup",
      name: "企业说明.md",
      content: original,
    });
    await service.app.idle();
    assert(saved, JSON.stringify((await api("/api/canvas")).messages));
    const current = (await api("/api/canvas")).foundation.current;
    assert.equal(current.status, "adopted");
    assert.deepEqual(current.content.concepts.map((item: any) => [item.id, item.origin]), [["resident", "program"]]);
    assert.equal(current.content.evidence.find((item: any) => item.id === "doc-1").sourceVersion, 1);
    assert.equal(current.content.evidence.find((item: any) => item.id === "doc-1").kind, "document");
    assert.equal((await api("/api/canvas")).pending, null);
    await service.close();
    const idle: AgentDriver = {
      async run() {
        return { text: "待检查新版本。", sessionId: "idle", runId: "idle" };
      },
      async stop() {},
      async close() {},
    };
    service = await createServer({ directory, driver: idle });
    api = await start();
    await api("/api/canvas/upload", {
      page: "setup",
      name: "企业说明.md",
      content: "澄川热力现服务工业企业。",
    });
    await service.app.idle();
    const evidence = await api(
      `/api/foundation/evidence?foundationId=${current.id}&version=${current.version}&evidenceId=doc-1`,
    );
    assert.equal(evidence.sourceId, sourceId);
    assert.equal(evidence.sourceVersion, 1);
    assert.equal(evidence.currentSourceVersion, 2);
    assert(evidence.text.includes("为居民提供供热服务"));
    assert.equal(evidence.quote, "澄川热力为居民提供供热服务。");
    const afterReplacement = await api("/api/canvas");
    assert.equal(afterReplacement.foundation.adopted.id, current.id);
    assert(afterReplacement.attention.some((item: any) => item.kind === "source_changed" && item.artifactId === sourceId));
    assert(!afterReplacement.attention.some((item: any) => item.kind === "source_unreviewed" && item.artifactId === sourceId));
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("document changes retain prior meaning as a conflict; a fresh human adjudication resolves it on the same foundation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-doc-conflict-"));
  let sourceId = "", checked = false;
  const driver: AgentDriver = {
    async run(request) {
      const input = JSON.parse(request.input);
      assert.equal(input.mode, "automatic-document-ontology", "only the host document job retains its internal proposal method");
      sourceId = input.sources[0].id;
      const before = await request.onTool("foundation_read", {}) as any;
      const unknowns = await request.onTool("foundation_read", { section: "unknowns" }) as any;
      const area = unknowns.current.content.unknowns.find((item: any) => item.description === "服务区域未知");
      assert(area, "the document job reads the real unresolved item before citing its identifier");
      const part = await request.onTool("foundation_document_read", { sourceId }) as any;
      const candidate = await request.onTool("foundation_propose", { baseVersion: before.current.version,
        enterprise: { name: "澄川热力", evidenceRefs: ["e1"] },
        concepts: [{ id: "customer", name: "客户", description: "接受供热服务的工业企业", evidenceRefs: ["d1"] }], relations: [],
        evidence: [{ id: "d1", kind: "document", readId: part.readId, quote: part.text }],
        unknowns: [{ id: area.id, description: "服务区域未知", resolvedBy: ["d1"] }], conflicts: [],
      }) as any;
      assert.equal(candidate.staged, true);
      assert.deepEqual(candidate.updated.unknowns, [area.id]);
      checked = true;
      return { text: "资料分歧已保留。", sessionId: "doc", runId: "doc" };
    }, async stop() {}, async close() {},
  };
  const service = await createServer({ directory, driver });
  seedFoundation(service.app.memory, service.app.foundation, { enterprise: "澄川热力", concepts: [{ id: "customer", name: "客户", description: "来自客户表的记录，业务含义待核对。" }] });
  const proposeUser = (text: string, description: string, evidenceId: string) => runFoundationSession(service.app, text, session => session.propose({
    baseVersion: session.read().current!.version, enterprise: { name: "澄川热力", evidenceRefs: ["e1"] },
    concepts: [{ id: "customer", name: "客户", description, evidenceRefs: [evidenceId] }], relations: [],
    evidence: [{ id: evidenceId, messageId: session.message.id, quote: text }],
    unknowns: evidenceId === "e1" ? [{ id: "area", description: "服务区域未知" }] : [], conflicts: [],
  }));
  try {
    const initial = await proposeUser("澄川热力为居民供热，客户指接受供热服务的居民", "接受供热服务的居民", "e1") as any;
    await service.app.canvasFoundationAdopt({ page: "setup", id: initial.id, version: initial.version });
    await service.app.canvasUpload({ page: "setup", name: "业务说明.txt", content: "澄川热力的客户指工业企业，服务区域为城北。" });
    await service.app.idle();
    assert(checked, JSON.stringify(service.app.canvasState().automaticBuild));
    const after = service.app.foundation.read().adopted!;
    assert.equal((after.content.concepts as any[])[0].description, "接受供热服务的居民");
    assert.equal((after.content.conflicts as any[])[0].retained.description, "接受供热服务的居民");
    assert.deepEqual((after.content.unknowns as any[])[0].resolvedBy, ["d1"]);
    const selected = service.app.canvasContext({ page: "ontology", context: { view: "ontology.definitions", revision: 0,
      selection: [{ spaceId: service.app.canvasState().workspaceId, kind: "foundation_concept", id: after.id, version: after.version, member: "customer" }],
      scope: { where: {}, offset: 0, limit: 20 }, draftRef: { id: "conflict-view", revision: 0 },
    } }).target!.definition as any;
    assert.equal(selected.conflicts[0].retained.description, "接受供热服务的居民");
    assert.equal(selected.conflicts[0].proposed.description, "接受供热服务的工业企业");
    assert(selected.evidence.some((e: any) => e.kind === "document"));
    assert.equal(selected.unresolvedConflictCount, 1);
    const conflict = (after.content.conflicts as any[])[0];
    const proposal = await service.app.adjudication.propose({ operationId: "doc-choice", foundationRef: { id: after.id, version: after.version },
      issue: { kind: "conflict", id: conflict.id }, action: "choose_proposed", reason: "确认采用文档中的工业企业客户含义，原居民范围不再适用。" });
    const verified = await service.app.changes.verify({ id: proposal.change.id, version: proposal.change.version, operationId: "doc-choice-check" });
    await service.app.changes.adopt({ id: verified.id, version: verified.version, operationId: "doc-choice-adopt" });
    const accepted = service.app.foundation.read().adopted!;
    assert.equal(accepted.id, initial.id);
    assert.equal((accepted.content.concepts as any[])[0].id, "customer");
    assert.equal((accepted.content.concepts as any[])[0].description, "接受供热服务的工业企业");
    assert(sourceId);
    const back = await proposeUser("更正，客户仍指接受供热服务的居民。", "接受供热服务的居民", "back") as any;
    await service.app.canvasFoundationAdopt({ page: "setup", id: back.id, version: back.version });
    const repeated = await runFoundationSession(service.app, "再检查资料中的客户定义。", session => session.propose({
      baseVersion: session.read().current!.version, enterprise: { name: "澄川热力", evidenceRefs: ["e1"] },
      concepts: [{ id: "customer", name: "客户", description: "接受供热服务的工业企业", evidenceRefs: ["d1"] }],
      relations: [], evidence: [], unknowns: [], conflicts: [],
    })) as any;
    await assert.rejects(service.app.canvasFoundationAdopt({ page: "setup", id: repeated.id, version: repeated.version }), /冲突/);
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("bad text fails explicitly and bounded document reads cannot cite unread tail or adopt after source replacement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-doc-boundary-"));
  let checked = 0;
  let replacement = false;
  let validSourceId = "";
  const driver: AgentDriver = {
    async run(request) {
      if (replacement)
        return { text: "新资料待检查。", sessionId: "new", runId: "new" };
      const input = JSON.parse(request.input);
      const sourceId = input.sources[0].id;
      if (input.mode !== "automatic-document-ontology") await request.onTool("skill_use", {
        name: "company-foundation-ontology",
      });
      validSourceId = sourceId;
      const part = (await request.onTool("foundation_document_read", {
        sourceId,
        limit: 20,
      })) as any;
      assert.equal(part.text.length, 20);
      assert.equal(part.coverage.complete, false);
      assert.equal(part.coverage.nextOffset, 20);
      const draft = {
        baseVersion: ((await request.onTool("foundation_read", {})) as any).current.version,
        enterprise: { name: "澄川热力", evidenceRefs: ["d1"] },
        concepts: [
          {
            id: "resident",
            name: "居民",
            description: "供热客户",
            evidenceRefs: ["d1"],
          },
        ],
        relations: [],
        evidence: [
          {
            id: "d1",
            kind: "document",
            readId: part.readId,
            quote: "澄川热力为居民供热。",
          },
        ],
        unknowns: [],
        conflicts: [],
      };
      await assert.rejects(
        request.onTool("foundation_propose", {
          ...draft,
          evidence: [{ ...draft.evidence[0], quote: "尾部未读取的证据" }],
        }),
        /实际读取/,
      );
      await request.onTool("foundation_propose", draft);
      checked++;
      return {
        text: "已保存有界片段候选。",
        sessionId: "bounded",
        runId: "bounded",
      };
    },
    async stop() {},
    async close() {},
  };
  const service = await createServer({ directory, driver });
  seedFoundation(service.app.memory, service.app.foundation, {
    enterprise: "澄川热力",
    concepts: [
      { id: "resident", name: "居民", description: "来自居民表的记录，业务含义待核对。" },
    ],
  });
  try {
    await service.app.canvasUpload({
      page: "setup",
      name: "empty.txt",
      content: " \n",
    });
    await service.app.idle();
    assert.equal(service.app.canvasState().sources[0].status, "failed");
    await service.app.canvasUpload({
      page: "setup",
      name: "binary.md",
      content: "\u0000not text",
    });
    await service.app.idle();
    assert.equal(service.app.canvasState().sources[0].status, "failed");
    await assert.rejects(
      service.app.canvasUpload({
        page: "setup",
        name: "unavailable.pdf",
        content: "pdf",
      }),
      /仅支持/,
    );
    await service.app.canvasUpload({
      page: "setup",
      name: "long.md",
      content:
        "澄川热力为居民供热。" + "正文".repeat(4000) + "尾部未读取的证据",
    });
    await service.app.idle();
    assert.equal(
      checked,
      1,
      JSON.stringify(service.app.canvasState().automaticBuild),
    );
    const candidate = service.app.canvasState().foundation.current!;
    replacement = true;
    await service.app.canvasUpload({
      page: "setup",
      name: "long.md",
      content: "澄川热力为居民供热。资料版本已核对。",
    });
    await service.app.idle();
    await assert.rejects(
      service.app.canvasFoundationAdopt({
        page: "setup",
        id: candidate.id,
        version: candidate.version,
      }),
      /候选版本已变化/,
    );
    const resave = async (reread: boolean) => runFoundationSession(service.app, "核对当前资料", async session => {
      const before = session.read().current!;
      const latest = reread ? session.documents.read({ sourceId: validSourceId }) : null;
      const saved = await session.propose({ baseVersion: before.version, enterprise: before.content.enterprise,
        concepts: [], relations: [], evidence: latest ? [{ id: "d2", kind: "document", readId: latest.readId, quote: latest.text }] : [], unknowns: [], conflicts: [] });
      checked++;
      return saved;
    });
    await resave(false);
    assert.equal(checked, 2);
    await assert.rejects(
      service.app.canvasFoundationAdopt({
        page: "setup",
        id: candidate.id,
        version: candidate.version + 1,
      }),
      /资料已更新/,
    );
    assert.equal(service.app.canvasState().foundation.adopted?.version, candidate.version);
    await resave(true);
    assert.equal(checked, 3);
    const reviewed = service.app.canvasState().foundation.current!;
    assert.equal((reviewed.content.documentVersions as any)[validSourceId], 2);
    await service.app.canvasFoundationAdopt({
      page: "setup",
      id: candidate.id,
      version: reviewed.version,
    });
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

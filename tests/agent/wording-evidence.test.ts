import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "../../src/agent/server.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";
import { createKnowledgeSource, knowledgeCapability } from "./knowledge-fixture.ts";
import { identityWorkspace, ref } from "./identity-fixture.ts";
import { freezeAgentTurn } from "../../src/agent/agent-modes.ts";
import { FoundationDocuments } from "../../src/agent/foundation-evidence.ts";

test("unified Agent wording retains authenticated web and knowledge citations across restart without exposing their full snapshots", { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-wording-evidence-")), upstream = await createKnowledgeSource();
  const site = createHttpServer((_req, res) => { res.setHeader("content-type", "text/plain; charset=utf-8"); res.end("澄川热力的客服部门受理居民咨询。" + "官网补充资料。".repeat(300)); });
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/company`;
  let connectionId = "", completed = false;
  const driver: AgentDriver = {
    async run(request) {
      assert(!request.tools.some(tool => tool.name === "foundation_propose"));
      const message = JSON.parse(request.input).recentMessages.filter((item: any) => item.role === "user").at(-1);
      const web = await request.onTool("foundation_web_read", { url, identity: { name: "澄川热力", messageId: message.id, quote: message.content } }) as any;
      const knowledge = await request.onTool("knowledge_read", { sourceId: connectionId, capability: "documents", segmentId: "company-1", revision: "r1" }) as any;
      for (const [id, kind, readId, quote, description] of [
        ["website", "web", web.readId, "澄川热力的客服部门受理居民咨询。", "受理居民咨询"],
        ["knowledge", "knowledge", knowledge.readId, "客服部门受理居民投诉。", "受理居民咨询和投诉"],
      ]) {
        const baseline = (await request.onTool("pending_list", {}) as any).baseline;
        const proposal = { operationId: id, type: "description", baseline, subject: { target: "concept", id: "service", description, evidence: [{ id, kind, readId, quote }] }, evidence: quote };
        const result = await request.onTool("change_propose", proposal) as any;
        assert.equal(result.change.status, "adopted");
        assert.equal(JSON.stringify(result).includes("官网补充资料"), false);
        const evidenceRef = result.change.content.subject.evidenceRefs[0];
        const receipt = await request.onTool("memory_read", evidenceRef) as any;
        assert.equal(receipt.content.evidence, undefined);
        assert.equal(receipt.content.evidenceLibrary.count, 1);
        assert.equal((await request.onTool("change_propose", proposal) as any).change.id, result.change.id, "a lost-response retry retains the authenticated receipt and one change");
      }
      completed = true;
      return { text: "已保存有原文依据的客服说明。", sessionId: "evidence", runId: "evidence" };
    }, async stop() {}, async close() {},
  };
  let service = await createServer({ directory, driver, researchTestOrigins: new Set([new URL(url).origin]), automaticApi: false });
  try {
    seedFoundation(service.app.memory, service.app.foundation, { enterprise: "澄川热力", concepts: [{ id: "service", name: "客服", description: "来自客服表的记录。" }] });
    const connection = await service.app.live.sources.connect({ name: "企业知识", protocol: "http", url: upstream.url, capabilities: [knowledgeCapability] });
    connectionId = connection.id;
    await service.app.canvasMessage({ page: "ontology", text: "请依据官网和知识库核对澄川热力客服的业务说明。", messageId: "citation-request" });
    await service.app.idle();
    assert(completed, JSON.stringify(service.app.canvasState().messages));
    assert.match(service.app.canvasState().messages.at(-1)!.content, /资料存在分歧，原含义保持/);
    const foundation = service.app.foundation.read().adopted!;
    assert.equal((foundation.content.concepts as any[])[0].description, "受理居民咨询", "later source disagreement cannot silently replace the accepted meaning");
    const conflict = (foundation.content.conflicts as any[]).find(item => !item.resolvedBy);
    assert.equal(conflict.retained.description, "受理居民咨询");
    assert.equal(conflict.proposed.description, "受理居民咨询和投诉");
    assert(conflict.evidenceRefs.includes("website") && conflict.evidenceRefs.includes("knowledge"));
    assert.equal(service.app.pendingCenter.list({ category: "adjudication" }).filteredTotal, 1);
    service.app.memory.collectFoundationEvidence();
    await service.close();
    service = await createServer({ directory, automaticApi: false });
    await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    for (const evidenceId of ["website", "knowledge"]) {
      const response = await fetch(`${base}/api/foundation/evidence?foundationId=${foundation.id}&version=${foundation.version}&evidenceId=${evidenceId}`, { headers: { "x-dataengine-token": service.adminToken } });
      assert.equal(response.status, 200);
      const citation = await response.json();
      assert(citation.text.includes(citation.quote));
      assert(citation.readAt);
    }
  } finally { await service.close(); await upstream.close(); await new Promise<void>(resolve => site.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});

test("an Agent wording citation cannot adopt after its document version changes or knowledge authorization is revoked", { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-wording-stale-")), upstream = await createKnowledgeSource();
  let sourceId = "", connectionId = "", checked = false;
  const driver: AgentDriver = {
    async run(request) {
      const document = await request.onTool("foundation_document_read", { sourceId }) as any;
      new Workspace(service.app.memory).upload("说明.md", "澄川热力客服职责待重新核对。");
      const knowledge = await request.onTool("knowledge_read", { sourceId: connectionId, capability: "documents", segmentId: "company-1", revision: "r1" }) as any;
      const connection = service.app.memory.getArtifact(connectionId);
      service.app.live.sources.disable(connection.id, connection.version);
      for (const [id, kind, readId, quote] of [["stale-doc", "document", document.readId, document.text], ["revoked-kb", "knowledge", knowledge.readId, "客服部门受理居民投诉。"]]) {
        const proposal = { operationId: id, type: "description", baseline: (await request.onTool("pending_list", {}) as any).baseline,
          subject: { target: "concept", id: "service", description: "受理居民投诉", evidence: [{ id, kind, readId, quote }] }, evidence: "按实际读取资料核对" };
        if (kind === "knowledge") {
          await assert.rejects(request.onTool("change_propose", proposal), /停用/);
          continue;
        }
        const result = await request.onTool("change_propose", proposal) as any;
        assert.equal(result.change.status, "failed");
        assert.match(result.change.content.verification.notes.join(" "), /停用|版本/);
      }
      checked = true;
      return { text: "来源已变化，保留原定义。", sessionId: "stale", runId: "stale" };
    }, async stop() {}, async close() {},
  };
  const service = await createServer({ directory, driver, automaticApi: false });
  try {
    const foundation = seedFoundation(service.app.memory, service.app.foundation, { enterprise: "澄川热力", concepts: [{ id: "service", name: "客服", description: "来自客服表的记录。" }] });
    sourceId = new Workspace(service.app.memory).upload("说明.md", "澄川热力客服受理居民投诉。").id;
    connectionId = (await service.app.live.sources.connect({ name: "知识", protocol: "http", url: upstream.url, capabilities: [knowledgeCapability] })).id;
    await service.app.canvasMessage({ page: "ontology", text: "核对客服说明", messageId: "stale-citation" });
    await service.app.idle();
    assert(checked, JSON.stringify(service.app.canvasState().messages));
    assert.equal(service.app.foundation.read().adopted!.version, foundation.version);
  } finally { await service.close(); await upstream.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a document disagreement about a property is explicitly adjudicated without changing its type or owner", { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-property-wording-"));
  let sourceId = "", completed = false;
  const driver: AgentDriver = {
    async run(request) {
      const part = await request.onTool("foundation_document_read", { sourceId }) as any;
      const result = await request.onTool("change_propose", { operationId: "property-description", type: "description", baseline: (await request.onTool("pending_list", {}) as any).baseline,
        subject: { target: "property", id: "phone", description: "员工的私人手机", evidence: [{ id: "phone-document", kind: "document", readId: part.readId, quote: part.text }] }, evidence: "企业通讯说明中的联系方式范围" }) as any;
      assert.equal(result.change.content.effect.conflictIds.length, 1);
      completed = true;
      return { text: "资料说明已记录。", sessionId: "property", runId: "property" };
    }, async stop() {}, async close() {},
  };
  const service = await createServer({ directory, driver });
  try {
    seedFoundation(service.app.memory, service.app.foundation, { enterprise: "澄川热力", concepts: [{ id: "staff", name: "员工", description: "员工名册" }] });
    const proposed = await service.app.changes.propose({ operationId: "phone-property", origin: "human", type: "property", baseline: service.app.changes.currentBaseline(),
      subject: { action: "add", property: { id: "phone", entityTypeId: "staff", name: "联系方式", description: "联系员工的工作号码", valueType: "string" } } });
    const checked = await service.app.changes.verify({ id: proposed.change.id, version: proposed.change.version, operationId: "phone-check" });
    await service.app.changes.adopt({ id: checked.id, version: checked.version, operationId: "phone-adopt" });
    sourceId = new Workspace(service.app.memory).upload("通讯说明.md", "澄川热力通讯录中的联系方式是员工的私人手机。").id;
    await service.app.canvasMessage({ page: "ontology", text: "请核对通讯资料里的联系方式范围。", messageId: "property-evidence" });
    await service.app.idle();
    assert(completed, JSON.stringify(service.app.canvasState().messages));
    const before = service.app.foundation.read().adopted!;
    assert.equal((before.content.properties as any[])[0].description, "联系员工的工作号码");
    const conflict = (before.content.conflicts as any[])[0];
    const choice = await service.app.adjudication.propose({ operationId: "choose-phone", foundationRef: { id: before.id, version: before.version }, issue: { kind: "conflict", id: conflict.id }, action: "choose_proposed", reason: "业务负责人确认通讯录记录私人手机号" });
    const verified = await service.app.changes.verify({ id: choice.change.id, version: choice.change.version, operationId: "choose-phone-check" });
    assert.equal(verified.status, "verified", JSON.stringify(verified.content.verification));
    await service.app.changes.adopt({ id: verified.id, version: verified.version, operationId: "choose-phone-adopt" });
    const property = (service.app.foundation.read().adopted!.content.properties as any[])[0];
    assert.equal(property.description, "员工的私人手机");
    assert.equal(property.valueType, "string");
    assert.equal(property.entityTypeId, "staff");
    assert(property.evidenceRefs.includes("phone-document"));
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a bound property keeps its evidence through live projection and a subsequent program build", { timeout: 20000 }, async () => {
  const w = await identityWorkspace(), app = w.service.app;
  try {
    const property = app.live.readLayered(w.model.id).semantic.properties.find(item => item.entityTypeId === "staff" && item.name === "电话")!;
    const source = new Workspace(app.memory).upload("通讯录说明.md", "电话字段记录人员的工作号码。");
    const session = app.memory.createSession(), context = app.memory.beginExecution(session.taskId), turn = freezeAgentTurn(app.memory, context, { mode: "build" });
    const documents = new FoundationDocuments(app.memory, context, new Set(), app.live.sources), part = documents.read({ sourceId: source.id });
    try {
      const result = await app.agentChanges.execute("change_propose", { operationId: "phone-evidence", type: "description", baseline: app.changes.currentBaseline(),
        subject: { target: "property", id: property.id, description: "人员的工作号码", evidence: [{ id: "phone-source", kind: "document", readId: part.readId, quote: part.text }] }, evidence: "通讯录说明" }, context, turn, documents) as any;
      assert.equal(result.change.status, "adopted");
    } finally { app.memory.endExecution(context); }
    const current = app.foundation.read().adopted!, conflict = (current.content.conflicts as any[]).find(item => !item.resolvedBy);
    if (conflict) {
      const proposal = await app.adjudication.propose({ operationId: "phone-meaning", foundationRef: ref(current), issue: { kind: "conflict", id: conflict.id }, action: "choose_proposed", reason: "确认工作号码解释" });
      const checked = await app.changes.verify({ ...ref(proposal.change), operationId: "phone-meaning-check" });
      await app.changes.adopt({ ...ref(checked), operationId: "phone-meaning-adopt" });
    }
    const result = await app.live.query({ modelId: w.model.id, type: "外部人员", id: "H1", fields: ["电话"] });
    assert.equal(result.items[0].电话, "10001");
    await app.programBuilds.build({ operationId: "rebuild-with-property-evidence" });
    const after = app.foundation.read().adopted!;
    assert((after.content.properties as any[]).find(item => item.id === property.id).evidenceRefs.includes("phone-source"));
    assert((after.content.evidence as any[]).some(item => item.id === "phone-source"));
  } finally { await w.close(); }
});

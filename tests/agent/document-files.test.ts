import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../../src/agent/server.ts";
import { FoundationDocuments } from "../../src/agent/foundation-evidence.ts";
import { fileChunks, textPdf, textDocx, documentZip } from "./document-fixture.ts";
import type { AddressInfo } from "node:net";
import type { AgentDriver } from "../../src/agent/runtime.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";
import { QuestionAnswering } from "../../src/agent/qa-tools.ts";

test("a streamed PDF joins one document batch and retains exact page references across replacement", { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-document-files-"));
  const service = await createServer({ directory, automaticApi: false });
  try {
    const begun = service.app.canvasDocumentBatchStart({ operationId: "pdf-batch", page: "setup" });
    const batch = await service.app.documentUploads.addFile({ batchId: begun.batch.id, operationId: "pdf-file", name: "Policy.pdf" }, fileChunks(textPdf(["Company policy overview.", "A customer is an active contracted company."])));
    assert.equal((batch.content.errors as any[]).length, 0);
    const sourceRef = (batch.content.sources as any[])[0];
    const source = service.app.memory.getArtifact(sourceRef.id, sourceRef.version);
    assert.equal(source.content.format, "text");
    assert.equal((source.content.documentFile as any).format, "pdf");
    assert.equal(service.app.memory.listArtifacts("document_build").length, 0, "files wait for batch finalization");
    const documents = new FoundationDocuments(service.app.memory), read = documents.read({ sourceId: source.id });
    const evidence = documents.cite({ id: "customer-policy", kind: "document", readId: read.readId, quote: "A customer is an active contracted company." });
    assert.deepEqual(evidence.documentLocation?.pages, [2]);
    assert.equal(documents.locate(evidence).text.includes(evidence.quote), true);
    service.app.documentUploads.finalize(batch.id);
    assert.equal(service.app.memory.listArtifacts("document_build").length, 1);
    const next = service.app.canvasDocumentBatchStart({ operationId: "pdf-replacement", page: "setup" });
    await service.app.documentUploads.addFile({ batchId: next.batch.id, operationId: "pdf-next", name: "Policy.pdf" }, fileChunks(textPdf(["A different policy is proposed."])));
    const old = documents.locate(evidence);
    assert.equal("currentSourceVersion" in old && old.currentSourceVersion, source.version + 1);
    assert.equal(old.text.includes(evidence.quote), true, "an old quote still locates the immutable original extracted text");
    assert.deepEqual(old.documentLocation?.pages, [2]);
    assert.equal(service.app.memory.listArtifacts("live_ontology").length, 0, "document extraction cannot invent executable structure");
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("unreadable and oversized documents stay individual batch failures while a valid DOCX can proceed", { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-document-partial-")), service = await createServer({ directory, automaticApi: false });
  try {
    const begun = service.app.canvasDocumentBatchStart({ operationId: "partial-batch", page: "setup" });
    await service.app.documentUploads.addFile({ batchId: begun.batch.id, operationId: "scan", name: "扫描.pdf" }, fileChunks(textPdf([""])));
    const externalXml = documentZip({ "[Content_Types].xml": "<Types/>", "word/document.xml": '<!DOCTYPE w:document [<!ENTITY secret SYSTEM "file:///etc/passwd">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&secret;</w:t></w:r></w:p></w:body></w:document>' });
    await service.app.documentUploads.addFile({ batchId: begun.batch.id, operationId: "external-xml", name: "外部定义.docx" }, fileChunks(externalXml));
    await service.app.documentUploads.addFile({ batchId: begun.batch.id, operationId: "oversize", name: "过大.pdf" }, (async function* () { yield Buffer.alloc(100_000_001); })());
    const batch = await service.app.documentUploads.addFile({ batchId: begun.batch.id, operationId: "good", name: "有效.docx" }, fileChunks(textDocx()));
    assert.equal((batch.content.errors as any[]).length, 3);
    assert.match(JSON.stringify(batch.content.errors), /扫描件|纯图片/);
    assert.match(JSON.stringify(batch.content.errors), /外部 XML/);
    assert.match(JSON.stringify(batch.content.errors), /100 MB/);
    const final = service.app.documentUploads.finalize(batch.id);
    assert.equal(final.status, "finalized");
    assert.equal(service.app.memory.listArtifacts("document_build").filter(job => job.status === "queued").length, 1);
    assert.equal(service.app.memory.listArtifacts("document_build").filter(job => job.status === "failed").length, 2);
    assert.doesNotMatch(JSON.stringify(service.app.memory.listArtifacts("source")), /root:x:|root:\*:/);
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("DOCX headings, paragraphs and tables retain their order and business quotation section", { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-document-docx-")), service = await createServer({ directory, automaticApi: false });
  try {
    const begun = service.app.canvasDocumentBatchStart({ operationId: "docx-batch", page: "setup" });
    const batch = await service.app.documentUploads.addFile({ batchId: begun.batch.id, operationId: "docx-file", name: "客户说明.docx" }, fileChunks(textDocx()));
    assert.deepEqual(batch.content.errors, []);
    const source = service.app.memory.getArtifact((batch.content.sources as any[])[0].id);
    assert.equal(source.content.raw, "客户定义\n\n客户指签订有效合同的企业。\n\n等级\t金牌\n\n后续说明。");
    const documents = new FoundationDocuments(service.app.memory), read = documents.read({ sourceId: source.id });
    const evidence = documents.cite({ id: "docx-customer", kind: "document", readId: read.readId, quote: "客户指签订有效合同的企业。" });
    assert.deepEqual(evidence.documentLocation, { format: "docx", pages: [], sections: ["客户定义"] });
    assert.deepEqual(documents.locate(evidence).documentLocation, evidence.documentLocation);
    assert.equal(service.app.memory.listArtifacts("live_ontology").length, 0);
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Strict OOXML DOCX preserves the same readable body and heading locations", { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-document-strict-")), service = await createServer({ directory, automaticApi: false });
  try {
    const begun = service.app.canvasDocumentBatchStart({ operationId: "strict-docx", page: "setup" });
    const batch = await service.app.documentUploads.addFile({ batchId: begun.batch.id, operationId: "strict-file", name: "严格文档.docx" }, fileChunks(textDocx(true)));
    assert.deepEqual(batch.content.errors, []);
    const documents = new FoundationDocuments(service.app.memory), read = documents.read({ sourceId: (batch.content.sources as any[])[0].id });
    const evidence = documents.cite({ id: "strict-customer", kind: "document", readId: read.readId, quote: "客户指签订有效合同的企业。" });
    assert.deepEqual(evidence.documentLocation?.sections, ["客户定义"]);
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("reading all extracted PDF text retains the missing-page warning on its citation", { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-document-coverage-")), service = await createServer({ directory, automaticApi: false });
  try {
    const begun = service.app.canvasDocumentBatchStart({ operationId: "partial-pdf", page: "setup" });
    const batch = await service.app.documentUploads.addFile({ batchId: begun.batch.id, operationId: "partial-pdf-file", name: "Mixed.pdf" }, fileChunks(textPdf(["The visible policy.", ""])));
    const documents = new FoundationDocuments(service.app.memory), read = documents.read({ sourceId: (batch.content.sources as any[])[0].id });
    assert.equal(read.coverage.complete, true, "the extracted body has been read completely");
    assert.match(read.documentWarnings?.join(" ") ?? "", /1 页未检出正文.*没有进行 OCR.*2/);
    const evidence = documents.cite({ id: "visible-policy", kind: "document", readId: read.readId, quote: "The visible policy." });
    assert.deepEqual(evidence.documentWarnings, read.documentWarnings);
    assert.deepEqual(documents.locate(evidence).documentWarnings, read.documentWarnings);
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("PDF bookmarks retain section names without claiming within-page heading precision", { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-document-outline-")), service = await createServer({ directory, automaticApi: false });
  try {
    const begun = service.app.canvasDocumentBatchStart({ operationId: "outline-pdf", page: "setup" });
    const batch = await service.app.documentUploads.addFile({ batchId: begun.batch.id, operationId: "outline-file", name: "Chapters.pdf" }, fileChunks(textPdf(["Company overview.", "A customer holds a contract."], [{title:"Overview",page:1},{title:"Customers",page:2}])));
    const documents = new FoundationDocuments(service.app.memory), read = documents.read({ sourceId: (batch.content.sources as any[])[0].id });
    const evidence = documents.cite({ id: "customer-section", kind: "document", readId: read.readId, quote: "A customer holds a contract." });
    assert.deepEqual(evidence.documentLocation, { format: "pdf", pages: [2], sections: ["Customers"] });
    assert.match(evidence.documentWarnings?.join(" ") ?? "", /书签.*按页/);
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("HTTP PDF and DOCX uploads supply authenticated Agent descriptions and queryable document quotes", { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-document-agent-")), sourceIds: string[] = [];
  const definitions = [
    { id: "policy", quote: "A customer is an active contracted company.", description: "An active contracted company", query: "active contracted" },
    { id: "customer", quote: "客户指签订有效合同的企业。", description: "签订有效合同的企业", query: "有效合同" },
  ];
  let completed = false;
  // This protocol driver deliberately exercises the public Agent tools, without claiming a real model run.
  const driver: AgentDriver = { async run(request) {
    for (const [index, definition] of definitions.entries()) {
      const part = await request.onTool("foundation_document_read", { sourceId: sourceIds[index] }) as any;
      assert(part.documentLocation);
      const result = await request.onTool("change_propose", { operationId: "document-" + definition.id, type: "description", baseline: (await request.onTool("pending_list", {}) as any).baseline,
        subject: { target: "concept", id: definition.id, description: definition.description, evidence: [{ id: "file-" + definition.id, kind: "document", readId: part.readId, quote: definition.quote }] }, evidence: "来自实际读取的企业说明" }) as any;
      assert.equal(result.change.status, "adopted", JSON.stringify(result));
    }
    completed = true; return { text: "已按实际文档保存说明与引用。", sessionId: "document-test", runId: "document-test" };
  }, async stop() {}, async close() {} };
  const service = await createServer({ directory, driver, automaticApi: false }), app = service.app;
  try {
    seedFoundation(app.memory, app.foundation, { enterprise: "文档验收企业", concepts: definitions.map(item => ({ id: item.id, name: item.id, description: "来自表格的记录。" })) });
    await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`, begun = app.canvasDocumentBatchStart({ operationId: "agent-files", page: "setup" });
    for (const [index, [name, bytes]] of ([ ["Policy.pdf", textPdf(["A customer is an active contracted company."])], ["客户定义.docx", textDocx()] ] as const).entries()) {
      const response = await fetch(`${base}/api/canvas/upload/document?${new URLSearchParams({ batchId: begun.batch.id, operationId: `agent-file-${index}`, name })}`, { method: "POST", headers: { "x-dataengine-token": service.adminToken, "content-type": "application/octet-stream" }, body: bytes });
      assert.equal(response.status, 200);
      const result = await response.json(); assert.deepEqual(result.batch.content.errors, []);
      sourceIds.push(result.batch.content.sources[index].id);
    }
    await app.canvasMessage({ page: "ontology", text: "请根据两份文档核对实体说明。", messageId: "read-files" }); await app.idle();
    assert(completed, JSON.stringify(app.canvasState().messages));
    for (const definition of definitions) {
      const foundation = app.foundation.read().adopted!;
      assert.equal((foundation.content.concepts as any[]).find(item => item.id === definition.id).description, definition.description);
      const evidence = (foundation.content.evidence as any[]).find(item => item.id === "file-" + definition.id);
      assert(evidence.documentLocation);
      const response = await fetch(`${base}/api/foundation/evidence?${new URLSearchParams({ foundationId: foundation.id, version: String(foundation.version), evidenceId: evidence.id })}`, { headers: { "x-dataengine-token": service.adminToken } });
      assert.equal(response.status, 200); assert.equal((await response.json()).quote, definition.quote);
      const result = await new QuestionAnswering(app.memory, app.foundation, app.live, app.snapshots, app.workspaceVersions, app.changes).begin({ question: "实体含义的文档依据" }).execute("knowledge_query", { query: definition.query });
      assert.equal((result.result as any).items[0]?.quote, definition.quote);
    }
    assert.equal(app.memory.listArtifacts("live_ontology").length, 0, "document wording never creates bindings or records");
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

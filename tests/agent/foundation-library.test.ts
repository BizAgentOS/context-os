import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { FoundationService } from "../../src/agent/foundation.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";

test("foundation keeps more than 200 citations and 100 unresolved items with historical evidence readable", () => {
  const directory = mkdtempSync(join(tmpdir(), "de-evidence-library-"));
  const memory = new MemoryStore(directory), foundation = new FoundationService(memory);
  try {
    const seed = seedFoundation(memory, foundation, { enterprise: "澄川仓配", concepts: [{ id: "store", name: "门店", description: "收货地点" }] });
    const task = memory.createTask("补充已有门店的依据"), message = memory.addMessage(task.id, "user", "澄川仓配的门店规则仍待核对。");
    const context = memory.beginExecution(task.id);
    for (let batch = 0; batch < 8; batch++) {
      const current = foundation.read().current!;
      const evidence = Array.from({ length: 30 }, (_, i) => ({ id: `note-${batch}-${i}`, messageId: message.id, quote: message.content }));
      const candidate = foundation.propose({ baseVersion: current.version, enterprise: current.content.enterprise,
        concepts: [], relations: [], evidence,
        unknowns: evidence.map(e => ({ id: `unknown-${e.id}`, description: "这一条门店规则仍未知", evidenceRefs: [e.id] })), conflicts: [],
      }, context, `batch-${batch}`, "fixture-skill", undefined, { lockStructure: true });
      foundation.adopt(candidate.id, candidate.version);
    }
    assert.equal((foundation.read().adopted!.content.evidence as unknown[]).length, 241);
    assert.equal((foundation.read().adopted!.content.unknowns as unknown[]).length, 240);
    assert.equal(memory.foundationEvidenceStats().entries, 241, "citations are shared across historical versions");
    assert.equal(memory.collectFoundationEvidence(), 0, "retained historical owners protect their evidence");
    const current = foundation.read().adopted!;
    assert.equal(memory.getArtifact(current.id, current.version, { evidence: "compact" }).content.evidence, undefined);
    assert.equal((foundation.project(current).content.evidence as unknown[]).length, 50, "ordinary UI and Agent projection is bounded");
    assert.equal(foundation.listEvidence({ id: current.id, version: current.version, offset: 200 }).items.length, 41);
    const program = memory.putArtifact({ kind: "engine_candidate", title: "保留文档说明的程序候选", status: "candidate", content: { foundation: current.content } });
    assert.equal((memory.getArtifact(program.id, program.version, { evidence: "compact" }).content.foundation as any).evidence, undefined, "program candidates also refer to the library instead of copying the definition's evidence");
    assert.equal(((memory.getArtifact(program.id).content.foundation as any).evidence as unknown[]).length, 241);
    assert.equal((memory.getArtifact(seed.id, seed.version).content.evidence as { quote: string }[])[0].quote, "澄川仓配的数据程序已根据结构化数据建立这些概念和关系。");
    memory.endExecution(context);
  } finally { memory.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("evidence library shares immutable citations across versions and collects only unreferenced entries", async () => {
  const { FoundationEvidenceLibrary } = await import("../../src/agent/foundation-library.ts");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:"), library = new FoundationEvidenceLibrary(db);
  try {
    const first = { id: "foundation", version: 1, kind: "foundation", title: "本体", status: "adopted", createdAt: "2026-01-01", content: { evidence: [{ id: "citation", quote: "可追溯的依据" }] } };
    const encoded = library.encode(first);
    assert.equal(JSON.stringify(encoded).includes("可追溯的依据"), false, "definition body carries no evidence text");
    const next = library.encode({ ...first, version: 2 });
    assert.equal(library.stats().entries, 1);
    assert.equal(library.stats().references, 2);
    assert.equal((library.decode(encoded).content.evidence as { quote: string }[])[0].quote, "可追溯的依据");
    assert.equal(library.collect(new Set(["foundation@1", "foundation@2"])), 0);
    assert.equal(library.collect(new Set(["foundation@2"])), 0, "a retained historical or current owner prevents reclamation");
    assert.equal((library.decode(next).content.evidence as { quote: string }[])[0].quote, "可追溯的依据");
    assert.equal(library.collect(new Set()), 1);
    assert.equal(library.stats().entries, 0);
  } finally { db.close(); }
});

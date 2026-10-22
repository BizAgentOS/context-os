import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { FoundationService } from "../../src/agent/foundation.ts";
import { LiveMemory } from "../../src/live/memory.ts";
import { ProgramBuilds, isStructural, structuralDelta } from "../../src/engine/program-builds.ts";
import { Workspace } from "../../src/agent/workspace.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "context-os-structure-approval-"));
  const memory = new MemoryStore(directory);
  const live = new LiveMemory(directory, memory);
  const foundation = new FoundationService(memory, live);
  const engine = new ProgramBuilds(memory, foundation, live);
  return { memory, live, foundation, engine, directory,
    close() { memory.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const issues = (run: { content: Record<string, unknown> }) => (run.content.issues ?? []) as any[];
const concepts = (f: ReturnType<typeof fixture>) => (f.foundation.read().adopted!.content.concepts ?? []) as any[];

test("structuralDelta reads structure only, never evidence or wording refreshes", () => {
  assert.equal(isStructural(structuralDelta({ addedConcepts: [], addedRelations: [], addedSupplements: [], retiredConcepts: [], retiredRelations: [] })), false);
  assert.equal(isStructural(structuralDelta(undefined)), false);
  assert.equal(isStructural(structuralDelta({ addedConcepts: ["source_a"] })), true);
  assert.equal(isStructural(structuralDelta({ addedRelations: ["rel_a"] })), true);
  assert.equal(isStructural(structuralDelta({ addedSupplements: ["投诉 ← 其它来源"] })), true);
  assert.equal(isStructural(structuralDelta({ retiredConcepts: ["legacy"] })), true);
  assert.equal(isStructural(structuralDelta({ preservedConcepts: ["source_a"], preservedMappings: ["source_a"], addedMappings: ["source_a"] })), false);
});

test("the first build adopts structure by itself, so a cold workspace still works without a decision", async () => {
  const f = fixture();
  try {
    new Workspace(f.memory).upload("companies.csv", "id,name\nC1,青山\nC2,海川\n");
    const first = await f.engine.build({ operationId: "first", autoAdopt: true });
    assert.equal(first.content.outcome, "adopted", JSON.stringify(issues(first)));
    assert.equal(issues(first).some((issue: any) => issue.code === "structure_needs_review"), false, "a first build is not held back");
    assert.equal(concepts(f).length, 1);
  } finally { f.close(); }
});

test("after the first build, objects from a new source wait for a decision instead of entering the working version", async () => {
  const f = fixture();
  try {
    const workspace = new Workspace(f.memory);
    workspace.upload("companies.csv", "id,name\nC1,青山\nC2,海川\n");
    const first = await f.engine.build({ operationId: "first", autoAdopt: true });
    assert.equal(first.content.outcome, "adopted", JSON.stringify(issues(first)));
    const foundation = f.foundation.read().adopted!, model = f.live.overview().models.find(item => item.status === "adopted")!;

    workspace.upload("orders.csv", "order_id,partner_id,amount\nO1,C1,10\nO2,C2,20\n");
    const second = await f.engine.build({ operationId: "with-orders", autoAdopt: true });
    assert.equal(second.content.outcome, "candidate", JSON.stringify(issues(second)));
    const structural = issues(second).find((issue: any) => issue.code === "structure_needs_review");
    assert.ok(structural, "the build says why it did not adopt");
    assert.match(structural.message, /结构变化/);
    assert.match(structural.message, /新对象/);

    // The working version is exactly what it was: adopting structure is a decision, not a side effect of syncing.
    assert.equal(f.foundation.read().adopted!.version, foundation.version, "the adopted foundation did not move");
    assert.equal(f.live.overview().models.find(item => item.status === "adopted")!.version, model.version, "the adopted mapping did not move");
    assert.equal(concepts(f).length, 1, "the new object is not in the working version");

    // An explicit decision adopts the whole candidate, and the new object then exists.
    const candidate = f.engine.overview().candidate!;
    const checked = await f.engine.check({ id: candidate.id, version: candidate.version });
    await f.engine.adopt({ id: checked.id, version: checked.version, operationId: "orders-adopt" });
    assert.equal(concepts(f).length, 2, "the decided object is now adopted");
  } finally { f.close(); }
});

test("a same-structure refresh still adopts automatically, so snapshot and evidence updates stay hands-off", async () => {
  const f = fixture();
  try {
    const workspace = new Workspace(f.memory);
    workspace.upload("companies.csv", "id,name\nC1,青山\nC2,海川\n");
    const first = await f.engine.build({ operationId: "first", autoAdopt: true });
    assert.equal(first.content.outcome, "adopted", JSON.stringify(issues(first)));
    const before = f.foundation.read().adopted!;

    workspace.upload("companies.csv", "id,name\nC1,青山\nC2,海川\nC3,新公司\n");
    const second = await f.engine.build({ operationId: "refresh", autoAdopt: true });
    assert.equal(second.content.outcome, "adopted", JSON.stringify(issues(second)));
    assert.equal(issues(second).some((issue: any) => issue.code === "structure_needs_review"), false);
    const after = f.foundation.read().adopted!;
    assert.equal(after.version > before.version, true, "the refreshed version is adopted");
    assert.equal(concepts(f).length, 1, "no object was added or removed");
  } finally { f.close(); }
});


/** Two new tables in one build, so a candidate actually offers a choice between new objects. */
async function twoNewObjects(f: ReturnType<typeof fixture>) {
  const workspace = new Workspace(f.memory);
  workspace.upload("companies.csv", "id,name\nC1,青山\nC2,海川\n");
  const first = await f.engine.build({ operationId: "first", autoAdopt: true });
  assert.equal(first.content.outcome, "adopted", JSON.stringify(issues(first)));
  workspace.upload("orders.csv", "order_id,partner_id,amount\nO1,C1,10\nO2,C2,20\n");
  workspace.upload("products.csv", "product_id,label\nP1,甲\nP2,乙\n");
  const second = await f.engine.build({ operationId: "two-new", autoAdopt: true });
  assert.equal(second.content.outcome, "candidate", JSON.stringify(issues(second)));
  const candidate = f.engine.overview().candidate!;
  return f.engine.check({ id: candidate.id, version: candidate.version });
}

test("adopting part of a candidate keeps the selected object and leaves the rest pending", async () => {
  const f = fixture();
  try {
    const checked = await twoNewObjects(f);
    const added = (checked.content.diff as any).addedConcepts as string[];
    assert.equal(added.length, 2, `both tables are new objects: ${JSON.stringify(issues(checked))}`);
    const [keep, drop] = added;
    await f.engine.adopt({ id: checked.id, version: checked.version, operationId: "partial",
      selection: { entities: [keep], relations: [], merges: [] } });
    const adopted = f.foundation.read().adopted!;
    const ids = (adopted.content.concepts as any[]).map(concept => concept.id);
    assert.ok(ids.includes(keep), "the selected object is adopted");
    assert.equal(ids.includes(drop), false, "the unselected object stays out of the working version");

    // The unselected object was never decided, so the next build proposes it again instead of adopting it.
    const again = await f.engine.build({ operationId: "remaining", autoAdopt: true });
    assert.equal(again.content.outcome, "candidate", JSON.stringify(issues(again)));
    const structural = issues(again).find((issue: any) => issue.code === "structure_needs_review");
    assert.match(structural.message, /新对象 1 项/);
  } finally { f.close(); }
});

test("a selection that names something the candidate does not add is refused instead of guessed", async () => {
  const f = fixture();
  try {
    const checked = await twoNewObjects(f);
    const before = f.foundation.read().adopted!.version;
    await assert.rejects(f.engine.adopt({ id: checked.id, version: checked.version, operationId: "bad-entity",
      selection: { entities: ["source_not_there"], relations: [], merges: [] } }), /不是本次候选新增的对象/);
    await assert.rejects(f.engine.adopt({ id: checked.id, version: checked.version, operationId: "bad-relation",
      selection: { entities: [], relations: ["rel_not_there"], merges: [] } }), /不是本次候选新增的关系/);
    await assert.rejects(f.engine.adopt({ id: checked.id, version: checked.version, operationId: "bad-merge",
      selection: { entities: [], relations: [], merges: ["不存在的合并 ← 来源"] } }), /不是本次候选新增的合并/);
    assert.equal(f.foundation.read().adopted!.version, before, "a refused selection changes nothing");
  } finally { f.close(); }
});
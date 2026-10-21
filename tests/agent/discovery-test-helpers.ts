import assert from "node:assert/strict";
import type { MemoryStore } from "../../src/agent/memory.ts";
import type { FoundationService } from "../../src/agent/foundation.ts";
import type { LiveMemory } from "../../src/live/memory.ts";
import type { Snapshots } from "../../src/data/snapshots.ts";
import type { ProgramBuilds } from "../../src/engine/program-builds.ts";
import { OntologyChanges } from "../../src/engine/changes.ts";
import { connectDiscoveryChanges } from "../../src/engine/discovery-changes.ts";
import { connectRelationChanges } from "../../src/engine/relation-change.ts";

/** Existing mapping tests explicitly accept the discovered relationships before revising them. */
export async function adoptDiscoveredRelations(memory: MemoryStore, foundation: FoundationService, live: LiveMemory, snapshots: Snapshots, engine: ProgramBuilds) {
  const changes = new OntologyChanges(memory, foundation, snapshots);
  connectRelationChanges(memory, foundation, live, snapshots, changes);
  connectDiscoveryChanges(memory, foundation, live, snapshots, engine, changes);
  await engine.idle();
  for (const proposal of changes.list({ type: "relation" }).changes) {
    await engine.idle();
    const current = changes.read(proposal.id);
    const checked = await changes.verify({ id: current.id, version: current.version, operationId: `check-${current.id}` });
    assert.equal(checked.status, "verified", JSON.stringify(checked.content.verification));
    await changes.adopt({ id: checked.id, version: checked.version, operationId: `adopt-${current.id}`, acknowledgeReview: true });
  }
  await engine.idle();
  return changes;
}

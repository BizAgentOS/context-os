import type { MemoryStore } from "../agent/memory.ts";
import type { FoundationService } from "../agent/foundation.ts";
import type { LiveMemory } from "../live/memory.ts";
import type { OntologyChanges } from "./changes.ts";
import { prepareWordingEdits } from "./wording-changes.ts";

/** Compile all patches together; no item can overwrite another item's definition. */
export function connectWordingBatch(memory: MemoryStore, foundation: FoundationService, live: LiveMemory, changes: OntologyChanges) {
  changes.registerBatchHandler({
    accepts: selected => selected.every(item => !item.content.owner && ["naming", "description"].includes(String(item.content.type))),
    prepare: async selected => (await prepareWordingEdits(memory, foundation, live, changes, selected)).apply,
  });
}

import type { MemoryStore } from "../../src/agent/memory.ts";
import type { FoundationService } from "../../src/agent/foundation.ts";

interface Seed {
  enterprise: string;
  concepts: { id: string; name: string; description: string }[];
  relations?: { id: string; name: string; from: string; to: string; description: string }[];
  program?: boolean;
}

/** Seeds the adopted structure in a separate data-program task, preserving program provenance by default.
 * Set `program: false` only when explicitly testing a historical interpretation-built foundation. */
export function seedFoundation(memory: MemoryStore, foundation: FoundationService, seed: Seed) {
  const task = memory.createTask("数据程序构建本体");
  const message = memory.addMessage(task.id, "user", `${seed.enterprise}的数据程序已根据结构化数据建立这些概念和关系。`);
  const context = memory.beginExecution(task.id);
  try {
    const evidenceRefs = ["program-seed"];
    let candidate = foundation.propose({
      baseVersion: foundation.read().current?.version ?? 0,
      enterprise: { name: seed.enterprise, evidenceRefs },
      concepts: seed.concepts.map((item) => ({ ...item, evidenceRefs })),
      relations: (seed.relations ?? []).map((item) => ({ ...item, evidenceRefs })),
      evidence: [{ id: "program-seed", messageId: message.id, quote: message.content }],
      unknowns: [], conflicts: [],
    }, context, "seed-foundation", "program-seed");
    if (seed.program !== false) {
      const mark = (items: unknown) => (items as Record<string, unknown>[]).map((item) => ({ ...item, origin: "program", programEvidenceId: "program-seed" }));
      candidate = memory.putArtifact({ ...candidate, expectedVersion: candidate.version,
        content: { ...candidate.content, concepts: mark(candidate.content.concepts), relations: mark(candidate.content.relations) } as typeof candidate.content });
    }
    return foundation.adopt(candidate.id, candidate.version);
  } finally {
    memory.endExecution(context);
  }
}

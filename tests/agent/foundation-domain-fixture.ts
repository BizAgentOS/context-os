import { createHash } from "node:crypto";
import type { AgentApplication } from "../../src/agent/app.ts";
import { FoundationDocuments } from "../../src/agent/foundation-evidence.ts";

/** Exercises the shared host domain boundary, not a simulated model tool catalog. */
export function foundationSession(app: AgentApplication, text: string, options: { taskId?: string; messageId?: string; origins?: ReadonlySet<string> } = {}) {
  const taskId = options.taskId ?? app.memory.createTask("基础依据领域回归").id;
  const message = app.memory.addMessage(taskId, "user", text, options.messageId);
  const context = app.memory.beginExecution(taskId);
  const documents = new FoundationDocuments(app.memory, context, options.origins, app.live.sources);
  return {
    taskId, context, message, documents,
    read: () => app.foundation.view(),
    propose: async (input: unknown, digest = "host-domain-regression") => app.foundation.project(app.foundation.propose(input, context,
      createHash("sha256").update(JSON.stringify(input)).digest("hex"), digest, documents, { lockStructure: true })),
    close: () => app.memory.endExecution(context),
  };
}
export type FoundationSession = ReturnType<typeof foundationSession>;
export async function runFoundationSession(app: AgentApplication, text: string, run: (session: FoundationSession) => Promise<unknown>, options: Parameters<typeof foundationSession>[2] = {}) {
  const session = foundationSession(app, text, options);
  try { return await run(session); } finally { session.close(); }
}

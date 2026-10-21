import type { RunRequest } from "../../src/agent/runtime.ts";
import type { Artifact } from "../../src/agent/contracts.ts";

/** Exercise the same model-visible proposal service as a real build-mode turn. */
export async function proposeWording(request: RunRequest, target: "concept" | "relation" | "property", id: string, patch: { name?: string; description?: string }, operationId = "wording") {
  const message = JSON.parse(request.input).recentMessages.at(-1);
  let change: Artifact | undefined;
  for (const [field, value] of Object.entries(patch)) {
    const pending = await request.onTool("pending_list", {}) as any;
    const result = await request.onTool("change_propose", { operationId: `${operationId}-${field}`, type: field === "name" ? "naming" : "description", baseline: pending.baseline,
      subject: { target, id, [field]: value, evidence: [{ id: `${operationId}-${field}`, messageId: message.id, quote: message.content }] }, evidence: message.content }) as any;
    change = result.change;
  }
  return change!;
}

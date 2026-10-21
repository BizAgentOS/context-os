import { z } from "zod";
import type { Data, DomainTool, WriteContext } from "./contracts.ts";
import type { MemoryStore } from "./memory.ts";
import { jsonData } from "../live/sources.ts";
import type { PendingCenter } from "../engine/pending.ts";

const text = z.string().trim().min(1).max(2000);
const reference = z.object({ id: z.string().trim().min(1), version: z.number().int().positive() }).strict();
const input = z.object({ question: text, reason: text, refs: z.array(reference).max(20).default([]),
  options: z.array(z.object({ label: text, description: text.optional() }).strict()).max(6).default([]) }).strict();

export const decisionRequestTool: DomainTool = { name: "decision_request", description: "请求用户核对具体问题、依据与选项。结构决定必须引用已保存变更的准确版本；只产生决定卡，不采用、拒绝或修改变更。成功后只收尾，不再调用其他工具。", inputSchema: z.toJSONSchema(input), mutates: true };

export function requestDecision(memory: MemoryStore, context: WriteContext, value: unknown, pending?: PendingCenter) {
  const args = input.parse(value);
  const items: Data[] = [];
  for (const target of args.refs) {
    if (pending) {
      const item = pending.read(target.id);
      if (item.version !== target.version || !item.actions.analyze) throw new Error("决定目标不是当前未决版本，请重新读取待处理事项");
      items.push({ id: item.id, version: item.version, title: item.title, impact: item.impact }); continue;
    }
    const change = memory.getArtifact(target.id);
    if (change.kind !== "ontology_change" || change.version !== target.version || !["proposed", "verified", "failed"].includes(change.status))
      throw new Error("决定目标不是当前未决变更版本，请重新读取变更");
  }
  return memory.ask(context, jsonData({ kind: "decision", ...args, items }));
}

/** Legacy questions share the same card, while adoption still belongs to the unified change service. */
export function decisionCard(memory: MemoryStore, pending: Data): Data {
  const refs: Data[] = [];
  if (Array.isArray(pending.refs)) for (const value of pending.refs) {
    const parsed = reference.safeParse(value);
    if (!parsed.success) continue;
    if (Array.isArray(pending.items) && pending.items.some(value => value && typeof value === "object" && !Array.isArray(value) && value.id === parsed.data.id && value.version === parsed.data.version)) { refs.push(parsed.data); continue; }
    try {
      const change = memory.getArtifact(parsed.data.id, parsed.data.version);
      if (change.kind === "ontology_change") refs.push(parsed.data);
    } catch { /* The question remains readable even if its historical target is unavailable. */ }
  }
  const owner = pending.foundationId ?? pending.candidateId;
  if (typeof owner === "string") {
    const change = memory.listArtifacts("ontology_change").find(item => (item.content.owner as Data | undefined)?.id === owner && (item.content.owner as Data | undefined)?.version === pending.version);
    if (change) refs.push({ id: change.id, version: change.version });
  }
  return { kind: "decision", question: String(pending.question ?? "请核对当前变更"), reason: String(pending.reason ?? ""), refs, impact: Array.isArray(pending.items) ? pending.items.map(value => value && typeof value === "object" && !Array.isArray(value) ? value.impact : "").filter(Boolean).join("；") : "",
    options: Array.isArray(pending.options) ? pending.options : [], status: "pending" };
}

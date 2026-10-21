import { z } from "zod";
import type { Data, DomainTool, WriteContext } from "./contracts.ts";
import type { MemoryStore } from "./memory.ts";
import type { PendingCenter } from "../engine/pending.ts";
import {qaDataViewSchema,type QaDataView} from './qa-view.ts';
export {qaDataViewSchema} from './qa-view.ts';

export type AgentMode = "build" | "qa";
const reference = z.object({ id: z.string().min(1), version: z.number().int().positive() }).strict();
const binding = z.object({ mode: z.enum(["build", "qa"]).default("build"), dataView:qaDataViewSchema.default({kind:'working'}),pendingRef: reference.optional(), continuationRunId: z.string().min(1).optional() }).strict();
const readonlyQuery = ["ontology_describe", "ontology_search", "objects_query", "relations_traverse", "objects_aggregate", "evidence_read", "knowledge_query"];
const common = ["session_title", "task_checkpoint"];
const native = ["web_search", "web_fetch", "mcp_search", "mcp_describe", "mcp_call", "mcp_read_resource", "mcp_get_prompt"];
const allowed: Record<AgentMode, ReadonlySet<string>> = {
  build: new Set([...common, ...readonlyQuery, ...native, "workspace_overview", "memory_read", "context_read", "canvas_history_read", "ontology_outline", "data_overview", "engine_overview", "engine_build", "discovery_explain", "source_catalog", "snapshot_query", "data_sync", "foundation_read", "foundation_document_read", "foundation_web_read", "knowledge_read", "live_overview", "live_read", "live_query", "object_execute", "metric_describe", "metric_query", "evidence_list", "evidence_collect", "release_overview", "capability_search", "skill_use", "skill_read", "sdk_call", "change_propose", "change_verify", "change_preview_query", "change_withdraw", "pending_list", "pending_read", "decision_request"]),
  qa: new Set([...common, ...readonlyQuery, "gap_report"]),
};
export interface FrozenAgentTurn {
  readonly mode: AgentMode; readonly taskId: string; readonly sessionId: string | null; readonly executionId: string;
  readonly dataView:QaDataView;
  readonly pendingRef?: { readonly id: string; readonly version: number };
  readonly continuation?: { readonly runRef: { readonly id: string; readonly version: number }; readonly goal: string; readonly completed: string[]; readonly savedChanges: Data[]; readonly remaining: string[] };
}
const freeze = <T>(value: T): T => { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };

/** Input comes from the persisted user message binding, never the current page or later UI state. */
export function freezeAgentTurn(memory: MemoryStore, context: WriteContext, input: unknown, pending?: PendingCenter): FrozenAgentTurn {
  memory.assertWritable(context);
  const args = binding.parse(input), session = memory.sessionForTask(context.taskId);
  if(args.mode==='build'&&args.dataView.kind!=='working')throw new Error('构建模式只能使用工作版视图');
  if (args.pendingRef) {
    if (args.mode !== "build") throw new Error("问答模式不能绑定待处理事项");
    const item = pending?.read(args.pendingRef.id);
    if (!item || item.version !== args.pendingRef.version || !item.actions.analyze) throw new Error("待处理事项版本或状态已变化，请重新读取");
  }
  let continuation: FrozenAgentTurn["continuation"];
  if (args.continuationRunId) {
    const run = memory.getArtifact(args.continuationRunId), owner = String(run.content.taskId ?? "");
    if (run.kind !== "agent_run" || !(session ? session.taskIds.includes(owner) : owner === context.taskId)) throw new Error("只能继续当前会话的运行回执");
    if (!["stopped", "timed_out", "failed"].includes(run.status) && !(run.status === "running" && memory.getTask(owner).executionId !== run.content.executionId)) throw new Error("该运行没有可继续的中断回执");
    const saved = run.content.continuation as Data | undefined;
    continuation = { runRef: { id: run.id, version: run.version }, goal: String(run.content.goal ?? ""), completed: (saved?.completed ?? []) as string[], savedChanges: (saved?.savedChanges ?? []) as Data[], remaining: (saved?.remaining ?? []) as string[] };
  }
  return freeze(structuredClone({ mode: args.mode,dataView:args.dataView, taskId: context.taskId, sessionId: session?.id ?? null, executionId: context.executionId, ...(args.pendingRef ? { pendingRef: args.pendingRef } : {}), ...(continuation ? { continuation } : {}) }));
}

/** Registration is an allowlist; execution checks the same allowlist again. Later catalogs override legacy names. */
export function modeTools(mode: AgentMode, catalog: DomainTool[]): DomainTool[] {
  return [...new Map(catalog.filter(tool => allowed[mode].has(tool.name) && !native.includes(tool.name)).map(tool => [tool.name, tool])).values()];
}
export function modeNativeTools(mode: AgentMode, catalog: string[]): string[] { return catalog.filter(name => native.includes(name) && allowed[mode].has(name)); }
export function assertAgentTool(memory: MemoryStore, context: WriteContext, turn: FrozenAgentTurn, name: string) {
  memory.assertWritable(context);
  if (turn.executionId !== context.executionId || turn.taskId !== context.taskId) throw new Error("工具调用不属于本次冻结运行");
  if (!allowed[turn.mode].has(name)) throw new Error(`当前${turn.mode === "build" ? "构建" : "问答"}模式没有这项能力`);
}

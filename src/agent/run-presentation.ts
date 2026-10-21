import type { Artifact, Data, Json, WriteContext } from "./contracts.ts";
import type { MemoryStore } from "./memory.ts";
import { jsonData } from "../live/sources.ts";
import { decisionCard } from "./decision-requests.ts";
import type { PendingCenter } from "../engine/pending.ts";

export type RunStatus = "running" | "completed" | "waiting" | "stopped" | "timed_out" | "failed";
type Ref = { id: string; version: number };
type StepKind = "read" | "query" | "check" | "propose" | "save" | "decision";
type Step = { id: string; kind: StepKind; summary: string; status: "running" | "completed" | "failed" | "stopped"; refs: Ref[]; startedAt: string; finishedAt?: string; tool: string };
export interface RunUsage { status: "available" | "unknown"; inputTokens: number | null; outputTokens: number | null; tokens: number | null; cost: number | null; currency: string | null }
export interface RunCard {
  id: string; taskId: string; status: RunStatus; goal: string; startedAt: string; finishedAt?: string;
  steps: Step[]; intermediate: string[];
  changeList: { ref: Ref; title: string; status: string; verification?: Data }[];
  answer?: Data;
  decisions: Data[]; tables: { title: string; rows: Data[]; coverage: Data | null; truncated: boolean }[];
  systemEvents: { kind: string; message: string; at: string }[];
  usage: RunUsage; error?: string;
  continuation: { goal: string; completed: string[]; savedChanges: Ref[]; remaining: string[] };
}
const ref = (artifact: Artifact): Ref => ({ id: artifact.id, version: artifact.version });
const object = (value: unknown): Data | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Data : undefined;
const now = () => new Date().toISOString();
const quantity = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const continuation = (card: RunCard) => ({ goal: card.goal, completed: card.steps.filter(step => step.status === "completed").map(step => step.summary), savedChanges: card.changeList.map(item => item.ref), remaining: card.steps.filter(step => step.status !== "completed").map(step => `${step.summary}（未完成）`) });

/** Missing provider telemetry stays unknown; a text length or guessed tariff is never a bill. */
export function runUsage(value?: Json): RunUsage {
  const usage = object(value), inputTokens = quantity(usage?.inputTokens), outputTokens = quantity(usage?.outputTokens);
  const tokens = quantity(usage?.totalTokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  const cost = quantity(usage?.costUsd);
  return { status: tokens === null && inputTokens === null && outputTokens === null ? "unknown" : "available", inputTokens, outputTokens, tokens, cost, currency: cost === null ? null : "USD" };
}

function operation(name: string): { kind: StepKind; summary: string } {
  if (/decision_request|task_ask/.test(name)) return { kind: "decision", summary: "等待你的决定" };
  if (/check|verify|test|validate/.test(name)) return { kind: "check", summary: "复验来源与变更" };
  if (/propose|suggest/.test(name)) return { kind: "propose", summary: "提出变更建议" };
  if (/query|search|execute/.test(name)) return { kind: "query", summary: "查询业务数据" };
  if (/save|update|patch|checkpoint|title|cancel|withdraw/.test(name)) return { kind: "save", summary: "保存处理结果" };
  return { kind: "read", summary: "读取来源与定义" };
}

/** Host-owned receipts for one execution. This telemetry never authorizes or adopts a domain change. */
export class RunPresentation {
  private memory: MemoryStore;
  private saved: Artifact;
  private card: RunCard;
  private sequence = 0;
  private text = "";

  constructor(memory: MemoryStore, context: WriteContext, input: { goal: string; workContext?: unknown }) {
    this.memory = memory;
    this.card = { id: `agent_run_${context.executionId}`, taskId: context.taskId, status: "running", goal: input.goal, startedAt: now(), steps: [], intermediate: [], changeList: [], decisions: [], tables: [], systemEvents: [], usage: runUsage(), continuation: { goal: input.goal, completed: [], savedChanges: [], remaining: [] } };
    this.saved = memory.putArtifact({ kind: "agent_run", title: input.goal.slice(0, 200), status: "running", content: jsonData({ ...this.card, executionId: context.executionId, workContext: input.workContext ?? null }) });
    this.card.id = this.saved.id;
  }
  private save() {
    if (this.card.status !== "running") this.card.continuation = continuation(this.card);
    this.saved = this.memory.putArtifact({ ...this.saved, expectedVersion: this.saved.version, status: this.card.status, content: jsonData({ ...this.saved.content, ...this.card }) });
  }
  private flushText() {
    if (this.text.trim()) this.card.intermediate.push(this.text.trim().slice(0, 6000));
    this.card.intermediate = this.card.intermediate.slice(-24);
    this.text = "";
  }
  event(kind: string, data: Data) {
    if (this.card.status !== "running") return;
    if (kind === "assistant.delta") { this.text = (this.text + String(data.text ?? "")).slice(-12000); return; }
    if (kind === "run.timed_out") { this.finish({ status: "timed_out", error: String(data.reason ?? "运行超时") }); return; }
    if (!/^(operation|capability)\.(started|completed|finished|failed)$/.test(kind)) return;
    const tool = String(data.name ?? "");
    if (kind.endsWith("started")) {
      this.flushText();
      this.card.steps.push({ id: String(data.id ?? `step-${++this.sequence}`), tool, ...operation(tool), status: "running", refs: [], startedAt: now() });
    } else {
      const step = this.card.steps.findLast(step => step.status === "running" && step.tool === tool && (!data.id || step.id === data.id));
      if (step) { step.status = kind.endsWith("failed") ? "failed" : "completed"; step.finishedAt = now(); }
    }
    this.save();
  }
  tool(name: string, args: Record<string, unknown>, result: Json, operationId?: string) {
    if (!["running", "stopped", "timed_out"].includes(this.card.status)) return;
    this.flushText();
    const receipt = object(result);
    if (receipt?.error) { this.failed(name, String(receipt.error), operationId); return; }
    let step = this.card.steps.findLast(step => step.tool === name && ["running", "stopped"].includes(step.status) && (!operationId || step.id === operationId));
    if (!step) {
      step = { id: operationId ?? `step-${++this.sequence}`, tool: name, ...operation(name), status: "running", refs: [], startedAt: now() };
      this.card.steps.push(step);
    }
    step.status = "completed"; step.finishedAt = now();
    if (this.card.status === "running") delete this.card.error;
    const artifacts = [receipt, object(receipt?.change), object(receipt?.candidate)].filter(Boolean) as Data[];
    if (/propose|verify|check|save|update|patch|withdraw|cancel/.test(name)) for (const item of artifacts) {
      if (typeof item.id !== "string" || typeof item.version !== "number") continue;
      let artifact: Artifact;
      try { artifact = this.memory.getArtifact(item.id, item.version); } catch { continue; }
      step.refs.push(ref(artifact));
      const change = artifact.kind === "ontology_change" ? artifact : this.memory.listArtifacts("ontology_change").find(candidate => (candidate.content.owner as Data | undefined)?.id === artifact.id);
      if (change) {
        this.card.changeList = this.card.changeList.filter(item => item.ref.id !== change.id);
        this.card.changeList.push({ ref: ref(change), title: change.title, status: change.status, ...(object(change.content.verification) ? { verification: object(change.content.verification) } : {}) });
      }
    }
    if (/live_query|snapshot_query|metric_query|object_execute|ontology_verify/.test(name) && receipt) {
      const source = receipt.kind === "verification" ? object(object(receipt.content)?.result) ?? receipt : receipt;
      const nested = object(source.results), value = nested ? object(Object.values(nested).at(-1)) ?? source : source;
      const entries = value.items ?? value.rows;
      if (Array.isArray(entries)) this.card.tables.push({ title: typeof args.type === "string" ? `${args.type} · 查询结果` : "查询结果", rows: entries.slice(0, 20).map(object).filter(Boolean) as Data[], coverage: object(value.coverage) ?? null, truncated: entries.length > 20 });
      else if (typeof value.count === "number") this.card.tables.push({ title: "统计结果", rows: [{ 统计结果: value.count }], coverage: object(value.coverage) ?? null, truncated: value.partial === true });
      this.card.tables = this.card.tables.slice(-8);
    }
    if (name === "change_preview_query" && receipt) {
      for (const [key, title] of [["before", "预览前 · 当前工作版"], ["after", "预览后 · 假设采用，尚未生效"]]) {
        const result = object(object(receipt[key])?.result), entries = result?.items;
        if (Array.isArray(entries)) this.card.tables.push({ title, rows: entries.slice(0, 20).map(object).filter(Boolean) as Data[], coverage: object(result?.coverage) ?? null, truncated: entries.length > 20 });
      }
      this.card.tables = this.card.tables.slice(-8);
    }
    this.save();
  }
  answer(value: Data) {
    if (this.card.status !== "running") return;
    this.card.answer = structuredClone(value); this.save();
  }
  failed(name: string, error: string, operationId?: string) {
    if (this.card.status !== "running") return;
    const step = this.card.steps.findLast(step => step.tool === name && step.status === "running" && (!operationId || step.id === operationId));
    if (step) { step.status = "failed"; step.finishedAt = now(); }
    else this.card.steps.push({ id: operationId ?? `step-${++this.sequence}`, tool: name, ...operation(name), status: "failed", refs: [], startedAt: now(), finishedAt: now() });
    this.card.error = error; this.save();
  }
  finish(input: { status: Exclude<RunStatus, "running">; error?: string; usage?: Json; pending?: Data | null }) {
    if (this.card.status !== "running") {
      if (input.usage) { this.card.usage = runUsage(input.usage); this.save(); }
      return;
    }
    if (["stopped", "timed_out", "failed"].includes(input.status)) this.flushText();
    for (const step of this.card.steps) if (step.status === "running") { step.status = "stopped"; step.finishedAt = now(); }
    this.card.status = input.status; this.card.finishedAt = now(); this.card.usage = runUsage(input.usage);
    const systemMessage = { stopped: "运行已停止，已保存成果保留。", timed_out: "运行超过时限，已停止后续操作；已保存成果保留。", failed: "运行未完成，请核对已保存成果后继续。", waiting: "有待你核对的决定，助手已暂停。", completed: "本轮处理已结束。" }[input.status];
    this.card.systemEvents.push({ kind: input.status, message: systemMessage, at: this.card.finishedAt });
    if (input.pending?.question) this.card.decisions = [decisionCard(this.memory, input.pending)];
    if (input.error) this.card.error = input.error;
    this.save();
  }
}

/** Existing run cards stay readable after restart; action targets follow the current saved change version. */
export function projectAgentRuns(memory: MemoryStore, taskId: string, pending?: PendingCenter): RunCard[] {
  const currentDecision = (id: string) => {
    try {
      if (pending) { const item = pending.read(id); return { ref: { id: item.id, version: item.version }, active: item.actions.analyze }; }
      const artifact = memory.getArtifact(id);
      return { ref: ref(artifact), active: ["proposed", "verified", "failed"].includes(artifact.status) };
    } catch { return null; }
  };
  return memory.listArtifacts("agent_run").filter(artifact => artifact.content.taskId === taskId).slice(0, 30).reverse().map(artifact => {
    const card = structuredClone(artifact.content) as unknown as RunCard;
    card.id = artifact.id;
    card.systemEvents ??= [];
    const task = memory.getTask(taskId);
    if (card.status === "running" && (task.executionId !== artifact.content.executionId || task.status === "paused")) {
      card.status = "stopped"; card.finishedAt = task.updatedAt;
      for (const step of card.steps) if (step.status === "running") { step.status = "stopped"; step.finishedAt = task.updatedAt; }
      card.systemEvents.push({ kind: "interrupted", message: "服务重启或运行中断，已保存成果保留。", at: task.updatedAt });
      card.continuation = continuation(card);
    }
    card.changeList = card.changeList.map(item => {
      try { const change = memory.getArtifact(item.ref.id); return { ...item, ref: ref(change), title: pending?.read(change.id).title ?? change.title, status: change.status, ...(object(change.content.verification) ? { verification: object(change.content.verification) } : {}) }; }
      catch { return item; }
    });
    card.decisions = card.decisions.map(decision => {
      const references = (Array.isArray(decision.refs) ? decision.refs : []).map(value => object(value)).filter(Boolean) as Data[];
      const current = references.map(reference => currentDecision(String(reference.id)));
      const active = current.length ? current.some(item => item?.active) : task.status === "waiting";
      return { ...decision, refs: current.map((item, index) => item?.ref ?? references[index]), status: active ? "pending" : "resolved" };
    });
    if (card.status !== "running") card.continuation = continuation(card);
    return card;
  });
}

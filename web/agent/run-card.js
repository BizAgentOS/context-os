import { safeText, technicalDetails } from "./ui-display.js";
import { renderMarkdown, renderResultTable } from "./message-markdown.js";
import { renderDecisionCard } from "./decision-card.js";
import { renderAnswerCard } from "./answer-card.js";

const labels = { running: "正在处理", completed: "已完成", waiting: "等待你的决定", stopped: "已停止", timed_out: "已超时", failed: "未完成", proposed: "待复验", verified: "待决定", adopted: "已采用", rejected: "已拒绝", withdrawn: "已撤回" };
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = safeText(text); if (className) node.className = className; return node; };
const list = values => { const node = el("ul"); for (const value of values) node.append(el("li", value)); return node; };
const details = (title, key, content, open = false) => { const node = el("details"); node.dataset.detailKey = key; node.open = open; node.append(el("summary", title), content); return node; };

export function renderRunCard(run, { openPending, highlightRefs, answerDecision, switchMode, continueRun, showAnswer, renderPendingActions, deferred, onLater, streaming } = {}) {
  const card = el("article", undefined, "agent-run-card"); card.dataset.runId = run.id;
  const heading = el("header"); heading.append(el("strong", labels[run.status] || "处理记录"));
  const started = new Date(run.startedAt), ended = run.finishedAt ? new Date(run.finishedAt) : null;
  if (!Number.isNaN(started.getTime())) heading.append(el("time", started.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })));
  card.append(heading);
  if(run.answer)card.append(renderAnswerCard(run.answer,{showAnswer,openPending}));
  const steps = el("ol", undefined, "agent-run-steps");
  for (const step of run.steps || []) {
    const row = el("li"); row.dataset.status = step.status;
    row.append(el("span", step.summary), el("span", labels[step.status] || (step.status === "failed" ? "未完成" : "未完成"), "agent-step-status")); steps.append(row);
  }
  if (!steps.children.length) steps.append(el("li", "正在准备本轮工作"));
  card.append(details(`执行步骤 · ${run.steps?.length || 0} 项`, `${run.id}:steps`, steps, run.status === "running"));
  const intermediate = [...(run.intermediate || []), ...(streaming ? [streaming] : [])];
  if (intermediate.length) {
    const content = el("div"); for (const text of intermediate) content.append(renderMarkdown(text));
    card.append(details("处理过程中的文字", `${run.id}:intermediate`, content));
  }
  if (run.changeList?.length) {
    const changes = el("section", undefined, "agent-run-changes"); changes.append(el("h4", "本轮变更"));
    for (const change of run.changeList) {
      const row = el("div", undefined, "agent-change-row"); row.append(el("span", change.title), el("small", labels[change.status] || change.status));
      if (openPending) { const button = el("button", "查看变更"); button.type = "button"; button.dataset.focusKey = `${run.id}:change:${change.ref.id}`; button.onclick = () => openPending(change.ref); row.append(button); }
      changes.append(row);
    }
    card.append(changes);
  }
  for (const result of run.tables || []) card.append(renderResultTable(result));
  for (const [index, decision] of (run.decisions || []).entries()) {
    const key = `${run.id}:decision:${index}`;
    const node = renderDecisionCard(decision, { openPending, highlightRefs, answerDecision, switchMode, renderPendingActions, onLater: () => onLater?.(key) });
    if (deferred?.has(key)) card.append(details(decision.kind==="mode_suggestion"?"稍后切换模式":"稍后决定 · 仍在待处理中", key, node)); else card.append(node);
  }
  for (const event of run.systemEvents || []) card.append(el("p", `系统 · ${event.message}`, "agent-system-event"));
  if (["stopped", "timed_out", "failed"].includes(run.status)) {
    const receipt = el("section", undefined, "agent-partial-receipt"); receipt.append(el("h4", "本轮完成情况"));
    const completed = run.continuation?.completed || [], saved = run.changeList || [], remaining = run.continuation?.remaining || [];
    receipt.append(el("h5", "已完成"), completed.length ? list(completed) : el("p", "没有已完成的步骤。"));
    receipt.append(el("h5", "已保存"), saved.length ? list(saved.map(change => change.title)) : el("p", "没有保存变更。"));
    receipt.append(el("h5", "未完成"), remaining.length ? list(remaining) : el("p", "未记录后续步骤；继续时会重新核对原目标。"));
    if (run.error) receipt.append(el("p", run.error, "agent-card-status"));
    if (continueRun) {
      const button = el("button", "继续处理"); button.type = "button"; button.dataset.focusKey = `${run.id}:continue`;
      button.onclick = async () => { button.disabled = true; try { await continueRun({ ...run.continuation, runId: run.id }); } catch (error) { receipt.append(el("p", error.message, "agent-card-status")); } finally { if (button.isConnected) button.disabled = false; } };
      receipt.append(button);
    }
    card.append(receipt);
  }
  const usage = run.usage || {}, tokens = Number.isFinite(usage.tokens) ? `${usage.tokens.toLocaleString("zh-CN")} token` : "token 未知";
  const cost = Number.isFinite(usage.cost) ? `${usage.currency || ""} ${usage.cost.toFixed(4)}`.trim() : "费用未知";
  const duration = ended && !Number.isNaN(ended.getTime()) && !Number.isNaN(started.getTime()) ? ` · ${Math.max(0, Math.round((ended - started) / 1000))} 秒` : "";
  card.append(el("footer", `${tokens} · ${cost}${duration}`, "agent-run-usage"), technicalDetails(run));
  return card;
}

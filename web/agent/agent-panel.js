import { technicalDetails } from "./ui-display.js";
import { renderMarkdown } from "./message-markdown.js";
import { renderRunCard } from "./run-card.js";
import { createAgentModeControls } from "./agent-mode-controls.js";

export function createAgentPanel({ state, ui, $, node, button, api, hasCanvasContent, inspectContext, errorMessage, openPending, highlightRefs, answerDecision, switchMode, continueRun, modeChanged, modesDisabled, showAnswer }) {
const deferred = new Set();
$(".interaction").classList.add("agent-panel-shell");
const modeControls=createAgentModeControls({ui,api,onChange:()=>{modeChanged?.();renderDialogue();},disabled:()=>modesDisabled?.()===true});
$(".history-panel").prepend(modeControls.root);
const collapse=$("#collapse-composer");collapse.textContent='收起助手';modeControls.root.after(collapse);
function renderDialogue() {
  const lines = state.messages
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({ ...message }));
  if (!lines.length && !state.busy && hasCanvasContent() && state.prompt)
    lines.push({ id: "prompt", role: "assistant", content: state.prompt });
  const runs = state.agentRuns || [];
  const visible = [...lines, ...runs.map(run => ({ id: run.id, role: "run", createdAt: run.startedAt, run }))]
    .filter(message=>!(message.role==='assistant'&&message.binding?.mode==='qa'&&runs.some(run=>run.taskId===message.taskId&&run.answer?.conclusion===message.content)))
    .sort((left, right) => (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0));
  modeControls.render();
  $("#history-label").textContent = state.busy ? "对话记录 · 正在处理…" : "对话记录";
  $("#chat-activity").hidden = !state.busy;
  const fingerprint = JSON.stringify([state.currentSessionId, visible, state.messagePage, state.streaming, [...deferred]]);
  if (ui.dialogueKey === fingerprint) return;
  ui.dialogueKey = fingerprint;
  const container = $("#dialogue");
  const followLatest = container.scrollHeight - container.scrollTop - container.clientHeight < 48;
  const previousScroll = container.scrollTop;
  const opened = new Map([...container.querySelectorAll("details[data-detail-key]")].map(detail => [detail.dataset.detailKey, detail.open]));
  const focused = container.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
  container.replaceChildren();
  if (state.messagePage?.nextBefore) {
    const before = state.messagePage.nextBefore, sessionId = state.currentSessionId, page = ui.page;
    container.append(button("加载更早消息", "quiet-button", async event => {
      const load = event.currentTarget; load.disabled = true;
      const height = container.scrollHeight, scroll = container.scrollTop;
      try {
        const older = await api(sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/messages?before=${encodeURIComponent(before)}` : `/api/canvas/messages?page=${page}&before=${encodeURIComponent(before)}`);
        if (state.currentSessionId !== sessionId) return;
        const ids = new Set(state.messages.map(m => m.id));
        state.messages = [...older.messages.filter(m => !ids.has(m.id)), ...state.messages];
        state.messagePage = { nextBefore: older.nextBefore };
        renderDialogue();
        container.scrollTop = scroll + container.scrollHeight - height;
      } catch (error) { errorMessage(error.message); }
      finally { if (load.isConnected) load.disabled = false; }
    }));
  }
  if (!visible.length) container.append(node("p", "dialogue-empty", "还没有对话，从下面介绍你的企业开始。"));
  visible.forEach(message => {
    if (message.role === "run") {
      container.append(renderRunCard(message.run, { openPending, highlightRefs, answerDecision, switchMode, continueRun, showAnswer, deferred, onLater: key => { deferred.add(key); renderDialogue(); }, streaming: message.run.status === "running" && message.run.id === runs.at(-1)?.id ? state.streaming : "" }));
      return;
    }
    const line = node(
      "article",
      `dialogue-line ${message.role}`,
    );
    line.setAttribute("aria-label", message.role === "user" ? "你的消息" : "助手答复");
    if(message.binding?.mode)line.append(node('small','message-mode',`${message.binding.mode==='qa'?'问答':'构建'} · ${message.binding.dataView?.kind==='consumer'?'接入方范围':message.binding.dataView?.kind==='release'?'固定发布':'工作版'}`));
    line.append(renderMarkdown(message.content));
    line.append(technicalDetails(message));
    if (message.workContext?.target) {
      const ref = message.workContext.target;
      const label = String(ref.label || "相关内容").replace(/\s*[·-]?\s*第\s*\d+\s*版/g, "").replace(/\s*[·-]?\s*v\d+\b/g, "");
      const time = new Date(message.createdAt);
      const savedAt = Number.isNaN(time.getTime()) ? "" : ` · ${time.toLocaleString("zh-CN")}`;
      line.append(
        button(
          `引用：${label}${savedAt}`,
          "message-context",
          () =>
            inspectContext(
              message.workContext.context,
              message.workContext.context.view.split(".")[0],
            ),
        ),
      );
    }
    container.append(line);
  });
  if (state.streaming && !runs.some(run => run.status === "running")) {
    const detail = node("details", "agent-streaming"); detail.dataset.detailKey = "streaming";
    detail.append(node("summary", "", "正在处理 · 查看过程文字"), renderMarkdown(state.streaming)); container.append(detail);
  }
  for (const detail of container.querySelectorAll("details[data-detail-key]")) if (opened.has(detail.dataset.detailKey)) detail.open = opened.get(detail.dataset.detailKey);
  if (focused) [...container.querySelectorAll("[data-focus-key]")].find(element => element.dataset.focusKey === focused)?.focus({ preventScroll: true });
  container.scrollTop = followLatest ? container.scrollHeight : previousScroll;
}
return { renderDialogue };
}

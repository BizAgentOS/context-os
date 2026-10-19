import { technicalDetails } from "./ui-display.js";

export function createAgentPanel({ state, ui, $, node, button, api, hasCanvasContent, inspectContext, errorMessage }) {
function renderDialogue() {
  const lines = state.messages
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({ ...message }));
  if (state.streaming)
    lines.push({
      id: "streaming",
      role: "assistant",
      content: state.streaming,
      streaming: true,
    });
  else if (
    !state.busy &&
    state.pending?.question &&
    lines.at(-1)?.role !== "assistant"
  )
    lines.push({
      id: "question",
      role: "assistant",
      content: state.pending.question,
    });
  else if (!lines.length && hasCanvasContent() && state.prompt)
    lines.push({ id: "prompt", role: "assistant", content: state.prompt });
  const visible = lines;
  $("#history-label").textContent = state.busy ? "对话记录 · 正在处理…" : "对话记录";
  $("#chat-activity").hidden = !state.busy;
  const fingerprint = JSON.stringify([visible, state.messagePage]);
  if (ui.dialogueKey === fingerprint) return;
  ui.dialogueKey = fingerprint;
  const container = $("#dialogue");
  const followLatest = container.scrollHeight - container.scrollTop - container.clientHeight < 48;
  const previousScroll = container.scrollTop;
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
  visible.forEach((message, index) => {
    const distance = visible.length - 1 - index;
    const age = distance === 0 ? "latest" : distance === 1 ? "older" : "oldest";
    const text = String(message.content)
      .replace(/\*\*/g, "")
      .replace(/^#{1,6}\s+/gm, "");
    const line = node(
      "p",
      `dialogue-line ${message.role} ${age}${message.streaming ? " streaming" : ""}`,
    );
    line.append(node("span", "message-text", text));
    if (/`{3,}json/.test(text)) line.append(technicalDetails({ text: message.content }));
    if (message.workContext?.target) {
      const ref = message.workContext.target;
      line.append(
        button(
          `引用：${ref.label} · 第 ${ref.ref.version} 版`,
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
  container.scrollTop = followLatest ? container.scrollHeight : previousScroll;
}
return { renderDialogue };
}

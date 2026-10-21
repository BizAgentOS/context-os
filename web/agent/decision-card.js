import { safeText } from "./ui-display.js";

/** Decisions, gaps and mode suggestions share presentation; only their owning service supplies actions. */
export function renderDecisionCard(decision, { openPending, highlightRefs, answerDecision, onLater } = {}) {
  const node = (tag, text) => { const value = document.createElement(tag); if (text) value.textContent = safeText(text); return value; };
  const card = node("section"); card.className = "agent-decision-card";
  card.setAttribute("aria-label", decision.kind === "gap" ? "数据缺口" : decision.kind === "mode_suggestion" ? "建议切换模式" : "需要你的决定");
  card.append(node("h4", decision.question || decision.title || "需要你的决定"));
  if (decision.reason) card.append(node("p", decision.reason));
  if (decision.impact) card.append(node("p", decision.impact));
  if (decision.status === "resolved") { card.append(node("p", "此决定已处理。当前结果请查看本轮变更。")); return card; }
  const controls = node("div"); controls.className = "agent-card-actions";
  const action = (label, task) => {
    const button = node("button", label); button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await task(); } catch (error) { status.textContent = safeText(error.message); }
      finally { if (button.isConnected) button.disabled = false; }
    }); controls.append(button);
  };
  const status = node("p"); status.className = "agent-card-status"; status.setAttribute("role", "status");
  for (const [index, ref] of (decision.refs || []).entries()) if (openPending) {
    action(decision.refs.length > 1 ? `查看变更 ${index + 1} 并决定` : "查看影响并决定", () => openPending(ref));
    if (highlightRefs) action("在本体中查看", () => highlightRefs([ref]));
  }
  if (answerDecision) for (const option of decision.options || []) action(option.label, () => answerDecision({ question: decision.question, option }));
  action("稍后", () => { card.dataset.deferred = "true"; status.textContent = "已暂缓显示，变更仍在待处理中。"; onLater?.(decision); });
  card.append(controls, status); return card;
}

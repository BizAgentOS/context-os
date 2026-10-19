import { el, action, dialog, field, message, transact } from "./engine-ui.js";

export function createSessions({ state, api, switchSession, error, host }) {
  const root = el("nav", null, "agent-sessions"); root.setAttribute("aria-label", "助手会话");
  const select = el("select"); select.setAttribute("aria-label", "当前会话");
  let sessions = [], loading = 0;
  const edit = action("重命名", () => {
    const session = sessions.find(item => item.id === state.currentSessionId); if (!session) return;
    const d = dialog("重命名会话"), title = field(d.body, "会话名称", session.title), output = message(d.body);
    d.body.append(action("保存名称", () => transact(d, output, async () => {
      await api(`/api/sessions/${encodeURIComponent(session.id)}`, { title: title.value }, "PATCH"); d.close(); await load();
    }), "engine-primary"));
  });
  const archive = action("归档", async () => {
    try { await api(`/api/sessions/${encodeURIComponent(state.currentSessionId)}`, { archived: true }, "PATCH"); await load(true); }
    catch (cause) { error(cause.message); }
  });
  root.append(select, action("新会话", async () => {
    try { const result = await api("/api/sessions", {}); await load(); await switchSession(result.session.id); }
    catch (cause) { error(cause.message); }
  }), edit, archive);
  select.onchange = () => void switchSession(select.value).catch(cause => error(cause.message));
  host.prepend(root);
  function render() {
    select.replaceChildren();
    for (const session of sessions.filter(item => !item.archived)) {
      const option = el("option", session.title || "新会话"); option.value = session.id;
      if (state.pools?.interactive?.some(run => run.sessionId === session.id)) option.textContent += " · 处理中";
      select.append(option);
    }
    select.value = state.currentSessionId || "";
    edit.disabled = archive.disabled = !state.currentSessionId;
  }
  async function load(choose = false) {
    const version = ++loading, result = await api("/api/sessions"); if (version !== loading) return;
    sessions = result.sessions; render();
    if (choose || !sessions.some(item => item.id === state.currentSessionId && !item.archived)) {
      const active = sessions.find(item => !item.archived) || (await api("/api/sessions", {})).session;
      await switchSession(active.id); render();
    }
    return sessions;
  }
  return { load, render, dispose: () => { loading++; root.remove(); } };
}

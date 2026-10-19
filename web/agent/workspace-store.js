/** Shared state and explicit module events. Modules never communicate by clicking another module's DOM. */
export function createWorkspaceStore(state) {
  const listeners = new Map();
  return {
    state,
    subscribe(topic, listener) {
      const group = listeners.get(topic) || new Set();
      listeners.set(topic, group); group.add(listener);
      return () => group.delete(listener);
    },
    emit(topic, value) { for (const listener of listeners.get(topic) || []) listener(value); },
    patch(value) {
      const changed = Object.keys(value).filter(key => Object.hasOwn(state, key));
      for (const key of changed) state[key] = value[key];
      this.emit("state", { changed, value });
    },
  };
}

/** One connection per tab, with browser reconnect/replay plus snapshot correction after a reconnect. */
export function connectWorkspaceEvents({ cursor, onEvent, onCorrect, onError, EventSourceClass = globalThis.EventSource }) {
  const source = new EventSourceClass(`/api/events?after=${encodeURIComponent(cursor || "")}`);
  let opened = false;
  source.onopen = () => { if (opened) onCorrect(); opened = true; };
  source.addEventListener("update", event => {
    try { onEvent(JSON.parse(event.data)); } catch (error) { onError?.(error); }
  });
  source.addEventListener("reset", () => onCorrect());
  source.onerror = () => onError?.(new Error("连接已中断，正在重新连接…"));
  return () => source.close();
}

/** Keep independent domain updates bounded and coalesced while a burst of durable changes commits. */
export function createScopeQueue(load, failed) {
  const pending = new Set();
  let timer, running = false, closed = false;
  async function flush() {
    timer = undefined;
    if (running || closed) return;
    running = true;
    const scopes = [...pending]; pending.clear();
    try { await Promise.all(scopes.map(load)); } catch (error) { failed?.(error); }
    finally { running = false; if (pending.size && !closed) timer = setTimeout(flush, 60); }
  }
  return {
    add(scopes) { for (const scope of scopes) pending.add(scope); if (!timer && !running) timer = setTimeout(flush, 60); },
    close() { closed = true; clearTimeout(timer); pending.clear(); },
  };
}

import { test } from "node:test";
import assert from "node:assert/strict";

test("the workspace client delivers versioned events, corrects reconnects and releases subscriptions", async () => {
  const { createWorkspaceStore, connectWorkspaceEvents, createScopeQueue } = await import(new URL("../../web/agent/workspace-store.js", import.meta.url).href);
  const state = { messages: [], profile: null };
  const store = createWorkspaceStore(state);
  let updates = 0;
  const unsubscribe = store.subscribe("state", () => updates++);
  store.patch({ profile: { title: "Acme" }, unknown: "ignored" });
  assert.equal(updates, 1);
  unsubscribe(); store.patch({ messages: [] }); assert.equal(updates, 1);
  assert.equal(Object.hasOwn(state, "unknown"), false);
  let source: any, corrected = 0;
  const delivered: unknown[] = [];
  class Source {
    listeners = new Map(); closed = false; onopen?: () => void;
    url: string;
    constructor(url: string) { this.url = url; source = this; }
    addEventListener(name: string, callback: unknown) { this.listeners.set(name, callback); }
    close() { this.closed = true; }
  }
  const close = connectWorkspaceEvents({ cursor: "epoch:1", EventSourceClass: Source, onEvent: (event: unknown) => delivered.push(event), onCorrect: () => corrected++ });
  assert.match(source.url, /after=epoch%3A1/);
  source.onopen(); assert.equal(corrected, 0);
  source.listeners.get("update")({ data: JSON.stringify({ ref: { id: "model", version: 3 } }) });
  assert.deepEqual(delivered, [{ ref: { id: "model", version: 3 } }]);
  source.onopen(); assert.equal(corrected, 1);
  source.listeners.get("reset")(); assert.equal(corrected, 2);
  close(); assert.equal(source.closed, true);
  const loads: string[] = [], queue = createScopeQueue(async (scope: string) => { loads.push(scope); });
  queue.add(["agent", "data"]); queue.add(["agent"]);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(loads.sort(), ["agent", "data"]);
  queue.close();
});

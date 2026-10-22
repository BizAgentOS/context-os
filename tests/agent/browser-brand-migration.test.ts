import { test } from "node:test";
import assert from "node:assert/strict";

test("renamed browser storage keeps workspace drafts and never overwrites a current value", async () => {
  const { readBrowserValue } = await import(new URL("../../web/agent/browser-storage.js", import.meta.url).href);
  const values = new Map<string, string>([["dataengine:drafts:v2:workspace-a", "saved-draft"], ["dataengine:drafts:v2:workspace-b", "other-draft"]]);
  const storage = { getItem: (key:string) => values.get(key) ?? null, setItem: (key:string, value:string) => values.set(key, value), removeItem: (key:string) => values.delete(key) };
  assert.equal(readBrowserValue(storage, "context-os:drafts:v2:workspace-a", ["dataengine:drafts:v2:workspace-a"]), "saved-draft");
  assert.equal(values.get("context-os:drafts:v2:workspace-a"), "saved-draft");
  assert.equal(values.get("dataengine:drafts:v2:workspace-b"), "other-draft");
  values.set("dataengine:drafts:v2:workspace-a", "outdated-draft");
  assert.equal(readBrowserValue(storage, "context-os:drafts:v2:workspace-a", ["dataengine:drafts:v2:workspace-a"]), "saved-draft");
  const blocked = { ...storage, setItem() { throw new Error("quota exceeded"); } };
  assert.equal(readBrowserValue(blocked, "context-os:drafts:v2:workspace-b", ["dataengine:drafts:v2:workspace-b"]), "other-draft");
  assert.equal(values.get("dataengine:drafts:v2:workspace-b"), "other-draft");
});

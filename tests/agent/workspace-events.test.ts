import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import { Workspace } from "../../src/agent/workspace.ts";

test("workspace events require admin access, replay object versions, and correct stale clients with snapshots", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-events-"));
  const service = await createServer({ directory, automaticApi: false });
  await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const headers = { "X-DataEngine-Token": service.adminToken };
  const abort = new AbortController();
  try {
    assert.equal((await fetch(`${base}/api/events`)).status, 403);
    const snapshot = await fetch(`${base}/api/snapshot`, { headers }).then(r => r.json());
    assert.equal(typeof snapshot.eventCursor, "string");
    assert.equal(snapshot.workspaceId, service.app.memory.workspaceId());
    const source = new Workspace(service.app.memory).upload("events.csv", "id,name\n1,Alpha\n");
    const response = await fetch(`${base}/api/events?after=${encodeURIComponent(snapshot.eventCursor)}`, { headers, signal: abort.signal });
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes(source.id)) {
      const chunk = await reader.read();
      text += new TextDecoder().decode(chunk.value);
    }
    const frames = text.split("\n\n").filter(frame => frame.includes("data: "));
    const event = frames.map(frame => JSON.parse(frame.split("data: ")[1])).find(event => event.ref?.id === source.id);
    assert.equal(event.ref.version, source.version);
    assert.ok(event.scopes.includes("data"));
    assert.doesNotMatch(text, /Alpha|id,name/, "events contain references, never source rows");
    abort.abort();
    const staleAbort = new AbortController();
    const stale = await fetch(`${base}/api/events?after=previous-process:100`, { headers, signal: staleAbort.signal });
    const chunk = await stale.body!.getReader().read();
    assert.match(new TextDecoder().decode(chunk.value), /event: reset/);
    staleAbort.abort();
    const data = await fetch(`${base}/api/snapshot?scope=data`, { headers }).then(r => r.json());
    assert.ok(data.sources.some((entry: {id:string}) => entry.id === source.id));
    assert.equal(data.messages, undefined, "a data correction does not resend the conversation");
    await service.app.programBuilds.build({ operationId: "events-build", autoAdopt: true });
    const shell = await fetch(`${base}/api/snapshot?scope=shell`, { headers }).then(r => r.json());
    const versions = await fetch(`${base}/api/workspace-versions`, { headers }).then(r => r.json());
    assert.equal(shell.workspaceVersion.number, versions.versions[0].number, "event-driven shell refreshes carry the current working version");
  } finally {
    abort.abort();
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

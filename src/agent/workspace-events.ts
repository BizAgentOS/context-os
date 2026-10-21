import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { EventEmitter } from "node:events";

type Change = { kind: string; id?: string; taskId?: string; sessionId?: string; version?: number; artifactKind?: string; event?: string; text?: string; data?: unknown };
export type WorkspaceEvent = { id: string; type: string; scopes: string[]; ref?: { id: string; version?: number; kind?: string }; sessionId?: string; text?: string };

/** Process-local replay is deliberately bounded. A restart or old cursor requires a fresh snapshot. */
export class WorkspaceEvents {
  private epoch = randomUUID();
  private sequence = 0;
  private history: WorkspaceEvent[] = [];
  private clients = new Set<ServerResponse>();
  private heartbeat: ReturnType<typeof setInterval>;
  private source: EventEmitter;
  private onChange = (change: Change) => this.publish(change);

  constructor(source: EventEmitter) {
    this.source = source;
    source.on("change", this.onChange);
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) client.write(": keepalive\n\n");
    }, 20_000);
    this.heartbeat.unref();
  }
  get cursor() { return `${this.epoch}:${this.sequence}`; }

  private publish(change: Change) {
    const kind = change.artifactKind ?? "";
    let type = change.kind, scopes = ["shell"];
    if (type === "artifact") {
      type = /source|dataset|snapshot/.test(kind) ? "sources" : /change|correction|verification/.test(kind) ? "changes" : /release|consumer/.test(kind) ? "versions" : /job|task/.test(kind) ? "tasks" : "versions";
      scopes = /source|dataset|snapshot/.test(kind) ? ["data", "ontology", "release", "shell"] : /release|consumer/.test(kind) ? ["release", "shell"] : ["data", "ontology", "release", "shell"];
    } else if (type === "delta") scopes = [];
    else if (type === "message") { type = "messages"; scopes = ["agent"]; }
    else if (type === "step") { type = "steps"; scopes = ["agent"]; }
    else if (["task", "runtime"].includes(type)) { type = "tasks"; scopes = ["agent", "shell"]; }
    else if (type === "session") scopes = ["agent", "sessions"];
    else if (type === "settings" || type === "canvas") scopes = ["shell", "agent"];
    const event: WorkspaceEvent = {
      id: `${this.epoch}:${++this.sequence}`, type, scopes,
      ...(change.id || change.taskId ? { ref: { id: change.id ?? change.taskId!, ...(change.version ? { version: change.version } : {}), ...(kind ? { kind } : {}) } } : {}),
      ...(change.sessionId ? { sessionId: change.sessionId } : {}),
      ...(type === "delta" ? { text: change.text ?? "" } : {}),
    };
    this.history.push(event);
    if (this.history.length > 512) this.history.shift();
    for (const client of this.clients) this.write(client, event);
  }
  private write(client: ServerResponse, event: WorkspaceEvent) {
    // A slow tab must reconnect and correct from a snapshot instead of retaining an unbounded queue.
    if (client.writableLength > 256 * 1024) { client.destroy(); this.clients.delete(client); return; }
    client.write(`id: ${event.id}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`);
  }
  connect(response: ServerResponse, after?: string) {
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    response.flushHeaders();
    if (after && after !== this.cursor) {
      const index = this.history.findIndex(event => event.id === after);
      // Cursor zero is valid only while the complete replay is retained.
      const fromStart = after === `${this.epoch}:0` && this.sequence <= this.history.length;
      if (index < 0 && !fromStart) response.write(`event: reset\ndata: ${JSON.stringify({ reason: "snapshot_required", cursor: this.cursor })}\n\n`);
      else for (const event of this.history.slice(fromStart ? 0 : index + 1)) this.write(response, event);
    }
    response.write(`event: ready\ndata: ${JSON.stringify({ cursor: this.cursor })}\n\n`);
    this.clients.add(response);
    response.once("close", () => this.clients.delete(response));
  }
  close() {
    clearInterval(this.heartbeat);
    this.source.off("change", this.onChange);
    for (const client of this.clients) client.end();
    this.clients.clear();
  }
}

export const snapshotScopes: Record<string, string[]> = {
  shell: ["workspaceId", "workspaceVersion", "pages", "model", "onboarding", "profile", "sourceSummary", "attention", "automaticBuild", "automaticApiBuild"],
  agent: ["session", "currentSessionId", "pools", "busy", "streaming", "messages", "messagePage", "pending", "prompt", "agentTask"],
  data: ["engine", "data", "sources", "sourceSummary", "sourcePolicies", "sourcePolicyFields", "live", "onboarding", "profile", "legacyHistory", "setupSection"],
  ontology: ["foundation", "ontologies", "outlines", "verifications", "evidence", "engine", "live", "sourceSummary", "automaticBuild", "automaticApiBuild"],
  release: ["consumers", "accessLogs", "live", "sourceSummary"],
};

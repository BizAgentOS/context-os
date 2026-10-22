import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { EventEmitter } from "node:events";

type Change = { kind: string; id?: string; taskId?: string; sessionId?: string; version?: number; artifactKind?: string; event?: string; text?: string; data?: unknown };
export type WorkspaceEvent = { id: string; type: string; scopes: string[]; ref?: { id: string; version?: number; kind?: string }; sessionId?: string; text?: string };
export interface EventAccess { validate?():void; project?(event:WorkspaceEvent):WorkspaceEvent|null; }

/** Process-local replay is deliberately bounded. A restart or old cursor requires a fresh snapshot. */
export class WorkspaceEvents {
  private epoch = randomUUID();
  private sequence = 0;
  private history: WorkspaceEvent[] = [];
  private clients = new Map<ServerResponse,EventAccess>();
  private heartbeat: ReturnType<typeof setInterval>;
  private source: EventEmitter;
  private onChange = (change: Change) => this.publish(change);

  constructor(source: EventEmitter) {
    this.source = source;
    source.on("change", this.onChange);
    this.heartbeat = setInterval(() => {
      for (const client of this.clients.keys()) if(this.authorized(client))client.write(": keepalive\n\n");
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
      if (kind === "agent_run") { type = "steps"; scopes = ["agent"]; }
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
    for (const client of this.clients.keys()) this.write(client, event);
  }
  private authorized(client:ServerResponse){
    const access=this.clients.get(client);if(!access)return false;
    try{access.validate?.();return true;}catch{this.clients.delete(client);client.end();return false;}
  }
  private write(client: ServerResponse, event: WorkspaceEvent) {
    if(!this.authorized(client))return false;
    let visible:WorkspaceEvent|null=event;
    try{const project=this.clients.get(client)?.project;if(project)visible=project(structuredClone(event));}catch{this.clients.delete(client);client.end();return false;}
    if(!visible)return true;
    // A slow tab must reconnect and correct from a snapshot instead of retaining an unbounded queue.
    if (client.writableLength > 256 * 1024) { client.destroy(); this.clients.delete(client); return false; }
    client.write(`id: ${visible.id}\nevent: update\ndata: ${JSON.stringify(visible)}\n\n`);return true;
  }
  connect(response: ServerResponse, after?: string, access:EventAccess={}) {
    access.validate?.();
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    response.flushHeaders();
    this.clients.set(response,access);response.once("close", () => this.clients.delete(response));
    if (after && after !== this.cursor) {
      const index = this.history.findIndex(event => event.id === after);
      // Cursor zero is valid only while the complete replay is retained.
      const fromStart = after === `${this.epoch}:0` && this.sequence <= this.history.length;
      if (index < 0 && !fromStart) {if(!this.authorized(response))return;response.write(`event: reset\ndata: ${JSON.stringify({ reason: "snapshot_required", cursor: this.cursor })}\n\n`);}
      else for (const event of this.history.slice(fromStart ? 0 : index + 1)) if(!this.write(response, event))return;
    }
    if(!this.authorized(response))return;
    response.write(`event: ready\ndata: ${JSON.stringify({ cursor: this.cursor })}\n\n`);
  }
  close() {
    clearInterval(this.heartbeat);
    this.source.off("change", this.onChange);
    for (const client of this.clients.keys()) client.end();
    this.clients.clear();
  }
}

export const snapshotScopes: Record<string, string[]> = {
  shell: ["workspaceId", "workspaceVersion", "pendingSummary", "pages", "model", "onboarding", "profile", "sourceSummary", "attention", "automaticBuild", "automaticApiBuild", "automaticNaming"],
  agent: ["session", "currentSessionId", "pools", "busy", "streaming", "messages", "messagePage", "pending", "prompt", "agentTask", "agentRuns"],
  data: ["engine", "data", "sources", "sourceSummary", "sourcePolicies", "sourcePolicyFields", "live", "onboarding", "profile", "legacyHistory", "setupSection", "automaticNaming"],
  ontology: ["foundation", "ontologies", "outlines", "verifications", "evidence", "engine", "live", "sourceSummary", "automaticBuild", "automaticApiBuild"],
  release: ["consumers", "accessLogs", "live", "sourceSummary"],
};

/** Restore pre-freeze persisted records for read/revocation regressions. Never used by product code. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { Data } from "../../src/agent/contracts.ts";
import type { MemoryStore } from "../../src/agent/memory.ts";
import type { ConsumptionService } from "../../src/agent/consumption.ts";
import type { AgentApplication } from "../../src/agent/app.ts";
import { contextReading, type ContextScope } from "../../src/live/consumer-context.ts";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as Data;

export function historicalConsumers(service: ConsumptionService, memory: MemoryStore, directory: string) {
  return {
    propose(input: Record<string, unknown>) {
      const model = memory.getArtifact(String(input.modelId), Number(input.modelVersion));
      return memory.putArtifact({ ...(input.id ? { id: String(input.id), expectedVersion: Number(input.expectedVersion) } : {}), kind: "consumer", title: String(input.name), status: "draft", content: plain({ ...input, sourceVersions: model.content.sourceVersions }) });
    },
    activate(id: string, version: number) {
      const draft = memory.getArtifact(id, version);
      const apiKey = "de_consumer_" + randomBytes(32).toString("base64url");
      const consumer = memory.putArtifact({ ...draft, expectedVersion: version, status: "active", content: { ...draft.content, activatedAt: new Date().toISOString() } });
      const db = new DatabaseSync(join(directory, "consumption.sqlite"));
      try { db.prepare("INSERT INTO credentials VALUES (?,?,?)").run(hash(apiKey), id, consumer.version); } finally { db.close(); }
      return { consumer, apiKey };
    },
    publishDataUpdate(id: string, version: number, sourceVersions: unknown) {
      const consumer = memory.getArtifact(id, version);
      return memory.putArtifact({ ...consumer, expectedVersion: version, content: { ...consumer.content, credentialVersion: consumer.content.credentialVersion ?? version, sourceVersions: plain(sourceVersions), dataPublishedAt: new Date().toISOString() } });
    },
  };
}

export function restoreHistoricalAccess(app: Pick<AgentApplication, "memory" | "live">, path: string, input: any): any {
  const memory = app.memory;
  if (path === "/api/live/views/propose") {
    const prior = memory.listArtifacts("consumer_view").find(v => v.content.fixtureOperation === input.operationId);
    if (prior) return { saved: prior };
    const model = app.live.assertModel(input.modelRef.id, input.modelRef.version);
    const contextEvidence = (input.contextEvidence || []).map((scope: ContextScope) => {
      const preview = contextReading(memory, app.live, input.modelRef, scope, "validation");
      return { ...scope, evidenceRef: randomUUID(), label: scope.kind === "document" ? String(preview.title) : String((preview.definition as Data).name) };
    });
    return { saved: memory.putArtifact({ kind: "consumer_view", title: input.name, status: "draft", content: plain({ contractVersion: "v3", modelRef: input.modelRef, semanticRef: model.content.foundationRef ?? null, purpose: input.purpose, grants: input.grants, contextEvidence, relationPolicy: "source_mapping_only", fixtureOperation: input.operationId }) }) };
  }
  if (path === "/api/live/views/activate") {
    const draft = memory.getArtifact(input.id, input.version), key = "de_view_" + randomBytes(32).toString("base64url");
    const view = memory.putArtifact({ ...draft, expectedVersion: draft.version, status: "active", content: { ...draft.content, keyHash: hash(key), activationBaseVersion: draft.version } });
    return { saved: { view, key, keyAvailable: true } };
  }
  if (path === "/api/live/prepare") {
    const model = app.live.assertModel(input.modelId, app.memory.getArtifact(input.modelId).version);
    return { saved: memory.putArtifact({ kind: "live_consumer", title: input.name, status: "draft", content: plain({ ...input, modelVersion: model.version }) }) };
  }
  if (path === "/api/live/activate") {
    const draft = memory.getArtifact(input.id, input.version), key = "de_live_" + randomBytes(32).toString("base64url");
    const consumer = memory.putArtifact({ ...draft, expectedVersion: draft.version, status: "active", content: { ...draft.content, keyHash: hash(key) } });
    return { saved: { consumer, key } };
  }
  if (path === "/api/datasets/publish") {
    const prior = memory.listArtifacts("ontology_dataset").find(d => d.content.fixtureOperation === input.operationId);
    if (prior) return { dataset: prior, key: null, keyAvailable: false };
    const foundation = memory.getArtifact(input.foundationRef.id, input.foundationRef.version);
    let business = null;
    if (input.business) {
      const draft = restoreHistoricalAccess(app, "/api/live/views/propose", { ...input.business, operationId: "dataset:" + input.operationId, name: input.name, purpose: "历史 MCP 数据集" }).saved;
      const view = restoreHistoricalAccess(app, "/api/live/views/activate", draft).saved.view;
      business = { ...input.business, viewRef: { id: view.id, version: view.version } };
    }
    const key = "de_dataset_" + randomBytes(32).toString("base64url");
    const dataset = memory.putArtifact({ kind: "ontology_dataset", title: input.name, status: "active", content: plain({ foundationRef: input.foundationRef, enterprise: (foundation.content.enterprise as Data).name, concepts: (foundation.content.concepts as Data[]).filter(c => input.conceptIds.includes(c.id)).map(c => ({ id: c.id, name: c.name, description: c.description, origin: "adopted_interpretation" })), relations: (foundation.content.relations as Data[]).filter(r => input.relationIds.includes(r.id)).map(r => ({ id: r.id, name: r.name, description: r.description, from: r.from, to: r.to, origin: "adopted_interpretation" })), business, keyHash: hash(key), fixtureOperation: input.operationId, publishedAt: new Date().toISOString() }) });
    return { dataset, key, keyAvailable: true };
  }
  throw new Error("历史夹具不支持该写操作：" + path);
}

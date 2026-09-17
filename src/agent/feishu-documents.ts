import { createHash } from "node:crypto";
import type { FeishuConnector } from "../connectors/feishu.ts";
import type { Artifact, Data, WriteContext } from "./contracts.ts";
import type { MemoryStore } from "./memory.ts";

export interface FeishuSourceOrigin {
  documentId: string;
  url: string;
  revision: number | null;
  format: string;
  readAt: string;
  coverage: string;
}
const origin = (source: Artifact) => source.content.feishu as unknown as FeishuSourceOrigin;
const remoteKey = (url: string, coverage: string, id: string) => `${new URL(url).hostname}/${coverage}/${id}`;

/** Explicit remote reads become versioned local evidence; the host schedules ontology construction. */
export class FeishuDocuments {
  onSaved?: (source: Artifact) => void;
  private memory: MemoryStore;
  private reader: Pick<FeishuConnector, "readDocument">;
  constructor(memory: MemoryStore, reader: Pick<FeishuConnector, "readDocument">) {
    this.memory = memory;
    this.reader = reader;
  }
  async read(url: string, context?: WriteContext) {
    if (context) this.memory.assertWritable(context);
    const doc = await this.reader.readDocument(url);
    if (context) this.memory.assertWritable(context);
    const hash = createHash("sha256").update(doc.content).digest("hex");
    const key = remoteKey(doc.url, doc.coverage, doc.documentId);
    const prior = this.memory.listArtifacts("source").find(s => s.content.remoteKey === key && s.content.origin === "feishu");
    const title = doc.title || doc.content.split("\n").find(line => /^#\s+\S/.test(line))?.replace(/^#\s+/, "").slice(0, 180) || "飞书在线文档";
    const changed = !prior || prior.content.hash !== hash || prior.title !== title || origin(prior).revision !== doc.revision;
    const parseError = !doc.content.trim() ? "正文为空，无法用于本体化" : /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(doc.content) ? "正文包含无效文本，无法用于本体化" : null;
    const source = changed ? this.memory.putArtifact({
      ...(prior ? { id: prior.id, expectedVersion: prior.version } : {}),
      kind: "source", title, status: parseError ? "failed" : "ready",
      content: {
        origin: "feishu", remoteKey: key, format: "text", raw: doc.content, hash,
        feishu: { documentId: doc.documentId, url: doc.url, revision: doc.revision, format: doc.format, readAt: doc.readAt, coverage: doc.coverage },
        ...(parseError ? { parseError } : {}),
      },
    }, context) : prior;
    this.onSaved?.(source);
    return { ...this.get(source.id), lastReadAt: doc.readAt, changed };
  }
  source(id: string, version?: number) {
    const source = this.memory.getArtifact(id, version);
    if (source.kind !== "source" || source.content.origin !== "feishu") throw new Error("请选择已保存的飞书资料");
    return source;
  }
  get(id: string, version?: number) {
    const source = this.source(id, version);
    return { ...this.summary(source), content: String(source.content.raw ?? "") };
  }
  list() {
    return this.memory.listArtifacts("source").filter(s => s.content.origin === "feishu").map(s => this.summary(s));
  }
  matchDirectory(listing: Awaited<ReturnType<FeishuConnector["browseDirectory"]>>) {
    const sources = new Map(this.memory.listArtifacts("source").filter(s => s.content.origin === "feishu").map(s => [s.content.remoteKey, s]));
    return { ...listing, items: listing.items.map(item => {
      const coverage = item.type === "docx" ? "document" : item.type === "file" ? "file" : null;
      const source = coverage ? sources.get(remoteKey(item.url, coverage, item.documentId)) : null;
      return { ...item, saved: source ? { sourceId: source.id, sourceVersion: source.version, characters: String(source.content.raw ?? "").length } : null };
    }) };
  }
  private summary(source: Artifact) {
    const current = this.memory.listArtifacts("foundation")[0];
    const adoptedVersion = current?.content.adoptedVersion;
    const adopted = current?.status === "adopted" ? current : current && typeof adoptedVersion === "number" ? this.memory.getArtifact(current.id, adoptedVersion) : null;
    const foundations = [current, ...(adopted && adopted.version !== current?.version ? [adopted] : [])].filter((f): f is Artifact => !!f);
    const usage = foundations.flatMap(foundation => {
      const entries = [foundation.content.enterprise as Data, ...foundation.content.concepts as Data[], ...foundation.content.relations as Data[], ...foundation.content.unknowns as Data[], ...foundation.content.conflicts as Data[]];
      const used = new Set(entries.flatMap(item => [...(item.evidenceRefs as string[] || []), ...(item.resolvedBy as string[] || [])]));
      const evidence = (foundation.content.evidence as Data[]).filter(e => used.has(String(e.id)) && e.kind === "document" && e.sourceId === source.id);
      if (!evidence.length) return [];
      const refs = new Set(evidence.map(e => e.id));
      const matches = (items: Data[]) => items.filter(item => (item.evidenceRefs as string[]).some(id => refs.has(id))).map(item => ({ id: String(item.id), name: String(item.name) }));
      return [{
        foundationId: foundation.id, foundationVersion: foundation.version, status: foundation.status,
        sourceVersions: [...new Set(evidence.map(e => Number(e.sourceVersion)))],
        concepts: matches(foundation.content.concepts as Data[]), relations: matches(foundation.content.relations as Data[]),
      }];
    });
    return { sourceId: source.id, sourceVersion: source.version, title: source.title, status: source.status,
      ...origin(source), contentHash: String(source.content.hash), characters: String(source.content.raw ?? "").length,
      preview: String(source.content.raw ?? "").slice(0, 180), usage };
  }
}

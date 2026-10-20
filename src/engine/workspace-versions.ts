import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { FoundationService } from "../agent/foundation.ts";
import type { LiveMemory } from "../live/memory.ts";
import type { Snapshots, DatasetContent } from "../data/snapshots.ts";
import { jsonData } from "../live/sources.ts";
import { fingerprint } from "./release-diff.ts";

/**
 * The user-visible "工作版 vN": one combination of semantic definition, bindings, identity decisions,
 * local corrections and the active snapshot set (blueprint §10.4). A new version is recorded in the same
 * transaction that changes any of its parts, so there is never an adopted state without a version for it.
 */
const SOURCES = new Set(["foundation", "live_ontology", "relation_correction", "data_dataset"]);
const isAdopted = (artifact: Artifact) => {
  if (artifact.kind === "data_dataset") return true;
  return artifact.status === "adopted";
};

export class WorkspaceVersions {
  private memory: MemoryStore;
  private foundation: FoundationService;
  private live: LiveMemory;
  private recording = false;

  constructor(memory: MemoryStore, foundation: FoundationService, live: LiveMemory) {
    this.memory = memory; this.foundation = foundation; this.live = live;
    // A workspace that already has adopted state gets its baseline now, so the next change is recorded as a change.
    this.recording = true;
    try { if (!this.latest() && this.hasAdoptedState()) this.memory.atomic(() => this.record([], ["baseline"])); } finally { this.recording = false; }
    memory.beforeCommit = written => this.onWritten(written);
  }
  private hasAdoptedState() {
    return !!this.foundation.read().adopted || this.memory.listArtifacts("live_ontology").some(item => item.status === "adopted");
  }

  /** What defines the workspace right now. Wording and bindings are split because they change independently. */
  composition(): Data {
    const { adopted } = this.foundation.read();
    const model = this.memory.listArtifacts("live_ontology").find(item => item.status === "adopted") ?? null;
    const ref = (artifact: Artifact | null) => artifact ? { id: artifact.id, version: artifact.version } : null;
    const store = this.live.snapshots as Snapshots | undefined;
    const snapshots = (store?.datasets() ?? []).flatMap(dataset => {
      const content = dataset.content as unknown as DatasetContent;
      return content.activeVersion && content.materialization !== "live" ? [{ datasetId: dataset.id, snapshotId: content.activeVersion }] : [];
    }).sort((a, b) => a.datasetId.localeCompare(b.datasetId));
    const corrections = model ? this.memory.listArtifacts("relation_correction")
      .filter(item => item.status === "adopted" && (item.content.target as Data).modelId === model.id && (item.content.target as Data).modelVersion === model.version)
      .map(item => `${item.id}@${item.version}`).sort() : [];
    return jsonData({ semantic: ref(adopted), bindings: ref(model), identityDecisions: [], corrections, snapshots });
  }

  list() {
    return this.memory.listArtifacts("workspace_version").map(item => ({ id: item.id, version: item.version, number: item.content.number, createdAt: item.createdAt,
      cause: item.content.cause, changeRefs: item.content.changeRefs })).sort((a, b) => Number(b.number) - Number(a.number));
  }
  latest(): Artifact | null {
    return this.memory.listArtifacts("workspace_version").sort((a, b) => Number(b.content.number) - Number(a.content.number))[0] ?? null;
  }
  read(number: number): Artifact {
    const found = this.memory.listArtifacts("workspace_version").find(item => item.content.number === number);
    if (!found) throw new Error("工作版不存在");
    return found;
  }

  /** Called inside the committing transaction. A version is recorded only when the composition really changed. */
  private onWritten(written: Artifact[]) {
    if (this.recording) return;
    const causes = written.filter(item => SOURCES.has(item.kind) && isAdopted(item));
    if (!causes.length) return;
    this.recording = true;
    try { this.record(causes); } finally { this.recording = false; }
  }
  record(causes: Artifact[], label?: string[]) {
    const composition = this.composition();
    const previous = this.latest();
    if (previous && fingerprint(previous.content.composition) === fingerprint(composition)) return previous;
    const cause = label ?? [...new Set(causes.map(item => item.kind))].sort();
    const number = Number(previous?.content.number ?? 0) + 1;
    return this.memory.putArtifact({ kind: "workspace_version", title: `工作版 v${number}`, status: "recorded",
      content: jsonData({ number, composition, cause, changeRefs: causes.map(item => ({ id: item.id, version: item.version, kind: item.kind })) }) });
  }
}

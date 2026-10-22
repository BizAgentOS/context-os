import { projectMetricReferences } from "../semantic/metric-projection.ts";
import { z } from "zod";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { FoundationService } from "../agent/foundation.ts";
import type { Snapshots, DatasetContent } from "../data/snapshots.ts";
import { pinKey, type LiveMemory, type SnapshotPins } from "../live/memory.ts";
import { captureRelation, relationKey, type CorrectionTarget } from "../live/relation-corrections.ts";
import { jsonData } from "../live/sources.ts";
import { projectLegacyModel } from "../semantic/model.ts";
import { fingerprint } from "./release-diff.ts";
import { ChangeConflict } from "./changes.ts";
import { prepareIdentityDecisionMigration } from "../live/identity-migration.ts";
import { identityDecisionsForModel } from "../live/identity.ts";
import { propertyCorrectionsForModel, validatePropertyCorrections } from "../live/property-corrections.ts";

const ref = z.object({ id: z.string().trim().min(1).max(200), version: z.number().int().positive() }).strict();
export const workspaceRestoreSubject = z.object({ workspaceVersionRef: ref }).strict();
const compositionSchema = z.object({ semantic: ref.nullable(), bindings: ref.nullable(),
  identityDecisions: z.array(z.string()).default([]), corrections: z.array(z.string()), propertyCorrections: z.array(z.string()).default([]),
  snapshots: z.array(z.object({ datasetId: z.string(), snapshotId: z.string() }).strict()) }).strict();
const reference = (artifact: Artifact) => ({ id: artifact.id, version: artifact.version });

/** Restoring history is a new adopted state. Preparation reads the historical inputs but never changes them. */
export class WorkspaceRestore {
  private memory: MemoryStore;
  private foundation: FoundationService;
  private live: LiveMemory;
  private snapshots: Snapshots;
  constructor(memory: MemoryStore, foundation: FoundationService, live: LiveMemory, snapshots: Snapshots) {
    this.memory = memory; this.foundation = foundation; this.live = live; this.snapshots = snapshots;
  }

  async prepare(input: unknown): Promise<{ metrics: Record<string, number | boolean | string | null>; inputs: Data; notes: string[]; apply: () => Data }> {
    const { workspaceVersionRef } = workspaceRestoreSubject.parse(input);
    const currentWorkspaceRef = () => {
      const latest = this.memory.listArtifacts("workspace_version").sort((a, b) => Number(b.content.number) - Number(a.content.number))[0];
      return latest ? reference(latest) : null;
    };
    const workspaceBaseline = currentWorkspaceRef();
    const historical = this.memory.getArtifact(workspaceVersionRef.id, workspaceVersionRef.version);
    if (historical.kind !== "workspace_version" || historical.status !== "recorded") throw new Error("历史工作版不存在");
    const composition = compositionSchema.parse(historical.content.composition);
    if (!composition.semantic || !composition.bindings) throw new Error("历史工作版尚无完整的语义定义与执行绑定，无法恢复");
    const semantic = this.memory.getArtifact(composition.semantic.id, composition.semantic.version);
    const binding = this.memory.getArtifact(composition.bindings.id, composition.bindings.version);
    if (semantic.kind !== "foundation" || semantic.status !== "adopted" || binding.kind !== "live_ontology" || binding.status !== "adopted")
      throw new Error("历史工作版引用的已采用定义或绑定不可用");
    if ((binding.content.foundationRef as Data | undefined)?.id !== semantic.id) throw new Error("历史语义定义与绑定不属于同一本体");
    let layered = this.live.readLayered(binding.id, binding.version);
    for (const [items, definitions] of [[layered.semantic.entityTypes, semantic.content.concepts], [layered.semantic.relationTypes, semantic.content.relations], [layered.semantic.properties, semantic.content.properties ?? layered.semantic.properties]] as const) {
      for (const item of items) {
        const definition = (definitions as Data[]).find(entry => entry.id === item.id);
        if (!definition) throw new Error("历史绑定引用的语义对象不存在");
        if (item.name !== definition.name && !item.aliases.includes(item.name)) item.aliases.push(item.name);
        item.name = String(definition.name); item.description = String(definition.description);
      }
    }
    layered = projectMetricReferences(layered, semantic.content);
    const definition = jsonData({ ...binding.content, ...projectLegacyModel(layered, { allowTransforms: true }), layered, foundationRef: composition.semantic });
    const historicalConnections = { ...(definition.connections as Data) };
    const bindings = (definition.types as Data[]).flatMap(type => [type, ...((type.supplements ?? []) as Data[])]);
    for (const relation of definition.relations as Data[]) if (relation.linkTable) bindings.push(relation.linkTable as Data);
    const tracked = new Map<string, Artifact>();
    const track = (artifact: Artifact) => { tracked.set(artifact.id, artifact); return artifact; };
    for (const metric of layered.semantic.metricReferences) {
      this.live.sources.capability(metric.sourceId, metric.capability, metric.connectionVersion);
      track(this.memory.getArtifact(metric.sourceId));
    }
    const currentFoundation = this.foundation.read().current;
    if (currentFoundation) track(currentFoundation);
    const datasets = this.snapshots.datasets().map(track);
    const pins: SnapshotPins = {};
    const historicalSnapshots = new Map<string, Artifact>();
    // Querying each retained file proves that its data is still available, not merely its old metadata.
    for (const item of composition.snapshots) {
      const dataset = this.snapshots.dataset(item.datasetId), content = dataset.content as unknown as DatasetContent;
      const source = track(this.memory.getArtifact(content.sourceId));
      if (source.status !== "ready") throw new Error("历史工作版的来源已停用或移除，无法恢复");
      const snapshot = this.memory.getArtifact(item.snapshotId);
      if (snapshot.kind !== "data_snapshot" || snapshot.content.datasetSourceId !== content.sourceId || snapshot.content.capability !== content.capability)
        throw new Error("历史快照与来源绑定不一致");
      await this.snapshots.preview({ datasetId: dataset.id, snapshotId: snapshot.id, limit: 1 });
      historicalSnapshots.set(dataset.id, snapshot);
    }
    const liveInputs: Data[] = [];
    const liveDatasets = new Set<string>();
    for (const item of bindings) {
      const sourceId = String(item.sourceId), capability = String(item.capability);
      const source = track(this.memory.getArtifact(sourceId));
      if (source.kind !== "source_connection" || source.status !== "ready") throw new Error("历史工作版的来源已停用或移除，无法恢复");
      const connectionVersion = Number(historicalConnections[sourceId]);
      const dataset = this.snapshots.bindingDataset(sourceId, capability);
      const snapshot = dataset && historicalSnapshots.get(dataset.id);
      const historicalCapability = this.live.sources.pinnedCapability(sourceId, capability, connectionVersion).cap;
      const currentCapability = this.live.sources.capability(sourceId, capability).cap;
      if (historicalCapability.idField !== currentCapability.idField || historicalCapability.idType !== currentCapability.idType ||
          historicalCapability.fields.some(field => !currentCapability.fields.includes(field)) ||
          Object.keys(historicalCapability.filters).some(field => !Object.hasOwn(currentCapability.filters, field)))
        throw new Error("当前来源授权或字段契约已收窄，历史绑定必须重新构建后才能恢复");
      if (snapshot) {
        pins[pinKey(sourceId, capability)] = snapshot.id;
      } else {
        if (dataset) liveDatasets.add(dataset.id);
        const read = await this.live.sources.readRecords(sourceId, capability, {}, 0, 3, source.version);
        liveInputs.push(jsonData({ sourceId, capability, items: read.items, coverage: read.coverage }));
      }
      (definition.connections as Data)[sourceId] = source.version;
      const localSource = source.content.localSource as Data | undefined;
      if (localSource) {
        const uploaded = track(this.memory.getArtifact(String(localSource.id)));
        if (uploaded.status !== "ready") throw new Error("历史工作版的上传来源已移除，无法恢复");
      }
    }
    const corrections: Artifact[] = [];
    for (const pin of composition.corrections) {
      const [id, version] = pin.split("@");
      const correction = this.memory.getArtifact(id, Number(version));
      const target = correction.content.target as unknown as CorrectionTarget;
      if (correction.kind !== "relation_correction" || correction.status !== "adopted" || target.modelId !== binding.id || target.modelVersion !== binding.version)
        throw new Error("历史纠正不属于所选工作版绑定");
      const captured = await captureRelation(this.live, target, correction.content.targetIds as string[], () => {},
        { readMode: "release_pinned", pins, fixedSemantic: true, modelDefinition: (correction.content.modelDefinition ?? binding.content) as Data,
          identityDecisionPins: new Set(composition.identityDecisions) });
      if (captured.fingerprint !== correction.content.fingerprint) throw new Error("历史快照无法复现该工作版的纠正依据，不能恢复");
      corrections.push(correction);
    }
    const restoreIdentityDecisions = await prepareIdentityDecisionMigration(this.memory, this.live, definition, {
      baseModel: binding, decisionPins: new Set(composition.identityDecisions), readMode: "release_pinned", pins, fixedSemantic: true,
    });
    const propertyCorrections = propertyCorrectionsForModel(this.memory, binding, new Set(composition.propertyCorrections));
    if (propertyCorrections.length !== composition.propertyCorrections.length) throw new Error("历史属性纠正不属于所选工作版");
    await validatePropertyCorrections(this.live, binding, propertyCorrections, { readMode: "release_pinned", pins, fixedSemantic: true,
      modelDefinition: definition, identityDecisionPins: new Set(composition.identityDecisions) });
    const inputs = jsonData({ workspaceVersionRef, workspaceBaseline, composition, sourceState: [...tracked.values()].map(artifact => ({ ...reference(artifact), status: artifact.status })), liveInputs });
    const assertUnchanged = () => {
      if (fingerprint(currentWorkspaceRef()) !== fingerprint(workspaceBaseline)) throw new ChangeConflict("verification_changed", "当前工作版的治理决定或数据已变化，请重新复验恢复");
      for (const artifact of tracked.values()) {
        const current = this.memory.getArtifact(artifact.id);
        if (current.version !== artifact.version || current.status !== artifact.status) throw new Error("恢复依赖已变化，请重新复验历史工作版");
      }
      if (fingerprint(this.snapshots.datasets().map(reference)) !== fingerprint(datasets.map(reference))) throw new Error("工作版快照集已变化，请重新复验");
    };
    assertUnchanged();
    return {
      metrics: { workspaceNumber: Number(historical.content.number), entities: (definition.types as Data[]).length, relations: (definition.relations as Data[]).length,
        snapshots: composition.snapshots.length, corrections: corrections.length, propertyCorrections: propertyCorrections.length, identityDecisions: composition.identityDecisions.length, liveBindings: liveInputs.length },
      inputs,
      notes: liveInputs.length ? ["实时来源仅恢复绑定，读取当前数据，不承诺历史重放。"] : ["恢复使用已保留的历史快照，并生成新的工作版。"],
      apply: () => {
        assertUnchanged();
        const now = new Date().toISOString();
        const restoredSemantic = this.memory.putArtifact({ ...(currentFoundation ? { id: currentFoundation.id, expectedVersion: currentFoundation.version } : {}),
          kind: "foundation", title: semantic.title, status: "adopted", content: { ...semantic.content, restoredFrom: reference(semantic), restoredWorkspace: workspaceVersionRef, adoptedAt: now } });
        const restoredDefinition: Data = { ...definition, foundationRef: reference(restoredSemantic), restoredFrom: reference(binding), restoredWorkspace: workspaceVersionRef };
        // The old model must stay immutable: existing consumers still require its exact adopted reference.
        const restoredBinding = this.memory.putArtifact({ kind: "live_ontology", title: binding.title, status: "adopted", content: restoredDefinition });
        restoreIdentityDecisions(restoredBinding);
        const identityDecisionRefs = identityDecisionsForModel(this.memory, restoredBinding).map(reference);
        const correctionRefs = corrections.map(correction => {
          const oldTarget = correction.content.target as unknown as CorrectionTarget;
          const oldDefinition = (correction.content.modelDefinition ?? binding.content) as Data;
          const oldRelation = (oldDefinition.relations as Data[]).find(relation => relation.from === oldTarget.type && relation.name === oldTarget.relation);
          const relation = (restoredDefinition.relations as Data[]).find(relation => relation.relationId === oldRelation?.relationId);
          if (!relation) throw new Error("恢复的绑定中没有纠正对应的关系");
          const target = { ...oldTarget, modelId: restoredBinding.id, modelVersion: restoredBinding.version, type: String(relation.from), relation: String(relation.name) };
          return reference(this.memory.putArtifact({ kind: "relation_correction", title: correction.title, status: "adopted", content: {
            ...correction.content, target, targetKey: relationKey(target), modelDefinition: restoredDefinition, restoredFrom: reference(correction), adoptedAt: now,
          } }));
        });
        const propertyCorrectionRefs = propertyCorrections.map(correction => reference(this.memory.putArtifact({
          kind: "property_correction", title: correction.title, status: "adopted", content: { ...correction.content,
            modelRef: reference(restoredBinding), restoredFrom: reference(correction), adoptedAt: now },
        })));
        for (const dataset of datasets) {
          const content = dataset.content as unknown as DatasetContent;
          const snapshot = historicalSnapshots.get(dataset.id);
          if (!snapshot && !content.activeVersion && !liveDatasets.has(dataset.id)) continue;
          this.memory.putArtifact({ ...dataset, expectedVersion: dataset.version, content: jsonData({ ...content,
            activeVersion: snapshot?.id ?? null, ...(snapshot ? { materialization: "snapshot", profile: snapshot.content.profile, coverage: snapshot.content.coverage } : { profile: null, coverage: null }),
            ...(liveDatasets.has(dataset.id) ? { materialization: "live" } : {}),
            ...(content.pendingVersion === snapshot?.id ? { pendingVersion: null, pendingChanges: [] } : {}), restoredWorkspace: workspaceVersionRef }) });
        }
        return jsonData({ workspaceVersionRef, foundationRef: reference(restoredSemantic), modelRef: reference(restoredBinding), correctionRefs, propertyCorrectionRefs, identityDecisionRefs });
      },
    };
  }
}

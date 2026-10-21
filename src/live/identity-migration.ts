import type { Artifact, Data, Repository } from "../agent/contracts.ts";
import type { LiveMemory, SnapshotPins } from "./memory.ts";
import type { ReadMode } from "./reading-contract.ts";
import { captureIdentityDecision, identityDecisionsForModel, identityRuleOf, identityRuleScope } from "./identity.ts";
import { parseLayeredModel } from "../semantic/model.ts";
import { fingerprint } from "../engine/release-diff.ts";
import { jsonData } from "./sources.ts";

const ref = (artifact: Artifact) => ({ id: artifact.id, version: artifact.version });
const rows = (value: unknown): Data[] => Array.isArray(value) ? value : [];

/** Revalidate before the transaction; copy decisions synchronously beside the new adopted binding. */
export async function prepareIdentityDecisionMigration(repo: Repository, live: LiveMemory, definition: Data, options: {
  baseModel?: Artifact;
  decisionPins?: ReadonlySet<string>;
  readMode?: ReadMode;
  pins?: SnapshotPins;
  fixedSemantic?: boolean;
} = {}): Promise<(newModel: Artifact) => void> {
  const base = options.baseModel ?? repo.listArtifacts("live_ontology").find(model => model.status === "adopted");
  if (!base) return () => {};
  const decisions = identityDecisionsForModel(repo, base, options.decisionPins ?? true);
  if (options.decisionPins && decisions.length !== options.decisionPins.size) throw new Error("历史身份决定集与所选执行绑定不一致，不能恢复");
  if (!decisions.length) return () => {};
  if (!definition.layered) throw new Error("变更会丢失已采用身份决定的规则，请先处理该决定");
  const nextLayered = parseLayeredModel(definition.layered);
  const dependencies = new Map<string, Artifact>();
  const track = (artifact: Artifact) => { dependencies.set(artifact.id, artifact); return artifact; };
  const layered = parseLayeredModel(base.content.layered ?? live.readLayered(base.id, base.version));
  const bindings = rows((layered.bindings as Data).entities), rules = rows((layered.bindings as Data).identityRules);
  for (const decision of decisions) {
    const content = decision.content, rule = rules.find(rule => rule.id === content.ruleId);
    if (!rule) throw new Error("身份决定的规则已丢失，请先处理该决定");
    const endpoints = [rule.left, rule.right] as Data[];
    for (const endpoint of endpoints) {
      const binding = bindings.find(binding => binding.id === endpoint.bindingId);
      if (!binding) throw new Error("身份决定的来源绑定已丢失，请先处理该决定");
      const dataset = binding.dataset as Data;
      const source = track(repo.getArtifact(String(dataset.sourceId)));
      if (source.status !== "ready") throw new Error("身份决定依赖的来源已停用，请先处理该决定");
      const uploaded = source.content.localSource as Data | undefined;
      if (uploaded) track(repo.getArtifact(String(uploaded.id)));
      const materialized = live.snapshots?.bindingDataset?.(String(dataset.sourceId), String(dataset.capability));
      if (materialized) track(materialized);
    }
    const reading = { readMode: options.readMode ?? "active_snapshot" as ReadMode, pins: options.pins, fixedSemantic: options.fixedSemantic ?? false };
    const previous = await captureIdentityDecision(live, base, content, { ...reading, modelDefinition: base.content });
    if (previous.fingerprint !== content.fingerprint || previous.scopeFingerprint !== content.scopeFingerprint)
      throw new Error("身份决定依赖的事实或规则已变化，请先重新核对该决定");
    const nextScope = identityRuleScope(nextLayered, identityRuleOf(nextLayered, String(content.ruleId)));
    if (nextScope !== previous.scopeFingerprint)
      throw new Error("变更会修改或删除已采用身份决定的规则、端点或事实，请先处理该决定");
  }
  const assertUnchanged = () => {
    for (const artifact of dependencies.values()) {
      const current = repo.getArtifact(artifact.id);
      if (current.version !== artifact.version || current.status !== artifact.status) throw new Error("身份决定依赖已变化，请重新复验");
    }
    if (fingerprint(identityDecisionsForModel(repo, base, options.decisionPins ?? true).map(ref)) !== fingerprint(decisions.map(ref)))
      throw new Error("身份决定集已变化，请重新复验");
  };
  assertUnchanged();
  return newModel => {
    assertUnchanged();
    if (newModel.kind !== "live_ontology" || newModel.status !== "adopted") throw new Error("身份决定只能迁入已采用的执行绑定");
    if (fingerprint(newModel.content.layered) !== fingerprint(definition.layered)) throw new Error("采用的身份规则或绑定与复验内容不一致");
    for (const decision of decisions) repo.putArtifact({ kind: "identity_decision", title: decision.title, status: "adopted", content: jsonData({
      ...decision.content, modelRef: ref(newModel), migratedFrom: ref(decision), migratedAt: new Date().toISOString(),
    }) });
  };
}

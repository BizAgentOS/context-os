import type { Artifact, Data, Repository } from "../agent/contracts.ts";
import { fingerprint } from "./release-diff.ts";

/** Only dependencies of this candidate are pinned; unrelated sources do not invalidate its review. */
export function ownerVerificationInputs(repo: Repository, owner: Artifact): Data {
  owner = repo.getArtifact(owner.id, owner.version);
  const definition = (owner.kind === "mapping_change" ? owner.content.definition : owner.kind === "relation_correction" ? owner.content.modelDefinition : owner.kind === "engine_candidate" ? { ...owner.content, relations: owner.content.modelRelations } : owner.content) as Data;
  const rows = (value: unknown): Data[] => Array.isArray(value) ? value : [];
  const bindings = rows(definition?.types).flatMap(type => [type, ...rows(type.supplements)]);
  for (const relation of rows(definition?.relations)) if (relation.linkTable) bindings.push(relation.linkTable as Data);
  const sourceIds = new Set(bindings.map(binding => String(binding.sourceId)));
  const sources = [...sourceIds].sort().map(id => {
    const source = repo.getArtifact(id), localRef = source.content.localSource as Data | undefined;
    const local = localRef ? repo.getArtifact(String(localRef.id)) : undefined;
    return { id, version: source.version, status: source.status, local: local ? { id: local.id, version: local.version, status: local.status } : null };
  });
  const snapshots = repo.listArtifacts("data_dataset").filter(dataset => bindings.some(binding =>
    (dataset.content.connectionId ?? dataset.content.sourceId) === binding.sourceId && dataset.content.capability === binding.capability))
    .map(dataset => ({ id: dataset.id, materialization: dataset.content.materialization, activeVersion: dataset.content.activeVersion }))
    .sort((a,b) => a.id.localeCompare(b.id));
  return { ownerRef: { id: owner.id, version: owner.version }, fingerprint: fingerprint(owner.content), sources, snapshots };
}

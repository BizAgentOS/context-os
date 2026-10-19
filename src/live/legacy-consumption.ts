import type { Data, Repository } from "../agent/contracts.ts";

/** Legacy contracts remain readable until a separately approved removal. */
export class LegacyConsumptionFrozen extends Error {
  readonly code = "legacy_consumption_frozen";
  constructor() { super("旧消费接口已冻结，不能新建、修改或启用。请在“发布与接入”中选择发布版本并创建接入方，使用 v4 HTTP / MCP。"); }
}
export function freezeLegacyConsumption(): never { throw new LegacyConsumptionFrozen(); }

/** Filter current-release internals before pagination so old grants always remain reachable. */
export function historicalConsumption(repo: Repository, { offset = 0, limit = 40 }: { offset?: number; limit?: number } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("历史接入分页参数无效");
  const datasets = repo.listArtifacts("ontology_dataset");
  const releaseDatasets = new Set(repo.listArtifacts("release_connection").map(a => String((a.content.datasetRef as Data).id)));
  const ownedViews = new Set(datasets.flatMap(a => {
    const view = (a.content.business as Data | null)?.viewRef as Data | undefined;
    return view?.id ? [String(view.id)] : [];
  }));
  const all = [
    ...repo.listArtifacts("consumer"), ...repo.listArtifacts("live_consumer"),
    ...repo.listArtifacts("consumer_view").filter(a => !a.content.releaseRef && !ownedViews.has(a.id)),
    ...datasets.filter(a => !a.content.releaseRef && !releaseDatasets.has(a.id)),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const items = all.slice(offset, offset + limit).map(a => {
    const { keyHash, operationSignature, operationId, ...content } = a.content;
    return { ...a, content };
  });
  return { items, total: all.length, nextOffset: offset + items.length < all.length ? offset + items.length : null };
}

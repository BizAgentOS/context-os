import type { Artifact, Repository } from "./contracts.ts";

export interface SourcePolicy {
  sourceId: string;
  purpose: string;
  owner: string;
  sensitiveFields: string[];
}

const boundedText = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || value.length > max)
    throw new Error(`${label}需要文本，最多 ${max} 字符`);
  return value.trim();
};

/** Classification follows the source across versions, without changing its data. */
export class SourcePolicyService {
  private repo: Repository;
  constructor(repo: Repository) {
    this.repo = repo;
  }

  list(): Artifact[] {
    return this.repo.listArtifacts("source_policy");
  }

  read(sourceId: string): Artifact | null {
    return (
      this.list().find((policy) => policy.content.sourceId === sourceId) ?? null
    );
  }

  availableFields(sourceId: string): string[] {
    const source = this.repo.getArtifact(sourceId);
    if (source.kind !== "source") throw new Error("只能查看已接入来源的字段");
    if (source.content.format !== "csv") return [];
    const versions = new Set([source.version]);
    // A removed column can remain externally readable through a fixed model or
    // consumer. Include those real historical schemas in the owner's controls.
    for (const artifact of [
      ...this.repo.listArtifacts("ontology"),
      ...this.repo.listArtifacts("consumer"),
    ]) {
      const version = (
        artifact.content.sourceVersions as Record<string, unknown> | undefined
      )?.[sourceId];
      if (Number.isSafeInteger(version) && Number(version) >= 1)
        versions.add(Number(version));
    }
    const columns = new Set<string>();
    for (const version of versions) {
      const historical = this.repo.getArtifact(sourceId, version);
      if (historical.kind !== "source" || historical.content.format !== "csv")
        throw new Error("来源历史字段不可读取");
      for (const column of (historical.content.columns as
        string[] | undefined) ?? [])
        columns.add(column);
    }
    for (const column of (this.read(sourceId)?.content.sensitiveFields as
      string[] | undefined) ?? [])
      columns.add(column);
    return [...columns];
  }

  update(args: Record<string, unknown>): Artifact {
    const sourceId = boundedText(args.sourceId, "来源标识", 240);
    const source = this.repo.getArtifact(sourceId);
    if (source.kind !== "source")
      throw new Error("只能编辑已接入来源的使用说明");
    const previous = this.read(sourceId);
    const expectedVersion = args.version === undefined ? 0 : args.version;
    if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0)
      throw new Error("来源使用说明需要有效版本");
    if (expectedVersion !== (previous?.version ?? 0))
      throw new Error("来源使用说明版本已变化，请重新查看后保存");
    const purpose = boundedText(args.purpose, "用途", 1000);
    const owner = boundedText(args.owner, "负责人", 200);
    if (
      !Array.isArray(args.sensitiveFields) ||
      args.sensitiveFields.length > 100
    )
      throw new Error("敏感列需要明确清单，最多 100 项");
    const sensitiveFields = args.sensitiveFields.map((field) => {
      if (typeof field !== "string" || !field || field.length > 240)
        throw new Error("敏感列需要有效列名");
      return field;
    });
    if (new Set(sensitiveFields).size !== sensitiveFields.length)
      throw new Error("敏感列不能重复");
    if (sensitiveFields.length) {
      // Preserve earlier classifications even if a new upload removes that column:
      // existing consumers may still read an older fixed data version.
      if (source.content.format !== "csv")
        throw new Error("只有 CSV 来源可以标记敏感列");
      const columns = new Set(this.availableFields(sourceId));
      for (const field of sensitiveFields)
        if (!columns.has(field)) throw new Error(`来源没有列 ${field}`);
    }
    return this.repo.putArtifact({
      ...(previous
        ? { id: previous.id, expectedVersion: previous.version }
        : {}),
      kind: "source_policy",
      title: source.title,
      status: "saved",
      content: { sourceId, purpose, owner, sensitiveFields },
    });
  }
}

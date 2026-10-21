import {tableRowsSync} from "../data/table-rows.ts";
import { createHash, randomUUID } from "node:crypto";
import type { Artifact, Data, Json, Repository } from "./contracts.ts";

export interface TypeDefinition {
  name: string;
  description: string;
  sourceId: string;
  idField: string;
  fields: Record<string, string>;
}
export interface RelationDefinition {
  name: string;
  from: string;
  to: string;
  fromField: string;
  toField: string;
}
export interface FunctionDefinition {
  name: string;
  implementation: "recovery_evidence";
  type: string;
  relation: string;
  field: string;
  evidence: Data[];
}
export interface ModelDefinition {
  purpose: string;
  types: TypeDefinition[];
  relations: RelationDefinition[];
  functions: FunctionDefinition[];
  sourceVersions: Record<string, number>;
  evidence: Data[];
}
interface Entity {
  snapshot: string;
  type: string;
  id: string;
  fields: Data;
  evidence: Data[];
}
interface Coverage {
  complete: boolean;
  total: number | null;
  offset: number;
  shown: number;
  input?: Coverage;
}
interface Collection {
  snapshot: string;
  type: string;
  items: Entity[];
  total: number | null;
  truncated: boolean;
  collectionId?: string;
  offset?: number;
  unresolved?: boolean;
  unresolvedCount?: number;
  coverage?: Coverage;
}
const data = (value: unknown): Data => JSON.parse(JSON.stringify(value));

export class ObjectView {
  readonly snapshot: string;
  readonly sourceVersions: Record<string, number>;
  readonly model: Artifact;
  readonly definition: ModelDefinition;
  private entities = new Map<string, Entity[]>();
  private handles = new Map<string, unknown>();
  private collections = new Map<string, Collection>();
  private repo: Repository;
  constructor(
    repo: Repository,
    model: Artifact,
    sourceVersions?: Record<string, number>,
  ) {
    this.repo = repo;
    this.model = model;
    this.definition = model.content as unknown as ModelDefinition;
    this.sourceVersions = {
      ...this.definition.sourceVersions,
      ...sourceVersions,
    };
    this.snapshot = createHash("sha256")
      .update(
        JSON.stringify({
          model: { id: model.id, version: model.version },
          sources: Object.entries(this.sourceVersions).sort(),
        }),
      )
      .digest("hex")
      .slice(0, 24);
    for (const type of this.definition.types) {
      const source = repo.getArtifact(
        type.sourceId,
        this.sourceVersions[type.sourceId],
      );
      if (source.status === "failed")
        throw new Error(
          `类型 ${type.name} 的来源解析失败，请先修正来源：${source.content.parseError}`,
        );
      if (source.kind !== "source" || source.content.format !== "csv")
        throw new Error(`类型 ${type.name} 需要 CSV 来源`);
      const columns = source.content.columns as string[];
      for (const column of [type.idField, ...Object.values(type.fields)])
        if (!columns.includes(column))
          throw new Error(`来源缺少映射列 ${column}`);
      const ids = new Set<string>();
      const entities = [...tableRowsSync(source,repo)].map((row, index) => {
        const id = String(row[type.idField] ?? "");
        if (!id.trim() || ids.has(id))
          throw new Error(`类型 ${type.name} 身份为空或重复：${id}`);
        ids.add(id);
        return {
          snapshot: this.snapshot,
          type: type.name,
          id,
          fields: Object.fromEntries(
            Object.entries(type.fields).map(([name, column]) => [
              name,
              row[column],
            ]),
          ),
          evidence: [
            {
              sourceId: source.id,
              version: source.version,
              row: index + 1,
              hash: source.content.hash,
            },
          ],
        };
      });
      this.entities.set(type.name, entities);
    }
    for (const relation of this.definition.relations) {
      this.field(relation.from, relation.fromField);
      this.field(relation.to, relation.toField);
    }
    for (const method of this.definition.functions) {
      if (method.implementation !== "recovery_evidence")
        throw new Error("业务方法没有注册实现");
      const relation = this.definition.relations.find(
        (r) => r.from === method.type && r.name === method.relation,
      );
      if (!relation) throw new Error(`方法 ${method.name} 需要有效回访关系`);
      this.field(relation.to, method.field);
      if (!method.evidence?.length)
        throw new Error("恢复证据方法需要业务口径证据");
    }
  }
  private field(typeName: string, name: string) {
    const type = this.definition.types.find((t) => t.name === typeName);
    if (!type) throw new Error(`未知类型 ${typeName}`);
    if (name !== "$id" && !Object.hasOwn(type.fields, name))
      throw new Error(`类型 ${typeName} 没有字段 ${name}`);
  }
  private relation(typeName: string, name: string): RelationDefinition {
    const relation = this.definition.relations.find(
      (candidate) => candidate.from === typeName && candidate.name === name,
    );
    if (!relation) throw new Error(`类型 ${typeName} 没有关系 ${name}`);
    return relation;
  }
  private method(typeName: string, name: string): FunctionDefinition {
    const method = this.definition.functions.find(
      (candidate) => candidate.type === typeName && candidate.name === name,
    );
    if (!method) throw new Error(`类型 ${typeName} 没有已实现的方法 ${name}`);
    return method;
  }
  private all(type: string) {
    const items = this.entities.get(type);
    if (!items) throw new Error(`未知业务类型 ${type}`);
    return items;
  }
  private value(entity: Entity, field: string): Json {
    return field === "$id" ? entity.id : (entity.fields[field] ?? null);
  }
  private get(type: string, id: string) {
    const entity = this.all(type).find((e) => e.id === id);
    if (!entity) throw new Error(`业务对象不存在：${type}/${id}`);
    return entity;
  }
  private resolve(input: unknown): Entity | Collection {
    if (typeof input === "string" && input.startsWith("$")) {
      if (!this.handles.has(input.slice(1)))
        throw new Error("对象句柄不存在或不属于本次工作区");
      return this.resolve(this.handles.get(input.slice(1)));
    }
    if (!input || typeof input !== "object")
      throw new Error("需要对象引用或 $句柄");
    const ref = input as Entity & Collection;
    if (ref.snapshot !== this.snapshot)
      throw new Error("对象引用属于不同快照，不能混用；请显式读取历史证据");
    if (ref.collectionId !== undefined || ref.items !== undefined) {
      if (
        Array.isArray(ref.items) &&
        ref.items.some((item) => item.snapshot !== this.snapshot)
      )
        throw new Error("集合含不同快照的对象，不能混用");
      const collection =
        typeof ref.collectionId === "string"
          ? this.collections.get(ref.collectionId)
          : undefined;
      if (!collection)
        throw new Error(
          "集合必须使用本次工作区生成的 collectionId 或 $句柄引用",
        );
      for (const key of [
        "type",
        "total",
        "truncated",
        "offset",
        "unresolved",
        "unresolvedCount",
      ] as const) {
        if (Object.hasOwn(ref, key) && ref[key] !== collection[key])
          throw new Error("集合范围元数据被篡改，请使用原集合引用");
      }
      if (
        Object.hasOwn(ref, "coverage") &&
        !this.sameCoverage(ref.coverage, this.coverage(collection))
      )
        throw new Error("集合覆盖范围被篡改，请使用原集合引用");
      if (
        ref.items !== undefined &&
        (!Array.isArray(ref.items) ||
          ref.items.length !== collection.items.length ||
          ref.items.some(
            (item, index) =>
              item.type !== collection.items[index].type ||
              item.id !== collection.items[index].id,
          ))
      )
        throw new Error("集合成员被篡改，请重新查询所需范围");
      return collection;
    }
    return this.get(String(ref.type), String(ref.id));
  }
  private members(input: Entity | Collection): Entity[] {
    return "items" in input ? input.items : [input];
  }
  private coverage(input: Entity | Collection): Coverage {
    if (!("items" in input))
      return { complete: true, total: 1, offset: 0, shown: 1 };
    return (
      input.coverage ?? {
        complete: !input.truncated,
        total: input.total,
        offset: input.offset ?? 0,
        shown: input.items.length,
      }
    );
  }
  private sameCoverage(value: unknown, expected: Coverage): boolean {
    if (!value || typeof value !== "object") return false;
    const actual = value as Coverage;
    return (
      actual.complete === expected.complete &&
      actual.total === expected.total &&
      actual.offset === expected.offset &&
      actual.shown === expected.shown &&
      (expected.input
        ? this.sameCoverage(actual.input, expected.input)
        : actual.input === undefined)
    );
  }
  private registerCollection(collection: Collection): Collection {
    const registered = {
      ...collection,
      coverage: this.coverage(collection),
      collectionId: randomUUID(),
    };
    this.collections.set(registered.collectionId, registered);
    return registered;
  }
  private related(entity: Entity, name: string): Collection {
    const relation = this.relation(entity.type, name);
    const value = this.value(entity, relation.fromField);
    const items =
      value === null || value === ""
        ? []
        : this.all(relation.to).filter(
            (e) => this.value(e, relation.toField) === value,
          );
    return {
      snapshot: this.snapshot,
      type: relation.to,
      items,
      total: items.length,
      truncated: false,
      unresolved: items.length === 0,
    };
  }
  preview(): Data {
    const unresolved = this.definition.relations.map((relation) => ({
      relation: relation.name,
      from: relation.from,
      missing: this.all(relation.from).filter(
        (e) => this.related(e, relation.name).unresolved,
      ).length,
    }));
    return data({
      snapshot: this.snapshot,
      types: this.definition.types.map((t) => ({
        name: t.name,
        total: this.all(t.name).length,
        examples: this.all(t.name).slice(0, 3),
      })),
      unresolved,
    });
  }
  execute(operations: Data[]): Data {
    if (!operations.length || operations.length > 12)
      throw new Error("一次对象组合需要 1–12 个步骤");
    const results: Record<string, unknown> = {};
    for (let index = 0; index < operations.length; index++) {
      const step = operations[index];
      const name = typeof step.as === "string" ? step.as : `step${index + 1}`;
      if (!/^[a-zA-Z][\w]{0,40}$/.test(name))
        throw new Error("句柄应为简短字母数字标识");
      let result: unknown;
      if (step.op === "describe") {
        const type =
          step.type === undefined
            ? null
            : this.definition.types.find((t) => t.name === step.type);
        if (step.type !== undefined && !type) throw new Error("类型不存在");
        result = {
          model: {
            id: this.model.id,
            version: this.model.version,
            status: this.model.status,
          },
          snapshot: this.snapshot,
          types: type ? [type] : this.definition.types,
          relations: this.definition.relations.filter(
            (r) => !type || r.from === type.name,
          ),
          functions: this.definition.functions.filter(
            (f) => !type || f.type === type.name,
          ),
        };
      } else if (step.op === "query") {
        const type = String(step.type);
        const where = (step.where ?? {}) as Data;
        for (const field of Object.keys(where)) this.field(type, field);
        const matches = this.all(type).filter((entity) =>
          Object.entries(where).every(
            ([field, value]) => this.value(entity, field) === value,
          ),
        );
        const offset = Math.max(0, Number(step.offset) || 0);
        const limit = Math.min(100, Math.max(1, Number(step.limit) || 20));
        result = this.registerCollection({
          snapshot: this.snapshot,
          type,
          items: matches.slice(offset, offset + limit),
          total: matches.length,
          offset,
          truncated: offset > 0 || offset + limit < matches.length,
        });
      } else if (step.op === "get")
        result = this.get(String(step.type), String(step.id));
      else if (step.op === "related") {
        const input = this.resolve(step.input);
        const relation = this.relation(input.type, String(step.relation));
        const members = this.members(input);
        const inputCoverage = this.coverage(input);
        const sets = members.map((entity) =>
          this.related(entity, String(step.relation)),
        );
        const seen = new Map(
          sets.flatMap((set) => set.items).map((e) => [`${e.type}/${e.id}`, e]),
        );
        const items = [...seen.values()];
        const total = inputCoverage.complete ? items.length : null;
        result = this.registerCollection({
          snapshot: this.snapshot,
          type: relation.to,
          items,
          total,
          truncated: !inputCoverage.complete,
          unresolved: sets.some((set) => set.unresolved),
          unresolvedCount: sets.filter((set) => set.unresolved).length,
          coverage: {
            complete: inputCoverage.complete,
            total,
            offset: 0,
            shown: items.length,
            input: inputCoverage,
          },
        });
      } else if (step.op === "evidence") {
        const input = this.resolve(step.input);
        const members = this.members(input);
        const coverage = this.coverage(input);
        result = {
          snapshot: this.snapshot,
          evidence: members.flatMap((e) => e.evidence),
          total: members.length,
          partial: !coverage.complete,
          coverage,
        };
      } else if (step.op === "aggregate") {
        const input = this.resolve(step.input);
        if (step.field !== undefined)
          this.field(input.type, String(step.field));
        const members = this.members(input);
        const coverage = this.coverage(input);
        const aggregate = {
          snapshot: this.snapshot,
          count: members.length,
          evidence: members.flatMap((e) => e.evidence),
          coverage,
          partial: !coverage.complete,
          scope: coverage.complete ? "complete_result" : "current_page",
        };
        if (step.field === undefined) result = aggregate;
        else {
          const groups: Record<string, number> = Object.create(null);
          for (const e of members) {
            this.field(e.type, String(step.field));
            const key = String(this.value(e, String(step.field)));
            groups[key] = (groups[key] ?? 0) + 1;
          }
          result = { ...aggregate, groups };
        }
      } else if (step.op === "call") {
        const input = this.resolve(step.input);
        this.method(input.type, String(step.method));
        const members = this.members(input);
        const coverage = this.coverage(input);
        const calls = members.map((entity) =>
          this.call(entity, String(step.method)),
        );
        result =
          "items" in input
            ? {
                snapshot: this.snapshot,
                items: calls,
                total: calls.length,
                coverage,
                partial: !coverage.complete,
              }
            : { ...calls[0], coverage };
      } else throw new Error(`不支持对象操作 ${step.op}`);
      this.handles.set(name, result);
      results[name] = result;
    }
    return data({
      snapshot: this.snapshot,
      model: {
        id: this.model.id,
        version: this.model.version,
        status: this.model.status,
      },
      sourceVersions: this.sourceVersions,
      results,
    });
  }
  private call(entity: Entity, name: string): Data {
    const method = this.method(entity.type, name);
    const related = this.related(entity, method.relation);
    // These are registered callback outcomes, not a model-provided success predicate.
    const positive = new Set(["improved", "recovered", "已改善", "已恢复"]);
    const negative = new Set([
      "not_improved",
      "not_recovered",
      "未改善",
      "未恢复",
    ]);
    const outcomes = related.items.map((item) =>
      String(this.value(item, method.field)).trim(),
    );
    const yes = outcomes.some((v) => positive.has(v));
    const no = outcomes.some((v) => negative.has(v));
    const status =
      yes && no
        ? "conflicting_callback_evidence"
        : yes
          ? "positive_callback_evidence"
          : no
            ? "negative_callback_evidence"
            : related.items.length
              ? "unknown_callback_evidence"
              : "no_evidence";
    return data({
      snapshot: this.snapshot,
      object: { type: entity.type, id: entity.id },
      method: name,
      status,
      outcomes,
      scope:
        "仅判断关联回访是否包含改善反馈；办结、站温或单户反馈不能证明楼栋恢复。不同时间反馈保留为冲突，不自动判断最终恢复。",
      evidence: [
        ...entity.evidence,
        ...related.items.flatMap((e) => e.evidence),
        ...method.evidence,
      ],
    });
  }
}

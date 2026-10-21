import { z } from "zod";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { FoundationService } from "../agent/foundation.ts";
import type { OntologyChanges } from "./changes.ts";
import { fingerprint } from "./release-diff.ts";

export const pendingCategories = ["structure", "naming", "adjudication", "gap", "data_issue"] as const;
export type PendingCategory = typeof pendingCategories[number];
const filters = z.object({ category: z.enum(pendingCategories).optional(), source: z.string().min(1).optional(), object: z.string().min(1).optional(), owner: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(40), offset: z.number().int().min(0).default(0) }).strict();
const openStatuses = new Set(["proposed", "verified", "failed"]);
const typeLabels: Record<string, string> = { entity: "对象变更", property: "属性变更", binding: "数据绑定", relation: "关系变更", identity_rule: "身份对应规则",
  identity_decision: "记录身份决定", local_correction: "局部纠正", deprecation: "结构弃用", restore: "恢复工作版", naming: "命名", description: "说明", adjudication: "待裁决", gap: "问题缺口", data_issue: "数据问题" };
export interface PendingItem {
  detailRef?: Data;
  id: string; version: number; category: PendingCategory; title: string; origin: string; source: string; ownerId?: string;
  sources: Array<{ id: string; label: string }>; objects: Array<{ id: string; label: string }>;
  evidence: string; verification: Data | null; impact: string; status: string; createdAt: string;
  actions: { verify: boolean; adopt: boolean; reject: boolean; analyze: boolean }; stale: boolean;
}
export interface PendingProvider { list(): PendingItem[]; read(id: string): PendingItem | null }

/** One server-owned queue and count, independent of page, filters or pagination. */
export class PendingCenter {
  private providers: PendingProvider[] = [];
  private memory: MemoryStore;
  private changes: OntologyChanges;
  private foundation: FoundationService;
  constructor(memory: MemoryStore, changes: OntologyChanges, foundation: FoundationService) {
    this.memory = memory; this.changes = changes; this.foundation = foundation;
  }
  register(provider: PendingProvider) { this.providers.push(provider); }
  private category(type: string): PendingCategory {
    if (type === "naming" || type === "description") return "naming";
    return pendingCategories.includes(type as PendingCategory) ? type as PendingCategory : "structure";
  }
  private project(change: Artifact): PendingItem {
    const content = change.content, subject = (content.subject ?? {}) as Data, type = String(content.type);
    const sourceIds = new Set<string>(), objectIds = new Set<string>();
    const scan = (value: unknown, depth = 0) => {
      if (!value || typeof value !== "object" || depth > 6) return;
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === "string") {
          if (["datasetId", "sourceId", "bindingId"].includes(key)) sourceIds.add(item);
          if (["objectId", "conceptId", "entityTypeId", "relationTypeId"].includes(key)) objectIds.add(item);
        } else scan(item, depth + 1);
      }
    };
    scan(subject);
    if (["concept", "relation", "property"].includes(String(subject.target)) && typeof subject.id === "string") objectIds.add(subject.id);
    for (const value of [subject.entity, subject.property, subject.binding]) {
      if (value && typeof value === "object" && !Array.isArray(value) && typeof value.id === "string") objectIds.add(value.id);
    }
    const adopted = this.foundation.read().adopted;
    const definitions = [...(adopted?.content.concepts ?? []) as Data[], ...(adopted?.content.relations ?? []) as Data[], ...(adopted?.content.properties ?? []) as Data[]];
    const sources = [...sourceIds].map(id => {
      let artifact: Artifact | null = null;
      try { artifact = this.memory.getArtifact(id); } catch { /* A removed source remains a visible unresolved reference. */ }
      return { id, label: String(artifact?.content.name ?? artifact?.title ?? "来源待核对") };
    });
    const proposedDefinitions = [subject.entity, subject.property, subject.binding].filter(value => value && typeof value === "object" && !Array.isArray(value)) as Data[];
    const objects = [...objectIds].map(id => ({ id, label: String(definitions.find(item => item.id === id)?.name ?? proposedDefinitions.find(value => value.id === id)?.name ?? "对象待核对") }));
    const endpoint = (value: unknown) => {
      const ref = value as Data | undefined;
      return ref ? `${sources.find(item => item.id === ref.datasetId)?.label ?? "来源待核对"} · ${String(ref.column ?? "字段待核对")}` : "";
    };
    const title = type === "relation" && subject.from && subject.to ? `${endpoint(subject.from)} → ${endpoint(subject.to)}`
      : change.title.startsWith("变更 ·") ? typeLabels[type] ?? "待核对变更" : change.title;
    const verification = (content.verification ?? null) as Data | null;
    const stale = fingerprint(content.baseline) !== fingerprint(this.changes.currentBaseline());
    const active = openStatuses.has(change.status);
    return { id: change.id, version: change.version, category: this.category(type), title, origin: String(content.origin ?? "human"), source: String(content.origin ?? "human"),
      ...(typeof (content.owner as Data | undefined)?.id === "string" ? { ownerId: String((content.owner as Data).id) } : {}),
      sources, objects, evidence: String(content.evidence ?? "").slice(0, 500), verification,
      impact: type === "restore" ? "形成新的工作版，历史发布保持原版本" : "采用后更新工作版；已发布版本保持原内容",
      status: change.status, createdAt: change.createdAt, stale,
      actions: { verify: active && !stale, adopt: active && !stale && change.status === "verified" && ["passed", "review"].includes(String(verification?.result)), reject: active, analyze: active } };
  }
  private all() {
    const changes = this.memory.listArtifacts("ontology_change").filter(item => openStatuses.has(item.status)).map(item => this.project(item));
    const unique = new Map([...changes, ...this.providers.flatMap(provider => provider.list())].map(item => [item.id, item]));
    return [...unique.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  summary() {
    const items = this.all();
    const counts = Object.fromEntries(pendingCategories.map(category => [category, items.filter(item => item.category === category).length]));
    return { total: items.length, counts };
  }
  list(input: unknown = {}) {
    const args = filters.parse(input), all = this.all();
    const items = all.filter(item => (!args.category || item.category === args.category) && (!args.source || item.source === args.source || item.sources.some(source => source.id === args.source))
      && (!args.object || item.objects.some(object => object.id === args.object)) && (!args.owner || item.ownerId === args.owner));
    return { total: all.length, counts: Object.fromEntries(pendingCategories.map(category => [category, all.filter(item => item.category === category).length])),
      facets: { sources: [...new Map(all.flatMap(item => item.sources).map(item => [item.id, item])).values()], objects: [...new Map(all.flatMap(item => item.objects).map(item => [item.id, item])).values()] },
      filteredTotal: items.length, items: items.slice(args.offset, args.offset + args.limit),
      nextOffset: args.offset + args.limit < items.length ? args.offset + args.limit : null, baseline: this.changes.currentBaseline() };
  }
  read(id: string) {
    for (const provider of this.providers) { const item = provider.read(id); if (item) return item; }
    return this.project(this.changes.read(id));
  }
}

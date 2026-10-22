import { z } from "zod";
import {currentActor} from '../security/actors.ts';
import type { Artifact, Data } from "./contracts.ts";
import type { MemoryStore } from "./memory.ts";
import type { FoundationService } from "./foundation.ts";
import { ChangeConflict, type OntologyChanges } from "../engine/changes.ts";
import type { PendingItem, PendingProvider } from "../engine/pending.ts";
import { fingerprint } from "../engine/release-diff.ts";
import { jsonData } from "../live/sources.ts";

const ref = z.object({ id: z.string().min(1), version: z.number().int().positive() }).strict();
const issueRef = z.object({ kind: z.enum(["conflict", "unknown"]), id: z.string().min(1) }).strict();
const subject = z.object({ foundationRef: ref, issue: issueRef,
  action: z.enum(["choose_retained", "choose_proposed", "retain_disagreement", "explain", "close"]),
  reason: z.string().trim().min(1).max(1500), explanation: z.string().trim().min(1).max(1500).optional(),
  objectId: z.string().optional(), sources: z.array(z.object({ sourceId: z.string() }).strict()).optional(), evidenceRefs: z.array(z.string()).optional(),
}).strict();
const open = new Set(["proposed", "verified", "failed"]);
const items = (value: unknown) => (Array.isArray(value) ? value : []) as Data[];
const reference = (artifact: Artifact) => ({ id: artifact.id, version: artifact.version });
const key = (foundation: Artifact, kind: string, issue: Data) => `adjudication:${foundation.id}:${kind}:${issue.id}`;

/** Human adjudication is an explicit, verified semantic change; document agents cannot impersonate it. */
export class FoundationAdjudication {
  readonly provider: PendingProvider;
  private memory: MemoryStore;
  private foundation: FoundationService;
  private changes: OntologyChanges;
  constructor(memory: MemoryStore, foundation: FoundationService, changes: OntologyChanges) {
    this.memory = memory; this.foundation = foundation; this.changes = changes;
    changes.registerHandler("adjudication", { subject, prepare: async change => this.prepare(change) });
    changes.registerBatchHandler({ accepts: selected => selected.every(change => change.content.type === "adjudication"),
      prepare: async selected => {
        const content = structuredClone(this.foundation.read().adopted!.content), touched = new Set<string>();
        const plans = selected.map(change => {
          const choice = subject.parse(change.content.subject), identity = `${choice.issue.kind}:${choice.issue.id}`;
          if (touched.has(identity)) throw new ChangeConflict("batch_conflict", "同一待裁决项不能在一批中作出重复或冲突决定");
          touched.add(identity);
          const plan = this.plan(change, content);
          if (plan.targetId) {
            const target = `definition:${plan.targetId}`;
            if (touched.has(target)) throw new ChangeConflict("batch_conflict", "同一对象的含义不能在一批中被多个裁决覆盖，请逐项处理");
            touched.add(target);
          }
          return plan;
        });
        return () => this.save(plans);
      } });
    this.provider = { list: () => this.pendingItems(), read: id => this.pendingItems().find(item => item.id === id) ?? null };
  }

  private unresolved() {
    const foundation = this.foundation.read().adopted;
    if (!foundation) return [];
    return (["conflict", "unknown"] as const).flatMap(kind => items(foundation.content[kind === "conflict" ? "conflicts" : "unknowns"])
      .filter(issue => !issue.resolvedBy && !issue.adjudication)
      .map(issue => ({ foundation, kind, issue })));
  }
  private proposed(foundationId: string, kind: string, issueId: string) {
    return this.memory.listArtifacts("ontology_change").filter(change => {
      const s = change.content.subject as Data | undefined;
      return change.content.type === "adjudication" && open.has(change.status) && (s?.foundationRef as Data)?.id === foundationId
        && (s?.issue as Data)?.kind === kind && (s?.issue as Data)?.id === issueId;
    });
  }
  list(args: unknown = {}) {
    const query = z.object({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(40) }).strict().parse(args);
    const all = this.unresolved();
    return { total: all.length, items: all.slice(query.offset, query.offset + query.limit).map(({ foundation, kind, issue }) => ({
      id: key(foundation, kind, issue), foundationRef: reference(foundation), kind, issue,
    })), nextOffset: query.offset + query.limit < all.length ? query.offset + query.limit : null };
  }
  read(args: unknown) {
    const query = z.object({ foundationRef: ref, issue: issueRef }).strict().parse(args);
    const foundation = this.memory.getArtifact(query.foundationRef.id, query.foundationRef.version);
    if (foundation.kind !== "foundation") throw new Error("需要本体引用");
    const issue = items(foundation.content[query.issue.kind === "conflict" ? "conflicts" : "unknowns"]).find(item => item.id === query.issue.id);
    if (!issue) throw new Error("待裁决项不存在");
    const refs = new Set([...(issue.evidenceRefs ?? []) as string[], ...(issue.resolvedBy ?? []) as string[]]);
    const evidence = items(foundation.content.evidence).filter(item => refs.has(String(item.id))).map(item => {
      const { webSnapshot, knowledgeSnapshot, apiSnapshot, ...safe } = item; return safe;
    });
    return { foundationRef: query.foundationRef, kind: query.issue.kind, issue, evidence, evidenceRefs: [...refs] };
  }

  async propose(input: unknown) {
    const args = subject.omit({ objectId: true, sources: true, evidenceRefs: true }).extend({ operationId: z.string().min(1).max(200) }).strict().parse(input);
    const { operationId, ...selection } = args;
    const details = this.read({ foundationRef: args.foundationRef, issue: args.issue });
    const target = (details.issue.retained ?? details.issue.proposed) as Data | undefined;
    const choice = { ...selection, ...(typeof target?.id === "string" ? { objectId: target.id } : {}),
      sources: [...new Set(details.evidence.flatMap(item => typeof item.sourceId === "string" ? [item.sourceId] : []))].map(sourceId => ({ sourceId })), evidenceRefs: details.evidenceRefs };
    const receipt = this.memory.listArtifacts("ontology_change").find(change => change.content.operationId === operationId && change.content.type === "adjudication");
    if (receipt) return this.changes.propose({ operationId, origin: "human", type: "adjudication", baseline: receipt.content.baseline, subject: choice, evidence: choice.reason });
    const existing = this.proposed(choice.foundationRef.id, choice.issue.kind, choice.issue.id);
    if (existing.length) {
      if (fingerprint(existing[0].content.subject) === fingerprint(choice)) return { change: existing[0], suppressed: false };
      throw new ChangeConflict("decision_pending", "该项已有裁决提议，请先处理或拒绝原提议，再选择新的处理方式");
    }
    return this.changes.propose({ operationId, origin: "human", type: "adjudication", baseline: this.changes.currentBaseline(), subject: choice, evidence: choice.reason });
  }

  private pendingItems(): PendingItem[] {
    return this.unresolved().filter(({ foundation, kind, issue }) => !this.proposed(foundation.id, kind, String(issue.id)).length).map(({ foundation, kind, issue }) => {
      const refs = new Set((issue.evidenceRefs ?? []) as string[]), evidence = items(foundation.content.evidence).filter(item => refs.has(String(item.id)));
      const sourceIds = [...new Set(evidence.flatMap(item => typeof item.sourceId === "string" ? [item.sourceId] : []))];
      const target = (issue.retained ?? issue.proposed) as Data | undefined;
      return { id: key(foundation, kind, issue), ownerId: foundation.id, version: foundation.version, category: "adjudication", title: String(issue.description),
        detailRef: { foundationRef: reference(foundation), issue: { kind, id: issue.id } },
        origin: "document", source: kind, sources: sourceIds.map(id => ({ id, label: String(evidence.find(item => item.sourceId === id)?.title ?? "历史依据") })),
        objects: target ? [{ id: String(target.id), label: String(target.name) }] : [], evidence: evidence.map(item => item.quote).join("；").slice(0, 500),
        verification: null, impact: kind === "conflict" ? "选择已有含义、保留分歧或补充说明；保留双方历史依据" : "补充说明或关闭未知项；保留原问题与决定理由",
        status: "awaiting_choice", createdAt: foundation.createdAt, stale: false, actions: { verify: false, adopt: false, reject: false, analyze: true } };
    });
  }

  private prepare(change: Artifact) {
    const plan = this.plan(change);
    return { verification: plan.verification, apply: () => this.save([plan])[0] };
  }

  private plan(change: Artifact, content?: Data) {
    const choice = subject.parse(change.content.subject), current = this.foundation.read().adopted;
    if (!current || current.id !== choice.foundationRef.id || current.version !== choice.foundationRef.version) throw new ChangeConflict("baseline_changed", "待裁决项所在工作版已变化，请重新读取并选择");
    const details = this.read({ foundationRef: choice.foundationRef, issue: choice.issue }), issue = details.issue;
    if (issue.resolvedBy || issue.adjudication) throw new Error("该待裁决项已处理");
    if (choice.action === "explain" && !choice.explanation) throw new Error("补充说明必须填写说明内容");
    if (choice.issue.kind === "unknown" && !["explain", "close"].includes(choice.action)) throw new Error("未知项只能补充说明或关闭，不能选择不存在的双方含义");
    const selected = choice.action === "choose_retained" ? issue.retained : choice.action === "choose_proposed" ? issue.proposed : null;
    const draft = content ?? structuredClone(current.content);
    if (["choose_retained", "choose_proposed"].includes(choice.action)) {
      if (!selected || typeof selected !== "object" || Array.isArray(selected)) throw new Error("该冲突没有可选择的已有定义");
      const target = selected as Data;
      const definitions = issue.targetKind === "property" ? items(draft.properties) : issue.targetKind === "concept" ? items(draft.concepts)
        : issue.targetKind === "relation" ? items(draft.relations) : [...items(draft.concepts), ...items(draft.relations)];
      const existing = definitions.find(item => item.id === target.id);
      if (!existing || existing.from !== target.from || existing.to !== target.to || existing.entityTypeId !== target.entityTypeId || existing.valueType !== target.valueType) throw new Error("裁决不能生成新结构、修改关系端点或属性类型");
      if (definitions.some(item => item.id !== existing.id && item.name === target.name && (issue.targetKind !== "property" || item.entityTypeId === target.entityTypeId))) throw new Error("所选名称与其他对象重复，请先核对");
      for (const field of ["name", "description", "aliases", "evidenceRefs"]) if (target[field] !== undefined) existing[field] = target[field];
    }
    const field = choice.issue.kind === "conflict" ? "conflicts" : "unknowns";
    const nextIssue = items(draft[field]).find(item => item.id === issue.id)!;
    const decision = { actor: currentActor().id, reason: choice.reason, action: choice.action, explanation: choice.explanation ?? null, changeRef: reference(change) };
    nextIssue.resolvedBy = (issue.evidenceRefs ?? []) as string[];
    nextIssue.adjudication = decision;
    const inputs = jsonData({ foundationRef: reference(current), issue: { ...choice.issue, fingerprint: fingerprint(issue) }, evidence: details.evidenceRefs });
    return { current, draft, choice, decision, nextIssue, targetId: selected ? String((selected as Data).id) : null,
      verification: { result: "passed" as const, metrics: { issueExists: true, evidenceCount: details.evidence.length, changesMeaning: !!selected }, inputs,
        notes: [choice.action === "retain_disagreement" ? "保留双方分歧与已有生效含义，结束本次待裁决" : "保留原问题、双方依据以及本次决定人与理由"] } };
  }

  private save(plans: ReturnType<FoundationAdjudication["plan"]>[]): Data[] {
    const { current, draft } = plans[0], latest = this.foundation.read().adopted;
    if (!latest || latest.id !== current.id || latest.version !== current.version) throw new ChangeConflict("baseline_changed", "本体已变化，请重新复验裁决");
    const at = new Date().toISOString();
    for (const plan of plans) plan.nextIssue.adjudication = { ...plan.decision, at };
    const saved = this.memory.putArtifact({ ...current, expectedVersion: current.version, content: draft });
    return plans.map(plan => ({ foundationRef: reference(saved), issue: plan.choice.issue, decision: plan.nextIssue.adjudication }));
  }
}

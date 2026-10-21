import { readFileSync } from "node:fs";
import { ownerVerificationInputs } from "./owner-verification.ts";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { FoundationService } from "../agent/foundation.ts";
import type { Snapshots, DatasetContent } from "../data/snapshots.ts";
import { quote } from "../data/executor/engine.ts";
import { jsonData } from "../live/sources.ts";
import { fingerprint } from "./release-diff.ts";

/** Thresholds live in config so product owners can tune them without a code change. */
const rules = JSON.parse(readFileSync(fileURLToPath(new URL("../../config/ontology/change-rules.json", import.meta.url)), "utf8")) as {
  relation: { passMatchRate: number; reviewMatchRate: number; requireUniqueTarget: boolean };
  rejection: { reproposeMatchRateDelta: number };
  limits: { listPageSize: number; evidenceTextChars: number; targetChars: number };
};

/** The request is understood but no longer matches the workspace: the caller must re-read and retry. */
export class ChangeConflict extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export type ChangeStatus = "proposed" | "verified" | "failed" | "adopted" | "rejected" | "deprecated" | "superseded";
const TRANSITIONS: Record<ChangeStatus, ChangeStatus[]> = {
  proposed: ["verified", "failed", "rejected"],
  verified: ["verified", "failed", "adopted", "rejected"],
  failed: ["verified", "failed", "rejected"],
  adopted: ["deprecated", "superseded"],
  rejected: [], deprecated: [], superseded: [],
};

const name = z.string().trim().min(1).max(200);
const ref = z.object({ id: name, version: z.number().int().positive() }).strict();
const baseline = z.object({ foundationRef: ref.nullable(), modelRef: ref.nullable() }).strict();
const text = z.string().trim().min(1).max(rules.limits.evidenceTextChars);
const origin = z.enum(["program", "human", "agent", "qa"]);
const observed = z.object({ matchRate: z.number().min(0).max(1), targetUnique: z.boolean() }).strict();
const column = z.object({ datasetId: name, column: name }).strict();

// Types whose verification is wired. The rest are reserved names (blueprint §10.2) that later tickets and
// FEATURE_042 attach; proposing one now fails clearly instead of being accepted without a check.
const subjects = {
  naming: z.object({ target: z.enum(["concept", "relation"]), id: name, name }).strict(),
  description: z.object({ target: z.enum(["concept", "relation"]), id: name, description: z.string().trim().min(1).max(1500) }).strict(),
  relation: z.object({ from: column, to: column }).strict(),
};
const RESERVED = ["entity", "property", "binding", "identity_rule", "identity_decision", "local_correction", "deprecation", "restore", "data_issue"] as const;
const typeNames = ["naming", "description", "relation", ...RESERVED] as const;
const proposeInput = z.object({
  operationId: name, origin, type: z.enum(typeNames), baseline, subject: z.record(z.string(), z.unknown()),
  evidence: text.optional(), observed: observed.optional(),
}).strict();
const act = z.object({ operationId: name, id: name, version: z.number().int().positive() }).strict();
const adoptInput = act.extend({ acknowledgeReview: z.boolean().default(false) }).strict();
const reasonInput = act.extend({ reason: text }).strict();
const listInput = z.object({ status: z.string().optional(), type: z.string().optional(),
  limit: z.number().int().min(1).max(rules.limits.listPageSize).default(rules.limits.listPageSize), offset: z.number().int().min(0).default(0) }).strict();

type Subjects = { [K in keyof typeof subjects]: z.infer<(typeof subjects)[K]> };
type VerifiedType = keyof Subjects;
interface Metrics { [key: string]: number | boolean | string | null }
export interface Verification { ruleVersion: number; result: "passed" | "review" | "failed"; metrics: Metrics; notes: string[]; inputs: Data; checkedAt: string }
export interface PreparedChange { verification: Omit<Verification, "ruleVersion" | "checkedAt">; apply: () => Data }
export interface ChangeHandler {
  subject: z.ZodType;
  prepare: (change: Artifact) => Promise<PreparedChange>;
}

const isVerifiedType = (type: string): type is VerifiedType => Object.hasOwn(subjects, type);
const round = (value: number) => Math.round(value * 10000) / 10000;
const ownerProposalHash = (owner: Artifact) => {
  const keys = owner.kind === "mapping_change" ? ["draft"] : owner.kind === "relation_correction" ? ["target", "targetIds", "reason", "evidence"]
    : owner.kind === "foundation" ? ["enterprise", "concepts", "relations", "evidence", "unknowns", "conflicts", "profileRef", "documentVersions"]
      : ["purpose", "types", "relations", "foundationRef", "base", "layered"];
  return fingerprint(Object.fromEntries(keys.map(key => [key, owner.content[key] ?? null])));
};

export class OntologyChanges {
  applying = false;
  private memory: MemoryStore;
  private foundation: FoundationService;
  private snapshots: Snapshots;
  private handlers = new Map<string, ChangeHandler>();
  private ownerHandlers = new Map<string, ChangeHandler>();

  constructor(memory: MemoryStore, foundation: FoundationService, snapshots: Snapshots) {
    this.memory = memory; this.foundation = foundation; this.snapshots = snapshots;
  }

  registerHandler(type: string, handler: ChangeHandler) { this.handlers.set(type, handler); }
  registerOwnerHandler(kind: string, handler: ChangeHandler) { this.ownerHandlers.set(kind, handler); }
  private handler(change: Artifact) { return this.ownerHandlers.get(String((change.content.owner as Data | undefined)?.kind)) ?? this.handlers.get(String(change.content.type)); }

  /** What every change is proposed against; a change made against anything older is rejected as stale. */
  currentBaseline(): z.infer<typeof baseline> {
    const adopted = this.foundation.read().adopted;
    const model = this.memory.listArtifacts("live_ontology").find(item => item.status === "adopted");
    const toRef = (artifact: Artifact | null | undefined) => artifact ? { id: artifact.id, version: artifact.version } : null;
    return { foundationRef: toRef(adopted), modelRef: toRef(model) };
  }
  private assertBaseline(given: z.infer<typeof baseline>) {
    if (fingerprint(given) !== fingerprint(this.currentBaseline()))
      throw new ChangeConflict("stale_baseline", "本体基线已变化，请重新读取后再提出或处理变更");
  }

  list(input: unknown = {}) {
    const args = listInput.parse(input);
    const all = this.memory.listArtifacts("ontology_change")
      .filter(item => (!args.status || item.status === args.status) && (!args.type || item.content.type === args.type));
    return { baseline: this.currentBaseline(), total: all.length,
      changes: all.slice(args.offset, args.offset + args.limit).map(item => ({ id: item.id, version: item.version, title: item.title, status: item.status,
        type: item.content.type, origin: item.content.origin, subject: item.content.subject, owner: item.content.owner ?? null,
        verification: item.content.verification ?? null, effect: item.content.effect ?? null,
        result: (item.content.verification as Data | undefined)?.result ?? null, createdAt: item.createdAt })) };
  }
  read(id: string, version?: number): Artifact {
    if (!id) throw new Error("需要变更标识");
    const change = this.memory.getArtifact(id, version);
    if (change.kind !== "ontology_change") throw new Error("变更不存在");
    return change;
  }

  private previous(actor: string, operationId: string, signature: string) {
    const receipt = this.memory.listArtifacts("change_receipt").find(item => item.content.actor === actor && item.content.operationId === operationId);
    if (!receipt) return null;
    if (receipt.content.signature !== signature) throw new Error("幂等操作标识已绑定不同请求");
    return this.read(String(receipt.content.id), Number(receipt.content.version));
  }
  private receipt(actor: string, operationId: string, signature: string, change: Artifact) {
    this.memory.putArtifact({ kind: "change_receipt", title: "变更操作回执", status: "saved", content: { actor, operationId, signature, id: change.id, version: change.version } });
  }
  private move(change: Artifact, to: ChangeStatus, content: Data) {
    if (!TRANSITIONS[change.status as ChangeStatus]?.includes(to)) throw new ChangeConflict("invalid_transition", `变更处于“${change.status}”，不能转为“${to}”`);
    return this.memory.putArtifact({ id: change.id, expectedVersion: change.version, kind: "ontology_change", title: change.title, status: to, content });
  }
  private open(args: { id: string; version: number }) {
    const change = this.read(args.id);
    if (change.version !== args.version) throw new ChangeConflict("version_conflict", "变更版本已变化，请重新读取");
    return change;
  }

  /** A program proposal that was rejected stays quiet until the data it was based on changes materially. */
  private suppressedBy(fp: string, now: z.infer<typeof observed> | undefined) {
    const rejected = this.memory.listArtifacts("ontology_change").find(item =>
      item.status === "rejected" && item.content.origin === "program" && item.content.fingerprint === fp && item.content.disposition === "rejected");
    if (!rejected) return null;
    const before = rejected.content.rejectedMetrics as Data | null;
    if (!now || !before) return rejected;
    const moved = round(Math.abs(Number(before.matchRate) - now.matchRate)) > rules.rejection.reproposeMatchRateDelta;
    const uniquenessChanged = before.targetUnique !== now.targetUnique;
    return moved || uniquenessChanged ? null : rejected;
  }

  async propose(input: unknown) {
    const args = proposeInput.parse(input);
    const actor = "local-admin", signature = fingerprint({ method: "propose", args });
    const replay = this.previous(actor, args.operationId, signature);
    if (replay) return { change: replay, suppressed: replay.status === "rejected" && replay.content.disposition === "rejected" };
    const type = args.type;
    const handler = this.handlers.get(type);
    if (!isVerifiedType(type) && !handler) throw new Error(`“${type}”类变更的复验尚未接入统一流程`);
    if ((args.origin === "agent" || args.origin === "program") && !args.evidence) throw new Error("程序与 Agent 的提议必须附依据");
    const subject = (handler?.subject ?? subjects[type as VerifiedType]).parse(args.subject) as Subjects[VerifiedType];
    this.assertBaseline(args.baseline);
    if (type === "relation" && args.origin === "program") {
      const measured = await this.checkRelation(subject as Subjects["relation"]);
      args.observed = { matchRate: Number(measured.metrics.matchRate), targetUnique: Boolean(measured.metrics.targetUnique) };
      this.assertBaseline(args.baseline);
    }
    const fp = fingerprint({ type, subject: isVerifiedType(type) ? this.identity(type, subject) : subject });
    if (args.origin === "program") {
      const rejected = this.suppressedBy(fp, args.observed);
      if (rejected) return this.memory.atomic(() => { this.receipt(actor, args.operationId, signature, rejected); return { change: rejected, suppressed: true }; });
    }
    return this.memory.atomic(() => {
      const again = this.previous(actor, args.operationId, signature);
      if (again) return { change: again, suppressed: false };
      this.assertBaseline(args.baseline);
      const change = this.memory.putArtifact({ kind: "ontology_change", title: isVerifiedType(type) ? this.title(type, subject) : `变更 · ${type}`, status: "proposed", content: jsonData({
        origin: args.origin, type, subject, baseline: args.baseline, fingerprint: fp, evidence: args.evidence ?? null,
        ...(args.observed ? { observed: args.observed } : {}), proposedBy: actor, operationId: args.operationId }) });
      this.receipt(actor, args.operationId, signature, change);
      return { change, suppressed: false };
    });
  }

  async verify(input: unknown) {
    const args = act.parse(input), actor = "local-admin", signature = fingerprint({ method: "verify", args });
    const replay = this.previous(actor, args.operationId, signature);
    if (replay) return replay;
    const change = this.open(args);
    this.assertBaseline(change.content.baseline as z.infer<typeof baseline>);
    let verification: Verification;
    try { verification = await this.check(change); }
    catch (error) {
      if (error instanceof ChangeConflict) throw error;
      verification = { ruleVersion: 1, result: "failed", metrics: {}, notes: [(error as Error).message], inputs: {}, checkedAt: new Date().toISOString() };
    }
    return this.memory.atomic(() => {
      const again = this.previous(actor, args.operationId, signature);
      if (again) return again;
      if (this.read(change.id).version !== change.version) throw new ChangeConflict("version_conflict", "变更版本已变化，请重新读取");
      this.assertBaseline(change.content.baseline as z.infer<typeof baseline>);
      const saved = this.move(change, verification.result === "failed" ? "failed" : "verified", { ...change.content, verification: jsonData(verification) });
      this.receipt(actor, args.operationId, signature, saved);
      return saved;
    });
  }

  async adopt(input: unknown) {
    const args = adoptInput.parse(input), actor = "local-admin", signature = fingerprint({ method: "adopt", args });
    const replay = this.previous(actor, args.operationId, signature);
    if (replay) return replay;
    const change = this.open(args);
    if (change.status !== "verified") throw new ChangeConflict("not_verified", "请先复验该变更，再采用具体版本");
    const stored = change.content.verification as unknown as Verification;
    if (stored.result === "review" && !args.acknowledgeReview) throw new ChangeConflict("review_required", "复验结果为待审，需明确确认后才能采用");
    const prepared = await this.handler(change)?.prepare(change);
    const applier = prepared ? () => prepared.apply() : undefined;
    if (!applier) throw new Error(`“${change.content.type}”类变更的采用尚未接入统一流程`);
    this.assertBaseline(change.content.baseline as z.infer<typeof baseline>);
    // Adoption re-reads the facts: a result that moved since verification is no longer what was approved.
    const fresh = prepared ? { ruleVersion: 1, checkedAt: new Date().toISOString(), ...prepared.verification } : await this.check(change);
    if (fresh.result !== stored.result || fingerprint(fresh.metrics) !== fingerprint(stored.metrics) || fingerprint(fresh.inputs) !== fingerprint(stored.inputs))
      throw new ChangeConflict("verification_changed", "来源数据或定义已变化，复验结果与已核对的版本不一致，请重新复验");
    return this.memory.atomic(() => {
      const again = this.previous(actor, args.operationId, signature);
      if (again) return again;
      if (this.read(change.id).version !== change.version) throw new ChangeConflict("version_conflict", "变更版本已变化，请重新读取");
      this.assertBaseline(change.content.baseline as z.infer<typeof baseline>);
      let effect: Data;
      this.applying = true;
      try { effect = applier(); } finally { this.applying = false; }
      const saved = this.move(change, "adopted", { ...change.content, effect, decision: { actor, at: new Date().toISOString(), verifiedVersion: change.version, acknowledgedReview: args.acknowledgeReview } });
      this.receipt(actor, args.operationId, signature, saved);
      return saved;
    });
  }

  reject(input: unknown) { return this.close("reject", input, "rejected"); }

  /** Legacy entry points call this only after their owning service has revalidated its inputs. */
  commitOwned<T>(owner: Artifact, save: () => T, readings: Data = {}): T {
    if (this.applying) return save();
    return this.memory.atomic(() => {
      const change = this.trackOwner(owner);
      if (!change) return save();
      if (["rejected", "superseded", "deprecated", "adopted"].includes(change.status))
        throw new ChangeConflict("invalid_transition", "该变更已处理，不能从旧入口再次采用");
      this.assertBaseline(change.content.baseline as z.infer<typeof baseline>);
      const inputs = { ...ownerVerificationInputs(this.memory, owner), ...readings };
      if (change.status === "verified" && fingerprint((change.content.verification as Data).inputs) !== fingerprint(inputs))
        throw new ChangeConflict("verification_changed", "来源数据或定义已变化，复验结果与已核对的版本不一致，请重新复验");
      const verified = this.move(change, "verified", { ...change.content, verification: {
        ruleVersion: 1, result: "passed", metrics: { ownerValidated: true }, notes: ["原服务已重新核对来源、权限与候选版本"],
        inputs, checkedAt: new Date().toISOString() } });
      this.applying = true;
      let result: T;
      try { result = save(); } finally { this.applying = false; }
      const adopted = this.memory.getArtifact(owner.id);
      this.move(verified, "adopted", { ...verified.content, effect: { ownerRef: { id: adopted.id, version: adopted.version } },
        decision: { actor: "local-admin", at: new Date().toISOString(), verifiedVersion: verified.version } });
      return result;
    });
  }

  trackOwner(owner: Artifact): Artifact | null {
    const types: Record<string, string> = { foundation: "entity", live_ontology: "entity", mapping_change: "binding", relation_correction: "local_correction" };
    const type = types[owner.kind];
    if (!type) return null;
    if (this.memory.getArtifact(owner.id).version !== owner.version) return null;
    let existing = this.memory.listArtifacts("ontology_change").find(change => (change.content.owner as Data | undefined)?.id === owner.id);
    if (owner.status === "cancelled" && existing && ["proposed", "verified", "failed"].includes(existing.status))
      return this.move(existing, "rejected", { ...existing.content, disposition: "withdrawn", closedReason: "原入口撤回候选", closedBy: "local-admin", closedAt: new Date().toISOString() });
    if (!["candidate", "checked"].includes(owner.status)) return null;
    if (existing && (existing.content.owner as Data).version === owner.version) return existing;
    if (existing && ["rejected", "deprecated"].includes(existing.status)) {
      if (existing.content.proposalHash === ownerProposalHash(owner)) return existing;
      existing = undefined;
    }
    if (existing?.status === "adopted") existing = undefined;
    const baseline = this.currentBaseline();
    const content = jsonData({ origin: String(owner.content.responsible ?? "").startsWith("agent:") ? "agent" : "human", type, subject: { ownerRef: { id: owner.id, version: owner.version } },
      owner: { id: owner.id, version: owner.version, kind: owner.kind }, baseline,
      fingerprint: fingerprint({ kind: owner.kind, id: owner.id }), proposalHash: ownerProposalHash(owner), evidence: owner.content.reason ?? owner.content.rationale ?? owner.title,
      ...(owner.status === "checked" ? { verification: { ruleVersion: 1, result: "passed", metrics: { ownerValidated: true }, notes: ["原服务已重新核对来源、权限与候选版本"],
        inputs: ownerVerificationInputs(this.memory, owner), checkedAt: new Date().toISOString() } } : {}) });
    return this.memory.putArtifact({ ...(existing ? { id: existing.id, expectedVersion: existing.version } : {}), kind: "ontology_change", title: owner.title, status: owner.status === "checked" ? "verified" : "proposed", content });
  }

  trackProgram(owner: Artifact, item: { type: string; key: string; label?: string; selection: Data; identity: Data; observed?: { matchRate: number; targetUnique: boolean } }): Artifact {
    const fp = fingerprint({ type: item.type, subject: item.identity });
    const rejected = this.suppressedBy(fp, item.observed);
    if (rejected) return rejected;
    const existing = this.memory.listArtifacts("ontology_change").find(change => change.content.fingerprint === fp && !["adopted", "rejected", "deprecated"].includes(change.status));
    if (existing && (existing.content.owner as Data)?.id === owner.id && (existing.content.owner as Data)?.version === owner.version) return existing;
    return this.memory.putArtifact({ ...(existing ? { id: existing.id, expectedVersion: existing.version } : {}), kind: "ontology_change", title: `${item.type === "entity" ? "新增对象" : item.type === "relation" ? "新增关系" : item.type === "deprecation" ? "退役结构" : "合并来源"} · ${item.label ?? item.key}`,
      status: "proposed", content: jsonData({ type: item.type, origin: "program", subject: { candidateRef: { id: owner.id, version: owner.version }, selection: item.selection },
        owner: { id: owner.id, version: owner.version, kind: owner.kind }, baseline: this.currentBaseline(), fingerprint: fp, structuralKey: item.key,
        identity: item.identity, evidence: "程序根据来源字段、身份及实际值发现的结构变化", observed: item.observed ?? null }) });
  }

  commitProgram<T>(items: Artifact[], save: () => T): T {
    return this.memory.atomic(() => {
      for (const item of items) {
        const current = this.read(item.id);
        if (!["proposed", "verified", "failed"].includes(current.status)) throw new ChangeConflict("invalid_transition", "候选包含已拒绝或已处理的结构变更，请重新选择");
        this.assertBaseline(current.content.baseline as z.infer<typeof baseline>);
      }
      this.applying = true;
      let result: T;
      try { result = save(); } finally { this.applying = false; }
      for (const item of items) {
        const current = this.read(item.id);
        const verified = this.move(current, "verified", { ...current.content, verification: { ruleVersion: 1, result: "passed", metrics: { ownerValidated: true }, notes: ["程序按选中结构重新编译并验证"], inputs: { owner: current.content.owner }, checkedAt: new Date().toISOString() } });
        this.move(verified, "adopted", { ...verified.content, effect: { baseline: this.currentBaseline() }, decision: { actor: "local-admin", at: new Date().toISOString(), verifiedVersion: verified.version } });
      }
      return result;
    });
  }

  supersedeOwner(id: string) {
    for (const change of this.memory.listArtifacts("ontology_change")) {
      if ((change.content.owner as Data | undefined)?.id !== id || !["proposed", "verified", "failed"].includes(change.status)) continue;
      this.move(change, "rejected", { ...change.content, disposition: "withdrawn", closedReason: "后续构建已替代该候选，当前未再提出这项结构", closedAt: new Date().toISOString(), closedBy: "program" });
    }
  }

  withdraw(input: unknown) { return this.close("withdraw", input, "withdrawn"); }
  private close(method: string, input: unknown, disposition: "rejected" | "withdrawn") {
    const args = reasonInput.parse(input), actor = "local-admin", signature = fingerprint({ method, args });
    const replay = this.previous(actor, args.operationId, signature);
    if (replay) return replay;
    return this.memory.atomic(() => {
      const again = this.previous(actor, args.operationId, signature);
      if (again) return again;
      const change = this.open(args);
      this.assertBaseline(change.content.baseline as z.infer<typeof baseline>);
      const verification = change.content.verification as Data | undefined;
      // A rejection remembers the measured facts so the same program proposal is not repeated until they move.
      const metrics = (verification?.metrics ?? change.content.observed ?? null) as Data | null;
      const saved = this.move(change, "rejected", { ...change.content, disposition, closedReason: args.reason, closedBy: actor, closedAt: new Date().toISOString(),
        ...(disposition === "rejected" ? { rejectedMetrics: metrics ? { matchRate: metrics.matchRate ?? null, targetUnique: metrics.targetUnique ?? null } : null } : {}) });
      this.receipt(actor, args.operationId, signature, saved);
      return saved;
    });
  }

  private identity(type: VerifiedType, subject: Subjects[VerifiedType]) {
    if (type === "relation") { const s = subject as Subjects["relation"]; return { method: "foreign_key", from: s.from, to: s.to }; }
    return subject;
  }
  private title(type: VerifiedType, subject: Subjects[VerifiedType]) {
    if (type === "relation") { const s = subject as Subjects["relation"]; return `关系 ${s.from.datasetId}.${s.from.column} → ${s.to.datasetId}.${s.to.column}`.slice(0, rules.limits.targetChars); }
    const s = subject as Subjects["naming"] | Subjects["description"];
    const definitions = (this.foundation.read().adopted?.content[s.target === "concept" ? "concepts" : "relations"] ?? []) as Data[];
    const target = definitions.find(item => item.id === s.id);
    return `${type === "naming" ? "命名" : "说明"} · ${String(target?.name ?? "待核对对象")}`;
  }

  /** Deterministic verification: every number is recomputed here from the workspace, never taken from the proposer. */
  private async check(change: Artifact): Promise<Verification> {
    const type = String(change.content.type) as VerifiedType;
    const base = { ruleVersion: 1, checkedAt: new Date().toISOString() };
    const handler = this.handler(change);
    if (handler) return { ...base, ...(await handler.prepare(change)).verification };
    if (type === "relation") return { ...base, ...await this.checkRelation(change.content.subject as unknown as Subjects["relation"]) };
    return { ...base, ...this.checkWording(type, change.content.subject as unknown as Subjects["naming"] & Subjects["description"]) };
  }

  private checkWording(type: "naming" | "description", subject: Subjects["naming"] & Subjects["description"]) {
    const adopted = this.foundation.read().adopted;
    const items = ((subject.target === "concept" ? adopted?.content.concepts : adopted?.content.relations) ?? []) as Data[];
    const target = items.find(item => item.id === subject.id);
    const notes: string[] = [];
    const exists = !!target;
    if (!exists) notes.push("已采用的本体中没有该对象");
    let unique = true;
    if (type === "naming" && exists) {
      unique = !items.some(item => item.id !== subject.id && String(item.name).trim().toLowerCase() === subject.name.trim().toLowerCase());
      if (!unique) notes.push("同类对象中已有同名项");
    }
    const unchanged = exists && (type === "naming" ? target.name === subject.name : target.description === subject.description);
    if (unchanged) notes.push("与已采用的内容相同，没有变化");
    return { result: exists && unique && !unchanged ? "passed" as const : "failed" as const, metrics: { targetExists: exists, nameUnique: unique, changesContent: !unchanged },
      notes, inputs: { foundationRef: adopted ? { id: adopted.id, version: adopted.version } : null } };
  }

  async checkRelation(subject: Subjects["relation"]) {
    const dataset = (id: string) => {
      const artifact = this.snapshots.dataset(id), content = artifact.content as unknown as DatasetContent;
      if (!content.activeVersion || content.materialization === "live") throw new Error("该数据集没有可核对的已采用快照");
      return { id, content };
    };
    const from = dataset(subject.from.datasetId), to = dataset(subject.to.datasetId);
    for (const [side, col] of [[from, subject.from.column], [to, subject.to.column]] as const)
      if (!side.content.profile?.columns.some(item => item.name === col)) throw new Error(`字段不存在：${col}`);
    const a = this.snapshots.table(from.id), b = this.snapshots.table(to.id);
    const fromCol = `a.${quote(subject.from.column)}`, toCol = `b.${quote(subject.to.column)}`;
    const cast = (value: string) => `CAST(${value} AS VARCHAR)`;
    const refs = [from.id, to.id];
    const side = (await this.snapshots.query(refs, `SELECT count(*) FILTER (WHERE ${fromCol} IS NOT NULL) AS total, count(*) FILTER (WHERE ${fromCol} IS NOT NULL AND ${cast(fromCol)} IN (SELECT ${cast(toCol)} FROM ${b} b WHERE ${toCol} IS NOT NULL)) AS matched FROM ${a} a`, { limit: 1 })).rows[0];
    const target = (await this.snapshots.query(refs, `SELECT count(${toCol}) AS filled, count(DISTINCT ${cast(toCol)}) AS distinct_values FROM ${b} b`, { limit: 1 })).rows[0];
    const total = Number(side.total), matched = Number(side.matched);
    const matchRate = total ? round(matched / total) : 0, targetUnique = Number(target.filled) > 0 && Number(target.filled) === Number(target.distinct_values);
    const notes: string[] = [];
    if (!total) notes.push("起点列没有非空值，无法验证");
    if (rules.relation.requireUniqueTarget && !targetUnique) notes.push("目标列的值不唯一，关联会指向多条记录");
    let result: Verification["result"] = "passed";
    if (total && matchRate < rules.relation.reviewMatchRate) notes.push(`匹配率 ${matchRate} 低于最低线 ${rules.relation.reviewMatchRate}，起点值大多在目标中找不到`);
    if (!total || matchRate < rules.relation.reviewMatchRate || (rules.relation.requireUniqueTarget && !targetUnique)) result = "failed";
    else if (matchRate < rules.relation.passMatchRate) { result = "review"; notes.push(`匹配率 ${matchRate} 低于通过线 ${rules.relation.passMatchRate}，需人工判断`); }
    return { result, metrics: { total, matched, matchRate, targetUnique }, notes,
      inputs: { snapshots: { [from.id]: from.content.activeVersion, [to.id]: to.content.activeVersion } } as Data };
  }
}

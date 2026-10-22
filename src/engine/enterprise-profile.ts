import {currentActor,assertRole} from '../security/actors.ts';
import { z } from "zod";
import type { Artifact, Data, WriteContext } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { FoundationService } from "../agent/foundation.ts";
import type { FoundationDocuments } from "../agent/foundation-evidence.ts";
import { isUnknownEnterprise } from "../agent/foundation-evidence.ts";
import { captureChangeEvidence, changeEvidenceRefs, wordingEvidence } from "../agent/change-evidence.ts";
import { ChangeConflict, type OntologyChanges } from "./changes.ts";
import { fingerprint } from "./release-diff.ts";
import { jsonData } from "../live/sources.ts";

const reference = z.object({ id: z.string().min(1), version: z.number().int().positive() }).strict();
const update = z.object({ key: z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/), text: z.string().trim().min(1).max(4000),
  kind: z.enum(["fact", "suggestion"]), action: z.enum(["retain", "replace"]).default("retain"), evidenceRefs: changeEvidenceRefs }).strict();
export const enterpriseProfileSubject = z.object({ profileRef: reference.nullable(), updates: z.array(update).min(1).max(30),
  identityCorrection: z.object({ previousName: z.string().trim().min(1), sameSubject: z.literal(true) }).strict().optional(),
}).strict().refine(value => new Set(value.updates.map(item => item.key)).size === value.updates.length, "同一提议不能重复修改同一档案条目");
const ref = (value?: Artifact | null) => value ? { id: value.id, version: value.version } : null;
const rows = (value: unknown): Data[] => Array.isArray(value) ? structuredClone(value) : [];

/** Authenticate each proposed statement with the same host-owned receipts used by ontology wording. */
export function captureProfileEvidence(memory: MemoryStore, subject: Data, context: WriteContext, operationId: string, documents?: FoundationDocuments): Data {
  const raw = z.object({ updates: z.array(z.record(z.string(), z.unknown())).min(1).max(30) }).passthrough().parse(subject);
  return { ...subject, updates: raw.updates.map((item, index) => captureChangeEvidence(memory, jsonData(item), context, `${operationId}:profile:${index}`, documents)) };
}

/** Enterprise facts live in the existing profile. Every edit is an explicit, reviewed human decision. */
export function connectEnterpriseProfileChanges(memory: MemoryStore, foundation: FoundationService, changes: OntologyChanges) {
  changes.registerHandler("enterprise_profile", { subject: enterpriseProfileSubject, prepare: async (change, active = () => {}) => {
    active();
    const subject = enterpriseProfileSubject.parse(change.content.subject), prior = memory.listArtifacts("profile")[0], base = foundation.read().adopted;
    const baseline = changes.currentBaseline();
    const assertProfile = () => {
      if (fingerprint(ref(memory.listArtifacts("profile")[0])) !== fingerprint(subject.profileRef)) throw new ChangeConflict("profile_changed", "企业档案版本已变化，请重新读取并提出修改");
      if (fingerprint(changes.currentBaseline()) !== fingerprint(baseline)) throw new ChangeConflict("stale_baseline", "本体基线已变化，请重新读取并提出修改");
    };
    assertProfile();
    const statements = rows(prior?.content.statements), conflicts = rows(prior?.content.conflicts), content = base ? structuredClone(base.content) : undefined;
    const enterprise = base?.content.enterprise as Data | undefined;
    const previousName = String(enterprise && !isUnknownEnterprise(enterprise) ? enterprise.name : statements.find(item => item.key === "company.name")?.text ?? "");
    const checks: ReturnType<typeof wordingEvidence>[] = [], impact: Data[] = [], replacements: string[] = [], conflictIds: string[] = [];
    for (const item of subject.updates) {
      const citations = wordingEvidence(memory, item.evidenceRefs, previousName); checks.push(citations);
      if (item.kind === "fact" && !citations.evidence.length) throw new Error("企业事实必须引用本轮真实读取或用户陈述；没有依据只能提出建议");
      const before = statements.find(statement => statement.key === item.key);
      // Full retained source snapshots belong to the existing evidence receipt/library, not the profile projection.
      const evidence = citations.evidence.map(({ apiSnapshot: _api, knowledgeSnapshot: _knowledge, webSnapshot: _web, ...entry }) => jsonData(entry));
      const sourceRefs = citations.evidence.filter(entry => entry.sourceId && (entry.sourceVersion || entry.connectionVersion)).map(entry => ({ sourceId: entry.sourceId!, version: entry.connectionVersion ?? entry.sourceVersion! }));
      const next: Data = { key: item.key, text: item.text, origin: item.kind === "suggestion" ? "suggestion" : "source", evidence: sourceRefs, citations: evidence,
        evidenceRefs: item.evidenceRefs ?? [], userEdited: item.kind === "fact" };
      const direct = citations.evidence.find(entry => entry.kind === "user-statement" && entry.quote === item.text);
      if (item.kind === "fact" && direct) { next.origin = "user"; next.userEvidence = { messageId: direct.messageId!, quote: direct.quote }; }
      const retains = !!before && before.text !== item.text && item.action !== "replace";
      if (item.key === "company.name") {
        if (item.kind !== "fact" || !citations.evidence.some(entry => entry.quote.includes(item.text))) throw new Error("企业名称必须是有真实原文依据的事实，不能采用模型建议作为企业主体");
        if (!retains && previousName && previousName !== item.text) {
          if (subject.identityCorrection?.previousName !== previousName || !subject.identityCorrection.sameSubject) throw new Error("企业名称变化需要明确同主体名称纠正及原名称；不能合并不同企业");
          const fresh = citations.evidence.some(entry => {
            if (entry.kind !== "user-statement" || !entry.messageId || !entry.quote.includes(item.text)) return false;
            const message = memory.getMessage(entry.messageId), latest = message && memory.messages(message.taskId).filter(value => value.role === "user").at(-1);
            return latest?.id === entry.messageId && !rows(base?.content.evidence).some(old => old.id === entry.id || old.messageId === entry.messageId)
              && !rows(before?.citations).some(old => old.messageId === entry.messageId);
          });
          if (!fresh) throw new Error("名称纠正需要本轮新增且包含新名称的用户原话依据");
        }
      }
      impact.push({ key: item.key, action: retains ? "retain" : "replace", kind: item.kind, before: before ?? null, after: retains ? before! : next,
        proposed: next, evidence, requiresHumanConfirmation: true });
      if (retains) {
        const id = `profile-${fingerprint({ profile: ref(prior), key: item.key, text: item.text, evidence }).slice(0, 24)}`;
        if (!conflicts.some(conflict => conflict.id === id)) conflicts.push({ id, key: item.key, retained: before!.text, proposed: item.text,
          retainedEvidence: before!.evidence ?? [], evidence, changeRef: ref(change)! });
        conflictIds.push(id);
      } else {
        replacements.push(item.key);
        if (before) statements.splice(statements.indexOf(before), 1, next); else statements.push(next);
        if (content && item.key === "company.name") content.enterprise = { ...(content.enterprise as Data), name: item.text, evidenceRefs: citations.evidence.map(entry => entry.id) };
      }
      if (content) {
        const all = rows(content.evidence);
        for (const entry of citations.evidence) {
          const existing = all.find(value => value.id === entry.id);
          if (existing && fingerprint(existing) !== fingerprint(entry)) throw new Error("已有依据不可改写，请使用新证据标识");
          if (!existing) all.push(jsonData(entry));
          if (entry.kind === "document") content.documentVersions = { ...content.documentVersions as Data, [entry.sourceId!]: entry.sourceVersion! };
        }
        content.evidence = all;
      }
    }
    const assertCurrent = () => { active(); assertProfile(); for (const check of checks) check.assertCurrent(); };
    assertCurrent();
    return { verification: { result: "review" as const, metrics: { statements: subject.updates.length, replacements: replacements.length, retainedConflicts: conflictIds.length },
      notes: ["企业资料修改须由人核对原陈述、新陈述和真实依据后明确采用；建议仍标为建议", ...(conflictIds.length ? ["未明确选择替换的条目保留原陈述，记录分歧；需要替换时另提明确 replace 修改"] : [])],
      inputs: { profileRef: ref(prior), baseline, evidence: checks.map(check => check.fingerprint), impactHash: fingerprint(impact) } },
      previewImpact: { profileRef: ref(prior), updates: impact, requiresHumanConfirmation: true, publishedVersionsUnchanged: true },
      assertCurrent,
      apply: () => {
        assertCurrent();
        const confirmation = { actor: currentActor().id, at: new Date().toISOString(), changeRef: ref(change)!, acknowledgedReview: true };
        for (const statement of statements) if (replacements.includes(String(statement.key))) statement.confirmation = confirmation;
        for (const conflict of conflicts) if (replacements.includes(String(conflict.key)) && !conflict.resolved) conflict.resolved = { ...confirmation, value: statements.find(item => item.key === conflict.key)!.text };
        const profile = memory.putArtifact({ ...(prior ? { id: prior.id, expectedVersion: prior.version } : {}), kind: "profile", title: prior?.title ?? "企业理解", status: prior?.status ?? "draft", content: { ...prior?.content, statements, conflicts } });
        const saved = content && base ? memory.putArtifact({ ...base, expectedVersion: base.version, content: { ...content, profileRef: ref(profile)! } }) : null;
        return { profileRef: ref(profile), foundationRef: ref(saved), conflictIds, replacedKeys: replacements };
      } };
  } });
}

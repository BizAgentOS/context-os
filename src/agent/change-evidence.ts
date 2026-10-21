import { z } from "zod";
import type { Artifact, Data, WriteContext } from "./contracts.ts";
import type { MemoryStore } from "./memory.ts";
import { FoundationDocuments, foundationEvidenceInput, verifyFoundationEvidence, type FoundationEvidence } from "./foundation-evidence.ts";
import { fingerprint } from "../engine/release-diff.ts";
import { jsonData } from "../live/sources.ts";

export const changeEvidenceRefs = z.array(z.object({ id: z.string().min(1), version: z.number().int().positive() }).strict()).max(20).optional();
const inputs = z.array(foundationEvidenceInput).min(1).max(20);
export const CHANGE_EVIDENCE_KIND = "change_evidence_receipt";

/** The model supplies read receipts; only the host can persist their authenticated contents. */
export function captureChangeEvidence(memory: MemoryStore, subject: Data, context: WriteContext, operationId: string, documents?: FoundationDocuments): Data {
  if (subject.evidenceRefs !== undefined) throw new Error("依据回执由宿主生成，请引用本轮实际读取的 readId");
  if (subject.evidence === undefined) return subject;
  memory.assertWritable(context);
  const evidenceInputs = inputs.parse(subject.evidence);
  const { evidence: _inputs, ...wording } = subject;
  const inputHash = fingerprint({ wording, evidenceInputs }), receiptOperation = `change-evidence:${operationId}`;
  const existing = memory.artifactOperation(context, receiptOperation);
  if (existing) {
    if (existing.kind !== CHANGE_EVIDENCE_KIND || existing.content.inputHash !== inputHash) throw new Error("同一操作标识不能提交不同依据");
    return { ...wording, evidenceRefs: [{ id: existing.id, version: existing.version }] };
  }
  const base = memory.listArtifacts("foundation").find(item => item.status === "adopted");
  const previous = (base?.content.evidence ?? []) as unknown as FoundationEvidence[];
  const checked = verifyFoundationEvidence(memory, evidenceInputs, previous, context, documents);
  const evidence = checked.filter(entry => evidenceInputs.some(input => input.id === entry.id));
  const receipt = memory.putArtifact({ kind: CHANGE_EVIDENCE_KIND, title: "已核对的文字变更依据", status: "verified",
    content: jsonData({ inputHash, taskId: context.taskId, evidence }) }, context, receiptOperation);
  return { ...wording, evidenceRefs: [{ id: receipt.id, version: receipt.version }] };
}

/** Recheck source authorization and exact saved versions at prepare and at the transaction boundary. */
export function wordingEvidence(memory: MemoryStore, references: z.infer<typeof changeEvidenceRefs>, enterpriseName: string) {
  const receipts = (references ?? []).map(reference => {
    const receipt = memory.getArtifact(reference.id, reference.version);
    if (receipt.kind !== CHANGE_EVIDENCE_KIND || receipt.status !== "verified") throw new Error("文字变更必须引用宿主核对的真实依据");
    return receipt;
  });
  const evidence = receipts.flatMap(receipt => receipt.content.evidence as unknown as FoundationEvidence[]);
  const assertCurrent = () => {
    const locator = new FoundationDocuments(memory);
    for (const entry of evidence) {
      if (entry.kind === "user-statement") {
        const message = memory.getMessage(entry.messageId!);
        if (!message || message.role !== "user" || !message.content.includes(entry.quote)) throw new Error("引用的用户原话不可用");
      } else {
        locator.locate(entry);
        if (entry.kind === "web") {
          if (entry.identity?.name !== enterpriseName) throw new Error("网页研究主体与当前企业不一致");
        } else {
          const source = memory.getArtifact(entry.sourceId!);
          const version = entry.kind === "api" || entry.kind === "knowledge" ? entry.connectionVersion : entry.sourceVersion;
          if (source.version !== version || (entry.kind !== "profile" && source.status !== "ready")) throw new Error("变更引用的来源已停用或资料版本已变化，请重新读取并核对");
        }
      }
    }
  };
  assertCurrent();
  return { evidence, assertCurrent, fingerprint: fingerprint(receipts.map(receipt => ({ id: receipt.id, version: receipt.version, hash: receipt.content.inputHash }))) };
}

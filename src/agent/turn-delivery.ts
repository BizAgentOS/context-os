import type { Artifact, Data, Json, Repository } from "./contracts.ts";

const object = (value: unknown): Data | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Data : undefined;

/** Thinking blocks are never an answer. Do not reject a response just because it is English. */
export function userAnswer(text: string): string {
  const cleaned = text.replace(/<(think|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(think|analysis|reasoning)\b[^>]*>[\s\S]*$/gi, "").trim();
  if (/^(?:I have (?:what|everything) I need[.!]?\s*)?(?:Let me|I(?:'ll| will| need to))\b[\s\S]*\b(?:record|verify|call|tool|check|query|think|reason)\b/i.test(cleaned)) return "";
  return cleaned;
}

/** Only actual tool receipts can supply the fallback when a model stops without an answer. */
export class TurnDelivery {
  private candidates = new Map<string, Artifact>();
  private result?: { question?: string; verification?: Artifact; value: Json };
  private failure?: string;

  failed(message: string) { this.failure = message; }

  remember(name: string, args: Record<string, unknown>, result: Json) {
    const receipt = object(result);
    if (!receipt?.error) this.failure = undefined;
    if (!receipt || receipt.error) return;
    const change = object(receipt.change) ?? (receipt.kind === "ontology_change" ? receipt : undefined);
    if (change?.kind === "ontology_change" && typeof change.id === "string") this.candidates.set(change.id, change as unknown as Artifact);
    if (typeof receipt.id === "string" && typeof receipt.kind === "string" && typeof receipt.version === "number") {
      const artifact = receipt as unknown as Artifact;
      if (["foundation", "live_ontology", "mapping_change", "relation_correction", "engine_candidate"].includes(artifact.kind))
        this.candidates.set(artifact.id, artifact);
      if (artifact.kind === "verification") {
        const results = object(object(artifact.content.result)?.results);
        this.result = { question: String(artifact.content.question), verification: artifact,
          value: results ? Object.values(results).at(-1)! : artifact.content.result };
      }
    }
    if (["object_execute", "live_query", "snapshot_query", "metric_query"].includes(name)) {
      const results = object(receipt.results);
      this.result = { question: typeof args.question === "string" ? args.question : undefined,
        value: results ? Object.values(results).at(-1)! : result };
    }
  }

  finish(text: string, input: string, repo: Repository, pending?: Data | null): string {
    const chinese = /[\p{Script=Han}]/u.test(input);
    let answer = userAnswer(text);
    const needsFallback = !answer;
    const candidates = [...this.candidates.values()].map(a => repo.getArtifact(a.id))
      .filter(a => ["candidate", "checked", "ready", "proposed", "verified", "failed"].includes(a.status));
    const conflicts = [...this.candidates.values()].map(a => repo.getArtifact(a.id)).filter(a =>
      a.kind === "ontology_change" && a.status === "adopted" && Array.isArray(object(a.content.effect)?.conflictIds) && (object(a.content.effect)!.conflictIds as Json[]).length);
    if (!answer && this.result) {
      const { question, verification, value } = this.result;
      const row = object(value);
      const coverage = object(row?.coverage);
      const count = typeof row?.count === "number" ? row.count : null;
      const items = Array.isArray(row?.items) ? row.items : Array.isArray(row?.rows) ? row.rows : null;
      answer = chinese
        ? `${verification ? `已保存「${question}」的验证记录，业务结论仍需核对。` : "已返回查询结果。"}${count !== null ? `统计结果：${count}。` : items ? `本次返回 ${items.length} 条记录。` : "详情见本轮查询卡。"}`
        : `${verification ? `Verification saved for “${question}”; the business conclusion still needs review.` : "Query results are available."} ${count !== null ? `Count: ${count}.` : items ? `${items.length} records returned.` : "See the query card for details."}`;
      if (row?.partial === true) answer += chinese ? "这只是部分结果。" : "This is a partial result.";
      if (coverage?.complete === false) answer += chinese ? "读取覆盖不完整，不能代表全量。" : "Read coverage is incomplete and does not represent the whole dataset.";
      else if (coverage?.complete === true) answer += chinese ? "本次读取范围覆盖完整。" : "The requested reading scope is complete.";
      else answer += chinese ? "读取覆盖范围尚未确认。" : "Read coverage has not been confirmed.";
    }
    if (candidates.length) {
      const labels = candidates.map(a => `「${a.kind === "ontology_change" ? ({ relation: "关系变更", entity: "对象变更", property: "属性变更", binding: "数据对应变更", identity_rule: "身份规则", identity_decision: "身份决定", naming: "命名变更", description: "说明变更", deprecation: "弃用建议" }[String(a.content.type)] ?? "本体变更") : a.title}」`).join("、");
      const needsCheck = candidates.some(a => ["mapping_change", "relation_correction"].includes(a.kind) && a.status !== "checked");
      answer += `${answer ? "\n\n" : ""}${chinese
        ? `本轮候选尚未采用：${labels}。请在待处理中心核对依据、复验与影响后决定。`
        : `This turn's candidates have not been adopted: ${labels}. ${needsCheck ? "Check the candidates first, then confirm the specific version on the ontology page." : "Review the checks and confirm the specific version on the ontology page."}`}`;
    }
    if (conflicts.length) answer += `${answer ? "\n\n" : ""}${chinese
      ? "资料存在分歧，原含义保持；请在待处理中心裁决。"
      : "The evidence conflicts with the current meaning, which remains in effect. Resolve the disagreement in the pending center."}`;
    if (needsFallback && this.failure)
      answer += `${answer ? "\n\n" : ""}${chinese ? `最后一次操作未完成：${this.failure}。` : `The last operation did not complete: ${this.failure}.`}`;
    if (pending?.question && !answer) answer = chinese ? "有一项需要你核对的决定，请查看决定卡。" : "A decision needs your review; open the decision card.";
    return answer || (chinese ? "本次未形成可交付的结论。已保存的内容仍可查看，请继续核对所需资料或查询范围。" : "This run did not produce a conclusion. Saved work is still available; the required evidence or query scope needs further review.");
  }
}

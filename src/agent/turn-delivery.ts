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
      .filter(a => ["candidate", "checked", "ready"].includes(a.status));
    if (!answer && this.result) {
      const { question, verification, value } = this.result;
      // Preserve coverage/partial flags verbatim; a count or a tool success is not business verification.
      const row = object(value);
      const display = row ? Object.fromEntries(Object.entries(row).filter(([key]) =>
        !["evidence", "snapshot", "sourceVersions"].includes(key))) : value;
      const rendered = JSON.stringify(display, null, 2) ?? "null";
      const excerpt = rendered.length > 4000 ? rendered.slice(0, 4000) : rendered;
      const fence = "`".repeat(Math.max(3, ...[...excerpt.matchAll(/`+/g)].map(m => m[0].length + 1)));
      answer = chinese
        ? `${verification ? `已保存「${question}」的验证记录（v${verification.version}），业务结论仍需核对。实际返回结果：` : "本次查询的实际返回结果如下。"}\n\n${fence}json\n${excerpt}\n${fence}`
        : `${verification ? `Verification saved for “${question}” (v${verification.version}); the business conclusion still needs review.` : "The query returned the following results."}\n\n${fence}json\n${excerpt}\n${fence}`;
      if (rendered.length > 4000) answer += chinese
        ? `\n结果较长，此处仅展示片段；${verification ? "完整结果见已保存记录" : "可缩小查询范围继续查看"}。`
        : `\nThis is an excerpt; ${verification ? "open the saved record for the complete result" : "narrow the query to inspect more results"}.`;
    }
    if (candidates.length) {
      const labels = candidates.map(a => `「${a.title}」v${a.version}（${a.id.slice(0, 8)}）`).join("、");
      const needsCheck = candidates.some(a => ["mapping_change", "relation_correction"].includes(a.kind) && a.status !== "checked");
      answer += `${answer ? "\n\n" : ""}${chinese
        ? `本轮候选尚未采用：${labels}。${needsCheck ? "请先检查候选，再在本体页确认具体版本。" : "请在本体页查看检查结果并确认采用具体版本。"}`
        : `This turn's candidates have not been adopted: ${labels}. ${needsCheck ? "Check the candidates first, then confirm the specific version on the ontology page." : "Review the checks and confirm the specific version on the ontology page."}`}`;
    }
    if (needsFallback && this.failure)
      answer += `${answer ? "\n\n" : ""}${chinese ? `最后一次操作未完成：${this.failure}。` : `The last operation did not complete: ${this.failure}.`}`;
    if (pending?.question && !answer.includes(String(pending.question)))
      answer += `${answer ? "\n\n" : ""}${pending.question}`;
    return answer || (chinese ? "本次未形成可交付的结论。已保存的内容仍可查看，请继续核对所需资料或查询范围。" : "This run did not produce a conclusion. Saved work is still available; the required evidence or query scope needs further review.");
  }
}

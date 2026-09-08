import type { Repository } from "./contracts.ts";

/** A business judgment belongs to the user; the recorded execution remains unchanged. */
export function reviewVerification(
  repo: Repository,
  input: Record<string, unknown>,
) {
  if (typeof input.id !== "string" || !Number.isInteger(input.version))
    throw new Error("需要验证记录的准确版本");
  if (
    !["matches_expectation", "needs_adjustment"].includes(String(input.status))
  )
    throw new Error("请选择符合预期或需要调整");
  const record = repo.getArtifact(input.id);
  if (record.kind !== "verification") throw new Error("只能确认业务验证记录");
  if (record.version !== input.version)
    throw new Error("验证记录已变化，请重新打开");
  return repo.putArtifact({
    id: record.id,
    expectedVersion: record.version,
    kind: record.kind,
    title: record.title,
    status: String(input.status),
    content: {
      ...record.content,
      review: {
        origin: "user",
        status: String(input.status),
        at: new Date().toISOString(),
      },
    },
  });
}

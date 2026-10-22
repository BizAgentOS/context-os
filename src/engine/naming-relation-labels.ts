import type { Artifact, Data, Repository } from '../agent/contracts.ts';
import { relationSubjectSchema } from './relation-verification.ts';
import { fingerprint } from './release-diff.ts';

/** A label identifies the exact proposed edge, without authorizing that edge. */
export function namingRelationIdentity(value: unknown) {
  const subject = relationSubjectSchema.parse(value);
  return fingerprint({ from: subject.from, to: subject.to, cardinality: subject.cardinality ?? 'N:1', acyclic: subject.acyclic ?? false, maxDepth: subject.acyclic ? subject.maxDepth ?? 10 : null });
}
export function confirmedRelationWording(memory: Pick<Repository, 'listArtifacts'>, subject: unknown): Data | undefined {
  const identity = namingRelationIdentity(subject);
  const label = memory.listArtifacts('naming_relation_label').find((item: Artifact) => item.status === 'adopted' && item.content.identity === identity);
  return label?.content.wording as Data | undefined;
}

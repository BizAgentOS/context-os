import { requiresReview, reviewReasons, type Comparison, type Semantics, type Ontology } from './contracts.ts';
import { fingerprint } from './sources.ts';

export const FUSION_POLICY = 'semantic-conflict-v2';

export interface Statement {
  id: string; revision: number; predicate: string; value: unknown; target_id: string | null;
  origin: string; status: string; basis: string; valid_from: string | Date | null; valid_to: string | Date | null;
  time_precision: string; override_mode: string | null; override_source_version: string | null;
  source_id: string | null; source_version_id: string | null;
  semantics?: Partial<Semantics>; comparison?: Comparison;
}
const time = (value: string | Date) => new Date(value).getTime();
export function projectStatements(typeId: string, ontology: Ontology, statements: Statement[], validAt: string) {
  const type = ontology.types.find(t => t.id === typeId);
  const definitions = new Map([
    ...(type?.properties.map(p => [p.id, { multiple: p.multiple, name: p.name, comparison: p.comparison }] as const) ?? []),
    ...ontology.links.filter(l => l.from === typeId).map(l => [l.id, { multiple: l.multiple, name: l.name, comparison: undefined }] as const),
  ]);
  const at = time(validAt);
  if (!Number.isFinite(at)) throw new Error('业务查询时间无效');
  const fields: Record<string, unknown> = {};
  for (const predicate of new Set([...definitions.keys(), ...statements.map(s => s.predicate)])) {
    const all = statements.filter(s => s.predicate === predicate);
    const accepted = all.filter(s => s.status === 'accepted' && !requiresReview(s.basis, s.semantics) && !(s.origin === 'human' && s.override_mode === 'source_version' && !statements.some(other => other.origin === 'source' && other.status === 'accepted' && other.source_version_id === s.override_source_version)));
    const known = accepted.filter(s => s.time_precision !== 'unknown' && (!s.valid_from || time(s.valid_from) <= at) && (!s.valid_to || time(s.valid_to) > at));
    const unknown = accepted.filter(s => s.time_precision === 'unknown');
    const overrides = known.filter(s => s.origin === 'human' && (s.override_mode !== 'source_version' || statements.some(other => other.origin === 'source' && other.status === 'accepted' && other.source_version_id === s.override_source_version)));
    const candidates = overrides.length ? overrides : known;
    const expected = definitions.get(predicate)?.comparison;
    const incomparable = new Set(known.map(s => fingerprint(s.comparison ?? {}))).size > 1 ||
      !!expected && known.some(s => Object.entries(expected).some(([key, value]) => s.comparison?.[key as keyof Comparison] !== value));
    const value = (s: Statement) => s.target_id ? { objectId: s.target_id } : s.value;
    const distinct = [...new Map(candidates.map(s => [JSON.stringify(value(s)), value(s)])).values()];
    const multiple = definitions.get(predicate)?.multiple ?? false;
    const selected = incomparable ? null : multiple ? distinct : distinct.length === 1 ? distinct[0] : null;
    const disagreement = overrides.length > 0 && known.some(s => s.origin === 'source' && !distinct.some(v => JSON.stringify(v) === JSON.stringify(value(s))));
    fields[predicate] = {
      name: definitions.get(predicate)?.name ?? predicate,
      status: incomparable ? 'incomparable' : distinct.length ? !multiple && distinct.length > 1 ? 'conflict' : 'resolved' : unknown.length ? 'uncertain' : 'missing',
      value: selected, supportingAssertions: incomparable ? [] : candidates.map(s => s.id),
      unknownTimeAssertions: unknown.map(s => s.id),
      disputed: disagreement, pendingAssertions: all.filter(s => s.status === 'pending' || s.status === 'accepted' && requiresReview(s.basis, s.semantics)).map(s => s.id),
      comparison: expected ?? null,
      candidates: all.map(s => ({ id: s.id, revision: s.revision, value: value(s), origin: s.origin, status: s.status, basis: s.basis, semantics: s.semantics ?? { polarity: 'affirmed', modality: 'actual' }, comparison: s.comparison ?? {}, reviewRequired: requiresReview(s.basis, s.semantics), reviewReasons: reviewReasons(s.basis, s.semantics), validity: { from: s.valid_from, to: s.valid_to, precision: s.time_precision } })),
    };
  }
  return { typeId, validAt, policy: FUSION_POLICY, fields };
}

import type { Claim, Ontology } from './contracts.ts';
import { fingerprint } from './sources.ts';
export interface BuildEvent { id: string; kind: string; summary: string; details: unknown; }
export function buildConflictEvents(ontology: Ontology, claims: Claim[]): BuildEvent[] {
  const groups = new Map<string, Claim[]>();
  for (const claim of claims) {
    const property = ontology.types.find(t => t.id === claim.subject.typeId)?.properties.find(p => p.id === claim.predicate);
    const link = ontology.links.find(l => l.id === claim.predicate && l.from === claim.subject.typeId);
    if (property?.comparisonRequired?.some(d => !claim.comparison[d])) continue;
    if (property?.comparison && Object.entries(property.comparison).some(([key, value]) => claim.comparison[key as keyof typeof claim.comparison] !== value)) continue;
    if ((!property && !link) || (property ?? link)!.multiple || claim.validity.precision === 'unknown' || claim.basis !== 'explicit' || claim.semantics.polarity !== 'affirmed' || claim.semantics.modality !== 'actual' || claim.semantics.condition) continue;
    const key = fingerprint({ subject: claim.subject, predicate: claim.predicate, comparison: claim.comparison });
    const group = groups.get(key) ?? []; group.push(claim); groups.set(key, group);
  }
  const events: BuildEvent[] = [];
  for (const group of groups.values()) {
    const conflicting = group.some((a, i) => group.slice(i + 1).some(b => fingerprint(a.object ?? a.value) !== fingerprint(b.object ?? b.value) && Math.max(a.validity.from ? Date.parse(a.validity.from) : -Infinity, b.validity.from ? Date.parse(b.validity.from) : -Infinity) < Math.min(a.validity.to ? Date.parse(a.validity.to) : Infinity, b.validity.to ? Date.parse(b.validity.to) : Infinity)));
    if (!conflicting) continue;
    const detail = { subject: group[0].subject, predicate: group[0].predicate, candidates: [...new Map(group.map(c => [fingerprint({ value: c.object ?? c.value, validity: c.validity, comparison: c.comparison }), { value: c.object ?? c.value, validity: c.validity, comparison: c.comparison }])).values()].sort((a, b) => fingerprint(a).localeCompare(fingerprint(b))) };
    events.push({ id: fingerprint(detail), kind: 'fact_conflict', summary: `${group[0].subject.value} / ${group[0].predicate} 存在有效期重叠的不同值；决定是否保留冲突，不自动选胜者`, details: detail });
  }
  return events.sort((a, b) => a.id.localeCompare(b.id));
}

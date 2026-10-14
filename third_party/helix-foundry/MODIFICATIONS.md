# Helix Foundry attribution and ADE modifications

Upstream: https://github.com/HelixDB/helix-foundry
Pinned commit: `00d7927d7c08e16c58316e006959f052427e7fa1`.
Original file: `apps/api/src/discovery.ts` (Apache-2.0).

`src/engine/discovery.ts` adapts the upstream deterministic naming, key selection,
key-stem guard, and value-overlap thresholds. Copyright and license are retained.

ADE changes (2026-10-14):
- Work on authorized bounded API samples and complete uploaded CSV rows, without
  Helix Store, DuckDB SQL, or a model call. Coverage is explicit.
- Unicode names are preserved. Dataset/concept identity is based on immutable
  source identity, never a mutable display name.
- Validate a configured API identity; infer CSV identities only from meaningful
  key names with non-null unique values. Do not promote arbitrary unique names
  or timestamps to identities.
- Value overlaps produce review issues with supporting counts. They do not merge
  business entities or assert relations automatically. Integer ID coincidences
  must pass the original key-stem guard.
- Existing ADE concept IDs, descriptions, mapping fields, supplementary sources,
  and relationships are preserved. ADE shared services validate and atomically
  adopt the working definition; the build never publishes consumer access.
- All capacity limits are reported, never silently slice entities/relationships.

This is a scoped extraction/adaptation, not a vendored or running copy of the
entire Helix product. Its provider loop, DuckDB/Parquet engine, UI, connectors,
and storage backend are not included by this module.

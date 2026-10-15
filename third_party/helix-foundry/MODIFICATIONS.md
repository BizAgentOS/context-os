# Helix Foundry attribution and ADE modifications

Upstream: https://github.com/HelixDB/helix-foundry
Pinned commit: `00d7927d7c08e16c58316e006959f052427e7fa1` (Apache-2.0).
Copyright and license are retained in this directory; each adapted file names its upstream source.

## Snapshot executor (2026-10-15, FEATURE_031)

Original files: `services/executor/src/engine.ts`, `jobs.ts`, `limits.ts`, `paths.ts`, `runner.ts`;
`packages/shared/src/index.ts` (`compactValue`, `compactSample`, profile types).
ADE files: `src/data/executor/*.ts`.

ADE changes:
- No Fastify server or internal key: the host calls `Executor.run()` in-process, which still runs every
  job in a disposable child process. The queue is per `Executor` instance, not module-global.
- The child runs ADE's TypeScript directly with Node type stripping; `tsx` is not used. The data root is
  passed with the job instead of `DATA_DIR`.
- The `export` mode, query order profiling and the legacy untagged fingerprint are removed. Empty
  ingest files create an empty table without a declared schema.
- Sensitive-column detection also matches common Chinese field names.
- Error messages returned to users are Chinese.

`src/data/snapshots.ts` is new ADE code that re-implements the decision logic of upstream
`apps/api/src/datasets.ts` `ingestFile` (unchanged fingerprint short-circuit, schema drift kept pending,
uniqueness-lost and null-rate issues) on ADE's `MemoryStore`. CSV cells are ingested as text so
identities keep their form; HTTP/MCP records are read through ADE source contracts.

## Discovery heuristics (2026-10-14, FEATURE_026)

Original file: `apps/api/src/discovery.ts`.

`src/engine/discovery.ts` adapts the upstream deterministic naming, key selection,
key-stem guard, and value-overlap thresholds.

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

The Helix provider loop, UI, connectors and HelixDB storage backend are not included.

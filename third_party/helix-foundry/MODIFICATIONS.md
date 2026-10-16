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

## Snapshot validation (2026-10-15, FEATURE_033)

Reference: `apps/api/src/assistant.ts` `validateBundle` (check order, persisted pipeline outputs, checks whose
first row must be all true, key uniqueness, relationship match counts). ADE file: `src/engine/validation.ts`
re-implements these checks against ADE mapping definitions (types, supplements, relations) over snapshots
instead of a Helix bundle, adds supplement fan-out and low-match warnings, and fails a relationship with no
matches. Dashboard and action checks are not ported.

## Full ontology discovery (2026-10-15, FEATURE_032)

Original file: `apps/api/src/discovery.ts` (`suggestOntology`, `confirmOntology`, `ontologyBundle`,
`entityColumns`, `entityColumn` and their helpers). ADE file: `src/engine/helix-discovery.ts`; the algorithm
and upstream formatting are kept so the file can be compared with upstream.

ADE changes:
- An injected `query(datasetIds, sql, options)` over ADE snapshots replaces the Helix store and
  `queryDatasets`; types are declared locally instead of importing `packages/shared`.
- Names split on Unicode letters and digits; Chinese key suffixes (编号, 编码, 代码, 标识, 号 …) count as key
  and id names, and 邮箱 as e-mail. `tableName` accepts non-Latin table names.
- `ownKey` no longer falls back to an arbitrary unique column (a name, timestamp or free text); such a
  dataset stays unplaced and is reported.
- Descriptions, notes, summaries, link names, pipeline and check names, and confirmation errors are Chinese.
- Pipelines are keyed by the entity's id (`pipelineId(entity.id)`) and carry `entityId`/`datasetId`;
  object types and relationships carry `entityId`/`linkId` so ADE can map them back.
- The 20 entity / 10 pipeline / 30 relationship caps are unchanged, but `ontologyBundle` returns the cut
  entities and links in `capacity` so ADE reports them. `overviewDashboard` and `ontologyGoal` are not ported.

`src/engine/snapshot-discovery.ts` builds the discovery input from ADE snapshot datasets (one system per
connection or upload). `ProgramBuilds` maps entities to ADE concepts and mapping types under the existing
source-based concept identity; direct merges become ADE supplements and anchor links become foundation
and mapping relations when ADE's live mapping can express them, otherwise they are reported and kept in
the candidate.

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

## Snapshot correctness follow-up (2026-10-15, unreleased)

ADE's JSON ingest streams native JSON with encoded top-level keys to a temporary JSONL file,
preventing case-sensitive source keys from colliding in DuckDB's explicit schema. It inspects
the inferred schema and reads date/time/timestamp/UUID scalar and array columns explicitly as
VARCHAR, then restores the original names and DuckDB's normal output-name deduplication. Source
strings retain their spelling without changing numeric or boolean inference. Nested STRUCT fields
still follow DuckDB inference. Snapshot reuse requires
both content and source coverage to match; release retention reads the immutable definition's
snapshot manifest. Snapshot checks and consumer reads carry incomplete coverage instead of
claiming full-source completeness. New merge properties are named relative to the retained ADE
primary mapping and avoid existing property names. Unsupported candidates are reported as
not included in object queries or release consumption.


## Discovery review and legacy migration follow-up (2026-10-17, unreleased)

`src/engine/helix-discovery.ts` additionally indexes ordinary high-cardinality VARCHAR columns for
review-only overlap checks. These columns cannot create identities or executable links. At least three
shared normalized distinct values and 80% distinct overlap on one side are required for a review lead;
low-cardinality status vocabularies are not promoted by this path. Reviews carry dataset/column references
and measured counts, not raw values. Email equality alone no longer creates a cross-system identity merge.
Existing non-email key discovery remains in place.

`withoutImplied` preserves the exact direct link and two-hop path it actually removed, with the
row-comparison counts. ADE reports these as review items rather than inferring a missing business
relationship from a diagram. English table-derived names produce actionable naming reviews; confirmation
can rename a concept without changing its source-based ADE identity. No AI naming step was imported.
`ProgramBuilds` persists these reviews and `helix-projection.ts` attaches them to all involved concepts.

During rule reconstruction, ADE creates a new candidate that replaces legacy interpretation-built
concepts, relations and their mappings. Existing program concepts keep later human/Agent wording edits.
The candidate reports retired definitions and old version references; adoption does not rewrite historical
artifacts or published consumer definitions. This migration is ADE integration behavior, not an upstream
Helix store change. Regression tests exercise real snapshot queries, candidate/check/adopt boundaries,
and historical release consumers without invoking a model.

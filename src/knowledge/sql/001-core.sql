CREATE SCHEMA knowledge;
CREATE TABLE knowledge.ontologies (
 id uuid PRIMARY KEY, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 status text NOT NULL CHECK(status IN ('draft','published')), definition jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), published_at timestamptz
);
CREATE TABLE knowledge.sources (
 id uuid PRIMARY KEY, source_key text NOT NULL UNIQUE, title text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('csv','pdf')), revision integer NOT NULL DEFAULT 1,
 active_version uuid
);
CREATE TABLE knowledge.source_versions (
 id uuid PRIMARY KEY, source_id uuid NOT NULL REFERENCES knowledge.sources(id),
 revision integer NOT NULL, content_hash text NOT NULL, content jsonb NOT NULL,
 original_path text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(source_id,revision)
);
ALTER TABLE knowledge.sources ADD CONSTRAINT sources_active_version_fk FOREIGN KEY(active_version) REFERENCES knowledge.source_versions(id);
CREATE TABLE knowledge.objects (
 id uuid PRIMARY KEY, type_id text NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE knowledge.identifiers (
 type_id text NOT NULL, namespace text NOT NULL, value text NOT NULL,
 object_id uuid NOT NULL REFERENCES knowledge.objects(id), PRIMARY KEY(type_id,namespace,value)
);
CREATE TABLE knowledge.extraction_runs (
 id uuid PRIMARY KEY, operation_id text NOT NULL UNIQUE, fingerprint text NOT NULL,
 ontology_id uuid NOT NULL REFERENCES knowledge.ontologies(id), source_version_id uuid NOT NULL REFERENCES knowledge.source_versions(id),
 configuration jsonb NOT NULL, status text NOT NULL CHECK(status IN ('queued','running','completed','failed')),
 result jsonb, error text, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE knowledge.assertions (
 id uuid PRIMARY KEY, object_id uuid NOT NULL REFERENCES knowledge.objects(id),
 predicate text NOT NULL, ontology_id uuid NOT NULL REFERENCES knowledge.ontologies(id),
 source_version_id uuid REFERENCES knowledge.source_versions(id), run_id uuid REFERENCES knowledge.extraction_runs(id),
 origin text NOT NULL CHECK(origin IN ('source','human')), dedup_key text UNIQUE,
 revision integer NOT NULL DEFAULT 1
);
CREATE TABLE knowledge.assertion_revisions (
 assertion_id uuid NOT NULL REFERENCES knowledge.assertions(id), revision integer NOT NULL,
 value jsonb, target_id uuid REFERENCES knowledge.objects(id),
 valid_from timestamptz, valid_to timestamptz, time_precision text NOT NULL CHECK(time_precision IN ('unknown','day','instant')),
 system_from timestamptz NOT NULL DEFAULT clock_timestamp(), system_to timestamptz,
 status text NOT NULL CHECK(status IN ('accepted','pending','rejected','superseded')),
 basis text NOT NULL CHECK(basis IN ('explicit','inferred','human')),
 override_mode text CHECK(override_mode IN ('until_revoked','source_version')),
 override_source_version uuid REFERENCES knowledge.source_versions(id), reason text,
 PRIMARY KEY(assertion_id,revision), CHECK((value IS NULL) <> (target_id IS NULL)),
 CHECK(valid_from IS NULL OR valid_to IS NULL OR valid_from<valid_to),
 CHECK(time_precision<>'unknown' OR (valid_from IS NULL AND valid_to IS NULL)),
 CHECK(system_to IS NULL OR system_from<system_to)
);
CREATE UNIQUE INDEX assertion_current ON knowledge.assertion_revisions(assertion_id) WHERE system_to IS NULL;
CREATE INDEX assertion_object ON knowledge.assertions(object_id,predicate);
CREATE INDEX assertion_source ON knowledge.assertions(source_version_id);
CREATE TABLE knowledge.evidence (
 id uuid PRIMARY KEY, source_version_id uuid NOT NULL REFERENCES knowledge.source_versions(id), locator jsonb NOT NULL
);
CREATE TABLE knowledge.assertion_evidence (
 assertion_id uuid NOT NULL REFERENCES knowledge.assertions(id), evidence_id uuid NOT NULL REFERENCES knowledge.evidence(id),
 PRIMARY KEY(assertion_id,evidence_id)
);
CREATE TABLE knowledge.action_events (
 operation_id text PRIMARY KEY, fingerprint text NOT NULL, actor_id text NOT NULL,
 kind text NOT NULL, target_id uuid NOT NULL, payload jsonb NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE knowledge.projections (
 object_id uuid PRIMARY KEY REFERENCES knowledge.objects(id), object_revision integer NOT NULL,
 body jsonb NOT NULL, computed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE knowledge.projection_dependencies (
 object_id uuid NOT NULL REFERENCES knowledge.objects(id), assertion_id uuid NOT NULL REFERENCES knowledge.assertions(id),
 PRIMARY KEY(object_id,assertion_id)
);
CREATE TABLE knowledge.jobs (
 id uuid PRIMARY KEY, operation_id text NOT NULL UNIQUE, fingerprint text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('discover','extract')), actor_id text NOT NULL, payload jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','running','completed','failed')) DEFAULT 'queued',
 attempts integer NOT NULL DEFAULT 0, lease_token uuid, lease_until timestamptz,
 result jsonb, error text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX jobs_queue ON knowledge.jobs(state,created_at);
CREATE TABLE knowledge.operations (
 id text PRIMARY KEY, fingerprint text NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

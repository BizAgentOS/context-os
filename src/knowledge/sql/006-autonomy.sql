ALTER TABLE knowledge.sources DROP CONSTRAINT sources_kind_check;
ALTER TABLE knowledge.sources ADD CONSTRAINT sources_kind_check CHECK(kind IN ('csv','pdf','table'));
ALTER TABLE knowledge.sources ADD COLUMN observed_version uuid REFERENCES knowledge.source_versions(id);
CREATE TABLE knowledge.source_records (
 source_version_id uuid NOT NULL REFERENCES knowledge.source_versions(id), record_key text NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal>=0), values jsonb NOT NULL, PRIMARY KEY(source_version_id,record_key),
 UNIQUE(source_version_id,ordinal)
);
CREATE TABLE knowledge.connections (
 id uuid PRIMARY KEY, name text NOT NULL, kind text NOT NULL CHECK(kind='mysql'),
 scope jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
 enabled boolean NOT NULL DEFAULT true, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE knowledge.observation_runs (
 id uuid PRIMARY KEY, connection_id uuid NOT NULL REFERENCES knowledge.connections(id),
 operation_id text NOT NULL UNIQUE, fingerprint text NOT NULL, connection_revision integer NOT NULL,
 state text NOT NULL CHECK(state IN ('running','completed','failed')), table_name text NOT NULL,
 source_version_id uuid REFERENCES knowledge.source_versions(id), result jsonb, error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz
);
CREATE TABLE knowledge.observation_pages (
 run_id uuid NOT NULL REFERENCES knowledge.observation_runs(id), page integer NOT NULL,
 records jsonb NOT NULL, PRIMARY KEY(run_id,page)
);
CREATE TABLE knowledge.decision_packages (
 id uuid PRIMARY KEY, ontology_id uuid NOT NULL REFERENCES knowledge.ontologies(id),
 plan_id uuid NOT NULL UNIQUE REFERENCES knowledge.build_plans(id), scope_key text NOT NULL,
 superseded_by uuid REFERENCES knowledge.decision_packages(id), archived_by text, archived_at timestamptz, archive_reason text, revision integer NOT NULL DEFAULT 1,
 state text NOT NULL DEFAULT 'collecting', snapshot jsonb NOT NULL DEFAULT '{}', receipts jsonb NOT NULL DEFAULT '{}',
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE knowledge.jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE knowledge.jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('discover','extract','plan','build','observe','collect'));

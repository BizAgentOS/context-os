ALTER TABLE knowledge.ontologies ADD COLUMN discovery jsonb NOT NULL DEFAULT '{}';
ALTER TABLE knowledge.jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE knowledge.jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('discover','extract','plan','build'));
CREATE TABLE knowledge.build_plans (
 id uuid PRIMARY KEY, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 ontology_id uuid NOT NULL REFERENCES knowledge.ontologies(id), ontology_hash text NOT NULL,
 manifest jsonb NOT NULL, proposal jsonb NOT NULL, review jsonb NOT NULL DEFAULT '{"items":{},"identities":{},"reason":""}',
 preview jsonb, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','approved')),
 provenance jsonb NOT NULL DEFAULT '{}', created_by text NOT NULL, approved_by text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), approved_at timestamptz
);
CREATE TABLE knowledge.plan_identity_decisions (
 plan_id uuid NOT NULL REFERENCES knowledge.build_plans(id), group_key text NOT NULL,
 decision text NOT NULL CHECK(decision IN ('same','separate')), canonical_id uuid NOT NULL,
 participants jsonb NOT NULL, reason text NOT NULL, actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(plan_id,group_key)
);
CREATE INDEX plan_identity_group ON knowledge.plan_identity_decisions(group_key,created_at DESC);
CREATE TABLE knowledge.approved_plan_outputs (
 plan_id uuid NOT NULL REFERENCES knowledge.build_plans(id), source_version_id uuid NOT NULL REFERENCES knowledge.source_versions(id),
 output jsonb NOT NULL, output_hash text NOT NULL, namespaces text[] NOT NULL,
 PRIMARY KEY(plan_id,source_version_id)
);
ALTER TABLE knowledge.extraction_runs ADD COLUMN build_plan_id uuid REFERENCES knowledge.build_plans(id);
CREATE INDEX extraction_plan ON knowledge.extraction_runs(build_plan_id,source_version_id);
CREATE TABLE knowledge.plan_events (
 id uuid PRIMARY KEY, plan_id uuid NOT NULL REFERENCES knowledge.build_plans(id),
 actor_id text NOT NULL, kind text NOT NULL, revision integer NOT NULL, details jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

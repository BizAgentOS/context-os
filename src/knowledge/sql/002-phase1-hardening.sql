ALTER TABLE knowledge.assertion_revisions
 ADD COLUMN semantics jsonb NOT NULL DEFAULT '{"polarity":"affirmed","modality":"actual"}',
 ADD COLUMN comparison jsonb NOT NULL DEFAULT '{}',
 ADD CONSTRAINT assertion_semantics CHECK (
   jsonb_typeof(semantics)='object' AND semantics ?& ARRAY['polarity','modality'] AND
   semantics->>'polarity' IN ('affirmed','negated') AND
   semantics->>'modality' IN ('actual','planned','hypothetical') AND
   (NOT semantics ? 'condition' OR (jsonb_typeof(semantics->'condition')='string' AND length(btrim(semantics->>'condition'))>0))
 ),
 ADD CONSTRAINT assertion_comparison CHECK (jsonb_typeof(comparison)='object');

CREATE TABLE knowledge.assertion_revision_evidence (
 assertion_id uuid NOT NULL, revision integer NOT NULL,
 evidence_id uuid NOT NULL REFERENCES knowledge.evidence(id),
 PRIMARY KEY(assertion_id,revision,evidence_id),
 FOREIGN KEY(assertion_id,revision) REFERENCES knowledge.assertion_revisions(assertion_id,revision)
);

CREATE TABLE knowledge.identity_bindings (
 id uuid PRIMARY KEY, type_id text NOT NULL, namespace text NOT NULL, value text NOT NULL,
 object_id uuid NOT NULL REFERENCES knowledge.objects(id),
 system_from timestamptz NOT NULL DEFAULT clock_timestamp(), system_to timestamptz,
 operation_id text REFERENCES knowledge.action_events(operation_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(system_to IS NULL OR system_from<system_to)
);
CREATE UNIQUE INDEX identity_current ON knowledge.identity_bindings(type_id,namespace,value) WHERE system_to IS NULL;
CREATE INDEX identity_history ON knowledge.identity_bindings(object_id,system_from,system_to);
-- Existing bindings predate this feature; object creation is the best available recorded boundary.
INSERT INTO knowledge.identity_bindings(id,type_id,namespace,value,object_id,system_from)
 SELECT gen_random_uuid(),i.type_id,i.namespace,i.value,i.object_id,o.created_at
 FROM knowledge.identifiers i JOIN knowledge.objects o ON o.id=i.object_id;

ALTER TABLE knowledge.projections ADD COLUMN fusion_policy_version text NOT NULL DEFAULT 'explicit-conflict-v1';
ALTER TABLE knowledge.jobs ADD COLUMN metrics jsonb NOT NULL DEFAULT '{}';
CREATE TABLE knowledge.job_attempts (
 id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES knowledge.jobs(id),
 attempt integer NOT NULL CHECK(attempt>0),
 outcome text NOT NULL CHECK(outcome IN ('running','completed','failed','interrupted')),
 metrics jsonb NOT NULL DEFAULT '{}', UNIQUE(job_id,attempt)
);

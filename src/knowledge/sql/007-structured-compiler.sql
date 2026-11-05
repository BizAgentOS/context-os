CREATE TABLE knowledge.analysis_steps (
 job_id uuid NOT NULL REFERENCES knowledge.jobs(id), stage text NOT NULL,
 fingerprint text NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(job_id,stage)
);
ALTER TABLE knowledge.jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE knowledge.jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('discover','extract','plan','build','observe','collect','reuse'));

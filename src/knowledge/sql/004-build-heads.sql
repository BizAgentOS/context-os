CREATE TABLE knowledge.source_build_heads (
 source_id uuid PRIMARY KEY REFERENCES knowledge.sources(id),
 source_version_id uuid NOT NULL REFERENCES knowledge.source_versions(id),
 run_id uuid NOT NULL REFERENCES knowledge.extraction_runs(id),
 build_plan_id uuid REFERENCES knowledge.build_plans(id),
 installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO knowledge.source_build_heads(source_id,source_version_id,run_id,build_plan_id,installed_at)
SELECT DISTINCT ON(v.source_id) v.source_id,v.id,r.id,r.build_plan_id,r.created_at
FROM knowledge.extraction_runs r JOIN knowledge.source_versions v ON v.id=r.source_version_id
JOIN knowledge.sources s ON s.id=v.source_id AND s.active_version=v.id
WHERE r.status='completed' ORDER BY v.source_id,r.created_at DESC,r.id;

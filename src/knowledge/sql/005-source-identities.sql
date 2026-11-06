ALTER TABLE knowledge.approved_plan_outputs ADD COLUMN identity_mappings jsonb NOT NULL DEFAULT '[]';
ALTER TABLE knowledge.identity_bindings ADD COLUMN approval_plan_id uuid REFERENCES knowledge.build_plans(id);

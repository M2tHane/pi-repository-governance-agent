ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_status_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check CHECK (status IN ('running','succeeded','partial','failed','timeout','cancelled'));
ALTER TABLE agent_runs ADD COLUMN usage jsonb NOT NULL DEFAULT '{}';
ALTER TABLE agent_runs ADD COLUMN orchestration jsonb;

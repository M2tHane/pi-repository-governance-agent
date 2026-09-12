ALTER TABLE jobs DROP CONSTRAINT jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (job_type IN ('PR_REVIEW', 'DECISION_EXTRACT', 'REPLY_HANDLE'));

ALTER TABLE repositories ADD COLUMN review_mode text NOT NULL DEFAULT 'auto' CHECK (review_mode IN ('single', 'auto'));
ALTER TABLE repositories ADD COLUMN max_delegates integer NOT NULL DEFAULT 2 CHECK (max_delegates BETWEEN 0 AND 4);

CREATE TABLE review_findings (
  id text PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id),
  repository_id bigint NOT NULL,
  pr_number integer NOT NULL,
  head_sha text NOT NULL,
  fingerprint text NOT NULL UNIQUE,
  category text NOT NULL CHECK (category IN ('correctness','security','architecture','maintainability','team_rule','memory_conflict')),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  evidence_level text NOT NULL CHECK (evidence_level IN ('weak','moderate','strong')),
  path text,
  line integer,
  side text CHECK (side IN ('LEFT','RIGHT')),
  description text NOT NULL,
  evidence text NOT NULL,
  impact text NOT NULL,
  suggestion text,
  memory_id uuid,
  memory_version integer,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','NEEDS_CLARIFICATION','STILL_VALID','FIXED','WITHDRAWN','EXCEPTION_PENDING')),
  github_review_id bigint,
  github_comment_id bigint UNIQUE,
  binding_status text NOT NULL DEFAULT 'pending' CHECK (binding_status IN ('pending','bound','summary','incomplete')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_findings_thread ON review_findings(repository_id,pr_number,github_comment_id);

CREATE TABLE reply_publications (
  source_comment_id bigint PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id),
  finding_id text NOT NULL REFERENCES review_findings(id),
  analysis_head_sha text,
  result jsonb,
  github_reply_comment_id bigint,
  github_reply_url text,
  status text NOT NULL CHECK (status IN ('pending','published','uncertain','failed')),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE decision_clues (
  id uuid PRIMARY KEY,
  repository_id bigint NOT NULL,
  pr_number integer NOT NULL,
  finding_id text NOT NULL REFERENCES review_findings(id),
  source_human_comment_id bigint NOT NULL,
  analysis_head_sha text NOT NULL,
  type text NOT NULL CHECK (type IN ('possible_exception','possible_rule_change','implementation_rationale')),
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(repository_id,source_human_comment_id)
);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id),
  parent_run_id uuid REFERENCES agent_runs(id),
  role text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','succeeded','failed','timeout','cancelled')),
  model text,
  input_budget_tokens integer NOT NULL,
  usage_input_tokens integer,
  usage_output_tokens integer,
  timeout_ms integer NOT NULL,
  coverage jsonb NOT NULL DEFAULT '[]',
  limitations jsonb NOT NULL DEFAULT '[]',
  error_summary text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer
);
CREATE INDEX agent_runs_job ON agent_runs(job_id,started_at);

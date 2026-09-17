-- Note: 新部署的当前 Schema baseline 与旧库迁移边界，见 .agents/notes/implemented/architecture/2026-09-17-migration-baseline.md。
CREATE TABLE repositories (
  id bigint PRIMARY KEY,
  installation_id bigint NOT NULL,
  full_name text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  include_paths text[] NOT NULL DEFAULT '{}',
  exclude_paths text[] NOT NULL DEFAULT '{}',
  output_language text NOT NULL DEFAULT 'zh-CN',
  budget_tokens integer NOT NULL DEFAULT 20000,
  review_mode text NOT NULL DEFAULT 'auto' CHECK (review_mode IN ('single', 'auto')),
  max_delegates integer NOT NULL DEFAULT 2 CHECK (max_delegates BETWEEN 0 AND 4),
  health_schedule text NOT NULL DEFAULT 'off' CHECK (health_schedule IN ('off','daily','weekly')),
  health_next_run_at timestamptz,
  health_last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  delivery_id text PRIMARY KEY,
  event text NOT NULL,
  action text NOT NULL,
  repository_id bigint,
  installation_id bigint NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  delivery_id text REFERENCES webhook_deliveries(delivery_id),
  job_type text NOT NULL CHECK (job_type IN ('PR_REVIEW','DECISION_EXTRACT','REPLY_HANDLE','HEALTH_AUDIT')),
  repository_id bigint NOT NULL,
  installation_id bigint NOT NULL,
  repository text NOT NULL,
  pr_number integer,
  target_sha text NOT NULL,
  base_sha text,
  payload jsonb NOT NULL DEFAULT '{}',
  review_result jsonb,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'timeout', 'superseded', 'cancelled', 'uncertain')),
  attempt integer NOT NULL DEFAULT 0,
  next_run_at timestamptz,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_subject_check CHECK (
    (job_type='HEALTH_AUDIT' AND pr_number IS NULL AND base_sha IS NULL AND delivery_id IS NULL)
    OR (job_type<>'HEALTH_AUDIT' AND pr_number IS NOT NULL AND base_sha IS NOT NULL)
  )
);

CREATE UNIQUE INDEX jobs_automatic_business_key ON jobs (repository_id, pr_number, target_sha, job_type)
WHERE delivery_id IS NOT NULL AND job_type IN ('PR_REVIEW', 'DECISION_EXTRACT');
CREATE INDEX jobs_runnable ON jobs (status, next_run_at, created_at);
CREATE UNIQUE INDEX jobs_active_health ON jobs(repository_id)
WHERE job_type='HEALTH_AUDIT' AND status IN ('queued','running');

CREATE TABLE review_publications (
  job_id uuid PRIMARY KEY REFERENCES jobs(id),
  fingerprint text NOT NULL UNIQUE,
  github_review_id bigint,
  github_review_url text,
  status text NOT NULL CHECK (status IN ('pending', 'published', 'uncertain', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memories (
  id uuid NOT NULL,
  version integer NOT NULL,
  repository_id bigint NOT NULL,
  installation_id bigint NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  rationale text NOT NULL,
  scope jsonb NOT NULL DEFAULT '{}',
  source jsonb NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]',
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  uncertainties jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL CHECK (status IN ('CANDIDATE', 'ACTIVE', 'SUPERSEDED', 'DEPRECATED', 'REJECTED')),
  source_fingerprint text NOT NULL,
  exception_to uuid,
  expires_at timestamptz,
  supersedes uuid,
  superseded_by uuid,
  approved_by bigint,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version),
  UNIQUE (repository_id, source_fingerprint)
);

CREATE TABLE memory_audits (
  id uuid PRIMARY KEY,
  memory_id uuid NOT NULL,
  memory_version integer NOT NULL,
  actor_id bigint NOT NULL,
  actor_login text NOT NULL,
  action text NOT NULL,
  before_value jsonb,
  after_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

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
  presentation jsonb NOT NULL DEFAULT '{}',
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
  status text NOT NULL CHECK (status IN ('running','succeeded','partial','failed','timeout','cancelled')),
  model text,
  input_budget_tokens integer NOT NULL,
  usage_input_tokens integer,
  usage_output_tokens integer,
  usage jsonb NOT NULL DEFAULT '{}',
  orchestration jsonb,
  timeout_ms integer NOT NULL,
  coverage jsonb NOT NULL DEFAULT '[]',
  limitations jsonb NOT NULL DEFAULT '[]',
  error_summary text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer
);
CREATE INDEX agent_runs_job ON agent_runs(job_id,started_at);

CREATE TABLE health_reports (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

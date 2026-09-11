CREATE TABLE repositories (
  id bigint PRIMARY KEY,
  installation_id bigint NOT NULL,
  full_name text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  include_paths text[] NOT NULL DEFAULT '{}',
  exclude_paths text[] NOT NULL DEFAULT '{}',
  output_language text NOT NULL DEFAULT 'zh-CN',
  budget_tokens integer NOT NULL DEFAULT 20000,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  delivery_id text PRIMARY KEY,
  event text NOT NULL,
  action text NOT NULL,
  repository_id bigint NOT NULL,
  installation_id bigint NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  delivery_id text REFERENCES webhook_deliveries(delivery_id),
  job_type text NOT NULL CHECK (job_type IN ('PR_REVIEW', 'DECISION_EXTRACT')),
  repository_id bigint NOT NULL,
  installation_id bigint NOT NULL,
  repository text NOT NULL,
  pr_number integer NOT NULL,
  target_sha text NOT NULL,
  base_sha text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'timeout', 'superseded', 'cancelled', 'uncertain')),
  attempt integer NOT NULL DEFAULT 0,
  next_run_at timestamptz,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX jobs_automatic_business_key ON jobs (repository_id, pr_number, target_sha, job_type) WHERE delivery_id IS NOT NULL;
CREATE INDEX jobs_runnable ON jobs (status, next_run_at, created_at);

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

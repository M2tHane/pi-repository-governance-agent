ALTER TABLE jobs DROP CONSTRAINT jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (job_type IN ('PR_REVIEW','DECISION_EXTRACT','REPLY_HANDLE','HEALTH_AUDIT'));
ALTER TABLE jobs ALTER COLUMN pr_number DROP NOT NULL;
ALTER TABLE jobs ALTER COLUMN base_sha DROP NOT NULL;
ALTER TABLE jobs ADD CONSTRAINT jobs_subject_check CHECK (
  (job_type='HEALTH_AUDIT' AND pr_number IS NULL AND base_sha IS NULL AND delivery_id IS NULL)
  OR (job_type<>'HEALTH_AUDIT' AND pr_number IS NOT NULL AND base_sha IS NOT NULL)
);
CREATE UNIQUE INDEX jobs_active_health ON jobs(repository_id)
WHERE job_type='HEALTH_AUDIT' AND status IN ('queued','running');

ALTER TABLE repositories ADD COLUMN health_schedule text NOT NULL DEFAULT 'off' CHECK (health_schedule IN ('off','daily','weekly'));
ALTER TABLE repositories ADD COLUMN health_next_run_at timestamptz;
ALTER TABLE repositories ADD COLUMN health_last_error text;

CREATE TABLE health_reports (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DROP INDEX jobs_automatic_business_key;
CREATE UNIQUE INDEX jobs_automatic_business_key ON jobs (repository_id, pr_number, target_sha, job_type)
WHERE delivery_id IS NOT NULL AND job_type IN ('PR_REVIEW', 'DECISION_EXTRACT');

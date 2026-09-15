ALTER TABLE review_findings ADD COLUMN IF NOT EXISTS presentation jsonb NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS review_result jsonb;

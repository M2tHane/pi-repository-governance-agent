-- installation 级 delivery 不伪造某个 repository_id。
ALTER TABLE webhook_deliveries ALTER COLUMN repository_id DROP NOT NULL;

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import type { ReviewJob } from "./types.js";
import type { DecisionProposal } from "./types.js";
import { createHash } from "node:crypto";

export interface JobAcceptor {
  accept(input: Omit<ReviewJob, "id" | "status">, meta: { event: string; action: string; merged?: boolean; mergeCommitSha?: string | null }): Promise<{ kind: "accepted" | "duplicate" | "full"; job?: ReviewJob }>;
}

export class Database implements JobAcceptor {
  readonly pool: Pool;

  constructor(url: string) { this.pool = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 3000 }); }

  async close() { await this.pool.end(); }
  async check() { await this.pool.query("SELECT 1"); }

  async migrate(directory = resolve("migrations")) {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(4897032)");
      await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      for (const name of (await readdir(directory)).filter((file) => /^\d+.*\.sql$/.test(file)).sort()) {
        const exists = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
        if (exists.rowCount) continue;
        await client.query("BEGIN");
        try {
          await client.query(await readFile(resolve(directory, name), "utf8"));
          await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(4897032)").catch(() => undefined);
      client.release();
    }
  }

  async accept(input: Omit<ReviewJob, "id" | "status">, meta: { event: string; action: string; merged?: boolean; mergeCommitSha?: string | null }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const delivery = await client.query("INSERT INTO webhook_deliveries(delivery_id,event,action,repository_id,installation_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING delivery_id", [input.deliveryId, meta.event, meta.action, input.repositoryId, input.installationId]);
      if (!delivery.rowCount) {
        const existing = await client.query("SELECT * FROM jobs WHERE delivery_id=$1 ORDER BY created_at DESC LIMIT 1", [input.deliveryId]);
        await client.query("COMMIT");
        return { kind: "duplicate" as const, job: existing.rows[0] ? rowToJob(existing.rows[0]) : undefined };
      }
      await client.query("INSERT INTO repositories(id,installation_id,full_name) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET installation_id=EXCLUDED.installation_id,full_name=EXCLUDED.full_name,updated_at=now()", [input.repositoryId, input.installationId, input.repository]);
      const repository = await client.query("SELECT enabled FROM repositories WHERE id=$1", [input.repositoryId]);
      if (!repository.rows[0]?.enabled) { await client.query("COMMIT"); return { kind: "accepted" as const }; }
      if (meta.action === "closed") {
        await client.query("UPDATE jobs SET status='cancelled',finished_at=now(),updated_at=now() WHERE job_type='PR_REVIEW' AND repository_id=$1 AND pr_number=$2 AND status='queued'", [input.repositoryId, input.prNumber]);
        if (!meta.merged) { await client.query("COMMIT"); return { kind: "accepted" as const }; }
      }
      const jobType = meta.action === "closed" ? "DECISION_EXTRACT" : "PR_REVIEW";
      const targetSha = meta.action === "closed" ? meta.mergeCommitSha : input.headSha;
      if (!targetSha) throw new Error("merged PR 缺少 merge_commit_sha");
      if (jobType === "PR_REVIEW") await client.query("UPDATE jobs SET status='superseded',finished_at=now(),updated_at=now() WHERE job_type='PR_REVIEW' AND repository_id=$1 AND pr_number=$2 AND target_sha<>$3 AND status='queued'", [input.repositoryId, input.prNumber, targetSha]);
      const id = randomUUID();
      const inserted = await client.query("INSERT INTO jobs(id,delivery_id,job_type,repository_id,installation_id,repository,pr_number,target_sha,base_sha,payload,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued') ON CONFLICT DO NOTHING RETURNING *", [id, input.deliveryId, jobType, input.repositoryId, input.installationId, input.repository, input.prNumber, targetSha, input.baseSha, { title: input.title, body: input.body, cloneUrl: input.cloneUrl, originalHeadSha: input.headSha }]);
      const row = inserted.rows[0] ?? (await client.query("SELECT * FROM jobs WHERE repository_id=$1 AND pr_number=$2 AND target_sha=$3 AND job_type=$4 ORDER BY created_at DESC LIMIT 1", [input.repositoryId, input.prNumber, targetSha, jobType])).rows[0];
      await client.query("COMMIT");
      return { kind: inserted.rowCount ? "accepted" as const : "duplicate" as const, job: rowToJob(row) };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async getJob(id: string) {
    const result = await this.pool.query("SELECT * FROM jobs WHERE id=$1", [id]);
    return result.rows[0] ? rowToJob(result.rows[0]) : undefined;
  }

  async recoverRunning() {
    const result = await this.pool.query("UPDATE jobs SET status='queued',next_run_at=now(),last_error='服务重启后恢复',started_at=NULL,updated_at=now() WHERE status='running' RETURNING id");
    return result.rowCount ?? 0;
  }

  async claimNext(): Promise<ReviewJob | undefined> {
    const client = await this.pool.connect();
    try {
      return await transaction(client, async () => {
        const result = await client.query("SELECT * FROM jobs WHERE status='queued' AND (next_run_at IS NULL OR next_run_at<=now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1");
        if (!result.rows[0]) return undefined;
        const updated = await client.query("UPDATE jobs SET status='running',attempt=attempt+1,started_at=now(),updated_at=now() WHERE id=$1 RETURNING *", [result.rows[0].id]);
        return rowToJob(updated.rows[0]);
      });
    } finally { client.release(); }
  }

  async finishJob(job: ReviewJob) {
    const status = job.status === "running" ? "succeeded" : job.status;
    await this.pool.query("UPDATE jobs SET status=$2,last_error=$3,finished_at=now(),updated_at=now() WHERE id=$1", [job.id, status, status === "succeeded" ? null : job.error ?? null]);
  }

  async failJob(job: ReviewJob, error: Error, retry: boolean) {
    const delay = Math.min(3600, (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds ?? 2 ** Math.max(0, (job.attempt ?? 1) - 1));
    const status = job.status === "uncertain" ? "uncertain" : retry && (job.attempt ?? 1) < 3 ? "queued" : job.status === "timeout" ? "timeout" : "failed";
    await this.pool.query("UPDATE jobs SET status=$2,last_error=$3,next_run_at=CASE WHEN $2='queued' THEN now()+($4 || ' seconds')::interval ELSE NULL END,finished_at=CASE WHEN $2='queued' THEN NULL ELSE now() END,updated_at=now() WHERE id=$1", [job.id, status, error.message, delay]);
    job.status = status;
  }

  async beginPublication(job: ReviewJob, fingerprint: string) {
    const result = await this.pool.query("INSERT INTO review_publications(job_id,fingerprint,status) VALUES($1,$2,'pending') ON CONFLICT(fingerprint) DO UPDATE SET updated_at=now() RETURNING *", [job.id, fingerprint]);
    return result.rows[0] as { status: string; github_review_id?: string; github_review_url?: string };
  }

  async finishPublication(job: ReviewJob, status: "published" | "failed" | "uncertain") {
    await this.pool.query("UPDATE review_publications SET status=$2,github_review_id=$3,github_review_url=$4,updated_at=now() WHERE job_id=$1", [job.id, status, job.reviewId ?? null, job.reviewUrl ?? null]);
  }

  async isRepositoryEnabled(repositoryId: number) {
    const result = await this.pool.query("SELECT enabled FROM repositories WHERE id=$1", [repositoryId]);
    return result.rows[0]?.enabled === true;
  }

  async getRepositoryConfig(repositoryId: number) {
    const result = await this.pool.query("SELECT enabled,include_paths,exclude_paths,output_language,budget_tokens FROM repositories WHERE id=$1", [repositoryId]);
    const row = result.rows[0];
    return row ? { enabled: Boolean(row.enabled), includePaths: row.include_paths as string[], excludePaths: row.exclude_paths as string[], outputLanguage: String(row.output_language), budgetTokens: Number(row.budget_tokens) } : undefined;
  }

  async insertCandidates(job: ReviewJob, proposals: DecisionProposal[]) {
    const client = await this.pool.connect();
    try {
      return await transaction(client, async () => {
        const ids: string[] = [];
        for (const proposal of proposals) {
          const fingerprint = createHash("sha256").update(JSON.stringify([job.repositoryId, proposal.source.pullRequestNumber, proposal.source.commitSha, [...proposal.source.commentIds].sort(), proposal.type, proposal.content.trim().toLowerCase()])).digest("hex");
          const id = randomUUID();
          const result = await client.query("INSERT INTO memories(id,version,repository_id,installation_id,type,title,content,rationale,scope,source,evidence,confidence,uncertainties,status,source_fingerprint,exception_to,supersedes) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'CANDIDATE',$13,$14,$15) ON CONFLICT(repository_id,source_fingerprint) DO NOTHING RETURNING id", [id, job.repositoryId, job.installationId, proposal.type, proposal.title, proposal.content, proposal.rationale, proposal.scope, proposal.source, JSON.stringify(proposal.evidence), proposal.confidence, JSON.stringify(proposal.uncertainties), fingerprint, proposal.relation?.exceptionTo ?? null, proposal.relation?.supersedes ?? null]);
          if (result.rows[0]) ids.push(String(result.rows[0].id));
        }
        return ids;
      });
    } finally { client.release(); }
  }
}

function rowToJob(row: Record<string, unknown>): ReviewJob {
  const payload = row.payload as { title?: string; body?: string; cloneUrl?: string };
  return {
    id: String(row.id), deliveryId: String(row.delivery_id), jobType: row.job_type as ReviewJob["jobType"], installationId: Number(row.installation_id), repositoryId: Number(row.repository_id), repository: String(row.repository),
    cloneUrl: payload.cloneUrl ?? `https://github.com/${row.repository}.git`, prNumber: Number(row.pr_number), title: payload.title ?? "", body: payload.body ?? "", baseSha: String(row.base_sha), headSha: String(row.target_sha),
    status: row.status as ReviewJob["status"], error: row.last_error ? String(row.last_error) : undefined, reviewId: row.github_review_id ? Number(row.github_review_id) : undefined, reviewUrl: row.github_review_url ? String(row.github_review_url) : undefined, attempt: Number(row.attempt),
  };
}

export async function transaction<T>(client: PoolClient, run: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try { const value = await run(); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
}

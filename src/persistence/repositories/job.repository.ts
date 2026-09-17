import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AgentJob, ReviewJob } from "../../jobs/types.js";
import { transaction } from "../transaction.js";
import { rowToJob } from "../rows.js";

export interface JobAcceptor {
  accept(input: Omit<ReviewJob, "id" | "status">, meta: { event: string; action: string; merged?: boolean; mergeCommitSha?: string | null }): Promise<{ kind: "accepted" | "duplicate" | "full"; job?: ReviewJob }>;
  acceptReply?(input: import("./reply.repository.js").ReviewReplyInput): Promise<{ kind: "accepted" | "duplicate" | "ignored"; job?: ReviewJob }>;
  cancelReview?(repositoryId: number, prNumber: number): void;
  revokeInstallation?(input: { deliveryId: string; event: string; action: string; installationId: number; repositoryIds?: number[] }): Promise<{ duplicate: boolean }>;
}

export class JobRepository {
  private activeReviews = new Map<string, { job: AgentJob; controller: AbortController }>();
  private stopping = false;
  constructor(readonly pool: Pool) {}
  isStopping() { return this.stopping; }
  async accept(input: Omit<ReviewJob, "id" | "status">, meta: { event: string; action: string; merged?: boolean; mergeCommitSha?: string | null }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const delivery = await client.query("INSERT INTO webhook_deliveries(delivery_id,event,action,repository_id,installation_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING delivery_id", [input.deliveryId, meta.event, meta.action, input.repositoryId, input.installationId]);
      if (!delivery.rowCount) {
        const existing = await client.query("SELECT * FROM jobs WHERE delivery_id=$1 ORDER BY created_at DESC LIMIT 1", [input.deliveryId]);
        await client.query("COMMIT");
        return { kind: "duplicate" as const, job: existing.rows[0] ? rowToJob(existing.rows[0]) as ReviewJob : undefined };
      }
      await client.query("INSERT INTO repositories(id,installation_id,full_name) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET installation_id=EXCLUDED.installation_id,full_name=EXCLUDED.full_name,updated_at=now()", [input.repositoryId, input.installationId, input.repository]);
      const repository = await client.query("SELECT enabled FROM repositories WHERE id=$1", [input.repositoryId]);
      if (!repository.rows[0]?.enabled) { await client.query("COMMIT"); return { kind: "accepted" as const }; }
      if (meta.action === "closed") {
        this.cancelReview(input.repositoryId, input.prNumber);
        await client.query("UPDATE jobs SET status='cancelled',finished_at=now(),updated_at=now() WHERE job_type='PR_REVIEW' AND repository_id=$1 AND pr_number=$2 AND status='queued'", [input.repositoryId, input.prNumber]);
        if (!meta.merged) { await client.query("COMMIT"); return { kind: "accepted" as const }; }
      }
      const jobType = meta.action === "closed" ? "DECISION_EXTRACT" : "PR_REVIEW";
      const targetSha = meta.action === "closed" ? meta.mergeCommitSha : input.headSha;
      if (!targetSha) throw new Error("merged PR 缺少 merge_commit_sha");
      if (jobType === "PR_REVIEW") { this.abortReviews(input.repositoryId, input.prNumber, targetSha); await client.query("UPDATE jobs SET status='superseded',finished_at=now(),updated_at=now() WHERE job_type='PR_REVIEW' AND repository_id=$1 AND pr_number=$2 AND target_sha<>$3 AND status='queued'", [input.repositoryId, input.prNumber, targetSha]); }
      const id = randomUUID();
      const inserted = await client.query("INSERT INTO jobs(id,delivery_id,job_type,repository_id,installation_id,repository,pr_number,target_sha,base_sha,payload,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued') ON CONFLICT DO NOTHING RETURNING *", [id, input.deliveryId, jobType, input.repositoryId, input.installationId, input.repository, input.prNumber, targetSha, input.baseSha, { title: input.title, body: input.body, cloneUrl: input.cloneUrl, originalHeadSha: input.headSha }]);
      const row = inserted.rows[0] ?? (await client.query("SELECT * FROM jobs WHERE repository_id=$1 AND pr_number=$2 AND target_sha=$3 AND job_type=$4 ORDER BY created_at DESC LIMIT 1", [input.repositoryId, input.prNumber, targetSha, jobType])).rows[0];
      await client.query("COMMIT");
      return { kind: inserted.rowCount ? "accepted" as const : "duplicate" as const, job: rowToJob(row) as ReviewJob };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async getJob(id: string) {
    const result = await this.pool.query("SELECT * FROM jobs WHERE id=$1", [id]);
    return result.rows[0] ? rowToJob(result.rows[0]) : undefined;
  }

  registerReviewAbort(job: AgentJob, controller: AbortController) {
    if (this.stopping) controller.abort("cancelled");
    else this.activeReviews.set(job.id, { job, controller });
  }

  unregisterReviewAbort(job: AgentJob) {
    this.activeReviews.delete(job.id);
  }

  private abortReviews(repositoryId: number, prNumber: number, exceptHead?: string, reason = "superseded") {
    for (const { job, controller } of this.activeReviews.values()) if (job.jobType !== "HEALTH_AUDIT" && job.repositoryId === repositoryId && job.prNumber === prNumber && job.headSha !== exceptHead) controller.abort(reason);
  }

  cancelReview(repositoryId: number, prNumber: number) { this.abortReviews(repositoryId, prNumber, undefined, "cancelled"); }

  cancelRepository(repositoryId: number) {
    for (const { job, controller } of this.activeReviews.values()) if (job.repositoryId === repositoryId) controller.abort("cancelled");
  }

  async revokeInstallation(input: { deliveryId: string; event: string; action: string; installationId: number; repositoryIds?: number[] }) {
    const client = await this.pool.connect();
    try {
      const result = await transaction(client, async () => {
        const delivery = await client.query("INSERT INTO webhook_deliveries(delivery_id,event,action,installation_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING delivery_id", [input.deliveryId, input.event, input.action, input.installationId]);
        if (!delivery.rowCount) return { duplicate: true, repositories: [] as number[] };
        const rows = (await client.query("UPDATE repositories SET enabled=false,updated_at=now() WHERE installation_id=$1 AND ($2::bigint[] IS NULL OR id=ANY($2::bigint[])) RETURNING id", [input.installationId, input.repositoryIds ?? null])).rows;
        const repositories = rows.map((row) => Number(row.id));
        await client.query("UPDATE jobs SET status='cancelled',last_error='GitHub App 授权已撤销',finished_at=now(),updated_at=now() WHERE repository_id=ANY($1::bigint[]) AND (status='queued' OR status='running' AND job_type IN ('PR_REVIEW','REPLY_HANDLE','HEALTH_AUDIT'))", [repositories]);
        return { duplicate: false, repositories };
      });
      for (const repositoryId of result.repositories) this.cancelRepository(repositoryId);
      return { duplicate: result.duplicate };
    } finally { client.release(); }
  }

  stopReviews() {
    this.stopping = true;
    for (const { controller } of this.activeReviews.values()) controller.abort("cancelled");
  }

  async recoverRunning() {
    await this.pool.query("UPDATE agent_runs SET status='cancelled',error_summary='服务重启，旧 Session 已结束',finished_at=now() WHERE status='running'");
    const result = await this.pool.query("UPDATE jobs SET status='queued',next_run_at=now(),last_error='服务重启后恢复',started_at=NULL,updated_at=now() WHERE status='running' RETURNING id");
    return result.rowCount ?? 0;
  }

  async claimNext(): Promise<AgentJob | undefined> {
    const client = await this.pool.connect();
    try {
      return await transaction(client, async () => {
        const result = await client.query("SELECT * FROM jobs WHERE status='queued' AND (next_run_at IS NULL OR next_run_at<=now()) ORDER BY (job_type='HEALTH_AUDIT'),COALESCE((payload->>'humanReplyCreatedAt')::timestamptz,created_at),COALESCE((payload->>'sourceCommentId')::bigint,0),created_at FOR UPDATE SKIP LOCKED LIMIT 1");
        if (!result.rows[0]) return undefined;
        const updated = await client.query("UPDATE jobs SET status='running',attempt=attempt+1,started_at=now(),updated_at=now() WHERE id=$1 RETURNING *", [result.rows[0].id]);
        return rowToJob(updated.rows[0]);
      });
    } finally { client.release(); }
  }

  async finishJob(job: AgentJob) {
    if (job.status === "queued") return;
    const status = job.status === "running" ? "succeeded" : job.status;
    await this.pool.query("UPDATE jobs SET status=$2,last_error=$3,finished_at=now(),updated_at=now() WHERE id=$1 AND status NOT IN ('cancelled','superseded')", [job.id, status, status === "succeeded" ? null : job.error ?? null]);
  }

  async failJob(job: AgentJob, error: Error, retry: boolean) {
    const delay = Math.min(3600, (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds ?? 2 ** Math.max(0, (job.attempt ?? 1) - 1));
    const status = job.status === "uncertain" ? "uncertain" : retry && (job.attempt ?? 1) < 3 ? "queued" : job.status === "timeout" ? "timeout" : "failed";
    const updated = await this.pool.query("UPDATE jobs SET status=$2,last_error=$3,next_run_at=CASE WHEN $2='queued' THEN now()+($4 || ' seconds')::interval ELSE NULL END,finished_at=CASE WHEN $2='queued' THEN NULL ELSE now() END,updated_at=now() WHERE id=$1 AND status NOT IN ('cancelled','superseded') RETURNING status", [job.id, status, error.message, delay]);
    job.status = updated.rows[0]?.status ?? (await this.getJob(job.id))?.status ?? status;
  }

}

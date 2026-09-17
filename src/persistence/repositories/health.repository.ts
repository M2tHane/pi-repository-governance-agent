import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { HealthJob } from "../../jobs/types.js";
import type { HealthReport } from "../../health/types.js";
import { addUsage, emptyUsage, type AgentUsage } from "../../review/agent.js";
import { transaction } from "../transaction.js";
import { rowToJob } from "../rows.js";

export class HealthRepository {
  constructor(readonly pool: Pool, private readonly isStopping: () => boolean) {}
  async activeHealthJob(repositoryId: number) {
    const result = await this.pool.query("SELECT * FROM jobs WHERE repository_id=$1 AND job_type='HEALTH_AUDIT' AND status IN ('queued','running') LIMIT 1", [repositoryId]);
    return result.rows[0] ? rowToJob(result.rows[0]) as HealthJob : undefined;
  }

  async enqueueHealth(repositoryId: number, snapshot: { defaultBranch: string; headSha: string }, trigger: HealthJob["trigger"], now = new Date(), scheduledFor?: string) {
    if (!/^[a-f0-9]{40}$/i.test(snapshot.headSha) || !snapshot.defaultBranch || snapshot.defaultBranch.length > 255) throw new Error("健康快照无效");
    const client = await this.pool.connect();
    try {
      return await transaction(client, async () => {
        const repository = (await client.query("SELECT * FROM repositories WHERE id=$1 FOR UPDATE", [repositoryId])).rows[0];
        if (!repository?.enabled || this.isStopping()) return { kind: "ignored" as const };
        if (trigger === "schedule") {
          if (repository.health_schedule === "off" || !scheduledFor || !repository.health_next_run_at || new Date(repository.health_next_run_at).toISOString() !== scheduledFor || new Date(scheduledFor) > now) return { kind: "ignored" as const };
          const next = new Date(now.getTime() + (repository.health_schedule === "daily" ? 1 : 7) * 86400_000);
          await client.query("UPDATE repositories SET health_next_run_at=$2,health_last_error=NULL,updated_at=now() WHERE id=$1", [repositoryId, next]);
        }
        const prior = (await client.query("SELECT * FROM jobs WHERE repository_id=$1 AND job_type='HEALTH_AUDIT' AND status IN ('queued','running') LIMIT 1", [repositoryId])).rows[0];
        if (prior) return { kind: "duplicate" as const, job: rowToJob(prior) as HealthJob };
        const payload = {
          title: "Health: " + snapshot.defaultBranch, defaultBranch: snapshot.defaultBranch, trigger, scheduledFor,
          windowStart: new Date(now.getTime() - 30 * 86400_000).toISOString(), windowEnd: now.toISOString(),
          scope: { includePaths: repository.include_paths, excludePaths: repository.exclude_paths, outputLanguage: repository.output_language, budgetTokens: repository.budget_tokens },
        };
        const row = (await client.query("INSERT INTO jobs(id,job_type,repository_id,installation_id,repository,target_sha,payload,status) VALUES($1,'HEALTH_AUDIT',$2,$3,$4,$5,$6,'queued') RETURNING *", [randomUUID(), repositoryId, repository.installation_id, repository.full_name, snapshot.headSha, payload])).rows[0];
        return { kind: "accepted" as const, job: rowToJob(row) as HealthJob };
      });
    } finally { client.release(); }
  }

  async retryHealth(job: HealthJob) {
    const client = await this.pool.connect();
    try {
      return await transaction(client, async () => {
        const repository = (await client.query("SELECT enabled FROM repositories WHERE id=$1 FOR UPDATE", [job.repositoryId])).rows[0];
        if (!repository?.enabled || this.isStopping()) return { kind: "unavailable" as const };
        const row = (await client.query("SELECT * FROM jobs WHERE id=$1 AND repository_id=$2 AND job_type='HEALTH_AUDIT' FOR UPDATE", [job.id, job.repositoryId])).rows[0];
        if (!row || !["failed", "timeout", "cancelled"].includes(row.status) || (await client.query("SELECT 1 FROM health_reports WHERE job_id=$1", [job.id])).rowCount) return { kind: "unavailable" as const };
        const active = (await client.query("SELECT * FROM jobs WHERE repository_id=$1 AND job_type='HEALTH_AUDIT' AND status IN ('queued','running') LIMIT 1", [job.repositoryId])).rows[0];
        if (active) return { kind: "duplicate" as const, job: rowToJob(active) as HealthJob };
        const spent = (await client.query("SELECT COALESCE(sum(COALESCE((usage->>'totalTokens')::bigint,0)+COALESCE((usage->>'unreportedTokens')::bigint,0)),0) spent FROM agent_runs WHERE job_id=$1 AND role='health_auditor'", [job.id])).rows[0].spent;
        if (Number(spent) >= job.scope.budgetTokens) return { kind: "budget_exhausted" as const };
        const updated = (await client.query("UPDATE jobs SET status='queued',next_run_at=now(),started_at=NULL,finished_at=NULL,last_error=NULL,updated_at=now() WHERE id=$1 RETURNING *", [job.id])).rows[0];
        return { kind: "accepted" as const, job: rowToJob(updated) as HealthJob };
      });
    } finally { client.release(); }
  }

  async healthUsage(jobId: string): Promise<AgentUsage> {
    const rows = (await this.pool.query("SELECT usage FROM agent_runs WHERE job_id=$1 AND role='health_auditor'", [jobId])).rows;
    const usage = emptyUsage();
    for (const row of rows) addUsage(usage, row.usage);
    return usage;
  }

  async getHealthReport(jobId: string): Promise<HealthReport | undefined> {
    return (await this.pool.query("SELECT report FROM health_reports WHERE job_id=$1", [jobId])).rows[0]?.report;
  }

  async finishHealthReport(job: HealthJob, report: HealthReport, signal?: AbortSignal) {
    if (report.jobId !== job.id || report.repositoryId !== job.repositoryId || report.headSha !== job.headSha) throw new Error("健康报告归属无效");
    const client = await this.pool.connect();
    try {
      return await transaction(client, async () => {
        signal?.throwIfAborted();
        const repository = (await client.query("SELECT enabled FROM repositories WHERE id=$1 FOR UPDATE", [job.repositoryId])).rows[0];
        if (!repository?.enabled || this.isStopping()) return false;
        const row = (await client.query("SELECT status FROM jobs WHERE id=$1 FOR UPDATE", [job.id])).rows[0];
        if (!row || !["running", "succeeded", "partial"].includes(row.status)) return false;
        signal?.throwIfAborted();
        const saved = (await client.query("INSERT INTO health_reports(job_id,report) VALUES($1,$2) ON CONFLICT(job_id) DO UPDATE SET job_id=EXCLUDED.job_id RETURNING report", [job.id, report])).rows[0].report as HealthReport;
        await client.query("UPDATE jobs SET status=$2,last_error=NULL,finished_at=now(),updated_at=now() WHERE id=$1", [job.id, saved.status]);
        signal?.throwIfAborted();
        job.status = saved.status;
        return true;
      });
    } finally { client.release(); }
  }

}

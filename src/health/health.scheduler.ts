import type { Config } from "../config/config.js";
import type { Database } from "../persistence/database.js";
import { GitHubApiError, GitHubClient } from "../github/client.js";
import type { HealthJob } from "../jobs/types.js";

export class HealthRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function requestHealthAudit(config: Config, database: Database, github: GitHubClient, repositoryId: number, trigger: HealthJob["trigger"] = "manual", signal: AbortSignal = new AbortController().signal, now = new Date(), scheduledFor?: string) {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(Math.min(config.agentTimeoutMs, 15_000))]);
  bounded.throwIfAborted();
  const repository = (await database.pool.query("SELECT id,installation_id,full_name,enabled FROM repositories WHERE id=$1", [repositoryId])).rows[0];
  if (!repository) throw new HealthRequestError(404, "仓库尚未登记");
  if (!config.allowedRepositories.has(String(repository.full_name).toLowerCase())) throw new HealthRequestError(403, "仓库未授权");
  if (!repository.enabled) throw new HealthRequestError(409, "仓库已暂停");
  const active = await database.activeHealthJob(repositoryId);
  let snapshot: { defaultBranch: string; headSha: string };
  if (active) snapshot = active;
  else {
    try {
      const token = await github.installationToken(Number(repository.installation_id), bounded);
      snapshot = await github.repositorySnapshot(token, String(repository.full_name), repositoryId, bounded);
    } catch (error) {
      if (bounded.aborted) throw new HealthRequestError(504, "读取默认分支快照超时或已取消");
      const unavailable = error instanceof GitHubApiError && [404, 409, 422].includes(error.status);
      throw new HealthRequestError(unavailable ? 422 : 502, unavailable ? "仓库为空、默认分支不存在或 App 无法读取该分支" : "App 认证或默认分支快照读取失败");
    }
  }
  bounded.throwIfAborted();
  const result = await database.enqueueHealth(repositoryId, snapshot, trigger, now, scheduledFor);
  if (trigger === "manual" && result.kind === "ignored") throw new HealthRequestError(409, "仓库状态已变化，未创建健康任务");
  return result;
}

export async function enqueueDueHealthJobs(config: Config, database: Database, github: GitHubClient, signal: AbortSignal, now = new Date()) {
  const rows = (await database.pool.query("SELECT id,full_name,health_schedule,health_next_run_at FROM repositories WHERE enabled AND lower(full_name)=ANY($2::text[]) AND health_schedule<>'off' AND health_next_run_at<=$1 ORDER BY health_next_run_at LIMIT 100", [now, [...config.allowedRepositories]])).rows;
  for (const repository of rows) {
    signal.throwIfAborted();
    if (!config.allowedRepositories.has(String(repository.full_name).toLowerCase())) continue;
    const scheduledFor = new Date(repository.health_next_run_at).toISOString();
    try { await requestHealthAudit(config, database, github, Number(repository.id), "schedule", signal, now, scheduledFor); }
    catch (error) {
      signal.throwIfAborted();
      const next = new Date(now.getTime() + (repository.health_schedule === "daily" ? 1 : 7) * 86400_000);
      const message = error instanceof HealthRequestError ? error.message : "健康定时触发失败，可手动重试";
      await database.pool.query("UPDATE repositories SET health_last_error=$3,health_next_run_at=$4,updated_at=now() WHERE id=$1 AND enabled AND health_schedule<>'off' AND health_next_run_at=$2", [repository.id, scheduledFor, message, next]);
      console.error(JSON.stringify({ event: "health_schedule_failed", repositoryId: Number(repository.id), error: message }));
    }
  }
}

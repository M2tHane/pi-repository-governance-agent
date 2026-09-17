import type { Pool } from "pg";

export class RepositoryRepository {
  constructor(readonly pool: Pool) {}
  async isRepositoryEnabled(repositoryId: number) {
    const result = await this.pool.query("SELECT enabled FROM repositories WHERE id=$1", [repositoryId]);
    return result.rows[0]?.enabled === true;
  }

  async setHealthSchedule(repositoryId: number, schedule: "off" | "daily" | "weekly", now = new Date()) {
    if (!["off", "daily", "weekly"].includes(schedule)) throw new Error("健康调度配置无效");
    const next = new Date(now.getTime() + (schedule === "daily" ? 1 : 7) * 86400_000);
    const result = await this.pool.query("UPDATE repositories SET health_next_run_at=CASE WHEN $2='off' THEN NULL WHEN health_schedule<>$2 OR health_next_run_at IS NULL THEN $3 ELSE health_next_run_at END,health_schedule=$2,health_last_error=NULL,updated_at=now() WHERE id=$1 AND (enabled OR $2='off') RETURNING *", [repositoryId, schedule, next]);
    return result.rows[0];
  }

  async getRepositoryConfig(repositoryId: number) {
    const result = await this.pool.query("SELECT enabled,include_paths,exclude_paths,output_language,budget_tokens,review_mode,max_delegates FROM repositories WHERE id=$1", [repositoryId]);
    const row = result.rows[0];
    return row ? { enabled: Boolean(row.enabled), includePaths: row.include_paths as string[], excludePaths: row.exclude_paths as string[], outputLanguage: String(row.output_language), budgetTokens: Number(row.budget_tokens), reviewMode: String(row.review_mode) as "single" | "auto", maxDelegates: Number(row.max_delegates) } : undefined;
  }

}

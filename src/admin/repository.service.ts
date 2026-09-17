import type { Database } from "../persistence/database.js";
import { GitHubClient } from "../github/client.js";
import { repository, type Repository, type Session } from "./dto.js";

export function createRepositoryService(database: Database, github: GitHubClient) {
  async function allowedRepositories(user: Session) {
    const result = await database.pool.query("SELECT * FROM repositories ORDER BY full_name");
    const values: Repository[] = [];
    // 每次请求重新授权；只在本次聚合读取复用，不缓存权限结论。
    for (let offset = 0; offset < result.rows.length; offset += 4) {
      const batch = result.rows.slice(offset, offset + 4);
      const checks = await Promise.allSettled(batch.map(row => github.hasMaintainerPermission(user.token, String(row.full_name))));
      for (const [index, check] of checks.entries()) {
        if (check.status === "rejected") throw check.reason;
        if (check.value) values.push(repository(batch[index]!));
      }
    }
    return values;
  }

  async function listJobs(ids: number[]) {
    if (!ids.length) return [];
    const result = await database.pool.query("SELECT j.*,(SELECT count(*)::int FROM review_findings f WHERE f.job_id=j.id) finding_count,p.github_review_url,COALESCE((SELECT jsonb_agg(to_jsonb(a) - 'job_id' ORDER BY a.started_at) FROM agent_runs a WHERE a.job_id=j.id),'[]') agent_runs FROM jobs j LEFT JOIN review_publications p ON p.job_id=j.id WHERE j.repository_id=ANY($1::bigint[]) ORDER BY j.created_at DESC LIMIT 200", [ids]);
    return result.rows.map(({review_result,...row})=>({...row,report_available:Boolean(review_result)}));
  }
  return { allowedRepositories, listJobs };
}

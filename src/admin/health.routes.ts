import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config/config.js";
import type { Database } from "../persistence/database.js";
import { GitHubClient } from "../github/client.js";
import { compareHealthReports } from "../health/health.service.js";
import { requestHealthAudit } from "../health/health.scheduler.js";
import type { HealthReport } from "../health/types.js";
import { repository, type Repository, type Session } from "./dto.js";
import { body, json } from "./http.js";

export function isHealthRoute(request: IncomingMessage, url: URL) {
  const healthAction = url.pathname.match(/^\/api\/repositories\/(\d+)\/(health|health-schedule)$/);
  const healthMatch = url.pathname.match(/^\/api\/health\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(retry))?$/i);
  return Boolean(healthAction && (request.method === "POST" && healthAction[2] === "health" || request.method === "PATCH" && healthAction[2] === "health-schedule") || request.method === "GET" && url.pathname === "/api/health" || healthMatch && (request.method === "GET" && !healthMatch[2] || request.method === "POST" && healthMatch[2] === "retry"));
}

export function createHealthRoutes(config: Config, database: Database, github: GitHubClient, authorize: (request: IncomingMessage, response: ServerResponse, repositoryId: number) => Promise<{ user: Session; repository: Repository } | undefined>, allowedRepositories: (user: Session) => Promise<Repository[]>) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL, user: Session) => {
        const healthAction = url.pathname.match(/^\/api\/repositories\/(\d+)\/(health|health-schedule)$/);
        if (healthAction && (request.method === "POST" && healthAction[2] === "health" || request.method === "PATCH" && healthAction[2] === "health-schedule")) {
          if (!Number.isSafeInteger(Number(healthAction[1])) || Number(healthAction[1]) <= 0) return json(response, 422, { error: "仓库标识无效" });
          const access = await authorize(request, response, Number(healthAction[1])); if (!access) return;
          if (!config.allowedRepositories.has(access.repository.fullName.toLowerCase())) return json(response, 403, { error: "仓库未授权" });
          const value = await body(request);
          if (!value || typeof value !== "object" || Array.isArray(value)) return json(response, 422, { error: "健康检查参数无效" });
          if (healthAction[2] === "health-schedule") {
            const schedule = (value as { schedule?: string }).schedule;
            if (Object.keys(value).some((key) => key !== "schedule") || !["off", "daily", "weekly"].includes(schedule ?? "")) return json(response, 422, { error: "只支持关闭、每日或每周" });
            const updated = await database.setHealthSchedule(access.repository.id, schedule as Repository["healthSchedule"]);
            return updated ? json(response, 200, repository(updated)) : json(response, 409, { error: "仓库已暂停，无法启用定时检查" });
          }
          if (Object.keys(value).length) return json(response, 422, { error: "健康检查使用服务解析的默认分支，不接受自选 SHA 或窗口" });
          return json(response, 202, await requestHealthAudit(config, database, github, access.repository.id));
        }
        if (request.method === "GET" && url.pathname === "/api/health") {
          const requested = url.searchParams.get("repositoryId");
          const page = Number(url.searchParams.get("page") ?? 0);
          if (!Number.isSafeInteger(page) || page < 0 || page > 10000 || requested !== null && (!/^\d+$/.test(requested) || !Number.isSafeInteger(Number(requested)))) return json(response, 422, { error: "分页或仓库参数无效" });
          let ids: number[];
          if (requested !== null) {
            const access = await authorize(request, response, Number(requested)); if (!access) return;
            if (!config.allowedRepositories.has(access.repository.fullName.toLowerCase())) return json(response, 403, { error: "仓库未授权" });
            ids = [access.repository.id];
          } else ids = (await allowedRepositories(user)).filter((item) => config.allowedRepositories.has(item.fullName.toLowerCase())).map((item) => item.id);
          const result = await database.pool.query("SELECT j.*,(h.job_id IS NOT NULL) has_report,h.report->'result'->>'summary' health_summary,COALESCE(jsonb_array_length(h.report->'result'->'findings'),0) finding_count FROM jobs j LEFT JOIN health_reports h ON h.job_id=j.id WHERE j.job_type='HEALTH_AUDIT' AND j.repository_id=ANY($1::bigint[]) ORDER BY j.created_at DESC,j.id DESC LIMIT 51 OFFSET $2", [ids, page * 50]);
          return json(response, 200, { items: result.rows.slice(0, 50), nextPage: result.rows.length > 50 ? page + 1 : null });
        }
        const healthMatch = url.pathname.match(/^\/api\/health\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(retry))?$/i);
        if (healthMatch && (request.method === "GET" && !healthMatch[2] || request.method === "POST" && healthMatch[2] === "retry")) {
          const found = (await database.pool.query("SELECT * FROM jobs WHERE id=$1 AND job_type='HEALTH_AUDIT'", [healthMatch[1]])).rows[0];
          if (!found) return json(response, 404, { error: "健康任务不存在" });
          const access = await authorize(request, response, Number(found.repository_id)); if (!access) return;
          if (!config.allowedRepositories.has(access.repository.fullName.toLowerCase())) return json(response, 403, { error: "仓库未授权" });
          if (healthMatch[2] === "retry") {
            const value = await body(request);
            if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) return json(response, 422, { error: "重试沿用原快照与预算，不接受覆盖参数" });
            const job = await database.getJob(healthMatch[1]!);
            if (!job || job.jobType !== "HEALTH_AUDIT") return json(response, 404, { error: "健康任务不存在" });
            const result = await database.retryHealth(job);
            if (result.kind === "budget_exhausted") return json(response, 409, { error: "本任务累计 Token 预算已耗尽；需要时可发起新的检查" });
            return result.kind === "unavailable" ? json(response, 409, { error: "任务已有报告、仍在执行或仓库已暂停，不能重试" }) : json(response, 202, result);
          }
          const report = await database.getHealthReport(healthMatch[1]!);
          let previous: HealthReport | undefined;
          if (report) {
            const rows = (await database.pool.query("SELECT h.report FROM health_reports h JOIN jobs j ON j.id=h.job_id WHERE j.repository_id=$1 AND h.job_id<>$2 AND h.created_at<=(SELECT created_at FROM health_reports WHERE job_id=$2) ORDER BY (h.report->>'comparisonKey'=$3) DESC,h.created_at DESC LIMIT 20", [found.repository_id, healthMatch[1], report.comparisonKey])).rows;
            const candidates = rows.map((row) => row.report as HealthReport);
            previous = candidates.find((candidate) => compareHealthReports(report, candidate).dimensions.some((dimension) => dimension.comparable)) ?? candidates[0];
          }
          return json(response, 200, { job: found, report: report ?? null, usage: await database.healthUsage(healthMatch[1]!), previous: previous ? { jobId: previous.jobId, headSha: previous.headSha, completedAt: previous.completedAt } : null, comparison: report ? compareHealthReports(report, previous) : null });
        }
  };
}

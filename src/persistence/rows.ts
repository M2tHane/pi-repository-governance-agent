import type { AgentJob, HealthJob, ReviewJob } from "../jobs/types.js";
import type { StoredFinding } from "../review/types.js";

export function rowToJob(row: Record<string, unknown>): AgentJob {
  const payload = row.payload as Record<string, any>;
  if (row.job_type === "HEALTH_AUDIT") return {
    id: String(row.id), jobType: "HEALTH_AUDIT", installationId: Number(row.installation_id), repositoryId: Number(row.repository_id), repository: String(row.repository),
    cloneUrl: `https://github.com/${row.repository}.git`, title: payload.title, headSha: String(row.target_sha), status: row.status as HealthJob["status"],
    error: row.last_error ? String(row.last_error) : undefined, attempt: Number(row.attempt), defaultBranch: payload.defaultBranch,
    windowStart: payload.windowStart, windowEnd: payload.windowEnd, trigger: payload.trigger, scheduledFor: payload.scheduledFor, scope: payload.scope,
  };
  return {
    id: String(row.id), deliveryId: String(row.delivery_id), jobType: row.job_type as ReviewJob["jobType"], installationId: Number(row.installation_id), repositoryId: Number(row.repository_id), repository: String(row.repository),
    cloneUrl: payload.cloneUrl ?? `https://github.com/${row.repository}.git`, prNumber: Number(row.pr_number), title: payload.title ?? "", body: payload.body ?? "", baseSha: String(row.base_sha), headSha: String(row.target_sha),
    status: row.status as ReviewJob["status"], error: row.last_error ? String(row.last_error) : undefined, reviewId: row.github_review_id ? Number(row.github_review_id) : undefined, reviewUrl: row.github_review_url ? String(row.github_review_url) : undefined, attempt: Number(row.attempt), findingId: payload.findingId, rootCommentId: payload.rootCommentId, sourceCommentId: payload.sourceCommentId, sourceCommentUrl: payload.sourceCommentUrl, humanActorId: payload.humanActorId, humanActorLogin: payload.humanActorLogin, humanReplyBody: payload.humanReplyBody, humanReplyCreatedAt: payload.humanReplyCreatedAt,
  };
}

export function rowToFinding(row: Record<string, any>): StoredFinding {
  return { ...row.presentation, id: String(row.id), jobId: String(row.job_id), repositoryId: Number(row.repository_id), prNumber: Number(row.pr_number), headSha: String(row.head_sha), fingerprint: String(row.fingerprint), category: row.category, severity: row.severity, evidenceLevel: row.evidence_level, path: row.path ?? undefined, line: row.line ? Number(row.line) : undefined, side: row.side ?? undefined, description: row.description, evidence: row.evidence, impact: row.impact, suggestion: row.suggestion ?? undefined, memory: row.memory_id ? { ...row.presentation?.memory, id: String(row.memory_id), version: Number(row.memory_version), source: row.presentation?.memory?.source ?? {} } : undefined, status: row.status, githubReviewId: row.github_review_id ? Number(row.github_review_id) : undefined, githubCommentId: row.github_comment_id ? Number(row.github_comment_id) : undefined, bindingStatus: row.binding_status };
}

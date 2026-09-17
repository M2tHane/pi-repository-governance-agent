import type { HealthScope } from "../health/types.js";

export interface ReviewJob {
  id: string;
  deliveryId: string;
  jobType?: "PR_REVIEW" | "DECISION_EXTRACT" | "REPLY_HANDLE";
  installationId: number;
  repositoryId: number;
  repository: string;
  cloneUrl: string;
  prNumber: number;
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  status: "queued" | "running" | "succeeded" | "partial" | "failed" | "timeout" | "superseded" | "cancelled" | "uncertain";
  error?: string;
  reviewId?: number;
  reviewUrl?: string;
  attempt?: number;
  findingId?: string;
  rootCommentId?: number;
  sourceCommentId?: number;
  sourceCommentUrl?: string;
  humanActorId?: number;
  humanActorLogin?: string;
  humanReplyBody?: string;
  humanReplyCreatedAt?: string;
}

export interface HealthJob extends Pick<ReviewJob, "id" | "installationId" | "repositoryId" | "repository" | "cloneUrl" | "title" | "headSha" | "status" | "error" | "attempt"> {
  jobType: "HEALTH_AUDIT";
  defaultBranch: string;
  windowStart: string;
  windowEnd: string;
  trigger: "manual" | "schedule";
  scheduledFor?: string;
  scope: HealthScope;
}

export type AgentJob = ReviewJob | HealthJob;

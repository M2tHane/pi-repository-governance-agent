import type { AgentJob, HealthJob, ReviewJob } from "./types.js";

export interface JobProcessors {
  PR_REVIEW: (job: ReviewJob) => Promise<void>;
  DECISION_EXTRACT: (job: ReviewJob) => Promise<void>;
  REPLY_HANDLE: (job: ReviewJob) => Promise<void>;
  HEALTH_AUDIT: (job: HealthJob) => Promise<void>;
}

export function createJobDispatcher(processors: JobProcessors) {
  const dispatch: Record<string, (job: AgentJob) => Promise<void>> = {
    PR_REVIEW: (job) => processors.PR_REVIEW(job as ReviewJob),
    DECISION_EXTRACT: (job) => processors.DECISION_EXTRACT(job as ReviewJob),
    REPLY_HANDLE: (job) => processors.REPLY_HANDLE(job as ReviewJob),
    HEALTH_AUDIT: (job) => processors.HEALTH_AUDIT(job as HealthJob),
  };
  return (job: AgentJob): Promise<void> => {
    const processor = dispatch[job.jobType ?? ""];
    if (!processor) throw new Error(`Unknown job type: ${job.jobType ?? "undefined"}`);
    return processor(job);
  };
}

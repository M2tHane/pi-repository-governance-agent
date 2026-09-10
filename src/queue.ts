import { randomUUID } from "node:crypto";
import type { ReviewJob } from "./types.js";

export class JobQueue {
  readonly jobs = new Map<string, ReviewJob>();
  private pending: ReviewJob[] = [];
  private deliveries = new Map<string, string>();
  private succeeded = new Set<string>();
  private running = false;

  constructor(private capacity: number, private execute: (job: ReviewJob) => Promise<void>) {}

  enqueue(input: Omit<ReviewJob, "id" | "status">): { kind: "accepted" | "duplicate" | "full"; job?: ReviewJob } {
    const prior = this.deliveries.get(input.deliveryId);
    if (prior && this.jobs.get(prior)?.status !== "failed" && this.jobs.get(prior)?.status !== "timeout") return { kind: "duplicate", job: this.jobs.get(prior) };
    const key = `${input.repositoryId}:${input.prNumber}:${input.headSha}`;
    if (this.succeeded.has(key)) return { kind: "duplicate" };
    if (this.pending.length + Number(this.running) >= this.capacity) return { kind: "full" };
    for (const job of this.pending) if (job.repositoryId === input.repositoryId && job.prNumber === input.prNumber && job.headSha !== input.headSha) job.status = "superseded";
    this.pending = this.pending.filter((job) => job.status !== "superseded");
    const job: ReviewJob = { ...input, id: randomUUID(), status: "queued" };
    this.jobs.set(job.id, job);
    this.deliveries.set(job.deliveryId, job.id);
    this.trim();
    this.pending.push(job);
    queueMicrotask(() => void this.drain());
    return { kind: "accepted", job };
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (let job; (job = this.pending.shift());) {
        if (job.status === "superseded") continue;
        job.status = "running";
        try {
          await this.execute(job);
          if (job.status === "running") {
            job.status = "succeeded";
            this.succeeded.add(`${job.repositoryId}:${job.prNumber}:${job.headSha}`);
          }
        } catch (error) {
          if (job.status === "running") job.status = "failed";
          job.error = error instanceof Error ? error.message : "未知错误";
          console.error(JSON.stringify({ event: "job_failed", jobId: job.id, deliveryId: job.deliveryId, repositoryId: job.repositoryId, prNumber: job.prNumber, headSha: job.headSha, status: job.status, error: job.error }));
        }
      }
    } finally { this.running = false; }
  }

  private trim() {
    while (this.deliveries.size >= this.capacity * 10) {
      const delivery = this.deliveries.keys().next().value;
      if (delivery === undefined) break;
      this.deliveries.delete(delivery);
    }
    while (this.jobs.size >= this.capacity * 10) {
      const id = this.jobs.keys().next().value;
      if (id === undefined) break;
      this.jobs.delete(id);
    }
  }
}

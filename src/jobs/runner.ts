import type { Database } from "../persistence/database.js";
import type { AgentJob } from "./types.js";

export class PersistentRunner {
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(private database: Database, private execute: (job: AgentJob) => Promise<void>, private pollMs = 500) {}

  async start() {
    const recovered = await this.database.recoverRunning();
    if (recovered) console.info(JSON.stringify({ event: "jobs_recovered", count: recovered }));
    this.running = this.tick();
  }

  async stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.database.stopReviews(); await this.running; }

  private async tick() {
    if (this.stopped) return;
    try {
      const job = await this.database.claimNext();
      if (job) {
        try { await this.execute(job); await this.database.finishJob(job); }
        catch (error) {
          const failure = error instanceof Error ? error : new Error("未知错误");
          await this.database.failJob(job, failure, transient(failure));
          console.error(JSON.stringify({ event: "job_failed", jobId: job.id, deliveryId: "deliveryId" in job ? job.deliveryId : undefined, repositoryId: job.repositoryId, prNumber: "prNumber" in job ? job.prNumber : undefined, headSha: job.headSha, status: job.status, error: failure.message }));
        }
      }
    } catch (error) { console.error(JSON.stringify({ event: "runner_error", error: error instanceof Error ? error.message : "未知错误" })); }
    finally { if (!this.stopped) this.timer = setTimeout(() => { this.running = this.tick(); }, this.pollMs); }
  }
}

export function transient(error: Error) {
  return /\b429\b|\b5\d\d\b|fetch failed|network|ECONN|ETIMEDOUT|超时/i.test(error.message);
}

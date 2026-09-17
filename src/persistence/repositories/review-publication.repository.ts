import type { Pool } from "pg";
import type { ReviewJob } from "../../jobs/types.js";
import type { ReviewResult } from "../../review/types.js";

export class ReviewPublicationRepository {
  constructor(readonly pool: Pool) {}
  async beginPublication(job: ReviewJob, fingerprint: string) {
    const result = await this.pool.query("INSERT INTO review_publications(job_id,fingerprint,status) VALUES($1,$2,'pending') ON CONFLICT(fingerprint) DO UPDATE SET updated_at=now() RETURNING *", [job.id, fingerprint]);
    return result.rows[0] as { status: string; github_review_id?: string; github_review_url?: string };
  }

  async finishPublication(job: ReviewJob, status: "published" | "failed" | "uncertain") {
    await this.pool.query("UPDATE review_publications SET status=$2,github_review_id=$3,github_review_url=$4,updated_at=now() WHERE job_id=$1", [job.id, status, job.reviewId ?? null, job.reviewUrl ?? null]);
  }

  async saveReviewResult(job: ReviewJob, result: ReviewResult) {
    await this.pool.query("UPDATE jobs SET review_result=$2 WHERE id=$1", [job.id, JSON.stringify(result)]);
  }

}

import type { Pool } from "pg";
import type { Finding, StoredFinding } from "../../review/types.js";
import type { ReviewJob } from "../../jobs/types.js";
import { findingIdentity } from "../../review/finding.js";
import { rowToFinding } from "../rows.js";

export class FindingRepository {
  constructor(readonly pool: Pool) {}
  async saveFindings(job: ReviewJob, findings: Finding[], inline: Set<Finding>) {
    const values: StoredFinding[] = [];
    const occurrences = new Map<string, number>(), seen = new Map<string, StoredFinding>();
    for (const finding of findings) {
      const locationKey = findingIdentity(job, finding).fingerprint;
      const signature = JSON.stringify([locationKey, finding.description.trim(), finding.evidence.trim(), finding.impact.trim(), finding.suggestion ?? ""]);
      const repeated = seen.get(signature);
      if (repeated) { values.push(repeated); continue; }
      // ponytail: 同位置问题按本次结果顺序区分；需要跨重排重试保留语义身份时再缓存完整校验结果。
      const occurrence = occurrences.get(locationKey) ?? 0;
      occurrences.set(locationKey, occurrence + 1);
      const identity = findingIdentity(job, finding, occurrence);
      const result = await this.pool.query("INSERT INTO review_findings(id,job_id,repository_id,pr_number,head_sha,fingerprint,category,severity,evidence_level,path,line,side,description,evidence,impact,suggestion,memory_id,memory_version,binding_status,presentation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT(fingerprint) DO UPDATE SET updated_at=now() RETURNING *", [identity.id, job.id, job.repositoryId, job.prNumber, job.headSha, identity.fingerprint, finding.category, finding.severity, finding.evidenceLevel, finding.path ?? null, finding.line ?? null, finding.side ?? null, finding.description, finding.evidence, finding.impact, finding.suggestion ?? null, finding.memory?.id ?? null, finding.memory?.version ?? null, inline.has(finding) ? "pending" : "summary", JSON.stringify({display:finding.display,relatedLocations:finding.relatedLocations,mergedCount:finding.mergedCount,memory:finding.memory,candidates:finding.candidates})]);
      const stored = rowToFinding(result.rows[0]);
      values.push(stored); seen.set(signature, stored);
    }
    return values;
  }

  async bindFindings(job: ReviewJob, reviewId: number, comments: Array<{ id: number; body: string }>) {
    const bound = new Set<string>();
    for (const comment of comments) {
      const id = comment.body.match(/<!-- pi-finding:([a-z0-9_-]+) -->\s*$/)?.[1];
      if (!id) continue;
      const result = await this.pool.query("UPDATE review_findings SET github_review_id=$2,github_comment_id=$3,binding_status='bound',updated_at=now() WHERE id=$1 AND job_id=$4 RETURNING id", [id, reviewId, comment.id, job.id]);
      if (result.rowCount) bound.add(id);
    }
    await this.pool.query("UPDATE review_findings SET github_review_id=$2,binding_status='incomplete',updated_at=now() WHERE job_id=$1 AND binding_status='pending' AND NOT(id=ANY($3::text[]))", [job.id, reviewId, [...bound]]);
    await this.pool.query("UPDATE review_findings SET github_review_id=$2,updated_at=now() WHERE job_id=$1 AND binding_status='summary'", [job.id, reviewId]);
    return bound.size;
  }

  async getFinding(id: string) {
    const result = await this.pool.query("SELECT * FROM review_findings WHERE id=$1", [id]);
    return result.rows[0] ? rowToFinding(result.rows[0]) : undefined;
  }

  async getFindingByRoot(repositoryId: number, prNumber: number, rootCommentId: number) {
    const result = await this.pool.query("SELECT * FROM review_findings WHERE repository_id=$1 AND pr_number=$2 AND github_comment_id=$3", [repositoryId, prNumber, rootCommentId]);
    return result.rows[0] ? rowToFinding(result.rows[0]) : undefined;
  }

}

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ReplyResult } from "../../reply/types.js";
import type { ReviewJob } from "../../jobs/types.js";
import { transaction } from "../transaction.js";
import { rowToJob } from "../rows.js";
import type { FindingRepository } from "./finding.repository.js";

export interface ReviewReplyInput {
  deliveryId: string; installationId: number; repositoryId: number; repository: string; prNumber: number; baseSha: string; eventHeadSha: string;
  rootCommentId: number; sourceCommentId: number; sourceCommentUrl: string; humanActorId: number; humanActorLogin: string; humanReplyBody: string; humanReplyCreatedAt?: string;
}

export class ReplyRepository {
  constructor(readonly pool: Pool, private readonly findings: FindingRepository) {}
  async acceptReply(input: ReviewReplyInput) {
    const finding = await this.findings.getFindingByRoot(input.repositoryId, input.prNumber, input.rootCommentId);
    if (!finding || finding.status === "FIXED" || finding.status === "WITHDRAWN") return { kind: "ignored" as const };
    const humanReplyCreatedAt = input.humanReplyCreatedAt ?? new Date().toISOString();
    if (await this.isOlderReply(finding.id, input.sourceCommentId, humanReplyCreatedAt)) return { kind: "ignored" as const };
    const client = await this.pool.connect();
    try {
      return await transaction(client, async () => {
        const delivery = await client.query("INSERT INTO webhook_deliveries(delivery_id,event,action,repository_id,installation_id) VALUES($1,'pull_request_review_comment','created',$2,$3) ON CONFLICT DO NOTHING RETURNING delivery_id", [input.deliveryId, input.repositoryId, input.installationId]);
        if (!delivery.rowCount) {
          const existing = await client.query("SELECT * FROM jobs WHERE delivery_id=$1 LIMIT 1", [input.deliveryId]);
          return { kind: "duplicate" as const, job: existing.rows[0] ? rowToJob(existing.rows[0]) as ReviewJob : undefined };
        }
        const repository = await client.query("SELECT enabled FROM repositories WHERE id=$1 AND installation_id=$2", [input.repositoryId, input.installationId]);
        if (!repository.rows[0]?.enabled) return { kind: "ignored" as const };
        const prior = await client.query("SELECT job_id FROM reply_publications WHERE source_comment_id=$1", [input.sourceCommentId]);
        if (prior.rows[0]) {
          const existing = await client.query("SELECT * FROM jobs WHERE id=$1", [prior.rows[0].job_id]);
          return { kind: "duplicate" as const, job: existing.rows[0] ? rowToJob(existing.rows[0]) as ReviewJob : undefined };
        }
        const id = randomUUID();
        const payload = { findingId: finding.id, rootCommentId: input.rootCommentId, sourceCommentId: input.sourceCommentId, sourceCommentUrl: input.sourceCommentUrl, humanActorId: input.humanActorId, humanActorLogin: input.humanActorLogin, humanReplyBody: input.humanReplyBody, humanReplyCreatedAt, cloneUrl: `https://github.com/${input.repository}.git` };
        const inserted = await client.query("INSERT INTO jobs(id,delivery_id,job_type,repository_id,installation_id,repository,pr_number,target_sha,base_sha,payload,status) VALUES($1,$2,'REPLY_HANDLE',$3,$4,$5,$6,$7,$8,$9,'queued') RETURNING *", [id, input.deliveryId, input.repositoryId, input.installationId, input.repository, input.prNumber, input.eventHeadSha, input.baseSha, payload]);
        await client.query("INSERT INTO reply_publications(source_comment_id,job_id,finding_id,status) VALUES($1,$2,$3,'pending')", [input.sourceCommentId, id, finding.id]);
        return { kind: "accepted" as const, job: rowToJob(inserted.rows[0]) as ReviewJob };
      });
    } finally { client.release(); }
  }

  async retargetReply(job: ReviewJob, baseSha: string, headSha: string) {
    await this.pool.query("UPDATE jobs SET base_sha=$2,target_sha=$3,updated_at=now() WHERE id=$1 AND job_type='REPLY_HANDLE'", [job.id, baseSha, headSha]);
    job.baseSha = baseSha; job.headSha = headSha;
  }

  async isOlderReply(findingId: string, sourceCommentId: number, createdAt: string) {
    const result = await this.pool.query("SELECT 1 FROM reply_publications r JOIN jobs j ON j.id=r.job_id WHERE r.finding_id=$1 AND r.status='published' AND (COALESCE((j.payload->>'humanReplyCreatedAt')::timestamptz,r.created_at),r.source_comment_id)>($2::timestamptz,$3::bigint) LIMIT 1", [findingId, createdAt, sourceCommentId]);
    return Boolean(result.rowCount);
  }

  async requeueReply(job: ReviewJob, baseSha: string, headSha: string) {
    await this.pool.query("UPDATE jobs SET status='queued',base_sha=$2,target_sha=$3,next_run_at=now(),started_at=NULL,finished_at=NULL,last_error='PR head changed during reply analysis',updated_at=now() WHERE id=$1 AND job_type='REPLY_HANDLE'", [job.id, baseSha, headSha]);
    job.status = "queued"; job.baseSha = baseSha; job.headSha = headSha;
  }

  async getReplyPublication(sourceCommentId: number) {
    const result = await this.pool.query("SELECT * FROM reply_publications WHERE source_comment_id=$1", [sourceCommentId]);
    return result.rows[0] as { status: string; github_reply_comment_id?: string; github_reply_url?: string; result?: ReplyResult } | undefined;
  }

  async finishReply(job: ReviewJob, result: ReplyResult, published: { id: number; html_url: string }) {
    const client = await this.pool.connect();
    try {
      await transaction(client, async () => {
        await client.query("UPDATE reply_publications SET analysis_head_sha=$2,result=$3,github_reply_comment_id=$4,github_reply_url=$5,status='published',published_at=now(),updated_at=now() WHERE job_id=$1", [job.id, result.analysisHeadSha, result, published.id, published.html_url]);
        await client.query("UPDATE review_findings SET status=$2,updated_at=now() WHERE id=$1", [result.findingId, result.suggestedFindingStatus]);
        if (result.decisionClue) await client.query("INSERT INTO decision_clues(id,repository_id,pr_number,finding_id,source_human_comment_id,analysis_head_sha,type,summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(repository_id,source_human_comment_id) DO NOTHING", [randomUUID(), job.repositoryId, job.prNumber, result.findingId, job.sourceCommentId, result.analysisHeadSha, result.decisionClue.type, result.decisionClue.summary]);
      });
    } finally { client.release(); }
  }

  async markReplyPublication(job: ReviewJob, status: "failed" | "uncertain", result?: ReplyResult) {
    await this.pool.query("UPDATE reply_publications SET analysis_head_sha=$2,result=$3,status=$4,updated_at=now() WHERE job_id=$1", [job.id, result?.analysisHeadSha ?? null, result ?? null, status]);
  }

  async getDecisionClues(repositoryId: number, prNumber: number) {
    const result = await this.pool.query("SELECT type,summary,finding_id,source_human_comment_id,analysis_head_sha FROM decision_clues WHERE repository_id=$1 AND pr_number=$2 ORDER BY created_at", [repositoryId, prNumber]);
    return result.rows;
  }

}

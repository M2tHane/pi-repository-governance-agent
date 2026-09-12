import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import type { Finding, ReplyResult, ReviewJob, StoredFinding } from "./types.js";
import type { DecisionProposal } from "./types.js";
import { createHash } from "node:crypto";
import { findingIdentity } from "./finding.js";

export interface JobAcceptor {
  accept(input: Omit<ReviewJob, "id" | "status">, meta: { event: string; action: string; merged?: boolean; mergeCommitSha?: string | null }): Promise<{ kind: "accepted" | "duplicate" | "full"; job?: ReviewJob }>;
  acceptReply?(input: ReviewReplyInput): Promise<{ kind: "accepted" | "duplicate" | "ignored"; job?: ReviewJob }>;
  cancelReview?(repositoryId: number, prNumber: number): void;
}

export interface ReviewReplyInput {
  deliveryId: string; installationId: number; repositoryId: number; repository: string; prNumber: number; baseSha: string; eventHeadSha: string;
  rootCommentId: number; sourceCommentId: number; sourceCommentUrl: string; humanActorId: number; humanActorLogin: string; humanReplyBody: string; humanReplyCreatedAt?: string;
}

export class Database implements JobAcceptor {
  readonly pool: Pool;
  private activeReviews = new Map<string, { job: ReviewJob; controller: AbortController }>();
  private stopping = false;

  constructor(url: string) { this.pool = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 3000 }); }

  async close() { await this.pool.end(); }
  async check() { await this.pool.query("SELECT 1"); }

  async migrate(directory = resolve("migrations")) {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(4897032)");
      await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      for (const name of (await readdir(directory)).filter((file) => /^\d+.*\.sql$/.test(file)).sort()) {
        const exists = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
        if (exists.rowCount) continue;
        await client.query("BEGIN");
        try {
          await client.query(await readFile(resolve(directory, name), "utf8"));
          await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(4897032)").catch(() => undefined);
      client.release();
    }
  }

  async accept(input: Omit<ReviewJob, "id" | "status">, meta: { event: string; action: string; merged?: boolean; mergeCommitSha?: string | null }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const delivery = await client.query("INSERT INTO webhook_deliveries(delivery_id,event,action,repository_id,installation_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING delivery_id", [input.deliveryId, meta.event, meta.action, input.repositoryId, input.installationId]);
      if (!delivery.rowCount) {
        const existing = await client.query("SELECT * FROM jobs WHERE delivery_id=$1 ORDER BY created_at DESC LIMIT 1", [input.deliveryId]);
        await client.query("COMMIT");
        return { kind: "duplicate" as const, job: existing.rows[0] ? rowToJob(existing.rows[0]) : undefined };
      }
      await client.query("INSERT INTO repositories(id,installation_id,full_name) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET installation_id=EXCLUDED.installation_id,full_name=EXCLUDED.full_name,updated_at=now()", [input.repositoryId, input.installationId, input.repository]);
      const repository = await client.query("SELECT enabled FROM repositories WHERE id=$1", [input.repositoryId]);
      if (!repository.rows[0]?.enabled) { await client.query("COMMIT"); return { kind: "accepted" as const }; }
      if (meta.action === "closed") {
        this.cancelReview(input.repositoryId, input.prNumber);
        await client.query("UPDATE jobs SET status='cancelled',finished_at=now(),updated_at=now() WHERE job_type='PR_REVIEW' AND repository_id=$1 AND pr_number=$2 AND status='queued'", [input.repositoryId, input.prNumber]);
        if (!meta.merged) { await client.query("COMMIT"); return { kind: "accepted" as const }; }
      }
      const jobType = meta.action === "closed" ? "DECISION_EXTRACT" : "PR_REVIEW";
      const targetSha = meta.action === "closed" ? meta.mergeCommitSha : input.headSha;
      if (!targetSha) throw new Error("merged PR 缺少 merge_commit_sha");
      if (jobType === "PR_REVIEW") { this.abortReviews(input.repositoryId, input.prNumber, targetSha); await client.query("UPDATE jobs SET status='superseded',finished_at=now(),updated_at=now() WHERE job_type='PR_REVIEW' AND repository_id=$1 AND pr_number=$2 AND target_sha<>$3 AND status='queued'", [input.repositoryId, input.prNumber, targetSha]); }
      const id = randomUUID();
      const inserted = await client.query("INSERT INTO jobs(id,delivery_id,job_type,repository_id,installation_id,repository,pr_number,target_sha,base_sha,payload,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued') ON CONFLICT DO NOTHING RETURNING *", [id, input.deliveryId, jobType, input.repositoryId, input.installationId, input.repository, input.prNumber, targetSha, input.baseSha, { title: input.title, body: input.body, cloneUrl: input.cloneUrl, originalHeadSha: input.headSha }]);
      const row = inserted.rows[0] ?? (await client.query("SELECT * FROM jobs WHERE repository_id=$1 AND pr_number=$2 AND target_sha=$3 AND job_type=$4 ORDER BY created_at DESC LIMIT 1", [input.repositoryId, input.prNumber, targetSha, jobType])).rows[0];
      await client.query("COMMIT");
      return { kind: inserted.rowCount ? "accepted" as const : "duplicate" as const, job: rowToJob(row) };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async getJob(id: string) {
    const result = await this.pool.query("SELECT * FROM jobs WHERE id=$1", [id]);
    return result.rows[0] ? rowToJob(result.rows[0]) : undefined;
  }

  registerReviewAbort(job: ReviewJob, controller: AbortController) {
    if (this.stopping) controller.abort("cancelled");
    else this.activeReviews.set(job.id, { job, controller });
  }

  unregisterReviewAbort(job: ReviewJob) {
    this.activeReviews.delete(job.id);
  }

  private abortReviews(repositoryId: number, prNumber: number, exceptHead?: string, reason = "superseded") {
    for (const { job, controller } of this.activeReviews.values()) if (job.repositoryId === repositoryId && job.prNumber === prNumber && job.headSha !== exceptHead) controller.abort(reason);
  }

  cancelReview(repositoryId: number, prNumber: number) { this.abortReviews(repositoryId, prNumber, undefined, "cancelled"); }

  cancelRepository(repositoryId: number) {
    for (const { job, controller } of this.activeReviews.values()) if (job.repositoryId === repositoryId) controller.abort("cancelled");
  }

  stopReviews() {
    this.stopping = true;
    for (const { controller } of this.activeReviews.values()) controller.abort("cancelled");
  }

  async recoverRunning() {
    await this.pool.query("UPDATE agent_runs SET status='cancelled',error_summary='服务重启，旧 Session 已结束',finished_at=now() WHERE status='running'");
    const result = await this.pool.query("UPDATE jobs SET status='queued',next_run_at=now(),last_error='服务重启后恢复',started_at=NULL,updated_at=now() WHERE status='running' RETURNING id");
    return result.rowCount ?? 0;
  }

  async claimNext(): Promise<ReviewJob | undefined> {
    const client = await this.pool.connect();
    try {
      return await transaction(client, async () => {
        const result = await client.query("SELECT * FROM jobs WHERE status='queued' AND (next_run_at IS NULL OR next_run_at<=now()) ORDER BY COALESCE((payload->>'humanReplyCreatedAt')::timestamptz,created_at),COALESCE((payload->>'sourceCommentId')::bigint,0),created_at FOR UPDATE SKIP LOCKED LIMIT 1");
        if (!result.rows[0]) return undefined;
        const updated = await client.query("UPDATE jobs SET status='running',attempt=attempt+1,started_at=now(),updated_at=now() WHERE id=$1 RETURNING *", [result.rows[0].id]);
        return rowToJob(updated.rows[0]);
      });
    } finally { client.release(); }
  }

  async finishJob(job: ReviewJob) {
    if (job.status === "queued") return;
    const status = job.status === "running" ? "succeeded" : job.status;
    await this.pool.query("UPDATE jobs SET status=$2,last_error=$3,finished_at=now(),updated_at=now() WHERE id=$1", [job.id, status, status === "succeeded" ? null : job.error ?? null]);
  }

  async failJob(job: ReviewJob, error: Error, retry: boolean) {
    const delay = Math.min(3600, (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds ?? 2 ** Math.max(0, (job.attempt ?? 1) - 1));
    const status = job.status === "uncertain" ? "uncertain" : retry && (job.attempt ?? 1) < 3 ? "queued" : job.status === "timeout" ? "timeout" : "failed";
    await this.pool.query("UPDATE jobs SET status=$2,last_error=$3,next_run_at=CASE WHEN $2='queued' THEN now()+($4 || ' seconds')::interval ELSE NULL END,finished_at=CASE WHEN $2='queued' THEN NULL ELSE now() END,updated_at=now() WHERE id=$1", [job.id, status, error.message, delay]);
    job.status = status;
  }

  async beginPublication(job: ReviewJob, fingerprint: string) {
    const result = await this.pool.query("INSERT INTO review_publications(job_id,fingerprint,status) VALUES($1,$2,'pending') ON CONFLICT(fingerprint) DO UPDATE SET updated_at=now() RETURNING *", [job.id, fingerprint]);
    return result.rows[0] as { status: string; github_review_id?: string; github_review_url?: string };
  }

  async finishPublication(job: ReviewJob, status: "published" | "failed" | "uncertain") {
    await this.pool.query("UPDATE review_publications SET status=$2,github_review_id=$3,github_review_url=$4,updated_at=now() WHERE job_id=$1", [job.id, status, job.reviewId ?? null, job.reviewUrl ?? null]);
  }

  async isRepositoryEnabled(repositoryId: number) {
    const result = await this.pool.query("SELECT enabled FROM repositories WHERE id=$1", [repositoryId]);
    return result.rows[0]?.enabled === true;
  }

  async getRepositoryConfig(repositoryId: number) {
    const result = await this.pool.query("SELECT enabled,include_paths,exclude_paths,output_language,budget_tokens,review_mode,max_delegates FROM repositories WHERE id=$1", [repositoryId]);
    const row = result.rows[0];
    return row ? { enabled: Boolean(row.enabled), includePaths: row.include_paths as string[], excludePaths: row.exclude_paths as string[], outputLanguage: String(row.output_language), budgetTokens: Number(row.budget_tokens), reviewMode: String(row.review_mode) as "single" | "auto", maxDelegates: Number(row.max_delegates) } : undefined;
  }

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
      const result = await this.pool.query("INSERT INTO review_findings(id,job_id,repository_id,pr_number,head_sha,fingerprint,category,severity,evidence_level,path,line,side,description,evidence,impact,suggestion,memory_id,memory_version,binding_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT(fingerprint) DO UPDATE SET updated_at=now() RETURNING *", [identity.id, job.id, job.repositoryId, job.prNumber, job.headSha, identity.fingerprint, finding.category, finding.severity, finding.evidenceLevel, finding.path ?? null, finding.line ?? null, finding.side ?? null, finding.description, finding.evidence, finding.impact, finding.suggestion ?? null, finding.memory?.id ?? null, finding.memory?.version ?? null, inline.has(finding) ? "pending" : "summary"]);
      const stored = rowToFinding(result.rows[0]);
      values.push(stored); seen.set(signature, stored);
    }
    return values;
  }

  async bindFindings(job: ReviewJob, reviewId: number, comments: Array<{ id: number; body: string }>) {
    const bound = new Set<string>();
    for (const comment of comments) {
      const id = comment.body.match(/<!-- pi-finding:([a-z0-9_-]+) -->/)?.[1];
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

  async acceptReply(input: ReviewReplyInput) {
    const finding = await this.getFindingByRoot(input.repositoryId, input.prNumber, input.rootCommentId);
    if (!finding || finding.status === "FIXED" || finding.status === "WITHDRAWN") return { kind: "ignored" as const };
    const humanReplyCreatedAt = input.humanReplyCreatedAt ?? new Date().toISOString();
    if (await this.isOlderReply(finding.id, input.sourceCommentId, humanReplyCreatedAt)) return { kind: "ignored" as const };
    const client = await this.pool.connect();
    try {
      return await transaction(client, async () => {
        const delivery = await client.query("INSERT INTO webhook_deliveries(delivery_id,event,action,repository_id,installation_id) VALUES($1,'pull_request_review_comment','created',$2,$3) ON CONFLICT DO NOTHING RETURNING delivery_id", [input.deliveryId, input.repositoryId, input.installationId]);
        if (!delivery.rowCount) {
          const existing = await client.query("SELECT * FROM jobs WHERE delivery_id=$1 LIMIT 1", [input.deliveryId]);
          return { kind: "duplicate" as const, job: existing.rows[0] ? rowToJob(existing.rows[0]) : undefined };
        }
        const repository = await client.query("SELECT enabled FROM repositories WHERE id=$1 AND installation_id=$2", [input.repositoryId, input.installationId]);
        if (!repository.rows[0]?.enabled) return { kind: "ignored" as const };
        const prior = await client.query("SELECT job_id FROM reply_publications WHERE source_comment_id=$1", [input.sourceCommentId]);
        if (prior.rows[0]) {
          const existing = await client.query("SELECT * FROM jobs WHERE id=$1", [prior.rows[0].job_id]);
          return { kind: "duplicate" as const, job: existing.rows[0] ? rowToJob(existing.rows[0]) : undefined };
        }
        const id = randomUUID();
        const payload = { findingId: finding.id, rootCommentId: input.rootCommentId, sourceCommentId: input.sourceCommentId, sourceCommentUrl: input.sourceCommentUrl, humanActorId: input.humanActorId, humanActorLogin: input.humanActorLogin, humanReplyBody: input.humanReplyBody, humanReplyCreatedAt, cloneUrl: `https://github.com/${input.repository}.git` };
        const inserted = await client.query("INSERT INTO jobs(id,delivery_id,job_type,repository_id,installation_id,repository,pr_number,target_sha,base_sha,payload,status) VALUES($1,$2,'REPLY_HANDLE',$3,$4,$5,$6,$7,$8,$9,'queued') RETURNING *", [id, input.deliveryId, input.repositoryId, input.installationId, input.repository, input.prNumber, input.eventHeadSha, input.baseSha, payload]);
        await client.query("INSERT INTO reply_publications(source_comment_id,job_id,finding_id,status) VALUES($1,$2,$3,'pending')", [input.sourceCommentId, id, finding.id]);
        return { kind: "accepted" as const, job: rowToJob(inserted.rows[0]) };
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

  async startAgentRun(jobId: string, role: string, budget: number, timeoutMs: number, parentRunId?: string) {
    const id = randomUUID();
    await this.pool.query("INSERT INTO agent_runs(id,job_id,parent_run_id,role,status,input_budget_tokens,timeout_ms) VALUES($1,$2,$3,$4,'running',$5,$6)", [id, jobId, parentRunId ?? null, role, budget, timeoutMs]);
    return id;
  }

  async finishAgentRun(id: string, value: { status: "succeeded" | "partial" | "failed" | "timeout" | "cancelled"; model?: string; usage?: Partial<import("./review.js").AgentUsage>; coverage?: string[]; limitations?: string[]; error?: string; orchestration?: import("./types.js").OrchestrationSummary }) {
    await this.pool.query("UPDATE agent_runs SET status=$2,model=$3,usage_input_tokens=$4,usage_output_tokens=$5,coverage=$6,limitations=$7,error_summary=$8,usage=$9,orchestration=$10,finished_at=now(),duration_ms=GREATEST(0,round(extract(epoch from (now()-started_at))*1000)::integer) WHERE id=$1", [id, value.status, value.model ?? null, Number(value.usage?.input ?? 0), Number(value.usage?.output ?? 0), JSON.stringify(value.coverage ?? []), JSON.stringify(value.limitations ?? []), value.error ?? null, value.usage ?? {}, value.orchestration ?? null]);
  }

  async insertCandidates(job: ReviewJob, proposals: DecisionProposal[]) {
    const client = await this.pool.connect();
    try {
      return await transaction(client, async () => {
        const ids: string[] = [];
        for (const proposal of proposals) {
          const fingerprint = createHash("sha256").update(JSON.stringify([job.repositoryId, proposal.source.pullRequestNumber, proposal.source.commitSha, [...proposal.source.commentIds].sort(), proposal.type, proposal.content.trim().toLowerCase()])).digest("hex");
          const id = randomUUID();
          const result = await client.query("INSERT INTO memories(id,version,repository_id,installation_id,type,title,content,rationale,scope,source,evidence,confidence,uncertainties,status,source_fingerprint,exception_to,supersedes) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'CANDIDATE',$13,$14,$15) ON CONFLICT(repository_id,source_fingerprint) DO NOTHING RETURNING id", [id, job.repositoryId, job.installationId, proposal.type, proposal.title, proposal.content, proposal.rationale, proposal.scope, proposal.source, JSON.stringify(proposal.evidence), proposal.confidence, JSON.stringify(proposal.uncertainties), fingerprint, proposal.relation?.exceptionTo ?? null, proposal.relation?.supersedes ?? null]);
          if (result.rows[0]) ids.push(String(result.rows[0].id));
        }
        return ids;
      });
    } finally { client.release(); }
  }
}

function rowToJob(row: Record<string, unknown>): ReviewJob {
  const payload = row.payload as Record<string, any>;
  return {
    id: String(row.id), deliveryId: String(row.delivery_id), jobType: row.job_type as ReviewJob["jobType"], installationId: Number(row.installation_id), repositoryId: Number(row.repository_id), repository: String(row.repository),
    cloneUrl: payload.cloneUrl ?? `https://github.com/${row.repository}.git`, prNumber: Number(row.pr_number), title: payload.title ?? "", body: payload.body ?? "", baseSha: String(row.base_sha), headSha: String(row.target_sha),
    status: row.status as ReviewJob["status"], error: row.last_error ? String(row.last_error) : undefined, reviewId: row.github_review_id ? Number(row.github_review_id) : undefined, reviewUrl: row.github_review_url ? String(row.github_review_url) : undefined, attempt: Number(row.attempt), findingId: payload.findingId, rootCommentId: payload.rootCommentId, sourceCommentId: payload.sourceCommentId, sourceCommentUrl: payload.sourceCommentUrl, humanActorId: payload.humanActorId, humanActorLogin: payload.humanActorLogin, humanReplyBody: payload.humanReplyBody, humanReplyCreatedAt: payload.humanReplyCreatedAt,
  };
}

function rowToFinding(row: Record<string, any>): StoredFinding {
  return { id: String(row.id), jobId: String(row.job_id), repositoryId: Number(row.repository_id), prNumber: Number(row.pr_number), headSha: String(row.head_sha), fingerprint: String(row.fingerprint), category: row.category, severity: row.severity, evidenceLevel: row.evidence_level, path: row.path ?? undefined, line: row.line ? Number(row.line) : undefined, side: row.side ?? undefined, description: row.description, evidence: row.evidence, impact: row.impact, suggestion: row.suggestion ?? undefined, memory: row.memory_id ? { id: String(row.memory_id), version: Number(row.memory_version), source: {} } : undefined, status: row.status, githubReviewId: row.github_review_id ? Number(row.github_review_id) : undefined, githubCommentId: row.github_comment_id ? Number(row.github_comment_id) : undefined, bindingStatus: row.binding_status };
}

export async function transaction<T>(client: PoolClient, run: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try { const value = await run(); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
}

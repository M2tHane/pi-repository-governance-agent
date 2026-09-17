import { createHash } from "node:crypto";
import type { Config } from "../config/config.js";
import { GitHubClient } from "../github/client.js";
import type { Finding, ReviewResult, StoredFinding } from "./types.js";
import type { ReviewJob } from "../jobs/types.js";
import type { AgentUsage } from "./agent.js";
import { inlineBody, reviewBody } from "./presentation.js";

export interface PublicationStore {
  beginPublication(job: ReviewJob, fingerprint: string): Promise<{ status: string; github_review_id?: string; github_review_url?: string }>;
  finishPublication(job: ReviewJob, status: "published" | "failed" | "uncertain"): Promise<void>;
  isRepositoryEnabled?(repositoryId: number): Promise<boolean>;
  getRepositoryConfig?(repositoryId: number): Promise<{ enabled: boolean; includePaths: string[]; excludePaths: string[]; outputLanguage: string; budgetTokens: number; reviewMode?: "single" | "auto"; maxDelegates?: number } | undefined>;
  saveReviewResult?(job: ReviewJob, result: ReviewResult): Promise<void>;
  saveFindings?(job: ReviewJob, findings: Finding[], inline: Set<Finding>): Promise<StoredFinding[]>;
  bindFindings?(job: ReviewJob, reviewId: number, comments: Array<{ id: number; body: string }>): Promise<number>;
}

export async function publishReview(config: Config, github: GitHubClient, publications: PublicationStore | undefined, job: ReviewJob, token: string, controller: AbortController, review: { result: ReviewResult; model: string; durationMs: number; usage: AgentUsage }, stored: StoredFinding[], publishedResult: ReviewResult) {
        const detailsUrl = config.githubOAuthCallbackUrl ? new URL(config.githubOAuthCallbackUrl).origin + "/#reviews/" + job.id : undefined;
        const current = await github.getPullRequest(token, job.repository, job.prNumber);
        controller.signal.throwIfAborted();
        if (current.state !== "open" || current.draft || current.head.sha !== job.headSha || !config.allowedRepositories.has(job.repository.toLowerCase()) || publications?.isRepositoryEnabled && !await publications.isRepositoryEnabled(job.repositoryId)) {
          job.status = "superseded";
          return;
        }
        const fingerprint = createHash("sha256").update(`${job.repositoryId}:${job.prNumber}:${job.headSha}:COMMENT`).digest("hex");
        const prior = await publications?.beginPublication(job, fingerprint);
        if (prior?.status === "published") {
          job.reviewId = Number(prior.github_review_id);
          job.reviewUrl = prior.github_review_url;
          return;
        }
        if (prior?.status === "uncertain") { job.status = "uncertain"; throw new Error("GitHub Review 发布结果待核对"); }
        await publications?.saveReviewResult?.(job, publishedResult);
        try {
          const comments = [...new Map(stored.filter((finding) => finding.bindingStatus === "pending" && finding.path && finding.line && finding.side).map((finding) => [finding.id, finding])).values()].map((finding) => ({ path: finding.path!, line: finding.line!, side: finding.side!, body: inlineBody(job, finding, detailsUrl) }));
          controller.signal.throwIfAborted();
          const published = await github.createReview(token, job, reviewBody(job, publishedResult, job.status === "partial", detailsUrl), comments);
          job.reviewId = published.id;
          job.reviewUrl = published.html_url;
          await publications?.finishPublication(job, "published");
          if (comments.length && publications?.bindFindings) {
            try {
              const reviewComments = await github.getReviewCommentsForReview(token, job.repository, job.prNumber, published.id);
              const bound = await publications.bindFindings(job, published.id, reviewComments);
              if (bound !== comments.length) console.error(JSON.stringify({ event: "finding_binding_incomplete", jobId: job.id, expected: comments.length, bound }));
            } catch {
              await publications.bindFindings(job, published.id, []).catch(() => undefined);
              console.error(JSON.stringify({ event: "finding_binding_incomplete", jobId: job.id, reviewId: published.id }));
            }
          }
          console.info(JSON.stringify({ event: "review_published", jobId: job.id, deliveryId: job.deliveryId, repositoryId: job.repositoryId, prNumber: job.prNumber, headSha: job.headSha, reviewId: job.reviewId, model: review.model, durationMs: review.durationMs, usage: review.usage }));
        } catch (error) {
          const uncertain = !(error instanceof Error) || !error.message.startsWith("GitHub API ");
          if (uncertain) job.status = "uncertain";
          await publications?.finishPublication(job, uncertain ? "uncertain" : "failed");
          throw error;
        }
}

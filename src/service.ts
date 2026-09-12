import { readWorkspaceFile, withWorkspace } from "./workspace.js";
import { GitHubClient } from "./github.js";
import { runAgentReview, TimeoutError, type AgentUsage } from "./review.js";
import type { Config } from "./config.js";
import type { Finding, ReviewJob, ReviewResult, StoredFinding } from "./types.js";
import { createHash } from "node:crypto";
import type { MemoryService } from "./memory.js";
import { matchesGlob } from "node:path";
import { diffLines, normalizeFindingLocation } from "./finding.js";
import { complexityProfile, orchestrateReview, shouldOrchestrate } from "./orchestration.js";

interface PublicationStore {
  beginPublication(job: ReviewJob, fingerprint: string): Promise<{ status: string; github_review_id?: string; github_review_url?: string }>;
  finishPublication(job: ReviewJob, status: "published" | "failed" | "uncertain"): Promise<void>;
  isRepositoryEnabled?(repositoryId: number): Promise<boolean>;
  getRepositoryConfig?(repositoryId: number): Promise<{ enabled: boolean; includePaths: string[]; excludePaths: string[]; outputLanguage: string; budgetTokens: number; reviewMode?: "single" | "auto"; maxDelegates?: number } | undefined>;
  saveFindings?(job: ReviewJob, findings: Finding[], inline: Set<Finding>): Promise<StoredFinding[]>;
  bindFindings?(job: ReviewJob, reviewId: number, comments: Array<{ id: number; body: string }>): Promise<number>;
}

function reviewBody(job: ReviewJob, result: ReviewResult, inlineCount = 0): string {
  const findings = (result.findings.length ? result.findings.map((item, index) => `${index + 1}. **${item.path ?? "摘要"}** — ${item.description}\n   - 影响：${item.impact}\n   - 证据：${item.evidence}${item.memory ? `\n   - 团队规则：${item.memory.id} v${item.memory.version}（来源 PR #${item.memory.source.pullRequestNumber ?? "?"}）` : ""}${item.suggestion ? `\n   - 建议：${item.suggestion}` : ""}`).join("\n") : inlineCount ? "没有额外的摘要意见。" : "在本次检查范围内未产出 finding。") + (inlineCount ? `\n\n${inlineCount} 条意见作为行内评论发布，请查看对应代码线程。` : "");
  return `## Pi PR Review\n\n目标提交：\`${job.headSha}\`\n\n${result.summary}\n\n### Findings\n\n${findings}\n\n### Coverage\n\n${result.coverage.map((x) => `- ${x}`).join("\n") || "- 未报告"}\n\n### Limitations\n\n${result.limitations.map((x) => `- ${x}`).join("\n") || "- 未报告"}\n\n> “未产出 finding”不代表代码安全或检查通过。`;
}

function inlineBody(finding: StoredFinding) {
  return `${finding.description}\n\n**影响：** ${finding.impact}\n\n**证据：** ${finding.evidence}${finding.memory ? `\n\n**团队规则：** ${finding.memory.id} v${finding.memory.version}` : ""}${finding.suggestion ? `\n\n**建议：** ${finding.suggestion}` : ""}\n\n<!-- pi-finding:${finding.id} -->`;
}

export function createJobProcessor(config: Config, github = new GitHubClient(config.appId, config.privateKey), publications?: PublicationStore, memories?: MemoryService, execute = runAgentReview) {
  return async (job: ReviewJob): Promise<void> => {
    if (!config.allowedRepositories.has(job.repository.toLowerCase())) { job.status = "cancelled"; return; }
    const token = await github.installationToken(job.installationId);
    const repositoryConfig = await publications?.getRepositoryConfig?.(job.repositoryId);
    const initial = await github.getPullRequest(token, job.repository, job.prNumber);
    if (!config.allowedRepositories.has(job.repository.toLowerCase()) || repositoryConfig?.enabled === false || initial.state !== "open" || initial.draft || initial.head.sha !== job.headSha) { job.status = initial.head.sha !== job.headSha ? "superseded" : "cancelled"; return; }
    const allFiles = await github.getFiles(token, job.repository, job.prNumber);
    const files = allFiles.filter((file) => (!repositoryConfig?.includePaths.length || repositoryConfig.includePaths.some((pattern) => matchesGlob(file.filename, pattern))) && !repositoryConfig?.excludePaths.some((pattern) => matchesGlob(file.filename, pattern)));
    if (!files.length && allFiles.length) { job.status = "cancelled"; return; }
    if (files.length === 0) throw new Error("PR 没有可审查文件");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new TimeoutError()), config.agentTimeoutMs);
    const database = publications as import("./database.js").Database | undefined;
    database?.registerReviewAbort?.(job, controller);
    let singleRunId: string | undefined, agentUsage: AgentUsage | undefined;
    try {
      await withWorkspace(job.cloneUrl, token, job.baseSha, job.headSha, async (root) => {
        const recalled = await memories?.retrieve(job.repositoryId, { paths: files.map((file) => file.filename), text: `${job.title} ${job.body} ${files.map((file) => `${file.filename} ${file.patch ?? ""}`).join(" ")}` }) ?? [];
        let review;
        const profile = complexityProfile(files, recalled);
        if (shouldOrchestrate(profile, repositoryConfig?.reviewMode ?? "single") && (repositoryConfig?.maxDelegates ?? 2) > 0 && database) {
          review = await orchestrateReview({ config, database, job, root, files, memories: recalled, budgetTokens: repositoryConfig?.budgetTokens ?? 20_000, maxDelegates: repositoryConfig?.maxDelegates ?? 2, signal: controller.signal, outputLanguage: repositoryConfig?.outputLanguage });
        } else {
          singleRunId = await database?.startAgentRun?.(job.id, "general_review", repositoryConfig?.budgetTokens ?? 20_000, config.agentTimeoutMs);
          review = await execute({ root, provider: config.modelProvider, modelName: config.modelName, apiKey: config.modelApiKey, timeoutMs: config.agentTimeoutMs, title: job.title, body: job.body, baseSha: job.baseSha, headSha: job.headSha, changedFiles: files, memories: recalled, outputLanguage: repositoryConfig?.outputLanguage, budgetTokens: repositoryConfig?.budgetTokens, signal: controller.signal });
        }
        agentUsage = review.usage;
        controller.signal.throwIfAborted();
        if ((review as any).orchestration?.partial) job.status = "partial";
        if (files.some((file) => file.patch === undefined)) review.result.limitations.push("GitHub 未提供部分文件的 patch，相关内容只能按 Workspace 源码检查。");
        const changed = new Set(files.map((file) => file.filename));
        for (const finding of review.result.findings) if (finding.path) {
          if (!changed.has(finding.path)) throw new Error(`finding 路径不属于 PR: ${finding.path}`);
          await readWorkspaceFile(root, finding.path);
        }
        validateMemoryReferences(review.result, recalled, job.repositoryId);
        const validDiffLines = diffLines(files);
        const inline = new Set(review.result.findings.filter((finding) => normalizeFindingLocation(finding, validDiffLines)));
        if (singleRunId) { await database!.finishAgentRun(singleRunId, { status: "succeeded", model: review.model, usage: review.usage, coverage: review.result.coverage, limitations: review.result.limitations }); singleRunId = undefined; }
        const stored = await publications?.saveFindings?.(job, review.result.findings, inline) ?? [];
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
        try {
          const inlineIds = new Set(stored.filter((finding) => finding.bindingStatus === "pending").map((finding) => finding.id));
          const summary = { ...review.result, findings: review.result.findings.filter((_finding, index) => !inlineIds.has(stored[index]?.id ?? "")) };
          const comments = [...new Map(stored.filter((finding) => finding.bindingStatus === "pending" && finding.path && finding.line && finding.side).map((finding) => [finding.id, finding])).values()].map((finding) => ({ path: finding.path!, line: finding.line!, side: finding.side!, body: inlineBody(finding) }));
          controller.signal.throwIfAborted();
          const published = await github.createReview(token, job, reviewBody(job, summary, comments.length), comments);
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
      });
    } catch (error) {
      if (singleRunId) await database!.finishAgentRun(singleRunId, { status: controller.signal.aborted ? "cancelled" : error instanceof TimeoutError ? "timeout" : "failed", model: config.modelName, usage: (error as { usage?: AgentUsage })?.usage ?? agentUsage, error: error instanceof Error ? error.message : String(error) });
      if (controller.signal.reason === "superseded" || controller.signal.reason === "cancelled") { job.status = controller.signal.reason; return; }
      if (error instanceof TimeoutError) job.status = "timeout";
      throw error;
    } finally { clearTimeout(timer); database?.unregisterReviewAbort?.(job); }
  };
}

export function validateMemoryReferences(result: ReviewResult, recalled: import("./types.js").MemoryRecord[], repositoryId: number) {
  const recalledById = new Map(recalled.map((memory) => [`${memory.id}:${memory.version}`, memory]));
  for (const finding of result.findings) if (finding.memory) {
    const memory = recalledById.get(`${finding.memory.id}:${finding.memory.version}`);
    if (!memory || memory.status !== "ACTIVE" || memory.repositoryId !== repositoryId) throw new Error("模型引用了未召回或无效的 Memory");
    finding.memory.source = memory.source;
  }
}

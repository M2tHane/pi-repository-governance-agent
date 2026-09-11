import { readWorkspaceFile, withWorkspace } from "./workspace.js";
import { GitHubClient } from "./github.js";
import { runAgentReview, TimeoutError } from "./review.js";
import type { Config } from "./config.js";
import type { ReviewJob, ReviewResult } from "./types.js";
import { createHash } from "node:crypto";
import type { MemoryService } from "./memory.js";
import { matchesGlob } from "node:path";

interface PublicationStore {
  beginPublication(job: ReviewJob, fingerprint: string): Promise<{ status: string; github_review_id?: string; github_review_url?: string }>;
  finishPublication(job: ReviewJob, status: "published" | "failed" | "uncertain"): Promise<void>;
  isRepositoryEnabled?(repositoryId: number): Promise<boolean>;
  getRepositoryConfig?(repositoryId: number): Promise<{ enabled: boolean; includePaths: string[]; excludePaths: string[]; outputLanguage: string; budgetTokens: number } | undefined>;
}

function reviewBody(job: ReviewJob, result: ReviewResult): string {
  const findings = result.findings.length ? result.findings.map((item, index) => `${index + 1}. **${item.path ?? "摘要"}** — ${item.description}\n   - 影响：${item.impact}\n   - 证据：${item.evidence}${item.memory ? `\n   - 团队规则：${item.memory.id} v${item.memory.version}（来源 PR #${item.memory.source.pullRequestNumber ?? "?"}）` : ""}${item.suggestion ? `\n   - 建议：${item.suggestion}` : ""}`).join("\n") : "在本次检查范围内未产出 finding。";
  return `## Pi PR Review\n\n目标提交：\`${job.headSha}\`\n\n${result.summary}\n\n### Findings\n\n${findings}\n\n### Coverage\n\n${result.coverage.map((x) => `- ${x}`).join("\n") || "- 未报告"}\n\n### Limitations\n\n${result.limitations.map((x) => `- ${x}`).join("\n") || "- 未报告"}\n\n> “未产出 finding”不代表代码安全或检查通过。`;
}

export function createJobProcessor(config: Config, github = new GitHubClient(config.appId, config.privateKey), publications?: PublicationStore, memories?: MemoryService) {
  return async (job: ReviewJob): Promise<void> => {
    const token = await github.installationToken(job.installationId);
    const repositoryConfig = await publications?.getRepositoryConfig?.(job.repositoryId);
    const allFiles = await github.getFiles(token, job.repository, job.prNumber);
    const files = allFiles.filter((file) => (!repositoryConfig?.includePaths.length || repositoryConfig.includePaths.some((pattern) => matchesGlob(file.filename, pattern))) && !repositoryConfig?.excludePaths.some((pattern) => matchesGlob(file.filename, pattern)));
    if (!files.length && allFiles.length) { job.status = "cancelled"; return; }
    if (files.length === 0) throw new Error("PR 没有可审查文件");
    try {
      await withWorkspace(job.cloneUrl, token, job.baseSha, job.headSha, async (root) => {
        const recalled = await memories?.retrieve(job.repositoryId, { paths: files.map((file) => file.filename), text: `${job.title} ${job.body} ${files.map((file) => `${file.filename} ${file.patch ?? ""}`).join(" ")}` }) ?? [];
        const review = await runAgentReview({ root, provider: config.modelProvider, modelName: config.modelName, apiKey: config.modelApiKey, timeoutMs: config.agentTimeoutMs, title: job.title, body: job.body, baseSha: job.baseSha, headSha: job.headSha, changedFiles: files, memories: recalled, outputLanguage: repositoryConfig?.outputLanguage, budgetTokens: repositoryConfig?.budgetTokens });
        if (files.some((file) => file.patch === undefined)) review.result.limitations.push("GitHub 未提供部分文件的 patch，相关内容只能按 Workspace 源码检查。");
        const changed = new Set(files.map((file) => file.filename));
        for (const finding of review.result.findings) if (finding.path) {
          if (!changed.has(finding.path)) throw new Error(`finding 路径不属于 PR: ${finding.path}`);
          await readWorkspaceFile(root, finding.path);
        }
        validateMemoryReferences(review.result, recalled, job.repositoryId);
        const current = await github.getPullRequest(token, job.repository, job.prNumber);
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
          const published = await github.createReview(token, job, reviewBody(job, review.result));
          job.reviewId = published.id;
          job.reviewUrl = published.html_url;
          await publications?.finishPublication(job, "published");
          console.info(JSON.stringify({ event: "review_published", jobId: job.id, deliveryId: job.deliveryId, repositoryId: job.repositoryId, prNumber: job.prNumber, headSha: job.headSha, reviewId: job.reviewId, model: review.model, durationMs: review.durationMs, usage: review.usage }));
        } catch (error) {
          const uncertain = !(error instanceof Error) || !error.message.startsWith("GitHub API ");
          if (uncertain) job.status = "uncertain";
          await publications?.finishPublication(job, uncertain ? "uncertain" : "failed");
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof TimeoutError) job.status = "timeout";
      throw error;
    }
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

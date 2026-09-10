import { readWorkspaceFile, withWorkspace } from "./workspace.js";
import { GitHubClient } from "./github.js";
import { runAgentReview, TimeoutError } from "./review.js";
import type { Config } from "./config.js";
import type { ReviewJob, ReviewResult } from "./types.js";

function reviewBody(job: ReviewJob, result: ReviewResult): string {
  const findings = result.findings.length ? result.findings.map((item, index) => `${index + 1}. **${item.path ?? "摘要"}** — ${item.description}\n   - 影响：${item.impact}\n   - 证据：${item.evidence}${item.suggestion ? `\n   - 建议：${item.suggestion}` : ""}`).join("\n") : "在本次检查范围内未产出 finding。";
  return `## Pi PR Review\n\n目标提交：\`${job.headSha}\`\n\n${result.summary}\n\n### Findings\n\n${findings}\n\n### Coverage\n\n${result.coverage.map((x) => `- ${x}`).join("\n") || "- 未报告"}\n\n### Limitations\n\n${result.limitations.map((x) => `- ${x}`).join("\n") || "- 未报告"}\n\n> “未产出 finding”不代表代码安全或检查通过。`;
}

export function createJobProcessor(config: Config, github = new GitHubClient(config.appId, config.privateKey)) {
  return async (job: ReviewJob): Promise<void> => {
    const token = await github.installationToken(job.installationId);
    const files = await github.getFiles(token, job.repository, job.prNumber);
    if (files.length === 0) throw new Error("PR 没有可审查文件");
    try {
      await withWorkspace(job.cloneUrl, token, job.baseSha, job.headSha, async (root) => {
        const review = await runAgentReview({ root, provider: config.modelProvider, modelName: config.modelName, apiKey: config.modelApiKey, timeoutMs: config.agentTimeoutMs, title: job.title, body: job.body, baseSha: job.baseSha, headSha: job.headSha, changedFiles: files });
        if (files.some((file) => file.patch === undefined)) review.result.limitations.push("GitHub 未提供部分文件的 patch，相关内容只能按 Workspace 源码检查。");
        const changed = new Set(files.map((file) => file.filename));
        for (const finding of review.result.findings) if (finding.path) {
          if (!changed.has(finding.path)) throw new Error(`finding 路径不属于 PR: ${finding.path}`);
          await readWorkspaceFile(root, finding.path);
        }
        const current = await github.getPullRequest(token, job.repository, job.prNumber);
        if (current.state !== "open" || current.draft || current.head.sha !== job.headSha || !config.allowedRepositories.has(job.repository.toLowerCase())) {
          job.status = "superseded";
          return;
        }
        try {
          const published = await github.createReview(token, job, reviewBody(job, review.result));
          job.reviewId = published.id;
          job.reviewUrl = published.html_url;
          console.info(JSON.stringify({ event: "review_published", jobId: job.id, deliveryId: job.deliveryId, repositoryId: job.repositoryId, prNumber: job.prNumber, headSha: job.headSha, reviewId: job.reviewId, model: review.model, durationMs: review.durationMs, usage: review.usage }));
        } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith("GitHub API ")) job.status = "uncertain";
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof TimeoutError) job.status = "timeout";
      throw error;
    }
  };
}

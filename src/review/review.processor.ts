import { readWorkspaceFile, withWorkspace } from "../workspace/workspace.js";
import { GitHubClient } from "../github/client.js";
import { runAgentReview, TimeoutError, type AgentUsage } from "./agent.js";
import type { Config } from "../config/config.js";
import type { ReviewJob } from "../jobs/types.js";
import type { ReviewResult } from "./types.js";
import type { MemoryService } from "../memory/memory.service.js";
import { matchesGlob } from "node:path";
import { diffLines, normalizeFindingLocation } from "./finding.js";
import { complexityProfile, orchestrateReview, shouldOrchestrate } from "./orchestration.js";
import { publishReview, type PublicationStore } from "./review.publisher.js";


export function createReviewProcessor(config: Config, github = new GitHubClient(config.appId, config.privateKey), publications?: PublicationStore, memories?: MemoryService, execute = runAgentReview) {
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
    const database = publications as import("../persistence/database.js").Database | undefined;
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
        const locations = review.result.findings.flatMap(finding => [finding, ...(finding.relatedLocations ?? []), ...(finding.candidates ?? [])]);
        for (const path of new Set(locations.flatMap(location => location.path ? [location.path] : []))) {
          if (!changed.has(path)) throw new Error(`finding 路径不属于 PR: ${path}`);
          await readWorkspaceFile(root, path);
        }
        validateMemoryReferences(review.result, recalled, job.repositoryId);
        const validDiffLines = diffLines(files);
        for (const location of locations) normalizeFindingLocation(location, validDiffLines);
        const inline = new Set(review.result.findings.filter(finding => normalizeFindingLocation(finding, validDiffLines)));
        if (singleRunId) { await database!.finishAgentRun(singleRunId, { status: "succeeded", model: review.model, usage: review.usage, coverage: review.result.coverage, limitations: review.result.limitations }); singleRunId = undefined; }
        const stored = await publications?.saveFindings?.(job, review.result.findings, inline) ?? [];
        const publishedResult = { ...review.result, findings: stored.length ? [...new Map(stored.map(f => [f.id, f])).values()] : review.result.findings };
        await publishReview(config, github, publications, job, token, controller, review, stored, publishedResult);
      });
    } catch (error) {
      if (singleRunId) await database!.finishAgentRun(singleRunId, { status: controller.signal.aborted ? "cancelled" : error instanceof TimeoutError ? "timeout" : "failed", model: config.modelName, usage: (error as { usage?: AgentUsage })?.usage ?? agentUsage, error: error instanceof Error ? error.message : String(error) });
      if (controller.signal.reason === "superseded" || controller.signal.reason === "cancelled") { job.status = controller.signal.reason; return; }
      if (error instanceof TimeoutError) job.status = "timeout";
      throw error;
    } finally { clearTimeout(timer); database?.unregisterReviewAbort?.(job); }
  };
}

export function validateMemoryReferences(result: ReviewResult, recalled: import("../memory/types.js").MemoryRecord[], repositoryId: number) {
  const recalledById = new Map(recalled.map((memory) => [`${memory.id}:${memory.version}`, memory]));
  for (const finding of result.findings.flatMap(item => [item, ...(item.candidates ?? [])])) {
    if (["team_rule", "memory_conflict"].includes(finding.category) && !finding.memory) throw new Error("团队规则 finding 必须绑定 Memory id/version");
    if (!finding.memory) continue;
    const memory = recalledById.get(`${finding.memory.id}:${finding.memory.version}`);
    if (!memory || memory.status !== "ACTIVE" || memory.repositoryId !== repositoryId) throw new Error("模型引用了未召回或无效的 Memory");
    finding.memory.source = memory.source;
    finding.memory.title = memory.title;
  }
}

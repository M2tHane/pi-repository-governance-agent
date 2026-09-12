import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitHubApiError, GitHubClient } from "../src/github.js";
import { emptyUsage } from "../src/review.js";
import { withWorkspace } from "../src/workspace.js";
import type { HealthJob, HealthReport } from "../src/types.js";

const exec = promisify(execFile);
const job: HealthJob = { id: "health-job", jobType: "HEALTH_AUDIT", repositoryId: 1, installationId: 1, repository: "owner/repo", cloneUrl: "https://github.com/owner/repo.git", title: "Health: main", headSha: "a".repeat(40), status: "running", defaultBranch: "main", windowStart: "2026-08-13T00:00:00.000Z", windowEnd: "2026-09-12T00:00:00.000Z", trigger: "manual", scope: { includePaths: [], excludePaths: [], outputLanguage: "zh-CN", budgetTokens: 20000 } };
async function healthApi() {
  const api = await import(new URL("../src/health.js", import.meta.url).href).catch((error) => { if (error.code === "ERR_MODULE_NOT_FOUND") return {}; throw error; });
  assert.equal(typeof api.parseHealthResult, "function", "缺少 Health Auditor 实现");
  return api;
}

test("取消的健康任务不会开始准备 Git Workspace", async () => {
  let entered = false;
  await assert.rejects(Reflect.apply(withWorkspace, undefined, ["unused-local-repository", "test", job.headSha, job.headSha, async () => { entered = true; }, { signal: AbortSignal.abort() }]), (error: any) => error.name === "AbortError");
  assert.equal(entered, false);
});

test("健康快照读取真实默认分支并校验仓库归属，取消后不请求 GitHub", async (t) => {
  const github: any = new GitHubClient("app", "unused");
  assert.equal(typeof github.repositorySnapshot, "function");
  const calls: string[] = []; let otherRepository = false;
  const signal = new AbortController().signal;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push(url); assert.equal(init.signal, signal);
    return Response.json(url.includes("/branches/") ? { commit: { sha: job.headSha } } : { id: otherRepository ? 2 : 1, default_branch: "release/main" });
  });
  assert.deepEqual(await github.repositorySnapshot("token", job.repository, 1, signal), { defaultBranch: "release/main", headSha: job.headSha });
  assert(calls[1].endsWith("/branches/release%2Fmain"));
  otherRepository = true;
  await assert.rejects(github.repositorySnapshot("token", job.repository, 1, signal));
  const before = calls.length;
  await assert.rejects(github.repositorySnapshot("token", job.repository, 1, AbortSignal.abort()));
  assert.equal(calls.length, before);
});

test("Health 结果只引用已读取的代码和已提供的 CI / Memory，身份由服务生成", async () => {
  const { parseHealthResult } = await healthApi();
  const binding = { job, files: new Map([["src/a.ts", "first\nsecond\nthird"]]), readLines: new Map([["src/a.ts", new Set([1, 2])]]), sources: [{ id: "check:1" }], memories: [{ id: "memory-1", version: 2, repositoryId: 1, status: "ACTIVE" }] };
  const finding = { dimension: "code", severity: "high", evidenceLevel: "strong", description: "失败分支丢失状态", impact: "重试丢数据", suggestion: "保持失败前状态", references: [{ kind: "code", path: "src/a.ts", line: 2, detail: "已读到该分支" }, { kind: "memory", id: "memory-1", version: 2, detail: "适用规则" }] };
  const raw = { summary: "发现一个有证据的问题", findings: [finding, finding], limitations: [] };
  const result = parseHealthResult(JSON.stringify(raw), binding);
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].id, /^health_finding_/);
  assert.equal(result.findings[0].id, parseHealthResult(JSON.stringify(raw), binding).findings[0].id);
  for (const reference of [
    { kind: "code", path: "../secret", line: 1, detail: "越界" },
    { kind: "code", path: "src/a.ts", line: 3, detail: "未读过" },
    { kind: "code", path: "src/a.ts", line: 99, detail: "不存在" },
    { kind: "ci", sourceId: "forged", detail: "未提供的来源" },
    { kind: "memory", id: "memory-1", version: 3, detail: "伪造版本" },
  ]) assert.throws(() => parseHealthResult(JSON.stringify({ ...raw, findings: [{ ...finding, references: [reference] }] }), binding));
  assert.throws(() => parseHealthResult(JSON.stringify({ ...raw, repositoryId: 2 }), binding));
  assert.throws(() => parseHealthResult(JSON.stringify({ ...raw, findings: [{ ...finding, id: "forged" }] }), binding));
  assert.throws(() => parseHealthResult(JSON.stringify({ ...raw, findings: [{ ...finding, references: [] }] }), binding));
  assert.throws(() => parseHealthResult("PRIVATE_OUTPUT_SENTINEL is not JSON", binding), (error: any) => !error.message.includes("PRIVATE"));
});

test("Health 文件工具只读受限的已跟踪文本，记录实际返回行并拒绝外部路径", async () => {
  const { collectHealthFiles, healthTools } = await healthApi();
  await mkdir(resolve("work"), { recursive: true });
  const root = await mkdtemp(resolve("work/m3-files-"));
  try {
    await mkdir(join(root, "src"));
    await Promise.all([writeFile(join(root, "src/a.ts"), "first\nsecond\nthird"), writeFile(join(root, "README.md"), "readme"), writeFile(join(root, "excluded.txt"), "excluded"), writeFile(join(root, "large.txt"), "x".repeat(70000)), writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2]))]);
    await symlink("/etc/passwd", join(root, "escape"));
    await exec("git", ["init", "--quiet", root]);
    await exec("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "add", "."]);
    await writeFile(join(root, "untracked.txt"), "not selected");
    const signal = new AbortController().signal;
    const selected = await collectHealthFiles(root, { ...job.scope, excludePaths: ["excluded.txt"] }, signal);
    assert.deepEqual([...selected.files.keys()].sort(), ["README.md", "src/a.ts"]);
    assert(selected.skippedFiles.some((item: any) => item.path === "escape"));
    assert(selected.skippedFiles.some((item: any) => item.path === "large.txt"));
    const readLines = new Map<string, Set<number>>();
    const tools = healthTools(selected.files, readLines, signal);
    assert.deepEqual(tools.map((tool: any) => tool.name), ["read_file", "search_text"]);
    const read = tools.find((tool: any) => tool.name === "read_file");
    const output = await read.execute("read", { path: "src/a.ts", startLine: 2, endLine: 2 });
    assert.match(output.content[0].text, /2.*second/);
    assert.deepEqual([...readLines.get("src/a.ts")!], [2]);
    await assert.rejects(read.execute("bad", { path: "escape" }));
    await assert.rejects(read.execute("bad", { path: "../.env" }));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(collectHealthFiles(root, job.scope, controller.signal));
    await Promise.all(Array.from({length:201},(_,index)=>writeFile(join(root,"src",`${String(index).padStart(3,"0")}.ts`),"export const value = 1;")));
    await exec("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "add", "src"]);
    const bounded = await collectHealthFiles(root, { ...job.scope, includePaths:["src/**"] }, signal);
    assert.equal(bounded.files.size,200);
    assert.equal(bounded.limited,true);
    assert.equal(bounded.skippedFileCount,2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Health CI 区分权限、目标 SHA、历史记录、窗口外与截断", async () => {
  const { collectHealthCi } = await healthApi();
  const run = { id: 1, name: "CI", head_branch: "main", head_sha: job.headSha, status: "completed", conclusion: "failure", updated_at: "2026-09-11T00:00:00Z", html_url: "https://github.com/owner/repo/actions/runs/1" };
  const github = {
    healthChecks: async () => { throw new GitHubApiError("/checks", 403); },
    healthWorkflows: async () => ({ total_count: 101, workflow_runs: [run, { ...run, id: 2, head_sha: "b".repeat(40) }, { ...run, id: -1 }, { ...run, id: 3, updated_at: "2026-08-01T00:00:00Z" }] }),
  };
  const result = await collectHealthCi(github, "token", job, new AbortController().signal);
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources.find((item: any) => item.id === "workflow:1").target, true);
  assert.equal(result.sources.find((item: any) => item.id === "workflow:2").target, false);
  assert(result.missingData.some((item: any) => item.reason === "permission_denied"));
  assert(result.missingData.some((item: any) => item.reason === "outside_window"));
  assert(result.missingData.some((item: any) => item.reason === "truncated"));
  assert(result.missingData.some((item: any) => item.reason === "invalid_record"));
});

test("Health 趋势只比较同口径的完整维度，数量下降不生成修复判定", async () => {
  const { compareHealthReports } = await healthApi();
  const base: HealthReport = { version: 1, jobId: job.id, repositoryId: 1, repository: job.repository, headSha: job.headSha, defaultBranch: "main", windowStart: job.windowStart, windowEnd: job.windowEnd, collectedAt: job.windowEnd, completedAt: job.windowEnd, status: "succeeded", scope: job.scope, model: "test/model", durationMs: 1, usage: emptyUsage(), comparisonKey: "same", coverage: { eligibleFiles: 1, files: [{ path: "src/a.ts", totalLines: 3, readLines: 3 }], skippedFiles: [], memoryReferences: [] }, sources: [], missingData: [], result: { summary: "sample", findings: [], limitations: [] } };
  const previous = { ...base, jobId: "previous", result: { ...base.result, findings: [{ id: "previous-finding", dimension: "code", severity: "high", evidenceLevel: "strong", description: "old", impact: "impact", suggestion: "suggestion", references: [] }] } };
  const compared = compareHealthReports(base, previous);
  assert.equal(compared.dimensions.find((item: any) => item.dimension === "code").delta, -1);
  assert.equal("fixed" in compared, false);
  assert(compareHealthReports({ ...base, comparisonKey: "changed" }, previous).dimensions.every((item: any) => !item.comparable));
  const partial = compareHealthReports({ ...base, status: "partial", missingData: [{ source: "checks", reason: "permission_denied", detail: "无权限" }] }, previous);
  assert.equal(partial.dimensions.find((item: any) => item.dimension === "ci").comparable, false);
  assert.equal(partial.dimensions.find((item: any) => item.dimension === "code").comparable, true);
});

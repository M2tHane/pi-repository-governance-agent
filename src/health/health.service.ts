import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join, matchesGlob } from "node:path";
import { promisify } from "node:util";
import { Integer, Object as ObjectSchema, Optional, String as StringSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { GitHubApiError, GitHubClient } from "../github/client.js";
import { readWorkspaceFile } from "../workspace/workspace.js";
import type { HealthDimension, HealthFinding, HealthMissingData, HealthReference, HealthReport, HealthResult, HealthScope, HealthSource } from "./types.js";
import type { HealthJob } from "../jobs/types.js";
import type { MemoryRecord } from "../memory/types.js";

const exec = promisify(execFile);
export const HEALTH_VERSION = "health-v1";
export const HEALTH_LIMITS = { files: 200, fileBytes: 65_536, totalBytes: 2_097_152, toolChars: 16_000, toolLines: 200, ciRecords: 50, timeoutMs: 120_000 };
export const healthDimensions: HealthDimension[] = ["code", "ci", "dependencies", "documentation"];

function fields(value: unknown, allowed: string[], label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`Health ${label} 结构无效`);
  return value as Record<string, any>;
}
function text(value: unknown, label: string, max = 4000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Health ${label} 文本无效`);
  return value.trim();
}

export function parseHealthResult(raw: string, binding: { job: HealthJob; files: Map<string, string>; readLines: Map<string, Set<number>>; sources: HealthSource[]; memories: MemoryRecord[] }): HealthResult {
  if (raw.length > 60_000) throw new Error("Health 结果过长");
  let parsed: unknown;
  try { parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
  catch { throw new Error("HealthResult 不是合法 JSON"); }
  const value = fields(parsed, ["summary", "findings", "limitations"], "结果");
  const summary = text(value.summary, "summary", 8000);
  if (!Array.isArray(value.findings) || value.findings.length > 30 || !Array.isArray(value.limitations) || value.limitations.length > 30) throw new Error("Health findings/limitations 无效");
  const findings = new Map<string, HealthFinding>();
  for (const rawFinding of value.findings) {
    const item = fields(rawFinding, ["dimension", "severity", "evidenceLevel", "description", "impact", "suggestion", "references"], "finding");
    if (!healthDimensions.includes(item.dimension) || !["low", "medium", "high", "critical"].includes(item.severity) || !["weak", "moderate", "strong"].includes(item.evidenceLevel) || !Array.isArray(item.references) || !item.references.length || item.references.length > 12) throw new Error("Health finding 分类或证据无效");
    const references: HealthReference[] = item.references.map((rawReference: unknown) => {
      const ref = fields(rawReference, ["kind", "path", "line", "sourceId", "id", "version", "detail"], "reference");
      const detail = text(ref.detail, "证据");
      if (ref.kind === "code") {
        const path = text(ref.path, "path", 1000), content = binding.files.get(path);
        if (path.startsWith("/") || path.split("/").includes("..") || content === undefined || !Number.isSafeInteger(ref.line) || ref.line < 1 || ref.line > content.split(/\r?\n/).length || !binding.readLines.get(path)?.has(ref.line)) throw new Error("Health 代码证据未读取或越界");
        return { kind: "code", path, line: ref.line, detail };
      }
      if (ref.kind === "ci" && typeof ref.sourceId === "string" && binding.sources.some((source) => source.id === ref.sourceId)) return { kind: "ci", sourceId: ref.sourceId, detail };
      if (ref.kind === "memory" && binding.memories.some((memory) => memory.id === ref.id && memory.version === ref.version && memory.repositoryId === binding.job.repositoryId && memory.status === "ACTIVE")) return { kind: "memory", id: ref.id, version: ref.version, detail };
      throw new Error("Health 引用了未提供的来源或 Memory");
    });
    if (!references.some((reference) => reference.kind !== "memory")) throw new Error("Health finding 缺少代码或 CI 证据");
    const description = text(item.description, "description"), impact = text(item.impact, "impact"), suggestion = text(item.suggestion, "suggestion");
    const id = "health_finding_" + createHash("sha256").update(JSON.stringify([binding.job.id, item.dimension, description, references])).digest("hex").slice(0, 24);
    findings.set(id, { id, dimension: item.dimension, severity: item.severity, evidenceLevel: item.evidenceLevel, description, impact, suggestion, references });
  }
  return { summary, findings: [...findings.values()], limitations: value.limitations.map((item: unknown) => text(item, "limitation")) };
}

export async function collectHealthFiles(root: string, scope: HealthScope, signal: AbortSignal) {
  signal.throwIfAborted();
  const { stdout } = await exec("git", ["-C", root, "ls-files", "-z"], { signal, maxBuffer: 4 * 1024 * 1024 });
  const paths = stdout.split("\0").filter((path) => path && (!scope.includePaths.length || scope.includePaths.some((pattern) => matchesGlob(path, pattern))) && !scope.excludePaths.some((pattern) => matchesGlob(path, pattern))).sort();
  const files = new Map<string, string>(), skippedFiles: Array<{ path: string; reason: string }> = [];
  let totalBytes = 0, skippedFileCount = 0, limited = false;
  const skip = (path: string, reason: string) => { skippedFileCount++; if (skippedFiles.length < 200) skippedFiles.push({ path, reason }); if (reason !== "binary") limited = true; };
  for (const path of paths) {
    signal.throwIfAborted();
    if (files.size >= HEALTH_LIMITS.files) { skip(path, "file_limit"); continue; }
    try {
      const info = await lstat(join(root, path));
      if (!info.isFile() || info.isSymbolicLink()) { skip(path, "not_regular_file"); continue; }
      if (info.size > HEALTH_LIMITS.fileBytes || totalBytes + info.size > HEALTH_LIMITS.totalBytes) { skip(path, "byte_limit"); continue; }
      const content = await readWorkspaceFile(root, path, signal);
      if (content.includes("\0") || content.includes("\uFFFD")) { skip(path, "binary"); continue; }
      files.set(path, content); totalBytes += info.size;
    } catch (error) { signal.throwIfAborted(); skip(path, "unreadable"); }
  }
  return { files, eligibleFiles: paths.length, skippedFiles, skippedFileCount, limited };
}

export function healthTools(files: Map<string, string>, readLines: Map<string, Set<number>>, signal: AbortSignal): ToolDefinition[] {
  const record = (path: string, line: number) => { const seen = readLines.get(path) ?? new Set<number>(); seen.add(line); readLines.set(path, seen); };
  return [
    {
      name: "read_file", label: "Read health source", description: "读取服务已选定的文件行；每次最多 200 行和 16000 字符。",
      parameters: ObjectSchema({ path: StringSchema(), startLine: Optional(Integer({ minimum: 1 })), endLine: Optional(Integer({ minimum: 1 })) }, { additionalProperties: false }),
      async execute(_id, rawArgs) {
        const args = rawArgs as { path: string; startLine?: number; endLine?: number };
        signal.throwIfAborted();
        const content = files.get(args.path);
        if (content === undefined) throw new Error("文件不在健康检查范围内");
        const lines = content.split(/\r?\n/), start = args.startLine ?? 1, end = args.endLine ?? start + HEALTH_LIMITS.toolLines - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || start > lines.length) throw new Error("读取行号无效");
        const output: string[] = []; let size = 0;
        for (let index = start - 1; index < Math.min(end, lines.length, start - 1 + HEALTH_LIMITS.toolLines); index++) {
          const line = `${index + 1}\t${lines[index]}`;
          if (size + line.length > HEALTH_LIMITS.toolChars) break;
          output.push(line); size += line.length + 1; record(args.path, index + 1);
        }
        return { content: [{ type: "text", text: `${args.path} (${lines.length} lines)\n${output.join("\n")}${output.length < Math.min(end, lines.length) - start + 1 ? "\n内容达到读取上限，未返回的行尚未检查。" : ""}` }], details: {} };
      },
    },
    {
      name: "search_text", label: "Search health sources", description: "在已选定文本内查找字面文本；最多返回 50 行。",
      parameters: ObjectSchema({ query: StringSchema({ minLength: 1, maxLength: 400 }) }, { additionalProperties: false }),
      async execute(_id, { query }) {
        signal.throwIfAborted();
        if (typeof query !== "string" || !query || query.length > 400) throw new Error("查询无效");
        const output: string[] = [];
        for (const [path, content] of files) {
          signal.throwIfAborted();
          for (const [index, line] of content.split(/\r?\n/).entries()) if (line.includes(query)) {
            output.push(`${path}:${index + 1}:${line.slice(0, 300)}`);
            if (line.length <= 300) record(path, index + 1);
            if (output.length >= 50) break;
          }
          if (output.length >= 50) break;
        }
        return { content: [{ type: "text", text: output.join("\n") || "未找到" }], details: {} };
      },
    },
  ];
}

export async function collectHealthCi(github: GitHubClient, token: string, job: HealthJob, signal: AbortSignal) {
  signal.throwIfAborted();
  const batches = await Promise.allSettled([
    github.healthChecks(token, job.repository, job.headSha, signal),
    github.healthWorkflows(token, job.repository, job.defaultBranch, job.windowStart, job.windowEnd, signal),
  ]);
  signal.throwIfAborted();
  const sources: HealthSource[] = [], missingData: HealthMissingData[] = [];
  const missing = (source: string, reason: string, detail: string) => { if (!missingData.some((item) => item.source === source && item.reason === reason)) missingData.push({ source, reason, detail }); };
  for (const [index, batch] of batches.entries()) {
    const source = index === 0 ? "checks" : "workflows", kind = index === 0 ? "check" : "workflow";
    if (batch.status === "rejected") {
      const denied = batch.reason instanceof GitHubApiError && [401, 403].includes(batch.reason.status);
      missing(source, denied ? "permission_denied" : "fetch_failed", denied ? "App 没有读取该 CI 来源的权限。" : "无法取得该 CI 来源，未推导检查结论。");
      continue;
    }
    const value = batch.value as any, entries = index === 0 ? value.check_runs : value.workflow_runs;
    if (!Array.isArray(entries)) { missing(source, "invalid_response", "CI 响应结构无效。"); continue; }
    if (!entries.length) missing(source, "no_records", "没有可用的 CI 记录。");
    if (value.total_count > entries.length || entries.length > HEALTH_LIMITS.ciRecords) missing(source, "truncated", "CI 记录只采集有界的第一页与最多 50 项来源。");
    for (const entry of entries.slice(0, 100)) {
      if (sources.length >= HEALTH_LIMITS.ciRecords) { missing(source, "truncated", "达到 CI 来源总数上限。"); break; }
      const timestamp = entry.completed_at ?? entry.updated_at ?? entry.started_at ?? entry.created_at;
      const at = new Date(timestamp).getTime();
      if (!Number.isSafeInteger(entry.id) || entry.id <= 0 || !/^[a-f0-9]{40}$/i.test(entry.head_sha ?? "") || !Number.isFinite(at) || typeof entry.status !== "string") { missing(source, "invalid_record", "部分 CI 记录缺少可信的身份、SHA 或时间。"); continue; }
      if (at < Date.parse(job.windowStart) || at > Date.parse(job.windowEnd)) { missing(source, "outside_window", "部分 CI 状态更新时间不在固定窗口内。"); continue; }
      if (index === 0 && entry.head_sha !== job.headSha || index === 1 && entry.head_branch !== job.defaultBranch) { missing(source, "snapshot_mismatch", "部分 CI 记录不属于目标提交或默认分支。"); continue; }
      let url: URL;
      try { url = new URL(entry.html_url); } catch { missing(source, "invalid_record", "CI 来源链接无效。"); continue; }
      if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.toLowerCase().startsWith(`/${job.repository.toLowerCase()}/`)) { missing(source, "invalid_record", "CI 来源链接不属于当前仓库。"); continue; }
      sources.push({ id: `${kind}:${entry.id}`, kind, name: String(entry.name ?? source).slice(0, 200), sha: entry.head_sha, status: entry.status, conclusion: typeof entry.conclusion === "string" ? entry.conclusion : null, at: new Date(at).toISOString(), url: url.href, target: entry.head_sha === job.headSha });
      if (entry.status !== "completed") missing(source, "in_progress", "部分 CI 尚未完成，不能作为通过证据。");
    }
  }
  if (!sources.some((source) => source.target)) missing("checks", "no_matching_sha", "没有窗口内属于目标 SHA 的可用 CI 记录。");
  return { sources, missingData };
}

export function compareHealthReports(current: HealthReport, previous?: HealthReport) {
  const same = previous && current.repositoryId === previous.repositoryId && current.comparisonKey === previous.comparisonKey;
  const sources: Record<HealthDimension, string[]> = { code: ["files", "memory", "analysis"], ci: ["checks", "workflows", "analysis"], dependencies: ["files", "dependencies", "analysis"], documentation: ["files", "analysis"] };
  return { previousJobId: previous?.jobId, dimensions: healthDimensions.map((dimension) => {
    const missing = [...current.missingData, ...(previous?.missingData ?? [])].some((item) => sources[dimension].includes(item.source));
    const incompleteFiles = dimension !== "ci" && [current, previous].some((report) => report?.coverage.files.some((file) => file.readLines < file.totalLines));
    const comparable = Boolean(same && !missing && !incompleteFiles);
    const after = current.result.findings.filter((finding) => finding.dimension === dimension), before = previous?.result.findings.filter((finding) => finding.dimension === dimension) ?? [];
    const severity = (findings: HealthFinding[]) => Object.fromEntries(["critical", "high", "medium", "low"].map((level) => [level, findings.filter((finding) => finding.severity === level).length]));
    return { dimension, comparable, reason: !previous ? "暂无可比较报告" : !same ? "范围、模型、窗口或规则版本不同" : !comparable ? "本次或上次的该维度覆盖不完整" : "仅比较观察数量，不表示问题已修复", before: before.length, after: after.length, delta: comparable ? after.length - before.length : null, previousSeverity: severity(before), currentSeverity: severity(after) };
  }) };
}

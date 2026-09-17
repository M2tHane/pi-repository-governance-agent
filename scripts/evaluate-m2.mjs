// 固定 M2 样本；只调用模型，不发布 GitHub Review，不执行样本代码。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { runAgentReview } from "../dist/src/review/agent.js";
import { complexityProfile, orchestrateReview, shouldOrchestrate } from "../dist/src/review/orchestration.js";
import { validateMemoryReferences } from "../dist/src/review/review.processor.js";

const exec = promisify(execFile);
const root = resolve(process.argv[2] ?? "work/m2-eval-snapshot");
const headSha = "ad75aa1e1f1a3604682af068c2c048da23bbbe7a";
const baseSha = "3e02a7c59b073547da3c466987d4d8570df31484";
const git = async (...args) => (await exec("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args])).stdout.trim();
if (await git("rev-parse", "HEAD") !== headSha || await git("status", "--porcelain")) throw new Error("样本必须是干净的固定 head checkout");
for (const name of ["MODEL_PROVIDER", "MODEL_NAME", "MODEL_API_KEY"]) if (!process.env[name]) throw new Error("缺少 " + name);
const config = { modelProvider: process.env.MODEL_PROVIDER, modelName: process.env.MODEL_NAME, modelApiKey: process.env.MODEL_API_KEY, agentTimeoutMs: 300_000 };
const names = (await git("diff", "--name-only", baseSha, headSha)).split("\n");
const files = await Promise.all(names.map(async filename => ({ filename, status: "added", patch: await git("diff", "--no-ext-diff", "--no-textconv", baseSha, headSha, "--", filename) })));
const now = new Date().toISOString();
const memory = { id: "11111111-1111-4111-8111-111111111111", version: 1, repositoryId: 1364052429, installationId: 160592861, type: "security_rule", title: "CSV spreadsheet safety", content: "Every exported text cell starting with =, +, -, or @ must be made inert before spreadsheet use.", rationale: "User-supplied labels must not execute spreadsheet formulas.", scope: { paths: ["backend/reporting/**"] }, source: { pullRequestNumber: 6, commitSha: baseSha, commentIds: [] }, evidence: [], confidence: 1, uncertainties: [], status: "ACTIVE", createdAt: now, updatedAt: now };
const cases = [
  { name: "complex", paths: names },
  { name: "java", paths: ["backend/service/LedgerService.java", "backend/storage/LedgerStore.java"] },
  { name: "security", paths: ["backend/auth/Session.java", "backend/api/TransferController.java", "backend/api/ReportController.java"] },
  { name: "architecture", paths: ["backend/api/ReportController.java", "backend/reporting/CsvReport.java", "backend/storage/LedgerStore.java"] },
  { name: "memory", paths: ["backend/reporting/CsvReport.java"], memories: [memory, { ...memory, id: "22222222-2222-4222-8222-222222222222", type: "exception", title: "Internal machine export", content: "Internal machine-only exports may preserve raw labels; this exception does not cover CSV files opened in spreadsheets.", scope: { paths: ["backend/reporting/**"] }, exceptionTo: memory.id }] },
  { name: "small", paths: ["docs/payments.md"] },
];
const selectiveOnly = process.argv.includes("--selective-only");
const requested = process.argv.slice(3).filter(value => value !== "--selective-only");
const report = { createdAt: now, repository: "M2tHane/pi-review-test-repository", baseSha, headSha, budgetTokens: 160_000, note: "固定提交的本地模型对照；memory 场景使用合成 ACTIVE Memory，不写入数据库；不替代真实 webhook 或维护者确认。", cases: [] };
const output = resolve("work/m2-evaluation.json");
const previous = selectiveOnly ? JSON.parse(await readFile(output, "utf8")) : undefined;
if (previous && (previous.headSha !== headSha || previous.budgetTokens !== report.budgetTokens)) throw new Error("不能复用不同提交或预算的 baseline");
if (previous) report.cases = previous.cases;
await mkdir(join(output, ".."), { recursive: true });
for (const sample of cases.filter(sample => !requested.length || requested.includes(sample.name))) {
  const changedFiles = files.filter(file => sample.paths.includes(file.filename)), memories = sample.memories ?? [];
  const job = { id: randomUUID(), deliveryId: "local-evaluation", jobType: "PR_REVIEW", repository: report.repository, repositoryId: 1364052429, installationId: 160592861, prNumber: 6, title: "Payment transfer and CSV reporting", body: "Review the current changes using the repository contract. Local fixed evaluation: " + sample.name, baseSha, headSha, status: "running", cloneUrl: "" };
  const entry = { name: sample.name, paths: sample.paths, syntheticMemories: memories.length > 0, profile: complexityProfile(changedFiles, memories), agentRuns: [] };
  if (selectiveOnly) {
    entry.single = previous.cases.find(value => value.name === sample.name)?.single;
    if (!entry.single) throw new Error("缺少已记录 baseline: " + sample.name);
    entry.singleRecordedAt = previous.cases.find(value => value.name === sample.name)?.singleRecordedAt ?? previous.createdAt;
  }
  const database = {
    async startAgentRun(jobId, role, budget, timeoutMs, parentRunId) { const id = randomUUID(); entry.agentRuns.push({ id, jobId, role, budget, timeoutMs, parentRunId }); return id; },
    async finishAgentRun(id, value) { Object.assign(entry.agentRuns.find(run => run.id === id), value); },
  };
  const validate = run => {
    for (const finding of run.result.findings) if (finding.path && !sample.paths.includes(finding.path)) throw Object.assign(new Error("finding outside selected change: " + finding.path), { usage: run.usage });
    validateMemoryReferences(run.result, memories, job.repositoryId);
    return run;
  };
  for (const mode of selectiveOnly ? ["selective"] : ["single", "selective"]) {
    try {
      if (mode === "selective" && !shouldOrchestrate(entry.profile, "auto")) entry[mode] = { ...entry.single, mode: "single", reusedBaseline: true };
      else entry[mode] = validate(mode === "single"
        ? await runAgentReview({ root, provider: config.modelProvider, modelName: config.modelName, apiKey: config.modelApiKey, timeoutMs: config.agentTimeoutMs, budgetTokens: report.budgetTokens, title: job.title, body: job.body, baseSha, headSha, changedFiles, memories })
        : await orchestrateReview({ config, database, job, root, files: changedFiles, memories, budgetTokens: report.budgetTokens, maxDelegates: 2, signal: new AbortController().signal }));
    } catch (error) {
      entry[mode] = { error: error.message, usage: error.usage, durationMs: error.durationMs };
    }
    console.log(JSON.stringify({ sample: sample.name, mode, error: entry[mode]?.error, durationMs: entry[mode]?.durationMs, usage: entry[mode]?.usage, findings: entry[mode]?.result?.findings.length }));
  }
  const index = report.cases.findIndex(value => value.name === sample.name);
  if (index < 0) report.cases.push(entry); else report.cases[index] = entry;
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify({ output, cases: report.cases.length }));

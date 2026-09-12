import assert from "node:assert/strict";
import test from "node:test";
import { BudgetLedger, delegateAgent, type DelegateContext } from "../src/delegation.js";
import { aggregate, allowedRoles, complexityProfile, orchestrateReview, shouldOrchestrate } from "../src/orchestration.js";
import type { Config } from "../src/config.js";
import type { Database } from "../src/database.js";
import type { Finding, MemoryRecord, ReviewJob } from "../src/types.js";
import { emptyUsage, type runAgentSession } from "../src/review.js";
import { findingIdentity } from "../src/finding.js";

const config = { modelProvider: "test", modelName: "test", modelApiKey: "x", agentTimeoutMs: 1000 } as Config;
const job = { id: "job", deliveryId: "delivery", installationId: 1, repositoryId: 2, repository: "owner/repo", cloneUrl: "url", prNumber: 3, title: "", body: "", baseSha: "base", headSha: "head", status: "running" } satisfies ReviewJob;
const finding = { path: "auth/a.ts", line: 2, side: "RIGHT", category: "security", severity: "high", evidenceLevel: "strong", description: "missing authorization", evidence: "handler has no guard", impact: "data leak" } satisfies Finding;

function fakeDatabase() {
  const runs: any[] = [];
  return { runs, startAgentRun: async (...args: any[]) => { const id = `run-${runs.length}`; runs.push({ id, start: args }); return id; }, finishAgentRun: async (id: string, value: any) => { runs.find((run) => run.id === id).finish = value; } } as any as Database & { runs: any[] };
}

const fakeMain: typeof runAgentSession = async (input) => {
  assert.deepEqual(input.tools?.map((tool) => tool.name), ["delegate_agent"]);
  assert.equal(input.parallelTools, true);
  const tool = input.tools![0]!;
  const results = await Promise.all(["general_review", "security_reviewer"].map((role) => tool.execute(role, { role, objective: "check boundary", maxTokens: 300, timeoutMs: 500 }, input.signal, undefined, {} as never)));
  const keys = results.flatMap((result) => { const value = JSON.parse((result.content[0] as { text: string }).text); return value.findings?.map((finding: { key: string }) => finding.key) ?? []; });
  return { text: JSON.stringify({ summary: "部分检查完成", findingGroups: keys.length ? [keys] : [] }), durationMs: 1, model: "test", usage: { ...emptyUsage(), input: 8, output: 2, totalTokens: 10 } };
};

test("ComplexityProfile 让小改动走 single，只为真实维度开放角色", () => {
  const simple = complexityProfile([{ filename: "README.md", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }], []);
  assert.equal(shouldOrchestrate(simple, "auto"), false);
  const complex = complexityProfile([{ filename: "auth/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-token\n+secret" }, { filename: "api/b.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }], []);
  assert.equal(shouldOrchestrate(complex, "auto"), true);
  assert.deepEqual(allowedRoles(complex), ["general_review", "security_reviewer"]);
  assert.equal(shouldOrchestrate(complex, "single"), false);
  const java = complexityProfile([{ filename: "src/A.java", status: "modified" }, { filename: "src/B.java", status: "modified" }], []);
  assert(allowedRoles(java).includes("java_reviewer"));
  const memory = { id: "a", type: "engineering_rule", scope: { paths: ["auth/**"] } } as MemoryRecord;
  assert.equal(complexityProfile([{ filename: "auth/a.ts", status: "modified" }], [memory, { ...memory, id: "b", scope: { paths: ["data/**"] } }]).possibleMemoryConflict, false);
  assert.equal(complexityProfile([{ filename: "auth/a.ts", status: "modified" }], [memory, { ...memory, id: "b" }]).possibleMemoryConflict, true);
});

test("delegate 拒绝 role、depth、越界 path/Memory、超预算", async () => {
  const database = fakeDatabase(), controller = new AbortController();
  const base = { config, database, job, root: "/tmp", files: [{ filename: "auth/a.ts", status: "modified" }], memories: [], allowedRoles: ["security_reviewer"], ledger: new BudgetLedger(100, 1), deadline: Date.now() + 1000, signal: controller.signal, parentRunId: "parent", depth: 0 } satisfies DelegateContext;
  const execute = async () => ({ result: { summary: "", findings: [], coverage: [], limitations: [] }, durationMs: 1, model: "test", usage: { ...emptyUsage(), input: 1, output: 1, totalTokens: 2 } });
  await assert.rejects(delegateAgent({ ...base, depth: 1 }, { role: "security_reviewer", objective: "x", maxTokens: 10, timeoutMs: 100 }, execute), /depth/);
  await assert.rejects(delegateAgent(base, { role: "java_reviewer", objective: "x", maxTokens: 10, timeoutMs: 100 }, execute), /role/);
  await assert.rejects(delegateAgent(base, { role: "security_reviewer", objective: "x", focusPaths: ["../secret"], maxTokens: 10, timeoutMs: 100 }, execute), /path/);
  await assert.rejects(delegateAgent(base, { role: "security_reviewer", objective: "x", relevantMemoryIds: [{ id: "x", version: 1 }], maxTokens: 10, timeoutMs: 100 }, execute), /Memory/);
  await assert.rejects(delegateAgent(base, { role: "security_reviewer", objective: "x", maxTokens: 101, timeoutMs: 100 }, execute), /budget/);
});

test("parent abort 传播给 child，失败 child 形成 partial 且 finding 去重", async () => {
  const database = fakeDatabase(), controller = new AbortController();
  const files = [{ filename: "auth/a.ts", status: "modified", patch: "@@ -1 +1,2 @@\n token\n+guard" }, { filename: "api/b.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }];
  let child = 0;
  const result = await orchestrateReview({ config, database, job, root: "/tmp", files, memories: [], budgetTokens: 1000, maxDelegates: 2, signal: controller.signal }, async (_context, input) => {
    child++;
    if (input.role === "security_reviewer") throw new Error("timeout");
    return { role: input.role, result: { summary: "found", findings: [finding, { ...finding }], coverage: ["auth"], limitations: [] }, durationMs: 1, model: "test", usage: { ...emptyUsage(), input: 10, output: 5, totalTokens: 15 } };
  }, fakeMain);
  assert.equal(child, 2);
  assert.equal(result.result.findings.length, 1);
  assert.equal(result.orchestration.partial, true);
  assert.deepEqual(result.orchestration.rolesFailed, ["security_reviewer"]);
  assert.equal(result.usage.totalTokens, 25);
  assert.equal(database.runs[0].finish.status, "partial");

  const signal = new AbortController(), context = { config, database, job, root: "/tmp", files, memories: [], allowedRoles: ["general_review"], ledger: new BudgetLedger(100, 1), deadline: Date.now() + 1000, signal: signal.signal, parentRunId: "parent", depth: 0 } satisfies DelegateContext;
  const pending = delegateAgent(context, { role: "general_review", objective: "x", maxTokens: 100, timeoutMs: 900 }, async (input) => await new Promise((_resolve, reject) => input.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
  signal.abort("cancelled");
  await assert.rejects(pending, /aborted|cancelled/);
});

test("Main 失败只允许有记录的已校验子结果 fallback，父取消禁止 fallback", async () => {
  const database = fakeDatabase(), controller = new AbortController();
  const input = { config, database, job, root: "/tmp", files: [{ filename: "auth/a.ts", status: "modified" }], memories: [], budgetTokens: 1000, maxDelegates: 2, signal: controller.signal };
  const child: typeof delegateAgent = async (_context, args) => ({ role: args.role, result: { summary: "ok", findings: [], coverage: ["boundary"], limitations: [] }, durationMs: 1, model: "test", usage: { ...emptyUsage(), input: 4, totalTokens: 4 } });
  const failMain: typeof runAgentSession = async (args) => { await fakeMain(args); throw Object.assign(new Error("Main budget exhausted"), { usage: { ...emptyUsage(), input: 9, totalTokens: 9 } }); };
  const result = await orchestrateReview(input, child, failMain);
  assert.equal(result.orchestration.fallback, "validated_children");
  assert.equal(result.usage.totalTokens, 17);
  assert.match(result.result.limitations.join(" "), /Main.*未完成/);
  await assert.rejects(orchestrateReview(input, child, async () => { throw new Error("Main failed before delegate"); }), /Main failed/);
  await assert.rejects(orchestrateReview(input, child, async (args) => { const run = await fakeMain(args); controller.abort("superseded"); return run; }), /superseded/);
  assert.equal(database.runs.at(-1).finish.status, "cancelled");
});

test("共享请求预留与并发上限阻止 N 倍预算，聚合保留专项分歧", () => {
  const ledger = new BudgetLedger(1000, 4);
  ledger.startDelegate(600); ledger.startDelegate(600);
  assert.throws(() => ledger.startDelegate(100), /concurrency/);
  ledger.reserve(700);
  assert.throws(() => ledger.reserve(301), /预算/);
  ledger.settle(700, 400);
  assert.equal(ledger.remaining, 600);
  assert.throws(() => ledger.startDelegate(601), /budget/);
  const result = aggregate(job, [
    { role: "general_review", result: { summary: "A", findings: [{ ...finding, suggestion: "fail closed" }], coverage: ["A"], limitations: [] }, durationMs: 1, model: "test", usage: emptyUsage() },
    { role: "security_reviewer", result: { summary: "B", findings: [{ ...finding, evidence: "caller data flow", suggestion: "allow fallback" }], coverage: ["B"], limitations: [] }, durationMs: 1, model: "test", usage: emptyUsage() },
  ], []);
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0]!.evidence, /caller data flow/);
  assert.match(result.findings[0]!.suggestion!, /fail closed.*[\s\S]*allow fallback/);
  assert.match(result.limitations.join(" "), /人工确认/);
  const runs: Awaited<ReturnType<typeof delegateAgent>>[] = [
    { role: "general_review", result: { summary: "A", findings: [finding], coverage: [], limitations: [] }, durationMs: 1, model: "test", usage: emptyUsage() },
    { role: "security_reviewer", result: { summary: "B", findings: [{ ...finding, category: "correctness", line: 3, evidence: "same root cause at another call" }], coverage: [], limitations: [] }, durationMs: 1, model: "test", usage: emptyUsage() },
  ];
  const keys = runs.map(run => `${run.role}:${findingIdentity(job, run.result.findings[0]!).id}:0`);
  assert.equal(aggregate(job, runs, [], [keys]).findings.length, 1);
  assert.throws(() => aggregate(job, runs, [], []), /遗漏/);
  assert.throws(() => aggregate(job, runs, [], [["foreign"]]), /未知/);
  assert.throws(() => aggregate(job, runs, [], [keys, [keys[0]!]]), /重复/);
});

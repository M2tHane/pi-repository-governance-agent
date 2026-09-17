import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { Database } from "../../src/persistence/database.js";
import { PersistentRunner } from "../../src/jobs/runner.js";
import { MemoryService } from "../../src/memory/memory.service.js";
import type { DecisionProposal } from "../../src/memory/types.js";
import type { ReplyResult } from "../../src/reply/types.js";
import type { ReviewJob } from "../../src/jobs/types.js";
import { createServer } from "node:http";
import { createAdminHandler } from "../../src/admin/handler.js";
import type { Config } from "../../src/config/config.js";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { emptyUsage } from "../../src/review/agent.js";
import { groupFindings } from "../../src/review/presentation.js";
import { GitHubApiError } from "../../src/github/client.js";
import { createApp } from "../../src/github/webhook/handler.js";
import { useTestDatabase, waitFor } from "../helpers/database.js";

const fixture = useTestDatabase();

test("Health Job 独立于 PR、活动任务去重、PR 优先且报告与终态原子保存", { skip: !fixture.url }, async () => {
  const database: any = new Database(fixture.url!);
  const repositoryId = 9_000_000_020;
  try {
    assert.equal(typeof database.enqueueHealth, "function", "缺少仓库级健康任务入口");
    await database.pool.query("INSERT INTO repositories(id,installation_id,full_name,budget_tokens) VALUES($1,1,'owner/health-test',10000)", [repositoryId]);
    const at = new Date("2026-09-12T00:00:00Z");
    const snapshot = { defaultBranch: "main", headSha: "a".repeat(40) };
    const [first, repeated] = await Promise.all([database.enqueueHealth(repositoryId, snapshot, "manual", at), database.enqueueHealth(repositoryId, snapshot, "manual", at)]);
    assert.equal(first.job.id, repeated.job.id);
    assert.deepEqual([first.kind, repeated.kind].sort(), ["accepted", "duplicate"]);
    assert.equal(first.job.jobType, "HEALTH_AUDIT");
    assert.equal(first.job.prNumber, undefined);
    assert.equal(first.job.deliveryId, undefined);
    assert.equal(first.job.windowEnd, at.toISOString());
    assert.equal(first.job.windowStart, "2026-08-13T00:00:00.000Z");
    assert.equal(first.job.scope.budgetTokens, 10000);
    const raw = (await database.pool.query("SELECT pr_number,base_sha,delivery_id FROM jobs WHERE id=$1", [first.job.id])).rows[0];
    assert.deepEqual(raw, { pr_number: null, base_sha: null, delivery_id: null });
    const review = await database.accept({ deliveryId: "m3-pr-priority", installationId: 1, repositoryId, repository: "owner/health-test", cloneUrl: "https://github.com/owner/health-test.git", prNumber: 1, title: "PR priority", body: "", baseSha: "base", headSha: "head" }, { event: "pull_request", action: "opened" });
    const pr = await database.claimNext();
    assert.equal(pr.id, review.job.id);
    await database.finishJob(pr);
    const health = await database.claimNext();
    assert.equal(health.id, first.job.id);
    const controller = new AbortController();
    database.registerReviewAbort(health, controller);
    database.cancelReview(repositoryId, 1);
    assert.equal(controller.signal.aborted, false, "PR 事件不能取消仓库健康任务");
    const runId = await database.startAgentRun(health.id, "health_auditor", 10000, 1000);
    await database.checkpointAgentUsage(runId, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, unreportedTokens: 4500 });
    await database.recoverRunning();
    assert.equal((await database.healthUsage(health.id)).unreportedTokens, 4500);
    const recovered = await database.claimNext();
    assert.equal(recovered.headSha, snapshot.headSha);
    assert.equal(recovered.windowEnd, at.toISOString());
    const report = { jobId: recovered.id, repositoryId, headSha: recovered.headSha, status: "partial", result: { summary: "固定快照报告" } };
    assert.equal(await database.finishHealthReport(recovered, report), true);
    assert.deepEqual(await database.getHealthReport(recovered.id), report);
    assert.equal((await database.getJob(recovered.id)).status, "partial");
    assert.equal(await database.finishHealthReport(recovered, report), true);
    assert.equal(Number((await database.pool.query("SELECT count(*) FROM health_reports WHERE job_id=$1", [recovered.id])).rows[0].count), 1);
    await database.finishHealthReport(recovered, { ...report, status: "succeeded", result: { summary: "不同的重复结果" } });
    assert.deepEqual(await database.getHealthReport(recovered.id), report);
    assert.equal((await database.getJob(recovered.id)).status, "partial");
    const next = await database.enqueueHealth(repositoryId, { ...snapshot, headSha: "b".repeat(40) }, "manual", at);
    assert.notEqual(next.job.id, first.job.id);
    database.cancelRepository(repositoryId);
    assert.equal(controller.signal.aborted, true);
    await database.pool.query("UPDATE repositories SET enabled=false WHERE id=$1", [repositoryId]);
    assert.equal((await database.enqueueHealth(repositoryId, snapshot, "manual", at)).kind, "ignored");
  } finally {
    await database.pool.query("UPDATE jobs SET status='cancelled' WHERE repository_id=$1 AND status IN ('queued','running')", [repositoryId]);
    await database.close();
  }
});

test("Health Worker 完成固定快照报告、保留重试消耗，并在暂停时取消", { skip: !fixture.url }, async () => {
  const api: any = { ...(await import("../../src/health/health.processor.js")), ...(await import("../../src/health/health.scheduler.js")) };
  assert.equal(typeof api.createHealthProcessor, "function", "缺少 Health Worker");
  const database = new Database(fixture.url!);
  await mkdir(resolve("work"), { recursive: true });
  const root = await mkdtemp(resolve("work/m3-worker-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Health Test", "-c", "user.email=health@example.invalid", ...args], { encoding: "utf8" }).trim();
  let runner: PersistentRunner | undefined;
  try {
    git("init", "--quiet"); await mkdir(join(root, "src")); await writeFile(join(root, "src/a.ts"), "export const timeout = -1;\n");
    git("add", "."); git("commit", "--quiet", "-m", "test health snapshot");
    const sha = git("rev-parse", "HEAD"), repositoryId = 9_000_000_021;
    await database.pool.query("INSERT INTO repositories(id,installation_id,full_name,budget_tokens) VALUES($1,1,'owner/health-worker',10000)", [repositoryId]);
    const first = await database.enqueueHealth(repositoryId, { defaultBranch: "main", headSha: sha }, "manual");
    const abandoned = await database.startAgentRun(first.job!.id, "health_auditor", 10000, 1000);
    await database.finishAgentRun(abandoned, { status: "failed", usage: { ...emptyUsage(), unreportedTokens: 4000 } });
    const config = { allowedRepositories: new Set(["owner/health-worker"]), modelProvider: "test", modelName: "model", modelApiKey: "test", agentTimeoutMs: 5000 } as Config;
    const github = { installationToken: async () => "test", repositorySnapshot: async () => ({ defaultBranch: "main", headSha: "b".repeat(40) }), healthChecks: async () => { throw new GitHubApiError("checks", 403); }, healthWorkflows: async () => ({ total_count: 0, workflow_runs: [] }) };
    const entered = Promise.withResolvers<void>();
    let mode = "valid", calls = 0, workspace = "";
    const budgets: number[] = [];
    const execute = async (input: any) => {
      calls++; workspace = input.root; budgets.push(input.budgetTokens);
      await input.onUsage({ ...emptyUsage(), unreportedTokens: 1000 });
      if (mode === "wait") {
        const pending = new Promise<void>((_resolve, reject) => input.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
        entered.resolve(); await pending;
      }
      for (const file of input.prompt.files) await input.tools.find((tool: any) => tool.name === "read_file").execute("read", { path: file.path });
      const usage = { ...emptyUsage(), input: 100, output: 50, totalTokens: 150 };
      await input.onUsage(usage);
      return { text: mode === "invalid" ? "{}" : JSON.stringify({ summary: "检查到负数超时", findings: [{ dimension: "code", severity: "high", evidenceLevel: "strong", description: "超时常量为负数", impact: "立即超时", suggestion: "使用正数", references: [{ kind: "code", path: "src/a.ts", line: 1, detail: "负数声明" }] }], limitations: [] }), usage, model: "model", durationMs: 1 };
    };
    const processHealth = api.createHealthProcessor(config, database, new MemoryService(database), github, execute);
    runner = new PersistentRunner(database, async (job) => { assert.ok(job.jobType === "HEALTH_AUDIT"); job.cloneUrl = root; await processHealth(job); }, 10);
    await runner.start();
    await waitFor(async () => (await database.getJob(first.job!.id))?.status === "partial");
    const report = (await database.getHealthReport(first.job!.id))!;
    assert.equal(report.headSha, sha, "远端前进不改变已绑定快照");
    assert.equal(report.result.findings.length, 1);
    assert.equal(report.usage.totalTokens, 150);
    assert.equal(report.usage.unreportedTokens, 4000);
    assert.equal(budgets[0], 6000);
    await assert.rejects(access(workspace));
    await processHealth(first.job);
    assert.equal(calls, 1, "已有报告不再消费模型");
    mode = "invalid";
    const invalid = await database.enqueueHealth(repositoryId, { defaultBranch: "main", headSha: sha }, "manual");
    await waitFor(async () => (await database.getJob(invalid.job!.id))?.status === "failed");
    assert.equal(await database.getHealthReport(invalid.job!.id), undefined);
    assert.equal((await database.healthUsage(invalid.job!.id)).totalTokens, 150);
    mode = "wait";
    const cancelled = await database.enqueueHealth(repositoryId, { defaultBranch: "main", headSha: sha }, "manual");
    await entered.promise;
    await database.pool.query("UPDATE repositories SET enabled=false WHERE id=$1", [repositoryId]);
    database.cancelRepository(repositoryId);
    await waitFor(async () => (await database.getJob(cancelled.job!.id))?.status === "cancelled");
    assert.equal(await database.getHealthReport(cancelled.job!.id), undefined);
    assert.equal((await database.healthUsage(cancelled.job!.id)).unreportedTokens, 1000);
  } finally { await runner?.stop(); await rm(root, { recursive: true, force: true }); await database.close(); }
});

test("Health 手动／定时共用去重，UTC 周期重启只补一次，关闭定时保留活动任务", { skip: !fixture.url }, async () => {
  const api: any = { ...(await import("../../src/health/health.processor.js")), ...(await import("../../src/health/health.scheduler.js")) };
  assert.equal(typeof api.requestHealthAudit, "function", "缺少健康触发入口");
  const database = new Database(fixture.url!), repositoryId = 9_000_000_022;
  const now = new Date("2026-09-12T00:00:00Z"), later = new Date("2026-10-02T00:00:00Z");
  const config = { allowedRepositories: new Set(["owner/health-schedule"]), agentTimeoutMs: 5000 } as Config;
  let snapshots = 0;
  const github = { installationToken: async () => "test", repositorySnapshot: async () => { snapshots++; return { defaultBranch: "main", headSha: "a".repeat(40) }; } };
  const signal = new AbortController().signal;
  try {
    await database.pool.query("INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,'owner/health-schedule')", [repositoryId]);
    await api.enqueueDueHealthJobs(config, database, github, signal, now);
    assert.equal(snapshots, 0);
    const first = await api.requestHealthAudit(config, database, github, repositoryId, "manual", signal, now);
    const repeated = await api.requestHealthAudit(config, database, github, repositoryId, "manual", signal, now);
    assert.equal(first.job.id, repeated.job.id);
    assert.equal(snapshots, 1);
    await database.finishJob({ ...first.job, status: "failed" });
    await (database as any).setHealthSchedule(repositoryId, "weekly", now);
    assert.equal((await database.pool.query("SELECT health_next_run_at FROM repositories WHERE id=$1", [repositoryId])).rows[0].health_next_run_at.toISOString(), "2026-09-19T00:00:00.000Z");
    await database.pool.query("INSERT INTO repositories(id,installation_id,full_name,health_schedule,health_next_run_at) SELECT 9000010000+n,1,'owner/not-configured-'||n,'weekly',$1 FROM generate_series(1,100) n", [now]);
    await Promise.all([api.enqueueDueHealthJobs(config, database, github, signal, later), api.enqueueDueHealthJobs(config, database, github, signal, later)]);
    const active = (await database.activeHealthJob(repositoryId))!;
    assert.ok(active, "未授权仓库不能占满定时扫描窗口");
    assert.equal(active.trigger, "schedule");
    assert.equal(active.windowEnd, later.toISOString());
    assert.equal(Number((await database.pool.query("SELECT count(*) FROM jobs WHERE repository_id=$1", [repositoryId])).rows[0].count), 2);
    assert.equal((await database.pool.query("SELECT health_next_run_at FROM repositories WHERE id=$1", [repositoryId])).rows[0].health_next_run_at.toISOString(), "2026-10-09T00:00:00.000Z");
    await (database as any).setHealthSchedule(repositoryId, "off", later);
    assert.equal((await database.activeHealthJob(repositoryId))?.id, active.id);
    assert.equal((await database.pool.query("SELECT health_next_run_at FROM repositories WHERE id=$1", [repositoryId])).rows[0].health_next_run_at, null);
    await database.pool.query("UPDATE repositories SET enabled=false WHERE id=$1", [repositoryId]);
    await assert.rejects(api.requestHealthAudit(config, database, github, repositoryId, "manual", signal, later));
    await assert.rejects((database as any).setHealthSchedule(repositoryId, "hourly", later));
  } finally { await database.pool.query("UPDATE jobs SET status='cancelled' WHERE repository_id=$1 AND status IN ('queued','running')", [repositoryId]); await database.close(); }
});

test("Health 管理 API 使用维护者与 CSRF 边界，重试保持原预算和快照", { skip: !fixture.url }, async () => {
  const database = new Database(fixture.url!), allowedId = 9_000_000_023, deniedId = 9_000_000_024;
  await database.pool.query("INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,'owner/health-api'),($2,1,'owner/health-private')", [allowedId, deniedId]);
  const config = { appId: "1", privateKey: "test", allowedRepositories: new Set(["owner/health-api", "owner/health-private"]), agentTimeoutMs: 5000, githubClientId: "client", githubClientSecret: "test", githubOAuthCallbackUrl: "http://127.0.0.1/callback", sessionSecret: "a".repeat(32) } as Config;
  const github = { exchangeOAuthCode: async () => "test-token", getUser: async () => ({ id: 42, login: "maintainer" }), hasMaintainerPermission: async (_token: string, repository: string) => repository === "owner/health-api", installationToken: async () => "test-app-token", repositorySnapshot: async () => ({ defaultBranch: "main", headSha: "a".repeat(40) }) };
  const server = createServer(createAdminHandler(config, database, github as any));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/health`)).status, 401);
    let response = await fetch(`${origin}/auth/github`, { redirect: "manual" });
    const state = new URL(response.headers.get("location")!).searchParams.get("state");
    const oauthCookie = response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
    response = await fetch(`${origin}/auth/github/callback?code=ok&state=${state}`, { headers: { cookie: oauthCookie }, redirect: "manual" });
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith("session="))!.split(";", 1)[0]!;
    const session = await (await fetch(`${origin}/api/session`, { headers: { cookie } })).json() as any;
    const headers = { cookie, origin: "http://127.0.0.1", "x-csrf-token": session.csrf, "content-type": "application/json" };
    const post = (path: string, body = "{}") => fetch(origin + path, { method: "POST", headers, body });
    assert.equal((await fetch(`${origin}/api/repositories/${allowedId}/health`, { method: "POST", headers: { cookie }, body: "{}" })).status, 403);
    assert.equal((await post(`/api/repositories/${deniedId}/health`)).status, 403);
    assert.equal((await post(`/api/repositories/${allowedId}/health`, '{"headSha":"forged"}')).status, 422);
    assert.equal((await post('/api/repositories/999999999999999999999999/health')).status, 422);
    response = await post(`/api/repositories/${allowedId}/health`);
    assert.equal(response.status, 202);
    const started = await response.json() as any;
    const duplicate = await (await post(`/api/repositories/${allowedId}/health`)).json() as any;
    assert.equal(duplicate.job.id, started.job.id);
    const listing = await (await fetch(`${origin}/api/health?repositoryId=${allowedId}`, { headers })).json() as any;
    assert.equal(listing.items.length, 1);
    assert.equal(listing.items[0].pr_number, null);
    const detail = await (await fetch(`${origin}/api/health/${started.job.id}`, { headers })).json() as any;
    assert.equal(detail.report, null);
    assert.equal(detail.job.target_sha, "a".repeat(40));
    const hidden = await database.enqueueHealth(deniedId, { defaultBranch: "main", headSha: "b".repeat(40) }, "manual");
    assert.equal((await fetch(`${origin}/api/health/${hidden.job!.id}`, { headers })).status, 403);
    assert.equal((await fetch(`${origin}/api/health?repositoryId=${deniedId}`, { headers })).status, 403);
    response = await fetch(`${origin}/api/repositories/${allowedId}/health-schedule`, { method: "PATCH", headers, body: '{"schedule":"weekly"}' });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).healthSchedule, "weekly");
    assert.equal((await fetch(`${origin}/api/repositories/${allowedId}/health-schedule`, { method: "PATCH", headers, body: '{"schedule":"hourly"}' })).status, 422);
    await database.finishJob({ ...started.job, status: "failed" });
    assert.equal((await post(`/api/health/${started.job.id}/retry`, '{"headSha":"forged"}')).status, 422);
    response = await post(`/api/health/${started.job.id}/retry`);
    assert.equal(response.status, 202);
    const retried = await response.json() as any;
    assert.equal(retried.job.id, started.job.id);
    assert.equal(retried.job.windowEnd, started.job.windowEnd);
    await database.finishJob({ ...started.job, status: "failed" });
    const run = await database.startAgentRun(started.job.id, "health_auditor", 20000, 1000);
    await database.finishAgentRun(run, { status: "failed", usage: { ...emptyUsage(), unreportedTokens: 20000 } });
    assert.equal((await post(`/api/health/${started.job.id}/retry`)).status, 409);
    const all = await (await fetch(`${origin}/api/health`, { headers })).json() as any;
    assert.equal(all.items.length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.pool.query("UPDATE jobs SET status='cancelled' WHERE repository_id=ANY($1::bigint[]) AND status IN ('queued','running')", [[allowedId, deniedId]]);
    await database.close();
  }
});

test("App 移除仓库的签名事件只撤销对应 installation，并取消健康任务且重投幂等", { skip: !fixture.url }, async () => {
  const database = new Database(fixture.url!), owned = 9_000_000_025, other = 9_000_000_026;
  const config = { webhookSecret: "revoke-test", webhookMaxBytes: 10000, allowedRepositories: new Set(["owner/revoked", "owner/other-installation"]) } as Config;
  await database.pool.query("INSERT INTO repositories(id,installation_id,full_name) VALUES($1,77,'owner/revoked'),($2,88,'owner/other-installation')", [owned, other]);
  const first = await database.enqueueHealth(owned, { defaultBranch: "main", headSha: "a".repeat(40) }, "manual");
  const foreign = await database.enqueueHealth(other, { defaultBranch: "main", headSha: "b".repeat(40) }, "manual");
  const active = await database.claimNext(); assert.ok(active?.jobType === "HEALTH_AUDIT");
  const controller = new AbortController(); database.registerReviewAbort(active, controller);
  const { server } = createApp(config, database);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address === "object");
  const post = (delivery: string, event: string, payload: object) => {
    const body = JSON.stringify(payload);
    return fetch(`http://127.0.0.1:${address.port}/github/webhook`, { method: "POST", headers: { "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": "sha256=" + createHmac("sha256", config.webhookSecret).update(body).digest("hex") }, body });
  };
  try {
    const removed = { action: "removed", installation: { id: 77 }, repositories_removed: [{ id: owned }] };
    assert.equal((await post("revoke-wrong-owner", "installation_repositories", { ...removed, installation: { id: 88 } })).status, 202);
    assert.equal(controller.signal.aborted, false);
    assert.equal((await post("revoke-invalid", "installation_repositories", { action: "removed", installation: { id: 77 } })).status, 422);
    assert.equal((await post("revoke-owned", "installation_repositories", removed)).status, 202);
    assert.equal(controller.signal.aborted, true);
    assert.equal((await database.getJob(first.job!.id))?.status, "cancelled");
    await database.failJob(active, new Error("network failed after cancellation"), true);
    assert.equal((await database.getJob(first.job!.id))?.status, "cancelled");
    await database.finishJob({ ...active, status: "succeeded" });
    assert.equal((await database.getJob(first.job!.id))?.status, "cancelled");
    assert.equal((await database.getRepositoryConfig(owned))?.enabled, false);
    assert.equal((await database.getRepositoryConfig(other))?.enabled, true);
    assert.equal((await database.getJob(foreign.job!.id))?.status, "queued");
    const duplicate = await (await post("revoke-owned", "installation_repositories", removed)).json() as any;
    assert.equal(duplicate.duplicate, true);
    const delivery = (await database.pool.query("SELECT repository_id FROM webhook_deliveries WHERE delivery_id='revoke-owned'")).rows;
    assert.equal(delivery.length, 1); assert.equal(delivery[0].repository_id, null);
    assert.equal((await post("revoke-installation", "installation", { action: "deleted", installation: { id: 88 } })).status, 202);
    assert.equal((await database.getJob(foreign.job!.id))?.status, "cancelled");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await database.pool.query("UPDATE jobs SET status='cancelled' WHERE repository_id=ANY($1::bigint[]) AND status IN ('queued','running')", [[owned, other]]); await database.close(); }
});

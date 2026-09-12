import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { Database } from "../src/database.js";
import { PersistentRunner } from "../src/runner.js";
import { MemoryService } from "../src/memory.js";
import type { DecisionProposal, ReplyResult, ReviewJob } from "../src/types.js";
import { createServer } from "node:http";
import { createAdminHandler } from "../src/admin.js";
import type { Config } from "../src/config.js";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { emptyUsage } from "../src/review.js";
import { GitHubApiError } from "../src/github.js";
import { createApp } from "../src/app.js";

let databaseUrl = process.env.DATABASE_URL;
const schema = "m2_test_" + randomUUID().replaceAll("-", "");
let control: Database | undefined;
before(async () => {
  if (!databaseUrl) return;
  control = new Database(databaseUrl);
  await control.pool.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(databaseUrl); url.searchParams.set("options", `-c search_path=${schema}`); databaseUrl = url.toString();
  const isolated = new Database(databaseUrl);
  try { await isolated.migrate(); } finally { await isolated.close(); }
});
after(async () => {
  if (!control) return;
  try { await control.pool.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await control.close(); }
});

test("Health Job 独立于 PR、活动任务去重、PR 优先且报告与终态原子保存", { skip: !databaseUrl }, async () => {
  const database: any = new Database(databaseUrl!);
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

test("Health Worker 完成固定快照报告、保留重试消耗，并在暂停时取消", { skip: !databaseUrl }, async () => {
  const api: any = await import("../src/health.js");
  assert.equal(typeof api.createHealthProcessor, "function", "缺少 Health Worker");
  const database = new Database(databaseUrl!);
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

test("Health 手动／定时共用去重，UTC 周期重启只补一次，关闭定时保留活动任务", { skip: !databaseUrl }, async () => {
  const api: any = await import("../src/health.js");
  assert.equal(typeof api.requestHealthAudit, "function", "缺少健康触发入口");
  const database = new Database(databaseUrl!), repositoryId = 9_000_000_022;
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

test("Health 管理 API 使用维护者与 CSRF 边界，重试保持原预算和快照", { skip: !databaseUrl }, async () => {
  const database = new Database(databaseUrl!), allowedId = 9_000_000_023, deniedId = 9_000_000_024;
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

test("App 移除仓库的签名事件只撤销对应 installation，并取消健康任务且重投幂等", { skip: !databaseUrl }, async () => {
  const database = new Database(databaseUrl!), owned = 9_000_000_025, other = 9_000_000_026;
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

test("migration 幂等且 delivery/job 跨连接持久化", { skip: !databaseUrl }, async () => {
  const repositoryId = 9_000_000_001;
  const database = new Database(databaseUrl!);
  await database.migrate();
  await database.migrate();
  await database.pool.query("DELETE FROM review_publications WHERE job_id IN (SELECT id FROM jobs WHERE repository_id=$1)", [repositoryId]);
  await database.pool.query("DELETE FROM jobs WHERE repository_id=$1", [repositoryId]);
  await database.pool.query("DELETE FROM webhook_deliveries WHERE repository_id=$1", [repositoryId]);
  await database.pool.query("DELETE FROM repositories WHERE id=$1", [repositoryId]);
  const input = { deliveryId: "db-delivery-1", installationId: 1, repositoryId, repository: "owner/database-test", cloneUrl: "https://github.com/owner/database-test.git", prNumber: 2, title: "title", body: "body", baseSha: "base", headSha: "head" };
  try {
    const accepted = await database.accept(input, { event: "pull_request", action: "opened" });
    assert.equal(accepted.kind, "accepted");
    assert.equal(accepted.job?.status, "queued");
    assert.equal((await database.accept(input, { event: "pull_request", action: "opened" })).kind, "duplicate");
    const id = accepted.job!.id;
    await database.close();
    const restarted = new Database(databaseUrl!);
    try {
      assert.equal((await restarted.getJob(id))?.status, "queued");
      const sameHead = await restarted.accept({ ...input, deliveryId: "db-delivery-2" }, { event: "pull_request", action: "synchronize" });
      assert.equal(sameHead.kind, "duplicate");
      assert.equal(sameHead.job?.id, id);
    } finally {
      await restarted.pool.query("DELETE FROM jobs WHERE repository_id=$1", [repositoryId]);
      await restarted.pool.query("DELETE FROM webhook_deliveries WHERE repository_id=$1", [repositoryId]);
      await restarted.pool.query("DELETE FROM repositories WHERE id=$1", [repositoryId]);
      await restarted.close();
    }
  } catch (error) { await database.close().catch(() => undefined); throw error; }
});

test("PostgreSQL 不可用时明确失败", async () => {
  const unavailable = new Database("postgresql://postgres:postgres@127.0.0.1:1/pi_governance");
  await assert.rejects(unavailable.check());
  await unavailable.close();
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition timed out");
}

test("持久 Runner 恢复 running Job 并保存发布结果", { skip: !databaseUrl }, async () => {
  const repositoryId = 9_000_000_002;
  const database = new Database(databaseUrl!);
  const input = { deliveryId: "runner-recovery", installationId: 1, repositoryId, repository: "owner/runner-test", cloneUrl: "https://github.com/owner/runner-test.git", prNumber: 2, title: "recover", body: "", baseSha: "base", headSha: "head" };
  await database.pool.query("DELETE FROM review_publications WHERE job_id IN (SELECT id FROM jobs WHERE repository_id=$1)", [repositoryId]);
  await database.pool.query("DELETE FROM jobs WHERE repository_id=$1", [repositoryId]);
  await database.pool.query("DELETE FROM webhook_deliveries WHERE repository_id=$1", [repositoryId]);
  await database.pool.query("DELETE FROM repositories WHERE id=$1", [repositoryId]);
  const accepted = await database.accept(input, { event: "pull_request", action: "opened" });
  await database.pool.query("UPDATE jobs SET status='running' WHERE id=$1", [accepted.job!.id]);
  const runner = new PersistentRunner(database, async (job) => {
    assert.ok(job.jobType !== "HEALTH_AUDIT");
    const publication = await database.beginPublication(job, `fingerprint-${job.id}`);
    assert.equal(publication.status, "pending");
    job.reviewId = 123;
    job.reviewUrl = "https://example/review/123";
    await database.finishPublication(job, "published");
  }, 10);
  try {
    await runner.start();
    await waitFor(async () => (await database.getJob(accepted.job!.id))?.status === "succeeded");
    assert.equal((await database.getJob(accepted.job!.id))?.error, undefined);
    const publication = await database.pool.query("SELECT * FROM review_publications WHERE job_id=$1", [accepted.job!.id]);
    assert.equal(publication.rows[0].status, "published");
    assert.equal(String(publication.rows[0].github_review_id), "123");
  } finally {
    await runner.stop();
    await database.pool.query("DELETE FROM review_publications WHERE job_id=$1", [accepted.job!.id]);
    await database.pool.query("DELETE FROM jobs WHERE repository_id=$1", [repositoryId]);
    await database.pool.query("DELETE FROM webhook_deliveries WHERE repository_id=$1", [repositoryId]);
    await database.pool.query("DELETE FROM repositories WHERE id=$1", [repositoryId]);
    await database.close();
  }
});

test("transient 最多重试三次，永久错误只执行一次", { skip: !databaseUrl }, async () => {
  const repositoryId = 9_000_000_003;
  const database = new Database(databaseUrl!);
  const make = (deliveryId: string, prNumber: number, title: string) => ({ deliveryId, installationId: 1, repositoryId, repository: "owner/retry-test", cloneUrl: "https://github.com/owner/retry-test.git", prNumber, title, body: "", baseSha: "base", headSha: `head-${prNumber}` });
  await database.pool.query("DELETE FROM jobs WHERE repository_id=$1", [repositoryId]);
  await database.pool.query("DELETE FROM webhook_deliveries WHERE repository_id=$1", [repositoryId]);
  await database.pool.query("DELETE FROM repositories WHERE id=$1", [repositoryId]);
  const transient = await database.accept(make("runner-transient", 1, "transient"), { event: "pull_request", action: "opened" });
  const permanent = await database.accept(make("runner-permanent", 2, "permanent"), { event: "pull_request", action: "opened" });
  const counts = new Map<string, number>();
  const runner = new PersistentRunner(database, async (job) => {
    counts.set(job.id, (counts.get(job.id) ?? 0) + 1);
    // 本例验证重试次数，替身通过 Retry-After: 0 避免等待真实退避。
    if (job.title === "transient") throw Object.assign(new Error("remote HTTP 500"), { retryAfterSeconds: 0 });
    throw new Error("GitHub API failed (403)");
  }, 10);
  try {
    await runner.start();
    await waitFor(async () => (await database.getJob(transient.job!.id))?.status === "failed", 6000);
    await waitFor(async () => (await database.getJob(permanent.job!.id))?.status === "failed");
    assert.equal(counts.get(transient.job!.id), 3);
    assert.equal(counts.get(permanent.job!.id), 1);
    assert.equal((await database.getJob(transient.job!.id))?.attempt, 3);
  } finally {
    await runner.stop();
    await database.pool.query("DELETE FROM jobs WHERE repository_id=$1", [repositoryId]);
    await database.pool.query("DELETE FROM webhook_deliveries WHERE repository_id=$1", [repositoryId]);
    await database.pool.query("DELETE FROM repositories WHERE id=$1", [repositoryId]);
    await database.close();
  }
});

test("closed 仅在 merged 时创建唯一 Decision Extract Job", { skip: !databaseUrl }, async () => {
  const repositoryId = 9_000_000_004;
  const database = new Database(databaseUrl!);
  const base = { installationId: 1, repositoryId, repository: "owner/decision-test", cloneUrl: "https://github.com/owner/decision-test.git", prNumber: 7, title: "decision", body: "", baseSha: "base", headSha: "feature" };
  await database.pool.query("DELETE FROM memories WHERE repository_id=$1", [repositoryId]);
  await database.pool.query("DELETE FROM jobs WHERE repository_id=$1", [repositoryId]);
  await database.pool.query("DELETE FROM webhook_deliveries WHERE repository_id=$1", [repositoryId]);
  await database.pool.query("DELETE FROM repositories WHERE id=$1", [repositoryId]);
  try {
    const closed = await database.accept({ ...base, deliveryId: "closed-unmerged" }, { event: "pull_request", action: "closed", merged: false, mergeCommitSha: null });
    assert.equal(closed.kind, "accepted");
    assert.equal(closed.job, undefined);
    const merged = await database.accept({ ...base, deliveryId: "closed-merged" }, { event: "pull_request", action: "closed", merged: true, mergeCommitSha: "merged-snapshot" });
    assert.equal(merged.job?.jobType, "DECISION_EXTRACT");
    assert.equal(merged.job?.headSha, "merged-snapshot");
    assert.equal((await database.accept({ ...base, deliveryId: "closed-merged-replay" }, { event: "pull_request", action: "closed", merged: true, mergeCommitSha: "merged-snapshot" })).kind, "duplicate");
  } finally {
    await database.pool.query("DELETE FROM memories WHERE repository_id=$1", [repositoryId]);
    await database.pool.query("DELETE FROM jobs WHERE repository_id=$1", [repositoryId]);
    await database.pool.query("DELETE FROM webhook_deliveries WHERE repository_id=$1", [repositoryId]);
    await database.pool.query("DELETE FROM repositories WHERE id=$1", [repositoryId]);
    await database.close();
  }
});

test("Memory 生命周期、版本、幂等和 Scope/仓库隔离", { skip: !databaseUrl }, async () => {
  const repositoryId = 9_000_000_005;
  const database = new Database(databaseUrl!);
  const service = new MemoryService(database);
  const actor = { id: 42, login: "maintainer" };
  const job = { id: "00000000-0000-4000-8000-000000000005", deliveryId: "memory-source", jobType: "DECISION_EXTRACT", installationId: 1, repositoryId, repository: "owner/memory-test", cloneUrl: "url", prNumber: 8, title: "", body: "", baseSha: "base", headSha: "merged", status: "running" } satisfies ReviewJob;
  const proposal: DecisionProposal = { type: "coding_convention", title: "DTO Optional", content: "Public DTO fields do not use Optional", rationale: "Stable serialization", scope: { paths: ["backend/**/dto/**"], languages: ["java"] }, source: { pullRequestNumber: 8, commitSha: "merged", commentIds: [10] }, evidence: [{ kind: "human_comment", reference: "10", detail: "decision" }, { kind: "code", reference: "backend/a/dto/X.java:2", detail: "change" }], confidence: 0.9, uncertainties: [] };
  await database.pool.query("INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,'owner/memory-test') ON CONFLICT DO NOTHING", [repositoryId]);
  try {
    const ids = await database.insertCandidates(job, [proposal]);
    assert.equal(ids.length, 1);
    assert.deepEqual(await database.insertCandidates(job, [proposal]), []);
    const id = ids[0]!;
    assert.equal((await service.get(repositoryId + 1, id)), undefined);
    assert.equal((await service.transition(repositoryId, id, "approve", actor)).status, "ACTIVE");
    assert.equal((await service.retrieve(repositoryId, { paths: ["backend/a/dto/X.java"], text: "Optional DTO" })).length, 1);
    assert.equal((await service.retrieve(repositoryId, { paths: ["frontend/X.java"], text: "Optional DTO" })).length, 0);
    const edited = await service.edit(repositoryId, id, { content: "Public DTO fields never use Optional" }, actor);
    assert.equal(edited.version, 2);
    assert.equal(edited.status, "CANDIDATE");
    assert.equal((await service.retrieve(repositoryId, { paths: ["backend/a/dto/X.java"], text: "Optional DTO" })).length, 0);
    assert.equal((await service.transition(repositoryId, id, "approve", actor)).status, "ACTIVE");
    const versions = await database.pool.query("SELECT version,status FROM memories WHERE id=$1 ORDER BY version", [id]);
    assert.deepEqual(versions.rows.map((row) => [row.version, row.status]), [[1, "SUPERSEDED"], [2, "ACTIVE"]]);
    const second = await database.insertCandidates({ ...job, prNumber: 9, headSha: "merged-2" }, [{ ...proposal, title: "New DTO rule", content: "Use plain nullable DTO fields", source: { pullRequestNumber: 9, commitSha: "merged-2", commentIds: [11] } }]);
    assert.equal((await service.supersede(repositoryId, id, second[0]!, actor)).status, "ACTIVE");
    assert.equal((await service.get(repositoryId, id))?.status, "SUPERSEDED");
    assert.equal((await service.transition(repositoryId, second[0]!, "deprecate", actor)).status, "DEPRECATED");
  } finally {
    await database.pool.query("DELETE FROM memory_audits WHERE memory_id IN (SELECT id FROM memories WHERE repository_id=$1)", [repositoryId]);
    await database.pool.query("DELETE FROM memories WHERE repository_id=$1", [repositoryId]);
    await database.pool.query("DELETE FROM repositories WHERE id=$1", [repositoryId]);
    await database.close();
  }
});

test("OAuth state、Session、CSRF 与跨仓库 Maintainer 权限", { skip: !databaseUrl }, async () => {
  const database = new Database(databaseUrl!);
  const allowedId = 9_000_000_006;
  const deniedId = 9_000_000_007;
  const cleanup = async () => {
    await database.pool.query("DELETE FROM jobs WHERE repository_id=ANY($1::bigint[])", [[allowedId, deniedId]]);
    await database.pool.query("DELETE FROM webhook_deliveries WHERE repository_id=ANY($1::bigint[])", [[allowedId, deniedId]]);
    await database.pool.query("DELETE FROM memory_audits WHERE memory_id IN (SELECT id FROM memories WHERE repository_id=ANY($1::bigint[]))", [[allowedId, deniedId]]);
    await database.pool.query("DELETE FROM memories WHERE repository_id=ANY($1::bigint[])", [[allowedId, deniedId]]);
    await database.pool.query("DELETE FROM repositories WHERE id=ANY($1::bigint[])", [[allowedId, deniedId]]);
  };
  await cleanup();
  await database.pool.query("INSERT INTO repositories(id,installation_id,full_name) VALUES($1,1,'owner/allowed'),($2,1,'owner/denied')", [allowedId, deniedId]);
  const proposal: DecisionProposal = { type: "engineering_rule", title: "rule", content: "content", rationale: "reason", scope: {}, source: { pullRequestNumber: 1, commitSha: "merged", commentIds: [1] }, evidence: [{ kind: "human_comment", reference: "1", detail: "yes" }, { kind: "code", reference: "x:1", detail: "change" }], confidence: 1, uncertainties: [] };
  const makeJob = (repositoryId: number, repository: string, suffix: string) => ({ id: `00000000-0000-4000-8000-0000000000${suffix}`, deliveryId: `auth-${suffix}`, jobType: "DECISION_EXTRACT", installationId: 1, repositoryId, repository, cloneUrl: "url", prNumber: 1, title: "", body: "", baseSha: "base", headSha: "merged", status: "running" } satisfies ReviewJob);
  const allowedMemory = (await database.insertCandidates(makeJob(allowedId, "owner/allowed", "06"), [proposal]))[0]!;
  const deniedMemory = (await database.insertCandidates(makeJob(deniedId, "owner/denied", "07"), [{ ...proposal, source: { ...proposal.source, pullRequestNumber: 2 } }]))[0]!;
  const config = { appId: "1", privateKey: "key", webhookSecret: "secret", allowedRepositories: new Set(["owner/allowed", "owner/denied"]), databaseUrl: databaseUrl!, modelProvider: "test", modelName: "test", modelApiKey: "test", port: 0, webhookMaxBytes: 1000, queueCapacity: 1, agentTimeoutMs: 1000, githubClientId: "client", githubClientSecret: "client-secret", githubOAuthCallbackUrl: "http://127.0.0.1/callback", sessionSecret: "a".repeat(32) } satisfies Config;
  const github = { exchangeOAuthCode: async () => "user-token", getUser: async () => ({ id: 42, login: "maintainer" }), hasMaintainerPermission: async (_token: string, repository: string) => repository === "owner/allowed" };
  const server = createServer(createAdminHandler(config, database, github as any));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    let response = await fetch(`${origin}/api/memories/${allowedMemory}/approve`, { method: "POST" });
    assert.equal(response.status, 401);
    response = await fetch(`${origin}/auth/github`, { redirect: "manual" });
    const location = response.headers.get("location")!;
    const state = new URL(location).searchParams.get("state")!;
    const stateCookie = response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
    response = await fetch(`${origin}/auth/github/callback?code=ok&state=wrong`, { headers: { cookie: stateCookie }, redirect: "manual" });
    assert.equal(response.status, 400);
    response = await fetch(`${origin}/auth/github/callback?code=ok&state=${state}`, { headers: { cookie: stateCookie }, redirect: "manual" });
    assert.equal(response.status, 302);
    const sessionCookie = response.headers.getSetCookie().find((value) => value.startsWith("session="))!.split(";", 1)[0]!;
    response = await fetch(`${origin}/api/session`, { headers: { cookie: sessionCookie } });
    const session = await response.json() as { csrf: string };
    response = await fetch(`${origin}/api/memories/${allowedMemory}/approve`, { method: "POST", headers: { cookie: sessionCookie, origin: "http://127.0.0.1", "x-csrf-token": "wrong" } });
    assert.equal(response.status, 403);
    response = await fetch(`${origin}/api/memories/${allowedMemory}/approve`, { method: "POST", headers: { cookie: sessionCookie, origin: "http://127.0.0.1", "x-csrf-token": session.csrf } });
    assert.equal(response.status, 200);
    response = await fetch(`${origin}/api/memories/${deniedMemory}/reject`, { method: "POST", headers: { cookie: sessionCookie, origin: "http://127.0.0.1", "x-csrf-token": session.csrf } });
    assert.equal(response.status, 403);
    response = await fetch(`${origin}/api/repositories/${allowedId}`, { method: "PATCH", headers: { cookie: sessionCookie, origin: "http://127.0.0.1", "x-csrf-token": session.csrf }, body: JSON.stringify({ enabled: false }) });
    assert.equal(response.status, 200);
    const paused = await database.accept({ deliveryId: "paused-delivery", installationId: 1, repositoryId: allowedId, repository: "owner/allowed", cloneUrl: "url", prNumber: 3, title: "", body: "", baseSha: "base", headSha: "head" }, { event: "pull_request", action: "opened" });
    assert.equal(paused.job, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
    await database.close();
  }
});

test("Finding 绑定、Reply 幂等、状态和 decision clue", { skip: !databaseUrl }, async () => {
  const repositoryId = 9_000_000_008;
  const database = new Database(databaseUrl!);
  await database.migrate();
  const cleanup = async () => {
    await database.pool.query("DELETE FROM decision_clues WHERE repository_id=$1", [repositoryId]);
    await database.pool.query("DELETE FROM reply_publications WHERE finding_id IN (SELECT id FROM review_findings WHERE repository_id=$1)", [repositoryId]);
    await database.pool.query("DELETE FROM agent_runs WHERE job_id IN (SELECT id FROM jobs WHERE repository_id=$1)", [repositoryId]);
    await database.pool.query("DELETE FROM review_findings WHERE repository_id=$1", [repositoryId]);
    await database.pool.query("DELETE FROM jobs WHERE repository_id=$1", [repositoryId]);
    await database.pool.query("DELETE FROM webhook_deliveries WHERE repository_id=$1", [repositoryId]);
    await database.pool.query("DELETE FROM repositories WHERE id=$1", [repositoryId]);
  };
  await cleanup();
  const input = { deliveryId: "finding-review", installationId: 1, repositoryId, repository: "owner/finding-test", cloneUrl: "url", prNumber: 2, title: "", body: "", baseSha: "base", headSha: "head" };
  const accepted = await database.accept(input, { event: "pull_request", action: "opened" });
  const finding = { path: "src/a.ts", line: 2, side: "RIGHT", category: "correctness", severity: "high", evidenceLevel: "strong", description: "bad", evidence: "line", impact: "crash" } as const;
  const stored = await database.saveFindings(accepted.job!, [finding], new Set([finding]));
  assert.equal((await database.saveFindings(accepted.job!, [finding], new Set([finding])))[0]?.id, stored[0]?.id);
  const different = { ...finding, description: "another cause", evidence: "another code path", impact: "another impact" };
  const collocated = await database.saveFindings(accepted.job!, [finding, different, { ...finding }], new Set([finding, different]));
  assert.notEqual(collocated[0]!.id, collocated[1]!.id);
  assert.equal(collocated[0]!.id, collocated[2]!.id);
  assert.deepEqual((await database.saveFindings(accepted.job!, [finding, different], new Set([finding, different]))).map(item => item.id), collocated.slice(0, 2).map(item => item.id));
  assert.equal(await database.bindFindings(accepted.job!, 10, [{ id: 11, body: `body <!-- pi-finding:${stored[0]!.id} -->` }]), 1);
  assert.equal((await database.getFindingByRoot(repositoryId, 2, 11))?.bindingStatus, "bound");
  const agentRunId = await database.startAgentRun(accepted.job!.id, "security_reviewer", 500, 1000);
  await database.finishAgentRun(agentRunId, { status: "succeeded", model: "test", usage: { input: 10, output: 5, cacheRead: 20, totalTokens: 35 }, coverage: ["auth"], limitations: [] });
  const agentRun = await database.pool.query("SELECT * FROM agent_runs WHERE id=$1", [agentRunId]);
  assert.equal(agentRun.rows[0].usage_output_tokens, 5);
  assert.equal(agentRun.rows[0].usage.totalTokens, 35);
  assert.equal("reasoning" in agentRun.rows[0], false);
  const replyInput = { deliveryId: "reply-delivery", installationId: 1, repositoryId, repository: "owner/finding-test", prNumber: 2, baseSha: "base", eventHeadSha: "head", rootCommentId: 11, sourceCommentId: 12, sourceCommentUrl: "https://example/reply/12", humanActorId: 42, humanActorLogin: "human", humanReplyBody: "fixed" };
  const reply = await database.acceptReply(replyInput);
  assert.equal(reply.kind, "accepted");
  assert.equal((await database.acceptReply({ ...replyInput, deliveryId: "reply-duplicate" })).kind, "duplicate");
  assert.equal((await database.acceptReply({ ...replyInput, deliveryId: "foreign", rootCommentId: 99, sourceCommentId: 13 })).kind, "ignored");
  const result = { findingId: stored[0]!.id, analysisHeadSha: "head", conclusion: "VALID_EXCEPTION", summary: "valid locally", evidence: [{ path: "src/a.ts", line: 2, detail: "adapter only" }], memoryReferences: [], suggestedFindingStatus: "EXCEPTION_PENDING", decisionClue: { type: "possible_exception", summary: "adapter only" }, limitations: [] } satisfies ReplyResult;
  await database.finishReply(reply.job!, result, { id: 13, html_url: "https://example/reply/13" });
  assert.equal((await database.getFinding(stored[0]!.id))?.status, "EXCEPTION_PENDING");
  assert.equal((await database.getDecisionClues(repositoryId, 2)).length, 1);
  await database.finishJob({ ...accepted.job!, status: "succeeded" });
  await database.finishJob({ ...reply.job!, status: "succeeded" });
  const newer = await database.acceptReply({ ...replyInput, deliveryId: "reply-newer-first", sourceCommentId: 15, humanReplyCreatedAt: "2030-01-01T00:00:00Z" });
  const older = await database.acceptReply({ ...replyInput, deliveryId: "reply-older-second", sourceCommentId: 14, humanReplyCreatedAt: "2029-01-01T00:00:00Z" });
  assert.equal((await database.claimNext())?.id, older.job!.id);
  await database.finishJob({ ...older.job!, status: "succeeded" });
  assert.equal((await database.claimNext())?.id, newer.job!.id);
  await database.finishReply(newer.job!, { ...result, conclusion: "STILL_VALID", suggestedFindingStatus: "STILL_VALID", decisionClue: undefined }, { id: 16, html_url: "https://example/reply/16" });
  assert.equal((await database.acceptReply({ ...replyInput, deliveryId: "reply-late", sourceCommentId: 13, humanReplyCreatedAt: "2028-01-01T00:00:00Z" })).kind, "ignored");
  assert.equal(await database.isOlderReply(stored[0]!.id, 14, "2029-01-01T00:00:00Z"), true);
  const reviewAbort = new AbortController(), replyAbort = new AbortController(), unrelated = new AbortController();
  database.registerReviewAbort(accepted.job!, reviewAbort);
  database.registerReviewAbort(reply.job!, replyAbort);
  database.registerReviewAbort({ ...accepted.job!, id: "other-pr", prNumber: 99 }, unrelated);
  await database.accept({ ...input, deliveryId: "new-head-cancels", headSha: "head-2" }, { event: "pull_request", action: "synchronize" });
  assert(reviewAbort.signal.aborted && replyAbort.signal.aborted);
  assert.equal(unrelated.signal.aborted, false);
  database.stopReviews();
  assert(unrelated.signal.aborted);
  try { assert.equal((await database.getReplyPublication(12))?.status, "published"); }
  finally { await cleanup(); await database.close(); }
});

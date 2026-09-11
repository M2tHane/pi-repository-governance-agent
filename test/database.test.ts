import assert from "node:assert/strict";
import test from "node:test";
import { Database } from "../src/database.js";
import { PersistentRunner } from "../src/runner.js";
import { MemoryService } from "../src/memory.js";
import type { DecisionProposal, ReviewJob } from "../src/types.js";
import { createServer } from "node:http";
import { createAdminHandler } from "../src/admin.js";
import type { Config } from "../src/config.js";

const databaseUrl = process.env.DATABASE_URL;

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
    runner.stop();
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
    if (job.title === "transient") throw new Error("remote HTTP 500");
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
    runner.stop();
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

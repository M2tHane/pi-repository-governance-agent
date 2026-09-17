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

test("migration 幂等且 delivery/job 跨连接持久化", { skip: !fixture.url }, async () => {
  const repositoryId = 9_000_000_001;
  const database = new Database(fixture.url!);
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
    const restarted = new Database(fixture.url!);
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


test("持久 Runner 恢复 running Job 并保存发布结果", { skip: !fixture.url }, async () => {
  const repositoryId = 9_000_000_002;
  const database = new Database(fixture.url!);
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

test("transient 最多重试三次，永久错误只执行一次", { skip: !fixture.url }, async () => {
  const repositoryId = 9_000_000_003;
  const database = new Database(fixture.url!);
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

test("closed 仅在 merged 时创建唯一 Decision Extract Job", { skip: !fixture.url }, async () => {
  const repositoryId = 9_000_000_004;
  const database = new Database(fixture.url!);
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

import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { GitHubApiError, GitHubClient } from "../src/github.js";
import { JobQueue } from "../src/queue.js";
import { parseReviewResult } from "../src/review.js";
import type { ReviewJob } from "../src/types.js";
import { readWorkspaceFile, withWorkspace } from "../src/workspace.js";
import { validateMemoryReferences } from "../src/service.js";
import type { MemoryRecord } from "../src/types.js";

const exec = promisify(execFile);

const config: Config = {
  appId: "1", privateKey: "unused", webhookSecret: "secret", allowedRepositories: new Set(["owner/repo"]),
  databaseUrl: "postgresql://postgres:postgres@localhost/test",
  modelProvider: "test", modelName: "test", modelApiKey: "test", port: 0, webhookMaxBytes: 10_000, queueCapacity: 2, agentTimeoutMs: 100,
};

const payload = {
  action: "opened", installation: { id: 2 }, repository: { id: 3, full_name: "owner/repo", clone_url: "https://github.com/owner/repo.git" },
  pull_request: { number: 4, title: "PR", body: null, draft: false, state: "open", base: { sha: "a".repeat(40) }, head: { sha: "b".repeat(40), repo: { full_name: "owner/repo" } } },
};

function signature(body: string) { return `sha256=${createHmac("sha256", config.webhookSecret).update(body).digest("hex")}`; }

async function withServer(run: (url: string, calls: ReviewJob[]) => Promise<void>) {
  const calls: ReviewJob[] = [];
  const { server } = createApp(config, async (job) => { calls.push(job); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try { await run(`http://127.0.0.1:${address.port}/github/webhook`, calls); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("webhook 验签后快速入队，非法输入和忽略事件不执行", async () => withServer(async (url, calls) => {
  const body = JSON.stringify(payload);
  const headers = { "x-github-event": "pull_request", "x-github-delivery": "delivery-1", "x-hub-signature-256": signature(body) };
  let response = await fetch(url, { method: "POST", headers, body });
  assert.equal(response.status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.cloneUrl, "https://github.com/owner/repo.git");

  response = await fetch(url, { method: "POST", headers: { ...headers, "x-hub-signature-256": "sha256=bad" }, body });
  assert.equal(response.status, 401);
  response = await fetch(url, { method: "POST", headers: { ...headers, "x-github-delivery": "bad-json", "x-hub-signature-256": signature("{") }, body: "{" });
  assert.equal(response.status, 400);
  const huge = "x".repeat(config.webhookMaxBytes + 1);
  response = await fetch(url, { method: "POST", headers: { ...headers, "x-github-delivery": "huge", "x-hub-signature-256": signature(huge) }, body: huge });
  assert.equal(response.status, 413);
  const draft = JSON.stringify({ ...payload, pull_request: { ...payload.pull_request, draft: true } });
  response = await fetch(url, { method: "POST", headers: { ...headers, "x-github-delivery": "draft", "x-hub-signature-256": signature(draft) }, body: draft });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
}));

test("webhook 不等待后台任务", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { server } = createApp(config, async () => gate);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const body = JSON.stringify(payload);
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${address.port}/github/webhook`, { method: "POST", headers: { "x-github-event": "pull_request", "x-github-delivery": "slow", "x-hub-signature-256": signature(body) }, body });
  assert.equal(response.status, 202);
  assert(performance.now() - started < 1_000);
  release();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("持久层失败时 webhook 返回 503", async () => {
  const { server } = createApp(config, { accept: async () => { throw new Error("database unavailable"); } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const body = JSON.stringify(payload);
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/github/webhook`, { method: "POST", headers: { "x-github-event": "pull_request", "x-github-delivery": "database-down", "x-hub-signature-256": signature(body) }, body });
    assert.equal(response.status, 503);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("review comment 只路由人类对已绑定线程的回复", async () => {
  const calls: any[] = [];
  const target = { accept: async () => ({ kind: "accepted" as const }), acceptReply: async (input: any) => { calls.push(input); return { kind: "accepted" as const, job: { id: "reply-job" } as ReviewJob }; } };
  const { server } = createApp(config, target);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/github/webhook`;
  const value = { action: "created", installation: { id: 2 }, repository: { id: 3, full_name: "owner/repo" }, pull_request: { number: 4, state: "open", base: { sha: "base" }, head: { sha: "head" } }, comment: { id: 12, in_reply_to_id: 11, created_at: "2026-09-11T00:00:00Z", html_url: "https://example/reply/12", body: "fixed", path: "src/a.ts", line: 2, commit_id: "head", user: { id: 5, login: "human", type: "User" } } };
  const post = async (event: string, eventPayload: object, delivery: string) => { const text = JSON.stringify(eventPayload); return fetch(url, { method: "POST", headers: { "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": signature(text) }, body: text }); };
  try {
    assert.equal((await post("pull_request_review_comment", value, "reply-1")).status, 202);
    assert.equal(calls[0]?.rootCommentId, 11);
    assert.equal((await post("pull_request_review_comment", { ...value, comment: { ...value.comment, user: { ...value.comment.user, type: "Bot" } } }, "reply-bot")).status, 200);
    assert.equal((await post("pull_request_review_comment", { ...value, comment: { ...value.comment, in_reply_to_id: undefined } }, "reply-root")).status, 200);
    assert.equal((await post("issue_comment", value, "issue-comment")).status, 200);
    assert.equal(calls.length, 1);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

function job(deliveryId: string, headSha = deliveryId): Omit<ReviewJob, "id" | "status"> {
  return { deliveryId, installationId: 1, repositoryId: 2, repository: "owner/repo", cloneUrl: "url", prNumber: 3, title: "", body: "", baseSha: "base", headSha };
}

test("内存队列串行、去重并限制容量", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let active = 0;
  const order: string[] = [];
  const queue = new JobQueue(2, async (value) => { active++; assert.equal(active, 1); order.push(value.deliveryId); if (value.deliveryId === "one") await gate; active--; });
  assert.equal(queue.enqueue(job("one")).kind, "accepted");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.enqueue(job("two", "head-two")).kind, "accepted");
  assert.equal(queue.enqueue(job("three", "head-three")).kind, "full");
  assert.equal(queue.enqueue(job("one")).kind, "duplicate");
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, ["one", "two"]);
  assert.equal(queue.enqueue(job("four", "head-two")).kind, "duplicate");
});

test("失败 delivery 可重投，新 head 淘汰未运行旧任务", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ran: string[] = [];
  let failOnce = true;
  const queue = new JobQueue(3, async (value) => {
    ran.push(value.deliveryId);
    if (value.deliveryId === "block") await gate;
    if (value.deliveryId === "retry" && failOnce) { failOnce = false; throw new Error("temporary"); }
  });
  queue.enqueue(job("retry", "failed-head"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(queue.enqueue(job("retry", "failed-head")).kind, "accepted");
  await new Promise((resolve) => setTimeout(resolve, 10));
  queue.enqueue(job("block", "other-pr"));
  await new Promise((resolve) => setImmediate(resolve));
  queue.enqueue(job("old", "old-head"));
  queue.enqueue(job("new", "new-head"));
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(ran, ["retry", "retry", "block", "new"]);
});

test("发布结果不确定时保留状态且不盲目重投", async () => {
  const queue = new JobQueue(1, async (value) => { value.status = "uncertain"; throw new Error("network result unknown"); });
  const accepted = queue.enqueue(job("uncertain", "uncertain-head"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(accepted.job?.status, "uncertain");
  assert.equal(queue.enqueue(job("uncertain", "uncertain-head")).kind, "duplicate");
});

test("Workspace 读取拒绝路径穿越和外部符号链接", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-test-"));
  const outside = await mkdtemp(join(tmpdir(), "outside-test-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "ok.ts"), "ok");
    await writeFile(join(outside, "secret"), "secret");
    await symlink(join(outside, "secret"), join(root, "src", "escape"));
    assert.equal(await readWorkspaceFile(root, "src/ok.ts"), "ok");
    await assert.rejects(readWorkspaceFile(root, "../secret"), /Workspace/);
    await assert.rejects(readWorkspaceFile(root, "src/escape"), /符号链接/);
  } finally { await Promise.all([rm(root, { recursive: true }), rm(outside, { recursive: true })]); }
});

test("Workspace 固定到目标 SHA 并在结束后回收", async () => {
  const repository = await mkdtemp(join(tmpdir(), "git-sample-"));
  let workspace = "";
  try {
    await exec("git", ["init", "--quiet", repository]);
    await writeFile(join(repository, "file.txt"), "base");
    await exec("git", ["-C", repository, "add", "file.txt"]);
    await exec("git", ["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "base"]);
    const base = (await exec("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(repository, "file.txt"), "head");
    await exec("git", ["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-am", "head"]);
    const head = (await exec("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
    await withWorkspace(repository, "unused", base, head, async (root) => { workspace = root; assert.equal(await readWorkspaceFile(root, "file.txt"), "head"); });
    await assert.rejects(readWorkspaceFile(workspace, "file.txt"));
  } finally { await rm(repository, { recursive: true }); }
});

test("配置缺失或格式错误时明确失败", async () => {
  const root = await mkdtemp(join(tmpdir(), "config-test-"));
  try {
    const key = join(root, "key.pem");
    await writeFile(key, "key");
    const env = { GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY_PATH: key, GITHUB_WEBHOOK_SECRET: "secret", GITHUB_ALLOWED_REPOSITORIES: "owner/repo", DATABASE_URL: "postgresql://localhost/test", MODEL_PROVIDER: "provider", MODEL_NAME: "model", MODEL_API_KEY: "api", PORT: "3000" };
    assert.equal(loadConfig(env).port, 3000);
    assert.throws(() => loadConfig({ ...env, PORT: "invalid" }), /PORT/);
    assert.throws(() => loadConfig({ ...env, MODEL_API_KEY: "" }), /MODEL_API_KEY/);
  } finally { await rm(root, { recursive: true }); }
});

test("ReviewResult 只接受约定结构和有限输出", () => {
  assert.equal(parseReviewResult('{"summary":"ok","findings":[],"coverage":["diff"],"limitations":[]}').summary, "ok");
  assert.throws(() => parseReviewResult('{"summary":"raw"}'), /结构无效/);
  assert.throws(() => parseReviewResult("x".repeat(50_001)), /超过预算/);
  const optional = { summary: "ok", findings: [{ category: "correctness", severity: "low", evidenceLevel: "strong", description: "issue", evidence: "code", impact: "impact", path: null, line: null, side: null, suggestion: null, memory: null }], coverage: [], limitations: [] };
  assert.equal(parseReviewResult(JSON.stringify(optional)).findings[0]?.memory, undefined);
  assert.throws(() => parseReviewResult(JSON.stringify({ ...optional, findings: [{ ...optional.findings[0], memory: {} }] })), /Memory/);
});

test("模型不能引用未召回或跨仓库 Memory", () => {
  const memory = { id: "memory", version: 1, repositoryId: 2, installationId: 1, type: "engineering_rule", title: "rule", content: "content", rationale: "reason", scope: {}, source: { pullRequestNumber: 1, commitSha: "sha", commentIds: [1] }, evidence: [], confidence: 1, uncertainties: [], status: "ACTIVE", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } satisfies MemoryRecord;
  const result: import("../src/types.js").ReviewResult = { summary: "", coverage: [], limitations: [], findings: [{ category: "team_rule", severity: "medium", evidenceLevel: "strong", description: "issue", evidence: "code", impact: "impact", memory: { id: "memory", version: 1, source: {} } }] };
  validateMemoryReferences(result, [memory], 2);
  assert.equal(result.findings[0]?.memory?.source.pullRequestNumber, 1);
  assert.throws(() => validateMemoryReferences({ ...result, findings: [{ ...result.findings[0]!, memory: { id: "invented", version: 1, source: {} } }] }, [memory], 2), /未召回/);
  assert.throws(() => validateMemoryReferences(result, [memory], 3), /无效/);
});

test("GitHub Publisher 固定 COMMENT 和 commit_id", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const client = new GitHubClient("1", keys.privateKey);
  const original = globalThis.fetch;
  let sent: Record<string, unknown> | undefined;
  globalThis.fetch = async (_url, init) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ id: 9, html_url: "https://example/review/9" }), { status: 200 }); };
  try {
    await client.createReview("token", { ...job("delivery", "head"), id: "job", status: "running" }, "body");
    assert.deepEqual(sent, { commit_id: "head", event: "COMMENT", body: "body", comments: [] });
    globalThis.fetch = async () => new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
    await assert.rejects(client.createReview("token", { ...job("denied", "head"), id: "job", status: "running" }, "body"), /403/);
  } finally { globalThis.fetch = original; }
});

test("GitHub API 保留 Retry-After", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const client = new GitHubClient("1", keys.privateKey);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 429, headers: { "retry-after": "17" } });
  try { await assert.rejects(client.getUser("token"), (error: unknown) => error instanceof GitHubApiError && error.retryAfterSeconds === 17); }
  finally { globalThis.fetch = original; }
});

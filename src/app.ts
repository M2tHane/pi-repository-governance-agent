import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Config } from "./config.js";
import type { JobAcceptor } from "./database.js";
import { JobQueue } from "./queue.js";
import type { PullRequestEvent, ReviewJob } from "./types.js";

const actions = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

function send(response: ServerResponse, status: number, value: object) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new RangeError("payload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function verifySignature(body: Buffer, signature: string, secret: string): boolean {
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function parsePullRequest(value: unknown): PullRequestEvent {
  const event = value as Partial<PullRequestEvent> | null;
  const pr = event?.pull_request;
  if (!event || typeof event.action !== "string" || !Number.isSafeInteger(event.installation?.id) || !Number.isSafeInteger(event.repository?.id) || typeof event.repository?.full_name !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(event.repository.full_name) || !pr || !Number.isSafeInteger(pr.number) || typeof pr.title !== "string" || !(pr.body === null || typeof pr.body === "string") || typeof pr.draft !== "boolean" || typeof pr.state !== "string" || typeof pr.base?.sha !== "string" || typeof pr.head?.sha !== "string") throw new Error("缺少 pull_request 必需字段");
  if (event.action === "closed" && (typeof pr.merged !== "boolean" || (pr.merged && typeof pr.merge_commit_sha !== "string"))) throw new Error("closed 事件缺少 merged snapshot 字段");
  return event as PullRequestEvent;
}

export function createApp(config: Config, target: JobAcceptor | ((job: ReviewJob) => Promise<void>), fallback?: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const queue = typeof target === "function" ? new JobQueue(config.queueCapacity, target) : undefined;
  const accept = typeof target === "function" ? (input: Omit<ReviewJob, "id" | "status">, _meta: { event: string; action: string; merged?: boolean; mergeCommitSha?: string | null }) => Promise.resolve(queue!.enqueue(input)) : target.accept.bind(target);
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/github/webhook") return fallback ? fallback(request, response) : send(response, 404, { error: "not found" });
    const eventName = request.headers["x-github-event"];
    const deliveryId = request.headers["x-github-delivery"];
    const signature = request.headers["x-hub-signature-256"];
    if (typeof eventName !== "string" || typeof deliveryId !== "string" || typeof signature !== "string") return send(response, 400, { error: "缺少 GitHub header" });
    if (Number(request.headers["content-length"]) > config.webhookMaxBytes) return send(response, 413, { error: "请求体过大" });
    let body: Buffer;
    try { body = await readBody(request, config.webhookMaxBytes); }
    catch (error) { return send(response, error instanceof RangeError ? 413 : 400, { error: "请求体读取失败" }); }
    if (!verifySignature(body, signature, config.webhookSecret)) return send(response, 401, { error: "签名无效" });
    let payload: unknown;
    try { payload = JSON.parse(body.toString("utf8")); } catch { return send(response, 400, { error: "JSON 无效" }); }
    if (eventName !== "pull_request") return send(response, 200, { ignored: true });
    let event: PullRequestEvent;
    try { event = parsePullRequest(payload); } catch (error) { return send(response, 422, { error: error instanceof Error ? error.message : "payload 无效" }); }
    const repository = event.repository.full_name.toLowerCase();
    const pr = event.pull_request;
    const closed = event.action === "closed";
    if ((!actions.has(event.action) && !closed) || (!closed && (pr.draft || pr.state !== "open" || pr.head.repo?.full_name !== event.repository.full_name)) || !config.allowedRepositories.has(repository)) return send(response, 200, { ignored: true });
    let result;
    try { result = await accept({ deliveryId, installationId: event.installation.id, repositoryId: event.repository.id, repository: event.repository.full_name, cloneUrl: `https://github.com/${event.repository.full_name}.git`, prNumber: pr.number, title: pr.title, body: pr.body ?? "", baseSha: pr.base.sha, headSha: pr.head.sha }, { event: eventName, action: event.action, merged: pr.merged, mergeCommitSha: pr.merge_commit_sha }); }
    catch { return send(response, 503, { error: "任务持久化失败" }); }
    if (result.kind === "full") return send(response, 503, { error: "任务队列已满" });
    return send(response, 202, { accepted: result.kind === "accepted", duplicate: result.kind === "duplicate", jobId: result.job?.id });
  });
  return { server, queue };
}

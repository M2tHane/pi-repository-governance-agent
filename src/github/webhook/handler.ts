import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Config } from "../../config/config.js";
import type { JobAcceptor } from "../../persistence/database.js";
import { JobQueue } from "../../jobs/queue.js";
import type { ReviewJob } from "../../jobs/types.js";
import { readBody, send } from "./http.js";
import { verifySignature } from "./signature.js";
import { handleInstallation } from "./events/installation.js";
import { handleReviewComment } from "./events/review-comment.js";
import { handlePullRequest } from "./events/pull-request.js";

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
    if (eventName === "installation" || eventName === "installation_repositories") return handleInstallation(target, eventName, deliveryId, payload, response);
    if (eventName === "pull_request_review_comment") return handleReviewComment(config, target, deliveryId, payload, response);
    if (eventName !== "pull_request") return send(response, 200, { ignored: true });
    return handlePullRequest(config, target, accept, deliveryId, eventName, payload, response);
  });
  return { server, queue };
}

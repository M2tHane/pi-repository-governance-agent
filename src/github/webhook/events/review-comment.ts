import type { ServerResponse } from "node:http";
import type { Config } from "../../../config/config.js";
import type { JobAcceptor } from "../../../persistence/database.js";
import type { ReviewJob } from "../../../jobs/types.js";
import { send } from "../http.js";
import { parseReviewComment } from "../parser.js";

export async function handleReviewComment(config: Config, target: JobAcceptor | ((job: ReviewJob) => Promise<void>), deliveryId: string, payload: unknown, response: ServerResponse) {
  if (typeof target === "function" || !("acceptReply" in target) || typeof target.acceptReply !== "function") return send(response, 200, { ignored: true });
  const raw = payload as any;
  if (raw?.action !== "created" || raw?.pull_request?.draft === true || !Number.isSafeInteger(raw?.comment?.in_reply_to_id) || raw?.comment?.user?.type !== "User") return send(response, 200, { ignored: true });
  let input;
  try { input = parseReviewComment(payload); } catch (error) { return send(response, 422, { error: error instanceof Error ? error.message : "payload 无效" }); }
  if (input.action !== "created" || input.state !== "open" || input.authorType !== "User" || !config.allowedRepositories.has(input.repository.toLowerCase())) return send(response, 200, { ignored: true });
  let result;
  try { result = await target.acceptReply({ ...input, deliveryId }); } catch { return send(response, 503, { error: "任务持久化失败" }); }
  return result.kind === "ignored" ? send(response, 200, { ignored: true }) : send(response, 202, { accepted: result.kind === "accepted", duplicate: result.kind === "duplicate", jobId: result.job?.id });
}

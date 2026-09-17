import type { ServerResponse } from "node:http";
import type { Config } from "../../../config/config.js";
import type { JobAcceptor } from "../../../persistence/database.js";
import type { ReviewJob } from "../../../jobs/types.js";
import { send } from "../http.js";
import type { PullRequestEvent } from "../../types.js";
import { parsePullRequest } from "../parser.js";

const actions = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

export async function handlePullRequest(config: Config, target: JobAcceptor | ((job: ReviewJob) => Promise<void>), accept: JobAcceptor["accept"], deliveryId: string, eventName: string, payload: unknown, response: ServerResponse) {
  let event: PullRequestEvent;
  try { event = parsePullRequest(payload); } catch (error) { return send(response, 422, { error: error instanceof Error ? error.message : "payload 无效" }); }
  const repository = event.repository.full_name.toLowerCase();
  const pr = event.pull_request;
  const closed = event.action === "closed";
  if (!closed && (pr.draft || pr.state !== "open") && typeof target !== "function") target.cancelReview?.(event.repository.id, pr.number);
  if ((!actions.has(event.action) && !closed) || (!closed && (pr.draft || pr.state !== "open" || pr.head.repo?.full_name !== event.repository.full_name)) || !config.allowedRepositories.has(repository)) return send(response, 200, { ignored: true });
  let result;
  try { result = await accept({ deliveryId, installationId: event.installation.id, repositoryId: event.repository.id, repository: event.repository.full_name, cloneUrl: `https://github.com/${event.repository.full_name}.git`, prNumber: pr.number, title: pr.title, body: pr.body ?? "", baseSha: pr.base.sha, headSha: pr.head.sha }, { event: eventName, action: event.action, merged: pr.merged, mergeCommitSha: pr.merge_commit_sha }); }
  catch { return send(response, 503, { error: "任务持久化失败" }); }
  if (result.kind === "full") return send(response, 503, { error: "任务队列已满" });
  return send(response, 202, { accepted: result.kind === "accepted", duplicate: result.kind === "duplicate", jobId: result.job?.id });

}

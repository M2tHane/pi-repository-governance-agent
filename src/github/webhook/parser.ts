import type { ReviewReplyInput } from "../../persistence/database.js";
import type { PullRequestEvent } from "../types.js";

export function parsePullRequest(value: unknown): PullRequestEvent {
  const event = value as Partial<PullRequestEvent> | null;
  const pr = event?.pull_request;
  if (!event || typeof event.action !== "string" || !Number.isSafeInteger(event.installation?.id) || !Number.isSafeInteger(event.repository?.id) || typeof event.repository?.full_name !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(event.repository.full_name) || !pr || !Number.isSafeInteger(pr.number) || typeof pr.title !== "string" || !(pr.body === null || typeof pr.body === "string") || typeof pr.draft !== "boolean" || typeof pr.state !== "string" || typeof pr.base?.sha !== "string" || typeof pr.head?.sha !== "string") throw new Error("缺少 pull_request 必需字段");
  if (event.action === "closed" && (typeof pr.merged !== "boolean" || (pr.merged && typeof pr.merge_commit_sha !== "string"))) throw new Error("closed 事件缺少 merged snapshot 字段");
  return event as PullRequestEvent;
}

export function parseReviewComment(value: unknown): ReviewReplyInput & { action: string; state: string; authorType: string } {
  const event = value as any;
  const comment = event?.comment, pr = event?.pull_request, repository = event?.repository;
  if (typeof comment?.created_at !== "string" || !Number.isFinite(Date.parse(comment.created_at))) throw new Error("review comment created_at 无效");
  if (typeof event?.action !== "string" || !Number.isSafeInteger(event?.installation?.id) || !Number.isSafeInteger(repository?.id) || typeof repository?.full_name !== "string" || !Number.isSafeInteger(pr?.number) || typeof pr?.state !== "string" || typeof pr?.base?.sha !== "string" || typeof pr?.head?.sha !== "string" || !Number.isSafeInteger(comment?.id) || !Number.isSafeInteger(comment?.in_reply_to_id) || typeof comment?.body !== "string" || typeof comment?.html_url !== "string" || !Number.isSafeInteger(comment?.user?.id) || typeof comment?.user?.login !== "string" || typeof comment?.user?.type !== "string") throw new Error("缺少 review comment 必需字段");
  return { action: event.action, state: pr.state, authorType: comment.user.type, deliveryId: "", installationId: event.installation.id, repositoryId: repository.id, repository: repository.full_name, prNumber: pr.number, baseSha: pr.base.sha, eventHeadSha: pr.head.sha, rootCommentId: comment.in_reply_to_id, sourceCommentId: comment.id, sourceCommentUrl: comment.html_url, humanActorId: comment.user.id, humanActorLogin: comment.user.login, humanReplyBody: comment.body, humanReplyCreatedAt: new Date(comment.created_at).toISOString() };
}

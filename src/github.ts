import { createSign } from "node:crypto";
import type { ReviewJob } from "./types.js";

const api = "https://api.github.com";

export class GitHubApiError extends Error {
  constructor(path: string, status: number, readonly retryAfterSeconds?: number) { super(`GitHub API ${path} 失败 (${status})`); }
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export class GitHubClient {
  constructor(private appId: string, private privateKey: string) {}

  private jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.appId }))}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.privateKey);
    return `${unsigned}.${base64url(signature)}`;
  }

  async installationToken(installationId: number): Promise<string> {
    const response = await fetch(`${api}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.jwt()}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    });
    if (!response.ok) throw new Error(`GitHub installation 认证失败 (${response.status})`);
    const body = await response.json() as { token?: string };
    if (!body.token) throw new Error("GitHub installation 响应缺少 token");
    return body.token;
  }

  private async request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${api}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28", ...init.headers } });
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new GitHubApiError(path, response.status, Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined);
    }
    return await response.json() as T;
  }

  getPullRequest(token: string, repository: string, number: number) {
    return this.request<{ number: number; title: string; body: string | null; state: string; draft: boolean; merged: boolean; merged_at: string | null; merge_commit_sha: string | null; base: { sha: string }; head: { sha: string } }>(token, `/repos/${repository}/pulls/${number}`);
  }

  private async pages<T>(token: string, path: string): Promise<T[]> {
    const values: T[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.request<T[]>(token, `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      values.push(...batch);
      if (batch.length < 100) return values;
    }
  }

  getConversationComments(token: string, repository: string, number: number) { return this.pages<{ id: number; html_url: string; body: string; user: { id: number; login: string; type: string } }>(token, `/repos/${repository}/issues/${number}/comments`); }
  getReviews(token: string, repository: string, number: number) { return this.pages<{ id: number; html_url: string; body: string; state: string; commit_id: string; user: { id: number; login: string; type: string } }>(token, `/repos/${repository}/pulls/${number}/reviews`); }
  getReviewComments(token: string, repository: string, number: number) { return this.pages<{ id: number; in_reply_to_id?: number; html_url: string; body: string; path: string; line: number | null; commit_id: string; created_at: string; user: { id: number; login: string; type: string } }>(token, `/repos/${repository}/pulls/${number}/comments`); }

  async getFiles(token: string, repository: string, number: number): Promise<Array<{ filename: string; status: string; patch?: string }>> {
    const files = [];
    for (let page = 1; ; page++) {
      const batch = await this.request<Array<{ filename: string; status: string; patch?: string }>>(token, `/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`);
      files.push(...batch);
      if (batch.length < 100) return files;
    }
  }

  createReview(token: string, job: ReviewJob, body: string, comments: Array<{ path: string; line: number; side: "LEFT" | "RIGHT"; body: string }> = []) {
    return this.request<{ id: number; html_url: string }>(token, `/repos/${job.repository}/pulls/${job.prNumber}/reviews`, {
      method: "POST",
      body: JSON.stringify({ commit_id: job.headSha, event: "COMMENT", body, comments }),
    });
  }

  getReviewCommentsForReview(token: string, repository: string, number: number, reviewId: number) { return this.pages<{ id: number; html_url: string; body: string }>(token, `/repos/${repository}/pulls/${number}/reviews/${reviewId}/comments`); }

  replyToReviewComment(token: string, repository: string, number: number, rootCommentId: number, body: string) {
    return this.request<{ id: number; html_url: string }>(token, `/repos/${repository}/pulls/${number}/comments/${rootCommentId}/replies`, { method: "POST", body: JSON.stringify({ body }) });
  }

  async exchangeOAuthCode(clientId: string, clientSecret: string, code: string) {
    const response = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }) });
    const body = await response.json() as { access_token?: string; error_description?: string };
    if (!response.ok || !body.access_token) throw new Error(body.error_description ?? `GitHub OAuth 失败 (${response.status})`);
    return body.access_token;
  }

  getUser(token: string) { return this.request<{ id: number; login: string }>(token, "/user"); }

  async hasMaintainerPermission(token: string, repository: string) {
    const value = await this.request<{ permissions?: { admin?: boolean; maintain?: boolean } }>(token, `/repos/${repository}`);
    return value.permissions?.admin === true || value.permissions?.maintain === true;
  }
}

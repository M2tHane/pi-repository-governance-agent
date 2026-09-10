import { createSign } from "node:crypto";
import type { ReviewJob } from "./types.js";

const api = "https://api.github.com";

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
    if (!response.ok) throw new Error(`GitHub API ${path} 失败 (${response.status})`);
    return await response.json() as T;
  }

  getPullRequest(token: string, repository: string, number: number) {
    return this.request<{ state: string; draft: boolean; head: { sha: string } }>(token, `/repos/${repository}/pulls/${number}`);
  }

  async getFiles(token: string, repository: string, number: number): Promise<Array<{ filename: string; status: string; patch?: string }>> {
    const files = [];
    for (let page = 1; ; page++) {
      const batch = await this.request<Array<{ filename: string; status: string; patch?: string }>>(token, `/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`);
      files.push(...batch);
      if (batch.length < 100) return files;
    }
  }

  createReview(token: string, job: ReviewJob, body: string) {
    return this.request<{ id: number; html_url: string }>(token, `/repos/${job.repository}/pulls/${job.prNumber}/reviews`, {
      method: "POST",
      body: JSON.stringify({ commit_id: job.headSha, event: "COMMENT", body }),
    });
  }
}

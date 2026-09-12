import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import type { Database } from "./database.js";
import { GitHubClient } from "./github.js";
import { MemoryService, type Actor, type CandidatePatch } from "./memory.js";

type Session = Actor & { token: string; csrf: string; expiresAt: number };
type Repository = { id: number; installationId: number; fullName: string; enabled: boolean; includePaths: string[]; excludePaths: string[]; outputLanguage: string; budgetTokens: number; reviewMode: "single" | "auto"; maxDelegates: number };

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(value));
}

function cookies(request: IncomingMessage) {
  return Object.fromEntries((request.headers.cookie ?? "").split(";").map((part) => part.trim().split(/=(.*)/s, 2)).filter(([name, value]) => name && value).map(([name, value]) => [name!, decodeURIComponent(value!)]));
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 65_536) throw new Error("请求体过大"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function repository(row: Record<string, unknown>): Repository {
  return { id: Number(row.id), installationId: Number(row.installation_id), fullName: String(row.full_name), enabled: Boolean(row.enabled), includePaths: row.include_paths as string[], excludePaths: row.exclude_paths as string[], outputLanguage: String(row.output_language), budgetTokens: Number(row.budget_tokens), reviewMode: row.review_mode as "single" | "auto", maxDelegates: Number(row.max_delegates) };
}

export function createAdminHandler(config: Config, database: Database, github = new GitHubClient(config.appId, config.privateKey)) {
  const sessions = new Map<string, Session>();
  const states = new Map<string, number>();
  const memories = new MemoryService(database);
  const configured = Boolean(config.githubClientId && config.githubClientSecret && config.githubOAuthCallbackUrl && config.sessionSecret && config.sessionSecret.length >= 32);
  const secure = config.githubOAuthCallbackUrl?.startsWith("https://") ?? false;
  const sign = (id: string) => createHmac("sha256", config.sessionSecret ?? "").update(id).digest("base64url");
  const cookie = (name: string, value: string, maxAge = 3600) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

  function session(request: IncomingMessage) {
    const [id, signature] = (cookies(request).session ?? "").split(".");
    if (!id || !signature) return undefined;
    const expected = Buffer.from(sign(id));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
    const value = sessions.get(id);
    if (!value || value.expiresAt < Date.now()) { sessions.delete(id); return undefined; }
    return value;
  }

  async function allowedRepositories(user: Session) {
    const result = await database.pool.query("SELECT * FROM repositories ORDER BY full_name");
    const values: Repository[] = [];
    for (const row of result.rows) if (await github.hasMaintainerPermission(user.token, String(row.full_name))) values.push(repository(row));
    return values;
  }

  async function authorize(request: IncomingMessage, response: ServerResponse, repositoryId: number) {
    const user = session(request);
    if (!user) { json(response, 401, { error: "请先登录" }); return undefined; }
    const result = await database.pool.query("SELECT * FROM repositories WHERE id=$1", [repositoryId]);
    if (!result.rows[0]) { json(response, 404, { error: "仓库不存在" }); return undefined; }
    if (!await github.hasMaintainerPermission(user.token, String(result.rows[0].full_name))) { json(response, 403, { error: "需要 repository maintain 或 admin 权限" }); return undefined; }
    return { user, repository: repository(result.rows[0]) };
  }

  function requireCsrf(request: IncomingMessage, response: ServerResponse, user: Session) {
    let callbackOrigin: string;
    try { callbackOrigin = new URL(config.githubOAuthCallbackUrl!).origin; } catch { json(response, 503, { error: "OAuth 未配置" }); return false; }
    if (request.headers.origin !== callbackOrigin || request.headers["x-csrf-token"] !== user.csrf) { json(response, 403, { error: "CSRF 校验失败" }); return false; }
    return true;
  }

  return async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://local");
    try {
      if (request.method === "GET" && url.pathname === "/auth/github") {
        if (!configured) return json(response, 503, { error: "OAuth 未配置" });
        const state = randomBytes(32).toString("base64url");
        states.set(state, Date.now() + 10 * 60_000);
        response.writeHead(302, { location: `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(config.githubClientId!)}&redirect_uri=${encodeURIComponent(config.githubOAuthCallbackUrl!)}&state=${state}`, "set-cookie": cookie("oauth_state", state, 600) }).end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/auth/github/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const expiresAt = state ? states.get(state) : undefined;
        if (!configured || !code || !state || cookies(request).oauth_state !== state || !expiresAt || expiresAt < Date.now()) return json(response, 400, { error: "OAuth state 无效" });
        states.delete(state);
        const token = await github.exchangeOAuthCode(config.githubClientId!, config.githubClientSecret!, code);
        const actor = await github.getUser(token);
        const id = randomBytes(32).toString("base64url");
        sessions.set(id, { ...actor, token, csrf: randomBytes(24).toString("base64url"), expiresAt: Date.now() + 8 * 60 * 60_000 });
        response.writeHead(302, { location: "/", "set-cookie": [cookie("session", `${id}.${sign(id)}`, 8 * 60 * 60), cookie("oauth_state", "", 0)] }).end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/auth/logout") {
        const user = session(request);
        if (user && requireCsrf(request, response, user)) for (const [id, value] of sessions) if (value === user) sessions.delete(id);
        if (!response.headersSent) response.writeHead(204, { "set-cookie": cookie("session", "", 0) }).end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        const user = session(request);
        return user ? json(response, 200, { user: { id: user.id, login: user.login }, csrf: user.csrf }) : json(response, 401, { error: "请先登录" });
      }
      if (url.pathname.startsWith("/api/")) {
        const user = session(request);
        if (!user) return json(response, 401, { error: "请先登录" });
        if (request.method !== "GET" && !requireCsrf(request, response, user)) return;
        if (request.method === "GET" && url.pathname === "/api/repositories") return json(response, 200, await allowedRepositories(user));
        const repositoryMatch = url.pathname.match(/^\/api\/repositories\/(\d+)$/);
        if (repositoryMatch && request.method === "PATCH") {
          const access = await authorize(request, response, Number(repositoryMatch[1])); if (!access) return;
          const value = await body(request) as Partial<Pick<Repository, "enabled" | "includePaths" | "excludePaths" | "outputLanguage" | "budgetTokens" | "reviewMode" | "maxDelegates">>;
          if ((value.enabled !== undefined && typeof value.enabled !== "boolean") || (value.includePaths !== undefined && (!Array.isArray(value.includePaths) || !value.includePaths.every((x) => typeof x === "string"))) || (value.excludePaths !== undefined && (!Array.isArray(value.excludePaths) || !value.excludePaths.every((x) => typeof x === "string"))) || (value.outputLanguage !== undefined && typeof value.outputLanguage !== "string") || (value.budgetTokens !== undefined && (!Number.isSafeInteger(value.budgetTokens) || value.budgetTokens! <= 0)) || (value.reviewMode !== undefined && value.reviewMode !== "single" && value.reviewMode !== "auto") || (value.maxDelegates !== undefined && (!Number.isSafeInteger(value.maxDelegates) || value.maxDelegates! < 0 || value.maxDelegates! > 4))) return json(response, 422, { error: "仓库配置无效" });
          const updated = await database.pool.query("UPDATE repositories SET enabled=COALESCE($2,enabled),include_paths=COALESCE($3,include_paths),exclude_paths=COALESCE($4,exclude_paths),output_language=COALESCE($5,output_language),budget_tokens=COALESCE($6,budget_tokens),review_mode=COALESCE($7,review_mode),max_delegates=COALESCE($8,max_delegates),updated_at=now() WHERE id=$1 RETURNING *", [access.repository.id, value.enabled ?? null, value.includePaths ?? null, value.excludePaths ?? null, value.outputLanguage ?? null, value.budgetTokens ?? null, value.reviewMode ?? null, value.maxDelegates ?? null]);
          if (value.enabled === false) database.cancelRepository(access.repository.id);
          return json(response, 200, repository(updated.rows[0]));
        }
        if (request.method === "GET" && url.pathname === "/api/jobs") {
          const repositories = await allowedRepositories(user); const ids = repositories.map((item) => item.id);
          if (!ids.length) return json(response, 200, []);
          const result = await database.pool.query("SELECT j.*,p.github_review_url,COALESCE((SELECT jsonb_agg(to_jsonb(a) - 'job_id' ORDER BY a.started_at) FROM agent_runs a WHERE a.job_id=j.id),'[]') agent_runs FROM jobs j LEFT JOIN review_publications p ON p.job_id=j.id WHERE j.repository_id=ANY($1::bigint[]) ORDER BY j.created_at DESC LIMIT 200", [ids]);
          return json(response, 200, result.rows);
        }
        const jobMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)$/i);
        if (jobMatch && request.method === "GET") {
          const result = await database.pool.query("SELECT j.*,p.github_review_url FROM jobs j LEFT JOIN review_publications p ON p.job_id=j.id WHERE j.id=$1", [jobMatch[1]]);
          if (!result.rows[0]) return json(response, 404, { error: "Job 不存在" });
          if (!await authorize(request, response, Number(result.rows[0].repository_id))) return;
          const runs = await database.pool.query("SELECT * FROM agent_runs WHERE job_id=$1 ORDER BY started_at", [jobMatch[1]]);
          return json(response, 200, { ...result.rows[0], agent_runs: runs.rows });
        }
        if (request.method === "GET" && url.pathname === "/api/findings") {
          const repositories = await allowedRepositories(user); const ids = repositories.map((item) => item.id);
          if (!ids.length) return json(response, 200, []);
          const result = await database.pool.query("SELECT f.*,source_job.repository,j.payload->>'humanReplyBody' human_reply_body,j.payload->>'humanActorLogin' human_actor_login,j.payload->>'sourceCommentUrl' human_reply_url,r.source_comment_id,r.analysis_head_sha,r.result reply_result,r.github_reply_url,r.status reply_publish_status,CASE WHEN d.id IS NOT NULL THEN jsonb_build_object('id',d.id,'type',d.type,'summary',d.summary) END decision_clue FROM review_findings f JOIN jobs source_job ON source_job.id=f.job_id LEFT JOIN reply_publications r ON r.finding_id=f.id LEFT JOIN jobs j ON j.id=r.job_id LEFT JOIN decision_clues d ON d.repository_id=f.repository_id AND d.source_human_comment_id=r.source_comment_id WHERE f.repository_id=ANY($1::bigint[]) ORDER BY COALESCE(r.created_at,f.created_at) DESC", [ids]);
          return json(response, 200, result.rows);
        }
        if (request.method === "GET" && url.pathname === "/api/memories") {
          const repositories = await allowedRepositories(user); const status = url.searchParams.get("status") ?? undefined;
          const values = (await Promise.all(repositories.map((item) => memories.list(item.id, status as any)))).flat();
          return json(response, 200, values);
        }
        const memoryMatch = url.pathname.match(/^\/api\/memories\/([0-9a-f-]+)(?:\/(approve|reject|deprecate|supersede))?$/i);
        if (memoryMatch) {
          const result = await database.pool.query("SELECT repository_id FROM memories WHERE id=$1 ORDER BY version DESC LIMIT 1", [memoryMatch[1]]);
          if (!result.rows[0]) return json(response, 404, { error: "Memory 不存在" });
          const access = await authorize(request, response, Number(result.rows[0].repository_id)); if (!access) return;
          if (request.method === "GET" && !memoryMatch[2]) {
            const current = await memories.get(access.repository.id, memoryMatch[1]!);
            const versions = await database.pool.query("SELECT * FROM memories WHERE repository_id=$1 AND id=$2 ORDER BY version DESC", [access.repository.id, memoryMatch[1]]);
            return json(response, 200, { ...current, versions: versions.rows });
          }
          if (request.method === "PATCH" && !memoryMatch[2]) {
            const value = await body(request) as CandidatePatch;
            const types = new Set(["architecture_decision", "engineering_rule", "security_rule", "coding_convention", "exception", "deprecated_pattern"]);
            if ((value.type !== undefined && !types.has(value.type)) || (value.title !== undefined && typeof value.title !== "string") || (value.content !== undefined && typeof value.content !== "string") || (value.rationale !== undefined && typeof value.rationale !== "string") || (value.uncertainties !== undefined && (!Array.isArray(value.uncertainties) || !value.uncertainties.every((x) => typeof x === "string"))) || (value.scope !== undefined && (!value.scope || typeof value.scope !== "object" || !Object.values(value.scope).every((x) => x === undefined || Array.isArray(x) && x.every((item) => typeof item === "string"))))) return json(response, 422, { error: "Memory 修改无效" });
            return json(response, 200, await memories.edit(access.repository.id, memoryMatch[1]!, value, user));
          }
          if (request.method === "POST" && memoryMatch[2] === "supersede") return json(response, 200, await memories.supersede(access.repository.id, memoryMatch[1]!, String((await body(request) as { candidateId?: string }).candidateId ?? ""), user));
          if (request.method === "POST" && memoryMatch[2]) return json(response, 200, await memories.transition(access.repository.id, memoryMatch[1]!, memoryMatch[2] as "approve" | "reject" | "deprecate", user));
        }
        return json(response, 404, { error: "not found" });
      }
      if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/assets/"))) {
        const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const content = await readFile(resolve("dist/admin", path));
        const type = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html";
        response.writeHead(200, { "content-type": `${type}; charset=utf-8` }).end(content);
        return;
      }
      json(response, 404, { error: "not found" });
    } catch (error) { json(response, 500, { error: error instanceof Error ? error.message : "请求失败" }); }
  };
}

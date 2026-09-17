import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Database } from "../persistence/database.js";
import type { Repository, Session } from "./dto.js";
import { json } from "./http.js";

export function createFindingsRoute(database: Database, sign: (value: string) => string, allowedRepositories: (user: Session) => Promise<Repository[]>) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL, user: Session) => {
        if (request.method === "GET" && url.pathname === "/api/findings") {
          const jobId = url.searchParams.get("jobId"), repositoryId = url.searchParams.get("repositoryId");
          const limit = Number(url.searchParams.get("limit") ?? 50);
          if (jobId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId) || repositoryId !== null && (!/^\d+$/.test(repositoryId) || !Number.isSafeInteger(Number(repositoryId)) || Number(repositoryId) <= 0) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) return json(response, 422, { error: "讨论筛选或分页参数无效" });
          let cursor: { at: string; finding: string; reply: string; jobId: string | null; repositoryId: string | null } | undefined;
          const rawCursor = url.searchParams.get("cursor");
          if (rawCursor !== null) {
            try {
              if (rawCursor.length > 2048) throw new Error();
              const [payload, signature, extra] = rawCursor.split(".");
              if (!payload || !signature || extra !== undefined) throw new Error();
              const expected = Buffer.from(sign(payload)), actual = Buffer.from(signature);
              if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error();
              const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
              if (!value || value.jobId !== jobId || value.repositoryId !== repositoryId || typeof value.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.at) || typeof value.finding !== "string" || !/^finding_[0-9a-f]{24}$/.test(value.finding) || typeof value.reply !== "string" || !/^\d{1,19}$/.test(value.reply)) throw new Error();
              cursor = value;
            } catch { return json(response, 422, { error: "讨论游标无效，请重新加载" }); }
          }
          const repositories = await allowedRepositories(user);
          const ids = repositories.filter(item => repositoryId === null || item.id === Number(repositoryId)).map(item => item.id);
          if (!ids.length) return json(response, 200, { items: [], nextCursor: null });
          const result = await database.pool.query(`SELECT f.*,to_char(COALESCE(r.created_at,f.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at,COALESCE(r.source_comment_id,0)::text cursor_reply,source_job.repository,j.payload->>'humanReplyBody' human_reply_body,j.payload->>'humanActorLogin' human_actor_login,j.payload->>'sourceCommentUrl' human_reply_url,r.source_comment_id,r.analysis_head_sha,r.result reply_result,r.github_reply_url,r.status reply_publish_status,CASE WHEN d.id IS NOT NULL THEN jsonb_build_object('id',d.id,'type',d.type,'summary',d.summary) END decision_clue FROM review_findings f JOIN jobs source_job ON source_job.id=f.job_id LEFT JOIN reply_publications r ON r.finding_id=f.id LEFT JOIN jobs j ON j.id=r.job_id LEFT JOIN decision_clues d ON d.repository_id=f.repository_id AND d.source_human_comment_id=r.source_comment_id WHERE f.repository_id=ANY($1::bigint[]) AND ($2::uuid IS NULL OR f.job_id=$2) AND ($3::timestamptz IS NULL OR (COALESCE(r.created_at,f.created_at),f.id,COALESCE(r.source_comment_id,0)) < ($3::timestamptz,$4::text,$5::bigint)) ORDER BY COALESCE(r.created_at,f.created_at) DESC,f.id DESC,COALESCE(r.source_comment_id,0) DESC LIMIT $6`, [ids, jobId, cursor?.at ?? null, cursor?.finding ?? null, cursor?.reply ?? null, limit + 1]);
          const rows = result.rows.slice(0, limit);
          let nextCursor: string | null = null;
          if (result.rows.length > limit) {
            const last = rows.at(-1)!;
            const payload = Buffer.from(JSON.stringify({ at: last.cursor_at, finding: last.id, reply: last.cursor_reply, jobId, repositoryId })).toString("base64url");
            nextCursor = payload + "." + sign(payload);
          }
          return json(response, 200, { items: rows.map(({ cursor_at, cursor_reply, ...row }) => row), nextCursor });
        }
  };
}

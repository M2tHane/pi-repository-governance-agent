import { randomUUID } from "node:crypto";
import { extname, matchesGlob } from "node:path";
import type { Database } from "../persistence/database.js";
import { transaction } from "../persistence/transaction.js";
import type { DecisionProposal, MemoryRecord } from "./types.js";

export interface Actor { id: number; login: string }
export type CandidatePatch = Partial<Pick<MemoryRecord, "type" | "title" | "content" | "rationale" | "scope" | "uncertainties">>;

export class MemoryService {
  constructor(private database: Database) {}

  async list(repositoryId: number, status?: MemoryRecord["status"]) {
    const result = await this.database.pool.query("SELECT DISTINCT ON (id) *,max(version) FILTER (WHERE status='ACTIVE') OVER (PARTITION BY id) active_version FROM memories WHERE repository_id=$1 ORDER BY id,(status IN ('ACTIVE','CANDIDATE')) DESC,version DESC", [repositoryId]);
    return result.rows.map(toMemory).filter((memory) => !status || memory.status === status);
  }

  async get(repositoryId: number, id: string) {
    const result = await this.database.pool.query("SELECT * FROM memories WHERE repository_id=$1 AND id=$2 ORDER BY (status IN ('ACTIVE','CANDIDATE')) DESC,version DESC LIMIT 1", [repositoryId, id]);
    return result.rows[0] ? toMemory(result.rows[0]) : undefined;
  }

  async edit(repositoryId: number, id: string, patch: CandidatePatch, actor: Actor) {
    const client = await this.database.pool.connect();
    try {
      return await transaction(client, async () => {
        const currentResult = await client.query("SELECT * FROM memories WHERE repository_id=$1 AND id=$2 ORDER BY (status IN ('ACTIVE','CANDIDATE')) DESC,version DESC LIMIT 1 FOR UPDATE", [repositoryId, id]);
        if (!currentResult.rows[0]) throw new Error("Memory 不存在或不属于当前仓库");
        const current = toMemory(currentResult.rows[0]);
        const after = { ...current, ...patch };
        if (current.status === "CANDIDATE") {
          await client.query("UPDATE memories SET type=$3,title=$4,content=$5,rationale=$6,scope=$7,uncertainties=$8,updated_at=now() WHERE repository_id=$1 AND id=$2 AND version=$9", [repositoryId, id, after.type, after.title, after.content, after.rationale, after.scope, JSON.stringify(after.uncertainties), current.version]);
        } else if (current.status === "ACTIVE") {
          const version = Number((await client.query("SELECT max(version)+1 version FROM memories WHERE repository_id=$1 AND id=$2", [repositoryId, id])).rows[0].version);
          await client.query("INSERT INTO memories(id,version,repository_id,installation_id,type,title,content,rationale,scope,source,evidence,confidence,uncertainties,status,source_fingerprint,exception_to,expires_at,supersedes) SELECT id,$3::integer,repository_id,installation_id,$4,$5,$6,$7,$8,source,evidence,confidence,$9,'CANDIDATE',source_fingerprint||':v'||$3::text,exception_to,expires_at,supersedes FROM memories WHERE repository_id=$1 AND id=$2 AND version=$10", [repositoryId, id, version, after.type, after.title, after.content, after.rationale, after.scope, JSON.stringify(after.uncertainties), current.version]);
          after.version = version;
          after.status = "CANDIDATE";
        } else throw new Error("当前 Memory 状态不可编辑");
        await audit(client, current, after, actor, "edit");
        return after;
      });
    } finally { client.release(); }
  }

  async transition(repositoryId: number, id: string, action: "approve" | "reject" | "deprecate", actor: Actor) {
    const client = await this.database.pool.connect();
    try {
      return await transaction(client, async () => {
        const result = await client.query("SELECT * FROM memories WHERE repository_id=$1 AND id=$2 ORDER BY (status IN ('ACTIVE','CANDIDATE')) DESC,version DESC LIMIT 1 FOR UPDATE", [repositoryId, id]);
        if (!result.rows[0]) throw new Error("Memory 不存在或不属于当前仓库");
        const before = toMemory(result.rows[0]);
        const expected = action === "deprecate" ? "ACTIVE" : "CANDIDATE";
        if (before.status !== expected) throw new Error(`只有 ${expected} 可以 ${action}`);
        if (action === "approve") await validateException(client, before);
        const status = action === "approve" ? "ACTIVE" : action === "reject" ? "REJECTED" : "DEPRECATED";
        if (action === "approve") await client.query("UPDATE memories SET status='SUPERSEDED',superseded_by=$3,updated_at=now() WHERE repository_id=$1 AND id=$2 AND version<$4 AND status='ACTIVE'", [repositoryId, id, id, before.version]);
        const updated = await client.query("UPDATE memories SET status=$4,approved_by=CASE WHEN $4='ACTIVE' THEN $3 ELSE approved_by END,approved_at=CASE WHEN $4='ACTIVE' THEN now() ELSE approved_at END,updated_at=now() WHERE repository_id=$1 AND id=$2 AND version=$5 RETURNING *", [repositoryId, id, actor.id, status, before.version]);
        const after = toMemory(updated.rows[0]);
        await audit(client, before, after, actor, action);
        return after;
      });
    } finally { client.release(); }
  }

  async supersede(repositoryId: number, oldId: string, candidateId: string, actor: Actor) {
    const client = await this.database.pool.connect();
    try {
      return await transaction(client, async () => {
        const oldRow = await client.query("SELECT * FROM memories WHERE repository_id=$1 AND id=$2 ORDER BY (status IN ('ACTIVE','CANDIDATE')) DESC,version DESC LIMIT 1 FOR UPDATE", [repositoryId, oldId]);
        const candidateRow = await client.query("SELECT * FROM memories WHERE repository_id=$1 AND id=$2 ORDER BY (status IN ('ACTIVE','CANDIDATE')) DESC,version DESC LIMIT 1 FOR UPDATE", [repositoryId, candidateId]);
        const old = oldRow.rows[0] ? toMemory(oldRow.rows[0]) : undefined;
        const candidate = candidateRow.rows[0] ? toMemory(candidateRow.rows[0]) : undefined;
        if (old?.status !== "ACTIVE" || candidate?.status !== "CANDIDATE") throw new Error("替代要求同仓库 ACTIVE 原规则和 CANDIDATE 新规则");
        if (candidate.type === "exception" && candidate.exceptionTo === oldId) throw new Error("例外必须保留原规则，不能用例外替代原规则");
        await validateException(client, candidate);
        await client.query("UPDATE memories SET status='SUPERSEDED',superseded_by=$3,updated_at=now() WHERE repository_id=$1 AND id=$2 AND version=$4", [repositoryId, oldId, candidateId, old.version]);
        await client.query("UPDATE memories SET status='SUPERSEDED',superseded_by=$2,updated_at=now() WHERE repository_id=$1 AND id=$2 AND version<$3 AND status='ACTIVE'", [repositoryId, candidateId, candidate.version]);
        const result = await client.query("UPDATE memories SET status='ACTIVE',supersedes=$3,approved_by=$4,approved_at=now(),updated_at=now() WHERE repository_id=$1 AND id=$2 AND version=$5 RETURNING *", [repositoryId, candidateId, oldId, actor.id, candidate.version]);
        const after = toMemory(result.rows[0]);
        await audit(client, old, { ...old, status: "SUPERSEDED", supersededBy: candidateId }, actor, "supersede-old");
        await audit(client, candidate, after, actor, "supersede-new");
        return after;
      });
    } finally { client.release(); }
  }

  async retrieve(repositoryId: number, input: { paths: string[]; text: string; conditions?: string[]; limit?: number }) {
    const memories = (await this.database.pool.query("SELECT DISTINCT ON (id) * FROM memories WHERE repository_id=$1 AND status='ACTIVE' ORDER BY id,version DESC", [repositoryId])).rows.map(toMemory).filter((memory) => scopeMatches(memory, input.paths, input.conditions ?? []));
    const terms = new Set(input.text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((term) => term.length > 2));
    return memories.map((memory) => ({ memory, score: [...terms].filter((term) => `${memory.title} ${memory.content} ${memory.rationale}`.toLowerCase().includes(term)).length })).sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id)).slice(0, input.limit ?? 10).map(({ memory }) => memory);
  }
}

export function scopeMatches(memory: MemoryRecord, paths: string[], conditions: string[]) {
  const scope = memory.scope;
  if (scope.paths?.length && !paths.some((path) => scope.paths!.some((pattern) => matchesGlob(path, pattern)))) return false;
  if (scope.languages?.length) {
    const languages = new Set(paths.map((path) => ({ ".js": "javascript", ".ts": "typescript", ".java": "java", ".py": "python" })[extname(path)]).filter(Boolean));
    if (!scope.languages.some((language) => languages.has(language.toLowerCase()))) return false;
  }
  if (scope.modules?.length && !paths.some((path) => scope.modules!.some((module) => path.split("/").includes(module)))) return false;
  if (scope.conditions?.length && !scope.conditions.every((condition) => conditions.includes(condition))) return false;
  return true;
}

async function validateException(client: import("pg").PoolClient, memory: MemoryRecord) {
  if (memory.type !== "exception") return;
  if (!memory.exceptionTo || !Object.values(memory.scope).some(value => value?.length)) throw new Error("例外必须关联原规则并限定 Scope");
  const original = await client.query("SELECT 1 FROM memories WHERE repository_id=$1 AND id=$2 AND status='ACTIVE'", [memory.repositoryId, memory.exceptionTo]);
  if (!original.rowCount) throw new Error("例外关联的 ACTIVE 原规则不存在");
}

async function audit(client: import("pg").PoolClient, before: MemoryRecord, after: MemoryRecord, actor: Actor, action: string) {
  await client.query("INSERT INTO memory_audits(id,memory_id,memory_version,actor_id,actor_login,action,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [randomUUID(), after.id, after.version, actor.id, actor.login, action, before, after]);
}

function toMemory(row: Record<string, any>): MemoryRecord {
  return { activeVersion: row.active_version ? Number(row.active_version) : undefined, id: String(row.id), version: Number(row.version), repositoryId: Number(row.repository_id), installationId: Number(row.installation_id), type: row.type, title: row.title, content: row.content, rationale: row.rationale, scope: row.scope, source: row.source, evidence: row.evidence, confidence: Number(row.confidence), uncertainties: row.uncertainties, status: row.status, exceptionTo: row.exception_to ?? undefined, supersedes: row.supersedes ?? undefined, supersededBy: row.superseded_by ?? undefined, approvedBy: row.approved_by ? Number(row.approved_by) : undefined, approvedAt: row.approved_at?.toISOString(), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

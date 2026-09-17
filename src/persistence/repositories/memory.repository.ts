import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { DecisionProposal } from "../../memory/types.js";
import type { ReviewJob } from "../../jobs/types.js";
import { transaction } from "../transaction.js";
export class MemoryRepository {
  constructor(readonly pool: Pool) {}
  async insertCandidates(job: ReviewJob, proposals: DecisionProposal[]) {
    const client = await this.pool.connect();
    try {
      return await transaction(client, async () => {
        const ids: string[] = [];
        for (const proposal of proposals) {
          const fingerprint = createHash("sha256").update(JSON.stringify([job.repositoryId, proposal.source.pullRequestNumber, proposal.source.commitSha, [...proposal.source.commentIds].sort(), proposal.type, proposal.content.trim().toLowerCase()])).digest("hex");
          const id = randomUUID();
          const result = await client.query("INSERT INTO memories(id,version,repository_id,installation_id,type,title,content,rationale,scope,source,evidence,confidence,uncertainties,status,source_fingerprint,exception_to,supersedes) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'CANDIDATE',$13,$14,$15) ON CONFLICT(repository_id,source_fingerprint) DO NOTHING RETURNING id", [id, job.repositoryId, job.installationId, proposal.type, proposal.title, proposal.content, proposal.rationale, proposal.scope, proposal.source, JSON.stringify(proposal.evidence), proposal.confidence, JSON.stringify(proposal.uncertainties), fingerprint, proposal.relation?.exceptionTo ?? null, proposal.relation?.supersedes ?? null]);
          if (result.rows[0]) ids.push(String(result.rows[0].id));
        }
        return ids;
      });
    } finally { client.release(); }
  }
}

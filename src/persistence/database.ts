import { Pool } from "pg";
import type { JobAcceptor } from "./repositories/job.repository.js";
import { JobRepository } from "./repositories/job.repository.js";
import { RepositoryRepository } from "./repositories/repository.repository.js";
import { ReviewPublicationRepository } from "./repositories/review-publication.repository.js";
import { FindingRepository } from "./repositories/finding.repository.js";
import { ReplyRepository } from "./repositories/reply.repository.js";
import { AgentRunRepository } from "./repositories/agent-run.repository.js";
import { HealthRepository } from "./repositories/health.repository.js";
import { MemoryRepository } from "./repositories/memory.repository.js";
import { migrate } from "./migrations.js";
import type { ReviewReplyInput } from "./repositories/reply.repository.js";

export type { JobAcceptor, ReviewReplyInput };

// Keep the existing Database API while SQL is owned by business repositories.
export class Database extends JobRepository implements JobAcceptor {
  private readonly repositories = new RepositoryRepository(this.pool);
  private readonly publications = new ReviewPublicationRepository(this.pool);
  private readonly findings = new FindingRepository(this.pool);
  private readonly replies = new ReplyRepository(this.pool, this.findings);
  private readonly agents = new AgentRunRepository(this.pool);
  private readonly health = new HealthRepository(this.pool, () => this.isStopping());
  private readonly memories = new MemoryRepository(this.pool);

  constructor(url: string) { super(new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 3000 })); }
  async close() { await this.pool.end(); }
  async check() { await this.pool.query("SELECT 1"); }
  migrate = (directory?: string) => migrate(this.pool, directory);
  readonly isRepositoryEnabled = this.repositories.isRepositoryEnabled.bind(this.repositories);
  readonly setHealthSchedule = this.repositories.setHealthSchedule.bind(this.repositories);
  readonly getRepositoryConfig = this.repositories.getRepositoryConfig.bind(this.repositories);
  readonly beginPublication = this.publications.beginPublication.bind(this.publications);
  readonly finishPublication = this.publications.finishPublication.bind(this.publications);
  readonly saveReviewResult = this.publications.saveReviewResult.bind(this.publications);
  readonly saveFindings = this.findings.saveFindings.bind(this.findings);
  readonly bindFindings = this.findings.bindFindings.bind(this.findings);
  readonly getFinding = this.findings.getFinding.bind(this.findings);
  readonly getFindingByRoot = this.findings.getFindingByRoot.bind(this.findings);
  readonly acceptReply = this.replies.acceptReply.bind(this.replies);
  readonly retargetReply = this.replies.retargetReply.bind(this.replies);
  readonly isOlderReply = this.replies.isOlderReply.bind(this.replies);
  readonly requeueReply = this.replies.requeueReply.bind(this.replies);
  readonly getReplyPublication = this.replies.getReplyPublication.bind(this.replies);
  readonly finishReply = this.replies.finishReply.bind(this.replies);
  readonly markReplyPublication = this.replies.markReplyPublication.bind(this.replies);
  readonly getDecisionClues = this.replies.getDecisionClues.bind(this.replies);
  readonly checkpointAgentUsage = this.agents.checkpointAgentUsage.bind(this.agents);
  readonly startAgentRun = this.agents.startAgentRun.bind(this.agents);
  readonly finishAgentRun = this.agents.finishAgentRun.bind(this.agents);
  readonly activeHealthJob = this.health.activeHealthJob.bind(this.health);
  readonly enqueueHealth = this.health.enqueueHealth.bind(this.health);
  readonly retryHealth = this.health.retryHealth.bind(this.health);
  readonly healthUsage = this.health.healthUsage.bind(this.health);
  readonly getHealthReport = this.health.getHealthReport.bind(this.health);
  readonly finishHealthReport = this.health.finishHealthReport.bind(this.health);
  readonly insertCandidates = this.memories.insertCandidates.bind(this.memories);
}

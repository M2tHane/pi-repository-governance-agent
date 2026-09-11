export interface PullRequestEvent {
  action: string;
  installation: { id: number };
  repository: { id: number; full_name: string };
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    draft: boolean;
    state: string;
    merged?: boolean;
    merge_commit_sha?: string | null;
    base: { sha: string };
    head: { sha: string; repo: { full_name: string } | null };
  };
}

export interface ReviewJob {
  id: string;
  deliveryId: string;
  jobType?: "PR_REVIEW" | "DECISION_EXTRACT";
  installationId: number;
  repositoryId: number;
  repository: string;
  cloneUrl: string;
  prNumber: number;
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  status: "queued" | "running" | "succeeded" | "partial" | "failed" | "timeout" | "superseded" | "cancelled" | "uncertain";
  error?: string;
  reviewId?: number;
  reviewUrl?: string;
  attempt?: number;
}

export interface Finding {
  path?: string;
  description: string;
  evidence: string;
  impact: string;
  suggestion?: string;
  memory?: { id: string; version: number; source: { pullRequestNumber?: number; commentIds?: number[] } };
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
  coverage: string[];
  limitations: string[];
}

export interface DecisionProposal {
  type: "architecture_decision" | "engineering_rule" | "security_rule" | "coding_convention" | "exception" | "deprecated_pattern";
  title: string;
  content: string;
  rationale: string;
  scope: { paths?: string[]; languages?: string[]; modules?: string[]; conditions?: string[] };
  source: { pullRequestNumber: number; commitSha: string; commentIds: number[] };
  evidence: Array<{ kind: "human_comment" | "code"; reference: string; detail: string }>;
  relation?: { duplicateOf?: string; conflictsWith?: string[]; supersedes?: string; exceptionTo?: string };
  confidence: number;
  uncertainties: string[];
}

export interface MemoryRecord {
  id: string;
  version: number;
  repositoryId: number;
  installationId: number;
  type: DecisionProposal["type"];
  title: string;
  content: string;
  rationale: string;
  scope: DecisionProposal["scope"];
  source: DecisionProposal["source"];
  evidence: DecisionProposal["evidence"];
  confidence: number;
  uncertainties: string[];
  status: "CANDIDATE" | "ACTIVE" | "SUPERSEDED" | "DEPRECATED" | "REJECTED";
  exceptionTo?: string;
  supersedes?: string;
  supersededBy?: string;
  approvedBy?: number;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

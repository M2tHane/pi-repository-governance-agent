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
  jobType?: "PR_REVIEW" | "DECISION_EXTRACT" | "REPLY_HANDLE";
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
  findingId?: string;
  rootCommentId?: number;
  sourceCommentId?: number;
  sourceCommentUrl?: string;
  humanActorId?: number;
  humanActorLogin?: string;
  humanReplyBody?: string;
  humanReplyCreatedAt?: string;
}

export type FindingCategory = "correctness" | "security" | "architecture" | "maintainability" | "team_rule" | "memory_conflict";
export type FindingSeverity = "low" | "medium" | "high" | "critical";
export type EvidenceLevel = "weak" | "moderate" | "strong";
export type FindingStatus = "OPEN" | "NEEDS_CLARIFICATION" | "STILL_VALID" | "FIXED" | "WITHDRAWN" | "EXCEPTION_PENDING";

export interface Finding {
  path?: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
  category: FindingCategory;
  severity: FindingSeverity;
  evidenceLevel: EvidenceLevel;
  description: string;
  evidence: string;
  impact: string;
  suggestion?: string;
  memory?: { id: string; version: number; source: { pullRequestNumber?: number; commentIds?: number[] } };
}

export interface StoredFinding extends Finding {
  id: string;
  jobId: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  fingerprint: string;
  status: FindingStatus;
  githubReviewId?: number;
  githubCommentId?: number;
  bindingStatus: "pending" | "bound" | "summary" | "incomplete";
}

export type ReplyConclusion = "FIXED" | "MISJUDGMENT" | "VALID_EXCEPTION" | "STILL_VALID" | "NEEDS_CLARIFICATION";
export interface ReplyResult {
  findingId: string;
  analysisHeadSha: string;
  conclusion: ReplyConclusion;
  summary: string;
  evidence: Array<{ path?: string; line?: number; detail: string }>;
  memoryReferences: Array<{ id: string; version: number }>;
  suggestedFindingStatus: FindingStatus;
  clarificationQuestion?: string;
  decisionClue?: { type: "possible_exception" | "possible_rule_change" | "implementation_rationale"; summary: string };
  limitations: string[];
}

export type AgentRole = "general_review" | "java_reviewer" | "security_reviewer" | "architecture_reviewer" | "memory_conflict_reviewer";
export interface ComplexityProfile { changedFileCount: number; changedLineEstimate: number; languages: string[]; modules: string[]; touchesSecurityBoundary: boolean; activeMemoryCount: number; possibleMemoryConflict: boolean }
export interface OrchestrationSummary { mode: "single" | "orchestrated"; rolesRun: string[]; rolesFailed: string[]; totalDurationMs: number; totalUsage: import("./review.js").AgentUsage; parentUsage: import("./review.js").AgentUsage; findingsBeforeDedup: number; findingsAfterDedup: number; partial: boolean; fallback?: "validated_children" }

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

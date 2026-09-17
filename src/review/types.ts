export type FindingCategory = "correctness" | "security" | "architecture" | "maintainability" | "team_rule" | "memory_conflict";
export type FindingSeverity = "low" | "medium" | "high" | "critical";
export type EvidenceLevel = "weak" | "moderate" | "strong";
export type FindingStatus = "OPEN" | "NEEDS_CLARIFICATION" | "STILL_VALID" | "FIXED" | "WITHDRAWN" | "EXCEPTION_PENDING";

export interface Finding {
  candidates?: Finding[];
  reviewerRole?: AgentRole;
  display?: import("./presentation.js").FindingDisplay;
  relatedLocations?: Array<{ path?: string; line?: number; side?: "LEFT" | "RIGHT" }>;
  mergedCount?: number;
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
  memory?: { id: string; version: number; title?: string; source: { pullRequestNumber?: number; commentIds?: number[] } };
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

export type AgentRole = "general_review" | "java_reviewer" | "security_reviewer" | "architecture_reviewer" | "memory_conflict_reviewer";
export interface ComplexityProfile { changedFileCount: number; changedLineEstimate: number; languages: string[]; modules: string[]; touchesSecurityBoundary: boolean; activeMemoryCount: number; possibleMemoryConflict: boolean }
export interface OrchestrationSummary { mode: "single" | "orchestrated"; rolesRun: string[]; rolesFailed: string[]; totalDurationMs: number; totalUsage: import("./agent.js").AgentUsage; parentUsage: import("./agent.js").AgentUsage; findingsBeforeDedup: number; findingsAfterDedup: number; partial: boolean; fallback?: "validated_children" }

export interface ReviewResult {
  summary: string;
  findings: Finding[];
  coverage: string[];
  limitations: string[];
}

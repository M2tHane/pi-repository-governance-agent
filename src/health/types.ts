import type { FindingSeverity, EvidenceLevel } from "../review/types.js";

export interface HealthScope {
  includePaths: string[];
  excludePaths: string[];
  outputLanguage: string;
  budgetTokens: number;
}

export type HealthDimension = "code" | "ci" | "dependencies" | "documentation";
export interface HealthMissingData { source: string; reason: string; detail: string }
export interface HealthSource {
  id: string; kind: "check" | "workflow"; name: string; sha: string;
  status: string; conclusion: string | null; at: string; url: string; target: boolean;
}
export type HealthReference =
  | { kind: "code"; path: string; line: number; detail: string }
  | { kind: "ci"; sourceId: string; detail: string }
  | { kind: "memory"; id: string; version: number; detail: string };
export interface HealthFinding {
  id: string; dimension: HealthDimension; severity: FindingSeverity; evidenceLevel: EvidenceLevel;
  description: string; impact: string; suggestion: string; references: HealthReference[];
}
export interface HealthResult { summary: string; findings: HealthFinding[]; limitations: string[] }
export interface HealthReport {
  version: 1; jobId: string; repositoryId: number; repository: string; headSha: string; defaultBranch: string;
  windowStart: string; windowEnd: string; collectedAt: string; completedAt: string;
  status: "succeeded" | "partial"; scope: HealthScope; model: string; durationMs: number;
  usage: import("../review/agent.js").AgentUsage; comparisonKey: string;
  coverage: {
    eligibleFiles: number; files: Array<{ path: string; totalLines: number; readLines: number }>;
    skippedFiles: Array<{ path: string; reason: string }>;
    memoryReferences: Array<{ id: string; version: number }>;
  };
  sources: HealthSource[]; missingData: HealthMissingData[]; result: HealthResult;
}

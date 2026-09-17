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
  activeVersion?: number;
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

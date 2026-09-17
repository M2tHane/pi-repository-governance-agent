import type { FindingStatus } from "../review/types.js";

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

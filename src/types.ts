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
    base: { sha: string };
    head: { sha: string; repo: { full_name: string } | null };
  };
}

export interface ReviewJob {
  id: string;
  deliveryId: string;
  installationId: number;
  repositoryId: number;
  repository: string;
  cloneUrl: string;
  prNumber: number;
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  status: "queued" | "running" | "succeeded" | "failed" | "timeout" | "superseded" | "uncertain";
  error?: string;
  reviewId?: number;
  reviewUrl?: string;
}

export interface Finding {
  path?: string;
  description: string;
  evidence: string;
  impact: string;
  suggestion?: string;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
  coverage: string[];
  limitations: string[];
}

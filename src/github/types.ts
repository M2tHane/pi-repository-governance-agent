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

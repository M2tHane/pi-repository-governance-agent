import { createHash } from "node:crypto";
import type { Finding, ReviewJob } from "./types.js";

export function diffLines(files: Array<{ filename: string; patch?: string }>) {
  const lines = new Set<string>();
  for (const file of files) {
    let left = 0, right = 0;
    for (const text of file.patch?.split("\n") ?? []) {
      const header = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (header) { left = Number(header[1]); right = Number(header[2]); continue; }
      if (!left && !right || text.startsWith("\\")) continue;
      if (text.startsWith("+")) { lines.add(`${file.filename}:RIGHT:${right}`); right++; }
      else if (text.startsWith("-")) { lines.add(`${file.filename}:LEFT:${left}`); left++; }
      else { lines.add(`${file.filename}:LEFT:${left}`); lines.add(`${file.filename}:RIGHT:${right}`); left++; right++; }
    }
  }
  return lines;
}

export function normalizeFindingLocation(finding: Finding, lines: Set<string>) {
  if (finding.path && finding.line && finding.side && lines.has(`${finding.path}:${finding.side}:${finding.line}`)) return true;
  delete finding.line;
  delete finding.side;
  return false;
}

export function findingIdentity(job: ReviewJob, finding: Finding, occurrence = 0) {
  const location = finding.path && finding.line && finding.side ? `${finding.path}:${finding.side}:${finding.line}` : `summary:${finding.category}:${finding.description.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 120)}`;
  const memory = finding.memory ? `${finding.memory.id}:v${finding.memory.version}` : "";
  const fingerprint = createHash("sha256").update(`${job.repositoryId}:${job.prNumber}:${job.headSha}:${location}:${finding.category}:${memory}${occurrence ? `:issue-${occurrence}` : ""}`).digest("hex");
  return { id: `finding_${fingerprint.slice(0, 24)}`, fingerprint };
}

import assert from "node:assert/strict";
import test from "node:test";
import { diffLines, findingIdentity, normalizeFindingLocation } from "../../src/review/finding.js";
import type { Finding } from "../../src/review/types.js";
import type { ReviewJob } from "../../src/jobs/types.js";

const job = { id: "job", deliveryId: "delivery", installationId: 1, repositoryId: 2, repository: "owner/repo", cloneUrl: "url", prNumber: 3, title: "", body: "", baseSha: "base", headSha: "head", status: "running" } satisfies ReviewJob;
const finding = { path: "src/a.ts", line: 11, side: "RIGHT", category: "correctness", severity: "high", evidenceLevel: "strong", description: "Null dereference", evidence: "x is null", impact: "crash" } satisfies Finding;

test("diff 行映射只接受真实 LEFT/RIGHT 行", () => {
  const lines = diffLines([{ filename: "src/a.ts", patch: "@@ -10,2 +10,3 @@\n same\n-old\n+new\n+more" }]);
  assert(lines.has("src/a.ts:RIGHT:11"));
  assert(lines.has("src/a.ts:LEFT:11"));
  assert(lines.has("src/a.ts:RIGHT:12"));
  assert(normalizeFindingLocation({ ...finding }, lines));
  const invented = { ...finding, line: 99 };
  assert.equal(normalizeFindingLocation(invented, lines), false);
  assert.equal(invented.line, undefined);
  assert.equal(invented.side, undefined);
});

test("Finding identity 对同一位置稳定且不依赖数组顺序", () => {
  assert.deepEqual(findingIdentity(job, finding), findingIdentity(job, { ...finding, description: "wording changed" }));
  assert.notDeepEqual(findingIdentity(job, finding), findingIdentity(job, { ...finding, line: 12 }));
});

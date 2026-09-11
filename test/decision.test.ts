import assert from "node:assert/strict";
import test from "node:test";
import { parseDecisionProposals, proposalFingerprint } from "../src/decision.js";
import type { DecisionProposal, ReviewJob } from "../src/types.js";

const job = { id: "job", deliveryId: "delivery", jobType: "DECISION_EXTRACT", installationId: 1, repositoryId: 2, repository: "owner/repo", cloneUrl: "url", prNumber: 3, title: "", body: "", baseSha: "base", headSha: "merged", status: "running" } satisfies ReviewJob;
const proposal: DecisionProposal = {
  type: "engineering_rule", title: "No Optional DTO", content: "Public DTO fields do not use Optional.", rationale: "Stable serialization contract.", scope: { paths: ["backend/**/dto/**"], languages: ["java"] },
  source: { pullRequestNumber: 3, commitSha: "merged", commentIds: [11] }, evidence: [{ kind: "human_comment", reference: "11", detail: "maintainer decision" }, { kind: "code", reference: "backend/x/dto/A.java:4", detail: "field changed" }], confidence: 0.9, uncertainties: [],
};

test("明确规则通过归属与双证据校验", () => {
  const result = parseDecisionProposals(JSON.stringify([proposal]), job, new Set([11]), new Set(["backend/x/dto/A.java"]));
  assert.equal(result[0]?.title, proposal.title);
});

test("无决定允许空结果", () => assert.deepEqual(parseDecisionProposals("[]", job), []));

test("结构错误指出具体字段", () => assert.throws(() => parseDecisionProposals(JSON.stringify([{ ...proposal, source: { ...proposal.source, commitSha: "wrong" } }]), job), /source\.commitSha/));

test("争议或无有效人类证据不能伪装为决定", () => {
  assert.throws(() => parseDecisionProposals(JSON.stringify([{ ...proposal, source: { ...proposal.source, commentIds: [99] } }]), job, new Set([11]), new Set(["backend/x/dto/A.java"])), /无效人类评论/);
  assert.throws(() => parseDecisionProposals(JSON.stringify([{ ...proposal, evidence: proposal.evidence.filter((e) => e.kind === "code") }]), job), /缺少人类讨论/);
});

test("局部例外与替代关系保留，指纹稳定", () => {
  const exception = { ...proposal, type: "exception" as const, scope: { paths: ["legacy/**"] }, relation: { exceptionTo: "11111111-1111-1111-1111-111111111111" } };
  const superseding = { ...proposal, relation: { supersedes: "22222222-2222-2222-2222-222222222222" } };
  assert.equal(parseDecisionProposals(JSON.stringify([exception]), job)[0]?.relation?.exceptionTo, exception.relation.exceptionTo);
  assert.equal(parseDecisionProposals(JSON.stringify([superseding]), job)[0]?.relation?.supersedes, superseding.relation.supersedes);
  assert.equal(proposalFingerprint(2, proposal), proposalFingerprint(2, { ...proposal, source: { ...proposal.source, commentIds: [11] } }));
});

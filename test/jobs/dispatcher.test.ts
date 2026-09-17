import assert from "node:assert/strict";
import test from "node:test";
import { createJobDispatcher } from "../../src/jobs/dispatcher.js";
import type { AgentJob } from "../../src/jobs/types.js";

test("Job Dispatcher routes each supported type and rejects unknown types", async () => {
  const seen: string[] = [];
  const dispatch = createJobDispatcher({
    PR_REVIEW: async () => { seen.push("PR_REVIEW"); },
    DECISION_EXTRACT: async () => { seen.push("DECISION_EXTRACT"); },
    REPLY_HANDLE: async () => { seen.push("REPLY_HANDLE"); },
    HEALTH_AUDIT: async () => { seen.push("HEALTH_AUDIT"); },
  });
  for (const jobType of ["PR_REVIEW", "DECISION_EXTRACT", "REPLY_HANDLE", "HEALTH_AUDIT"] as const) await dispatch({ jobType } as AgentJob);
  assert.deepEqual(seen, ["PR_REVIEW", "DECISION_EXTRACT", "REPLY_HANDLE", "HEALTH_AUDIT"]);
  assert.throws(() => dispatch({ jobType: "UNRECOGNIZED" } as unknown as AgentJob), /Unknown job type: UNRECOGNIZED/);
});

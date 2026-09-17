import type { HealthReport } from "../../../src/health/types.js";
import type { AgentUsage } from "../../../src/review/agent.js";
import type { compareHealthReports } from "../../../src/health/health.service.js";
import type { Job } from "../../types.js";

export type HealthDetail = { job:Job; report:HealthReport|null; usage:AgentUsage; previous:{jobId:string;headSha:string;completedAt:string}|null; comparison:ReturnType<typeof compareHealthReports>|null };

import { createApp } from "../github/webhook/handler.js";
import { loadConfig } from "../config/config.js";
import { createReviewProcessor } from "../review/review.processor.js";
import { Database } from "../persistence/database.js";
import { PersistentRunner } from "../jobs/runner.js";
import { createDecisionProcessor } from "../memory/decision.processor.js";
import { MemoryService } from "../memory/memory.service.js";
import { createAdminHandler } from "../admin/handler.js";
import { createReplyProcessor } from "../reply/reply.processor.js";
import { createHealthProcessor } from "../health/health.processor.js";
import { enqueueDueHealthJobs } from "../health/health.scheduler.js";
import { GitHubClient } from "../github/client.js";
import { createJobDispatcher } from "../jobs/dispatcher.js";

// 单进程模块边界的理由见 .agents/decisions/repository-architecture.md。
export function createApplication() {
  const config = loadConfig();
  const database = new Database(config.databaseUrl);
  const memories = new MemoryService(database);
  const review = createReviewProcessor(config, undefined, database, memories);
  const extract = createDecisionProcessor(config, database);
  const reply = createReplyProcessor(config, database, memories);
  const health = createHealthProcessor(config, database, memories);
  const runner = new PersistentRunner(database, createJobDispatcher({ PR_REVIEW: review, DECISION_EXTRACT: extract, REPLY_HANDLE: reply, HEALTH_AUDIT: health }));
  const { server } = createApp(config, database, createAdminHandler(config, database));
  const scheduleAbort = new AbortController();
  const github = new GitHubClient(config.appId, config.privateKey);
  let scheduling: Promise<void> | undefined;
  let scheduleTimer: ReturnType<typeof setInterval> | undefined;

  const pollSchedules = () => {
    if (scheduling || scheduleAbort.signal.aborted) return;
    scheduling = enqueueDueHealthJobs(config, database, github, scheduleAbort.signal)
      .catch(() => { if (!scheduleAbort.signal.aborted) console.error(JSON.stringify({ event: "health_schedule_poll_failed" })); })
      .finally(() => { scheduling = undefined; });
  };

  return {
    async start() {
      await runner.start();
      scheduleTimer = setInterval(pollSchedules, 30_000);
      pollSchedules();
      server.listen(config.port, () => console.info(JSON.stringify({ event: "listening", port: config.port })));
    },
    async stop() {
      if (scheduleTimer) clearInterval(scheduleTimer);
      scheduleAbort.abort();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all([closed, runner.stop(), scheduling]);
      await database.close();
    },
  };
}

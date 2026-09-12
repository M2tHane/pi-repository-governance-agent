import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createJobProcessor } from "./service.js";
import { Database } from "./database.js";
import { PersistentRunner } from "./runner.js";
import { createDecisionProcessor } from "./decision.js";
import { MemoryService } from "./memory.js";
import { createAdminHandler } from "./admin.js";
import { createReplyProcessor } from "./reply.js";

// Note: M0 单服务与受控 Pi 审查边界 — 见 .agents/notes/implemented/architecture/2026-09-10-m0-pi-github-review.md
// Note: M1 持久任务、Team Memory 与维护者治理 — 见 .agents/notes/implemented/architecture/2026-09-10-m1-team-memory.md
// Note: M2 线程复核、委派与预算取舍 — 见 .agents/notes/proposed/architecture/2026-09-11-m2-reply-and-multi-agent.md
const config = loadConfig();
const database = new Database(config.databaseUrl);
await database.migrate();
const memories = new MemoryService(database);
const review = createJobProcessor(config, undefined, database, memories);
const extract = createDecisionProcessor(config, database);
const reply = createReplyProcessor(config, database, memories);
const runner = new PersistentRunner(database, (job) => job.jobType === "DECISION_EXTRACT" ? extract(job) : job.jobType === "REPLY_HANDLE" ? reply(job) : review(job));
const { server } = createApp(config, database, createAdminHandler(config, database));
await runner.start();
server.listen(config.port, () => console.info(JSON.stringify({ event: "listening", port: config.port })));

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  void Promise.all([closed, runner.stop()]).then(() => database.close()).finally(() => process.exit(0));
});

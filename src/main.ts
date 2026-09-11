import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createJobProcessor } from "./service.js";
import { Database } from "./database.js";
import { PersistentRunner } from "./runner.js";
import { createDecisionProcessor } from "./decision.js";
import { MemoryService } from "./memory.js";
import { createAdminHandler } from "./admin.js";

// Note: M0 单服务与受控 Pi 审查边界 — 见 .agents/notes/implemented/architecture/2026-09-10-m0-pi-github-review.md
// Note: M1 持久任务、Team Memory 与维护者治理 — 见 .agents/notes/implemented/architecture/2026-09-10-m1-team-memory.md
const config = loadConfig();
const database = new Database(config.databaseUrl);
await database.migrate();
const memories = new MemoryService(database);
const review = createJobProcessor(config, undefined, database, memories);
const extract = createDecisionProcessor(config, database);
const runner = new PersistentRunner(database, (job) => job.jobType === "DECISION_EXTRACT" ? extract(job) : review(job));
const { server } = createApp(config, database, createAdminHandler(config, database));
await runner.start();
server.listen(config.port, () => console.info(JSON.stringify({ event: "listening", port: config.port })));

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { runner.stop(); server.close(() => void database.close().finally(() => process.exit(0))); });

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createJobProcessor } from "./service.js";

// Note: M0 单服务与受控 Pi 审查边界 — 见 .agents/notes/implemented/architecture/2026-09-10-m0-pi-github-review.md
const config = loadConfig();
const { server } = createApp(config, createJobProcessor(config));
server.listen(config.port, () => console.info(JSON.stringify({ event: "listening", port: config.port })));

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => process.exit(0)));

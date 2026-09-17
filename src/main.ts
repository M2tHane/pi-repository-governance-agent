import { createApplication } from "./bootstrap/application.js";

const app = createApplication();
await app.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  void app.stop().finally(() => process.exit(0));
});

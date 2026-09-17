import { randomUUID } from "node:crypto";
import { before, after } from "node:test";
import { Database } from "../../src/persistence/database.js";

export function useTestDatabase() {
  let databaseUrl = process.env.DATABASE_URL;
  const schema = "m2_test_" + randomUUID().replaceAll("-", "");
  let control: Database | undefined;
  before(async () => {
    if (!databaseUrl) return;
    control = new Database(databaseUrl);
    await control.pool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl);
    url.searchParams.set("options", `-c search_path=${schema}`);
    databaseUrl = url.toString();
    const isolated = new Database(databaseUrl);
    try { await isolated.migrate(); } finally { await isolated.close(); }
  });
  after(async () => {
    if (!control) return;
    try { await control.pool.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await control.close(); }
  });
  return { get url() { return databaseUrl; } };
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等待状态变化超时");
}

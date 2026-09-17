import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Pool } from "pg";

export async function migrate(pool: Pool, directory = resolve("migrations")) {
  const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(4897032)");
      await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      for (const name of (await readdir(directory)).filter((file) => /^\d+.*\.sql$/.test(file)).sort()) {
        const exists = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
        if (exists.rowCount) continue;
        await client.query("BEGIN");
        try {
          await client.query(await readFile(resolve(directory, name), "utf8"));
          await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(4897032)").catch(() => undefined);
      client.release();
    }
  }

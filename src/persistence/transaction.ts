import type { PoolClient } from "pg";

export async function transaction<T>(client: PoolClient, run: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try { const value = await run(); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
}

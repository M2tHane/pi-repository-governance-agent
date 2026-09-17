import assert from "node:assert/strict";
import test from "node:test";
import { api, setCsrf } from "../../frontend/api/client.js";

test("admin API preserves JSON, CSRF, error and abort behavior", async t => {
  const requests: { path: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    requests.push({ path, init });
    return new Response(requests.length === 3 ? JSON.stringify({ error: "保存失败" }) : JSON.stringify({ ok: true }), {
      status: requests.length === 3 ? 403 : 200,
      headers: { "content-type": "application/json" },
    });
  });
  setCsrf("session-token");
  const controller = new AbortController();
  assert.deepEqual(await api("/api/bootstrap", { signal: controller.signal }), { ok: true });
  assert.deepEqual(await api("/api/repositories/1", { method: "PATCH", body: "{}" }), { ok: true });
  await assert.rejects(api("/api/memories/1/approve", { method: "POST", body: "{}" }), /保存失败/);
  assert.equal(requests[0]?.path, "/api/bootstrap");
  assert.equal(requests[0]?.init.signal, controller.signal);
  assert.equal((requests[0]?.init.headers as Record<string, string>)["x-csrf-token"], undefined);
  assert.equal((requests[1]?.init.headers as Record<string, string>)["x-csrf-token"], "session-token");
  assert.equal((requests[2]?.init.headers as Record<string, string>)["content-type"], "application/json");
});

import type { ServerResponse } from "node:http";
import type { Config } from "../../../config/config.js";
import type { JobAcceptor } from "../../../persistence/database.js";
import type { ReviewJob } from "../../../jobs/types.js";
import { send } from "../http.js";

export async function handleInstallation(target: JobAcceptor | ((job: ReviewJob) => Promise<void>), eventName: string, deliveryId: string, payload: unknown, response: ServerResponse) {
  const raw = payload as any;
  const revoke = eventName === "installation" ? ["deleted", "suspend"].includes(raw?.action) : raw?.action === "removed";
  if (!revoke || typeof target === "function" || !target.revokeInstallation) return send(response, 200, { ignored: true });
  if (!Number.isSafeInteger(raw?.installation?.id) || raw.installation.id <= 0) return send(response, 422, { error: "installation 无效" });
  let repositoryIds: number[] | undefined;
  if (eventName === "installation_repositories") {
    if (!Array.isArray(raw.repositories_removed) || raw.repositories_removed.length > 1000 || raw.repositories_removed.some((repository: any) => !Number.isSafeInteger(repository?.id) || repository.id <= 0)) return send(response, 422, { error: "repositories_removed 无效" });
    repositoryIds = raw.repositories_removed.map((repository: { id: number }) => repository.id);
  }
  try { return send(response, 202, { revoked: true, ...await target.revokeInstallation({ deliveryId, event: eventName, action: raw.action, installationId: raw.installation.id, repositoryIds }) }); }
  catch { return send(response, 503, { error: "撤销授权持久化失败" }); }
}

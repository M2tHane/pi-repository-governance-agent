import { readFileSync } from "node:fs";

export interface Config {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  allowedRepositories: Set<string>;
  modelProvider: string;
  modelName: string;
  modelApiKey: string;
  port: number;
  webhookMaxBytes: number;
  queueCapacity: number;
  agentTimeoutMs: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`缺少配置 ${name}`);
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`配置 ${name} 必须是正整数`);
  return value;
}

export function loadConfig(env = process.env): Config {
  const repositories = required(env, "GITHUB_ALLOWED_REPOSITORIES").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!repositories.every((x) => /^[^/\s]+\/[^/\s]+$/.test(x))) throw new Error("配置 GITHUB_ALLOWED_REPOSITORIES 格式错误");
  const privateKeyPath = required(env, "GITHUB_PRIVATE_KEY_PATH");
  let privateKey: string;
  try { privateKey = readFileSync(privateKeyPath, "utf8"); } catch { throw new Error("无法读取 GITHUB_PRIVATE_KEY_PATH"); }
  return {
    appId: required(env, "GITHUB_APP_ID"),
    privateKey,
    webhookSecret: required(env, "GITHUB_WEBHOOK_SECRET"),
    allowedRepositories: new Set(repositories),
    modelProvider: required(env, "MODEL_PROVIDER"),
    modelName: required(env, "MODEL_NAME"),
    modelApiKey: required(env, "MODEL_API_KEY"),
    port: positiveInt(env, "PORT", 3000),
    webhookMaxBytes: positiveInt(env, "WEBHOOK_MAX_BYTES", 1_048_576),
    queueCapacity: positiveInt(env, "QUEUE_CAPACITY", 20),
    agentTimeoutMs: positiveInt(env, "AGENT_TIMEOUT_MS", 300_000),
  };
}

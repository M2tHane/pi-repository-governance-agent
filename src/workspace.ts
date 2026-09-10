import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function withWorkspace<T>(cloneUrl: string, token: string, baseSha: string, headSha: string, run: (root: string) => Promise<T>): Promise<T> {
  // Note: GitHub Smart HTTP 认证必须非交互并避免 token 出现在参数中 — 见 .agents/notes/implemented/bug-fix/2026-09-10-git-installation-token-auth.md
  const root = await mkdtemp(join(tmpdir(), "pi-review-"));
  const authorization = Buffer.from(`x-access-token:${token}`).toString("base64");
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`, GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: "/dev/null", GIT_CONFIG_KEY_2: "credential.helper", GIT_CONFIG_VALUE_2: "" };
  try {
    await exec("git", ["init", "--quiet", root], { env: gitEnv });
    await exec("git", ["-C", root, "remote", "add", "origin", cloneUrl], { env: gitEnv });
    await exec("git", ["-C", root, "fetch", "--quiet", "--depth=1", "origin", baseSha, headSha], { env: gitEnv });
    await exec("git", ["-C", root, "checkout", "--quiet", "--detach", headSha], { env: gitEnv });
    const { stdout } = await exec("git", ["-C", root, "rev-parse", "HEAD"], { env: gitEnv });
    if (stdout.trim() !== headSha) throw new Error("Workspace head SHA 不匹配");
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function readWorkspaceFile(root: string, requested: string): Promise<string> {
  const rootReal = await realpath(root);
  const candidate = resolve(rootReal, requested);
  if (relative(rootReal, candidate).startsWith("..")) throw new Error("路径超出 Workspace");
  const parentReal = await realpath(dirname(candidate));
  if (relative(rootReal, parentReal).startsWith("..")) throw new Error("符号链接超出 Workspace");
  const fileReal = await realpath(candidate);
  if (relative(rootReal, fileReal).startsWith("..")) throw new Error("符号链接超出 Workspace");
  return readFile(fileReal, "utf8");
}

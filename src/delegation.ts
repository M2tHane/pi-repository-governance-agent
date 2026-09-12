import type { Config } from "./config.js";
import type { Database } from "./database.js";
import { BudgetError, emptyUsage, runAgentReview, type AgentReviewInput, type AgentUsage } from "./review.js";
import { diffLines, normalizeFindingLocation } from "./finding.js";
import type { AgentRole, MemoryRecord, ReviewJob, ReviewResult } from "./types.js";

const output = `只输出 ReviewResult JSON。每条 finding 必须包含 category、severity、evidenceLevel、description、evidence、impact，可选 path/line/side/suggestion/memory。没有确定问题时 findings=[]，并明确 coverage 与 limitations。`;
export const roleRegistry: Record<AgentRole, string> = {
  general_review: `你是只读 General Reviewer。检查正确性和可维护性，不重复专项猜测。${output}`,
  java_reviewer: `你是只读 Java Reviewer。只检查 Java 语义、异常、资源、并发、事务和框架用法。${output}`,
  security_reviewer: `你是只读 Security Reviewer。只检查认证、授权、输入、注入、敏感数据和数据出口；可能性不足不能升级为 finding。${output}`,
  architecture_reviewer: `你是只读 Architecture Reviewer。只检查模块边界、依赖方向、跨模块调用和架构规则。${output}`,
  memory_conflict_reviewer: `你是只读 Memory Conflict Reviewer。只检查 ACTIVE Memory 的 Scope、exception、supersedes 和冲突；不得修改 Memory。${output}`,
};

export class BudgetLedger {
  consumed = 0;
  reserved = 0;
  delegates = 0;
  active = 0;
  constructor(readonly total: number, readonly maxDelegates: number) {}
  get remaining() { return Math.max(0, this.total - this.consumed - this.reserved); }
  startDelegate(tokens: number) {
    if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > this.remaining || this.delegates >= this.maxDelegates) throw new Error("delegate budget exhausted");
    if (this.active >= 2) throw new Error("delegate concurrency exhausted");
    this.delegates++; this.active++;
  }
  reserve(tokens: number) {
    if (tokens > this.remaining) throw new BudgetError();
    this.reserved += tokens;
  }
  settle(reserved: number, consumed: number) {
    this.reserved -= reserved; this.consumed += consumed;
  }
}

export interface DelegateContext {
  config: Config; database: Database; job: ReviewJob; root: string; files: AgentReviewInput["changedFiles"]; memories: MemoryRecord[];
  allowedRoles: AgentRole[]; ledger: BudgetLedger; deadline: number; signal: AbortSignal; parentRunId: string; depth: number;
  outputLanguage?: string;
}

export interface DelegateInput { role: AgentRole; objective: string; focusPaths?: string[]; relevantMemoryIds?: Array<{ id: string; version: number }>; maxTokens: number; timeoutMs: number }

export async function delegateAgent(context: DelegateContext, input: DelegateInput, execute = runAgentReview): Promise<{ role: AgentRole; result: ReviewResult; durationMs: number; model: string; usage: AgentUsage }> {
  context.signal.throwIfAborted();
  if (Object.keys(input).some((key) => !["role", "objective", "focusPaths", "relevantMemoryIds", "maxTokens", "timeoutMs"].includes(key))) throw new Error("delegate input rejected");
  if (context.depth >= 1 || !context.allowedRoles.includes(input.role) || !Object.hasOwn(roleRegistry, input.role)) throw new Error("delegate role or depth rejected");
  if (typeof input.objective !== "string" || !input.objective.trim() || input.objective.length > 2000) throw new Error("delegate objective rejected");
  const paths = new Set(context.files.map((file) => file.filename));
  if (input.focusPaths?.some((path) => !paths.has(path))) throw new Error("delegate path outside current change");
  const recalled = new Map(context.memories.map((memory) => [`${memory.id}:${memory.version}`, memory]));
  if (input.relevantMemoryIds?.some((memory) => !recalled.has(`${memory.id}:${memory.version}`))) throw new Error("delegate Memory outside current recall");
  const remainingMs = context.deadline - Date.now();
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > remainingMs) throw new Error("delegate timeout exceeds parent");
  context.ledger.startDelegate(input.maxTokens);
  let runId: string | undefined, run: Awaited<ReturnType<typeof runAgentReview>> | undefined;
  try {
    runId = await context.database.startAgentRun(context.job.id, input.role, input.maxTokens, input.timeoutMs, context.parentRunId);
    context.signal.throwIfAborted();
    const selectedFiles = input.focusPaths?.length ? context.files.filter((file) => input.focusPaths!.includes(file.filename)) : context.files;
    const selectedMemories = input.relevantMemoryIds?.length ? input.relevantMemoryIds.map((item) => recalled.get(`${item.id}:${item.version}`)!) : context.memories;
    run = await execute({ root: context.root, provider: context.config.modelProvider, modelName: context.config.modelName, apiKey: context.config.modelApiKey, timeoutMs: input.timeoutMs, title: context.job.title, body: `${context.job.body}\n\n专项目标：${input.objective}`, baseSha: context.job.baseSha, headSha: context.job.headSha, changedFiles: selectedFiles, memories: selectedMemories, outputLanguage: context.outputLanguage, budgetTokens: input.maxTokens, systemPrompt: roleRegistry[input.role], signal: context.signal, ledger: context.ledger });
    context.signal.throwIfAborted();
    for (const finding of run.result.findings) if (finding.path && !paths.has(finding.path)) throw new Error("child finding path outside current change");
    const lines = diffLines(context.files);
    for (const finding of run.result.findings) normalizeFindingLocation(finding, lines);
    const memoryById = new Map(selectedMemories.map((memory) => [`${memory.id}:${memory.version}`, memory]));
    for (const finding of run.result.findings) if (finding.memory) {
      const memory = memoryById.get(`${finding.memory.id}:${finding.memory.version}`);
      if (!memory || memory.status !== "ACTIVE" || memory.repositoryId !== context.job.repositoryId) throw new Error("child Memory reference invalid");
      finding.memory.source = memory.source;
    }
    await context.database.finishAgentRun(runId, { status: "succeeded", model: run.model, usage: run.usage, coverage: run.result.coverage, limitations: run.result.limitations });
    return { role: input.role, ...run };
  } catch (error) {
    const message = error instanceof Error ? error.message : context.signal.aborted ? String(context.signal.reason) : "child failed";
    const usage = (error as { usage?: AgentUsage })?.usage ?? run?.usage ?? emptyUsage();
    if (runId) await context.database.finishAgentRun(runId, { status: context.signal.aborted ? "cancelled" : /timeout|超时/i.test(message) ? "timeout" : "failed", model: run?.model ?? context.config.modelName, usage, error: message });
    throw Object.assign(error instanceof Error ? error : new Error(message), { usage });
  } finally { context.ledger.active--; }
}

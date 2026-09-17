import type { Actor } from "../memory/memory.service.js";

export type Session = Actor & { token: string; csrf: string; expiresAt: number };
export type Repository = { id: number; installationId: number; fullName: string; enabled: boolean; includePaths: string[]; excludePaths: string[]; outputLanguage: string; budgetTokens: number; reviewMode: "single" | "auto"; maxDelegates: number; healthSchedule: "off" | "daily" | "weekly"; healthNextRunAt: string | null; healthLastError: string | null };

export function repository(row: Record<string, unknown>): Repository {
  return { id: Number(row.id), installationId: Number(row.installation_id), fullName: String(row.full_name), enabled: Boolean(row.enabled), includePaths: row.include_paths as string[], excludePaths: row.exclude_paths as string[], outputLanguage: String(row.output_language), budgetTokens: Number(row.budget_tokens), reviewMode: row.review_mode as "single" | "auto", maxDelegates: Number(row.max_delegates), healthSchedule: row.health_schedule as Repository["healthSchedule"], healthNextRunAt: row.health_next_run_at instanceof Date ? row.health_next_run_at.toISOString() : null, healthLastError: row.health_last_error ? String(row.health_last_error) : null };
}

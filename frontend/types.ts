import type { MemoryRecord } from "../src/memory/types.js";

export type Repository = { id:number; fullName:string; installationId:number; enabled:boolean; includePaths:string[]; excludePaths:string[]; outputLanguage:string; budgetTokens:number; reviewMode:"single"|"auto"; maxDelegates:number; healthSchedule:"off"|"daily"|"weekly"; healthNextRunAt:string|null; healthLastError:string|null };
export type Job = Record<string, any>;
export type Memory = MemoryRecord;
export type SessionResponse = { user: { id:number; login:string }; csrf:string };
export type BootstrapResponse = { repositories:Repository[]; jobs:Job[]; memories:Memory[] };

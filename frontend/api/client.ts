let csrf = "";

export function setCsrf(value:string) { csrf = value; }

export async function api<T>(path:string, init:RequestInit={}) {
  const response = await fetch(path, { ...init, headers: { "content-type":"application/json", ...(init.method && init.method !== "GET" ? { "x-csrf-token":csrf } : {}), ...init.headers } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value as T;
}

export const messageOf=(error:unknown)=>error instanceof Error?error.message:"操作失败，请重试。";

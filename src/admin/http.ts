import type { IncomingMessage, ServerResponse } from "node:http";

export function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(value));
}

export function cookies(request: IncomingMessage) {
  return Object.fromEntries((request.headers.cookie ?? "").split(";").map((part) => part.trim().split(/=(.*)/s, 2)).filter(([name, value]) => name && value).map(([name, value]) => [name!, decodeURIComponent(value!)]));
}

export async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 65_536) throw new Error("请求体过大"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

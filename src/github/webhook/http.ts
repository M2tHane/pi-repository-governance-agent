import type { IncomingMessage, ServerResponse } from "node:http";

export function send(response: ServerResponse, status: number, value: object) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

export async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new RangeError("payload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

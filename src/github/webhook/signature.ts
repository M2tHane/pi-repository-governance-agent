import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySignature(body: Buffer, signature: string, secret: string): boolean {
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

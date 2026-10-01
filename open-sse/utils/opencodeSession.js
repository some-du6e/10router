import { randomBytes } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// OpenCode session IDs encode an inverted timestamp followed by 14 base62 characters.
export function generateSessionId(timestamp = Date.now()) {
  const value = ~(BigInt(timestamp) * 0x1000n + 1n);
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, "0")
  ).join("");
  const random = Array.from(randomBytes(14), (byte) => BASE62[byte % BASE62.length]).join("");
  return `ses_${time}${random}`;
}

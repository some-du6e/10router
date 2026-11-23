// The UTF-8 bytes of JSON.stringify(value), written into a buffer or checked
// against bytes already built, without building the JSON string. Server only
// (Buffer). A body resent to another account is checked against the bytes
// sent the first time, and a request detail's full copy is written straight
// into its buffer, instead of serializing a multi-MB body again for each.
import { walkJson } from "./jsonMeasure.js";

const HEX = "0123456789abcdef";
// The letter JSON.stringify escapes a control character with (\b \t \n \f \r), or 0 for \u00xx.
const SHORT_ESCAPE_LETTER = new Uint8Array(0x20);
SHORT_ESCAPE_LETTER[8] = 0x62;
SHORT_ESCAPE_LETTER[9] = 0x74;
SHORT_ESCAPE_LETTER[10] = 0x6e;
SHORT_ESCAPE_LETTER[12] = 0x66;
SHORT_ESCAPE_LETTER[13] = 0x72;
// A character JSON.stringify escapes, besides a lone surrogate.
const NEEDS_ESCAPE = /["\\\u0000-\u001f]/;
// The most UTF-8 bytes JSON.stringify writes for one UTF-16 unit (\u00xx).
const MAX_BYTES_PER_UNIT = 6;
// A string with nothing to escape is compared through this window, natively,
// in pieces of at most WINDOW_BYTES / 3 units (3 bytes each at most).
const WINDOW_BYTES = 48 * 1024;

const STOP = Symbol("stop");

const isWellFormed = (s: string): boolean => (s as unknown as { isWellFormed?: () => boolean }).isWellFormed?.() ?? false;
const plain = (s: string): boolean => !NEEDS_ESCAPE.test(s) && isWellFormed(s);

// Writes JSON.stringify(s)'s UTF-8 into buf at `at`, which has room for
// MAX_BYTES_PER_UNIT * s.length + 2 bytes; returns the end.
function writeString(s: string, buf: Buffer, at: number): number {
  let pos = at;
  buf[pos++] = 0x22;
  if (plain(s)) {
    pos += buf.write(s, pos, "utf8");
    buf[pos++] = 0x22;
    return pos;
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c < 0x80) {
      if (c === 0x22 || c === 0x5c) buf[pos++] = 0x5c;
      buf[pos++] = c;
    } else if (c < 0x800) {
      if (c < 0x20) {
        buf[pos++] = 0x5c;
        const letter = SHORT_ESCAPE_LETTER[c];
        if (letter) buf[pos++] = letter;
        else {
          buf[pos++] = 0x75;
          buf[pos++] = 0x30;
          buf[pos++] = 0x30;
          buf[pos++] = HEX.charCodeAt(c >> 4);
          buf[pos++] = HEX.charCodeAt(c & 15);
        }
      } else {
        buf[pos++] = 0xc0 | (c >> 6);
        buf[pos++] = 0x80 | (c & 63);
      }
    } else if (c >= 0xd800 && c <= 0xdfff) {
      const next = s.charCodeAt(i + 1);
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        const cp = ((c - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        buf[pos++] = 0xf0 | (cp >> 18);
        buf[pos++] = 0x80 | ((cp >> 12) & 63);
        buf[pos++] = 0x80 | ((cp >> 6) & 63);
        buf[pos++] = 0x80 | (cp & 63);
        i++;
      } else {
        // A lone surrogate: \udxxx.
        buf[pos++] = 0x5c;
        buf[pos++] = 0x75;
        buf[pos++] = HEX.charCodeAt(c >> 12);
        buf[pos++] = HEX.charCodeAt((c >> 8) & 15);
        buf[pos++] = HEX.charCodeAt((c >> 4) & 15);
        buf[pos++] = HEX.charCodeAt(c & 15);
      }
    } else {
      buf[pos++] = 0xe0 | (c >> 12);
      buf[pos++] = 0x80 | ((c >> 6) & 63);
      buf[pos++] = 0x80 | (c & 63);
    }
  }
  buf[pos++] = 0x22;
  return pos;
}

let window: Buffer | null = null;
let scratch: Buffer | null = null;

// Whether bytes from `at` start with JSON.stringify(s)'s UTF-8; the end, or -1.
function matchString(s: string, bytes: Uint8Array, at: number): number {
  if (bytes[at] !== 0x22) return -1;
  let pos = at + 1;
  if (plain(s)) {
    // Its UTF-8 is its JSON: compared natively, a window at a time.
    const buf = (window ??= Buffer.allocUnsafeSlow(WINDOW_BYTES));
    const pieceChars = WINDOW_BYTES / 3;
    let i = 0;
    while (i < s.length) {
      let end = Math.min(s.length, i + pieceChars);
      // A surrogate pair stays in one piece.
      if (end < s.length) {
        const last = s.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff) end--;
      }
      const n = buf.write(i === 0 && end === s.length ? s : s.substring(i, end), 0, "utf8");
      if (pos + n > bytes.length || buf.compare(bytes, pos, pos + n, 0, n) !== 0) return -1;
      pos += n;
      i = end;
    }
    return bytes[pos] === 0x22 ? pos + 1 : -1;
  }
  // Each character against the bytes it is written as (as writeString writes them).
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c < 0x80) {
      if (c === 0x22 || c === 0x5c) {
        if (bytes[pos++] !== 0x5c) return -1;
      }
      if (bytes[pos++] !== c) return -1;
    } else if (c < 0x800) {
      if (c < 0x20) {
        if (bytes[pos++] !== 0x5c) return -1;
        const letter = SHORT_ESCAPE_LETTER[c];
        if (letter) {
          if (bytes[pos++] !== letter) return -1;
        } else if (bytes[pos++] !== 0x75 || bytes[pos++] !== 0x30 || bytes[pos++] !== 0x30
          || bytes[pos++] !== HEX.charCodeAt(c >> 4) || bytes[pos++] !== HEX.charCodeAt(c & 15)) return -1;
      } else if (bytes[pos++] !== (0xc0 | (c >> 6)) || bytes[pos++] !== (0x80 | (c & 63))) return -1;
    } else if (c >= 0xd800 && c <= 0xdfff) {
      const next = s.charCodeAt(i + 1);
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        const cp = ((c - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        if (bytes[pos++] !== (0xf0 | (cp >> 18)) || bytes[pos++] !== (0x80 | ((cp >> 12) & 63))
          || bytes[pos++] !== (0x80 | ((cp >> 6) & 63)) || bytes[pos++] !== (0x80 | (cp & 63))) return -1;
        i++;
      } else if (bytes[pos++] !== 0x5c || bytes[pos++] !== 0x75 || bytes[pos++] !== HEX.charCodeAt(c >> 12)
        || bytes[pos++] !== HEX.charCodeAt((c >> 8) & 15) || bytes[pos++] !== HEX.charCodeAt((c >> 4) & 15)
        || bytes[pos++] !== HEX.charCodeAt(c & 15)) return -1;
    } else if (bytes[pos++] !== (0xe0 | (c >> 12)) || bytes[pos++] !== (0x80 | ((c >> 6) & 63))
      || bytes[pos++] !== (0x80 | (c & 63))) return -1;
  }
  return bytes[pos] === 0x22 ? pos + 1 : -1;
}

/**
 * True only when Buffer.from(JSON.stringify(value), "utf8") equals `bytes`,
 * found without building either: false as soon as they differ, and for a
 * value walkJson can't follow (a toJSON, a class instance).
 */
export function serializesTo(value: unknown, bytes: Uint8Array): boolean {
  if (!(bytes instanceof Uint8Array) || value === undefined || typeof value === "function" || typeof value === "symbol") return false;
  let at = 0;
  try {
    walkJson(
      value,
      (text) => {
        for (let i = 0; i < text.length; i++) if (bytes[at++] !== text.charCodeAt(i)) throw STOP;
      },
      (s) => {
        at = matchString(s, bytes, at);
        if (at < 0) throw STOP;
      },
    );
  } catch {
    return false;
  }
  return at === bytes.length;
}

/**
 * Writes the UTF-8 bytes of JSON.stringify(value) into `target` from `offset`
 * and returns the offset after them. Throws when they don't fit and for a
 * value walkJson can't follow; either leaves what was written so far.
 */
export function writeJson(value: unknown, target: Uint8Array, offset: number): number {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") throw new TypeError("value has no JSON");
  const buf = Buffer.isBuffer(target) ? target : Buffer.from(target.buffer, target.byteOffset, target.byteLength);
  let at = offset;
  const room = (n: number) => {
    if (at + n > buf.length) throw new RangeError("JSON does not fit");
  };
  walkJson(
    value,
    (text) => {
      room(text.length);
      for (let i = 0; i < text.length; i++) buf[at++] = text.charCodeAt(i);
    },
    (s) => {
      // Room for the worst case; nearer the end, the exact size decides.
      if (at + MAX_BYTES_PER_UNIT * s.length + 2 > buf.length) {
        const n = plain(s) ? Buffer.byteLength(s, "utf8") + 2 : -1;
        if (n < 0) {
          // Not plain: written a piece at a time through scratch, each piece checked.
          const piece = (scratch ??= Buffer.allocUnsafeSlow(MAX_BYTES_PER_UNIT * 8 * 1024 + 2));
          const pieceChars = 8 * 1024;
          room(1);
          buf[at++] = 0x22;
          let i = 0;
          while (i < s.length) {
            let end = Math.min(s.length, i + pieceChars);
            if (end < s.length) {
              const last = s.charCodeAt(end - 1);
              if (last >= 0xd800 && last <= 0xdbff) end--;
            }
            const len = writeString(i === 0 && end === s.length ? s : s.substring(i, end), piece, 0) - 2;
            room(len);
            piece.copy(buf, at, 1, 1 + len);
            at += len;
            i = end;
          }
          room(1);
          buf[at++] = 0x22;
          return;
        }
        room(n);
      }
      at = writeString(s, buf, at);
    },
  );
  return at;
}

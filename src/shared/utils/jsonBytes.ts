// The UTF-8 bytes of JSON.stringify(value), written into a buffer or checked
// against bytes already built, without building the JSON string. Server only
// (Buffer). A body resent to another account is checked against the bytes
// sent the first time, and a request detail's full copy is written straight
// into its buffer, instead of serializing a multi-MB body again for each.
import { walkJson, quotedSizes, sized, skipped, SHORT_ESCAPE_LETTER } from "./jsonMeasure.js";

const HEX = "0123456789abcdef";
// A character JSON.stringify escapes, besides a lone surrogate.
const NEEDS_ESCAPE = /["\\\u0000-\u001f]/;
// The most UTF-8 bytes JSON.stringify writes for one UTF-16 unit (\u00xx).
const MAX_BYTES_PER_UNIT = 6;
// A string is checked a piece at a time through this window: pieces of
// WINDOW_BYTES / 3 units with nothing to escape (3 bytes each at most),
// WINDOW_BYTES / MAX_BYTES_PER_UNIT otherwise.
const WINDOW_BYTES = 48 * 1024;

const STOP = Symbol("stop");

const isWellFormed = (s: string): boolean => (s as unknown as { isWellFormed?: () => boolean }).isWellFormed?.() ?? false;
// Nothing to escape: its UTF-8 is its JSON, which Buffer#write gives natively.
const plain = (s: string): boolean => !NEEDS_ESCAPE.test(s) && isWellFormed(s);

// Where a piece of at most `n` units from `i` ends, never between a surrogate pair.
function pieceEnd(s: string, i: number, n: number): number {
  const end = Math.min(s.length, i + n);
  if (end === s.length) return end;
  const last = s.charCodeAt(end - 1);
  return last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
}

// Writes the JSON of s[i, end) (no quotes) as UTF-8 into buf at `pos`, which
// has room for it; returns the end. `end` doesn't split a surrogate pair.
function writeChars(s: string, i: number, end: number, buf: Buffer, pos: number): number {
  for (; i < end; i++) {
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
      const next = i + 1 < end ? s.charCodeAt(i + 1) : 0;
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
  return pos;
}

let window: Buffer | null = null;

// Whether bytes from `at` start with JSON.stringify(s)'s UTF-8; the end, or -1.
// Each piece is written into the window and compared natively.
function matchString(s: string, bytes: Uint8Array, at: number): number {
  if (bytes[at] !== 0x22) return -1;
  const buf = (window ??= Buffer.allocUnsafeSlow(WINDOW_BYTES));
  const isPlain = plain(s);
  const pieceChars = WINDOW_BYTES / (isPlain ? 3 : MAX_BYTES_PER_UNIT);
  let pos = at + 1;
  let i = 0;
  while (i < s.length) {
    const end = pieceEnd(s, i, pieceChars);
    const n = isPlain ? buf.write(i === 0 && end === s.length ? s : s.substring(i, end), 0, "utf8") : writeChars(s, i, end, buf, 0);
    if (pos + n > bytes.length || buf.compare(bytes, pos, pos + n, 0, n) !== 0) return -1;
    pos += n;
    i = end;
  }
  return bytes[pos] === 0x22 ? pos + 1 : -1;
}

/**
 * True only when Buffer.from(JSON.stringify(value), "utf8") equals `bytes`,
 * found without building either: false as soon as they differ, and for a
 * value walkJson can't follow (a toJSON, a class instance).
 */
export function serializesTo(value: unknown, bytes: Uint8Array): boolean {
  if (!(bytes instanceof Uint8Array) || skipped(value)) return false;
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
 * and returns the offset after them. Throws a RangeError when they don't fit,
 * and walkJson's error for a value it can't follow; either leaves what was
 * written so far.
 */
export function writeJson(value: unknown, target: Buffer, offset: number): number {
  if (skipped(value)) throw new TypeError("value has no JSON");
  let at = offset;
  const room = (n: number) => {
    if (at + n > target.length) throw new RangeError("JSON does not fit");
  };
  walkJson(
    value,
    (text) => {
      room(text.length);
      for (let i = 0; i < text.length; i++) target[at++] = text.charCodeAt(i);
    },
    (s) => {
      // Room for the worst case, or else for its exact size.
      if (at + MAX_BYTES_PER_UNIT * s.length + 2 > target.length) {
        quotedSizes(s);
        room(sized.bytes);
      }
      target[at++] = 0x22;
      at = plain(s) ? at + target.write(s, at, "utf8") : writeChars(s, 0, s.length, target, at);
      target[at++] = 0x22;
    },
  );
  return at;
}

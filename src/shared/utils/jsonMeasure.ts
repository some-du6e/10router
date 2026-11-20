// JSON.stringify's length, head and UTF-8 size for a value, without building
// the string. Request details store a few KB of a payload that can be several
// MB, once for every account a request tries; serializing it whole just to
// keep its size and its first 2,000 characters put a body-sized string on the
// heap each time.

// The strings that take the fast path: printable ASCII with no `"` or `\`,
// which JSON.stringify writes as they are, one byte a character. Anything
// else (escapes, non-ASCII, U+2028 and U+2029 included) is counted character
// by character.
const NOT_PLAIN_ASCII = /[^ -!#-[\]-~]/;

const shortEscape = (c: number): boolean => c === 8 || c === 9 || c === 10 || c === 12 || c === 13;

// quotedSizes' results, in module state so a call allocates nothing.
let sizedLength = 0;
let sizedBytes = 0;

// Both sizes of JSON.stringify(s) in one pass: characters into sizedLength,
// UTF-8 bytes into sizedBytes.
function quotedSizes(s: string): void {
  if (!NOT_PLAIN_ASCII.test(s)) {
    sizedLength = sizedBytes = s.length + 2;
    return;
  }
  let length = s.length + 2;
  let bytes = 2;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20) {
      const extra = shortEscape(c) ? 1 : 5;
      length += extra;
      bytes += extra + 1;
    } else if (c === 0x22 || c === 0x5c) {
      length += 1;
      bytes += 2;
    } else if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdfff) {
      const next = s.charCodeAt(i + 1);
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        // \udxxx
        length += 5;
        bytes += 6;
      }
    } else bytes += 3;
  }
  sizedLength = length;
  sizedBytes = bytes;
}

// Far below the nesting JSON.stringify overflows the stack on (about 4,500
// levels), so nothing measured here is a value it can't serialize. A cycle
// reaches it too.
export const MAX_MEASURE_DEPTH = 1000;

const UNSUPPORTED = Symbol("unsupported");

const skipped = (v: unknown): boolean => v === undefined || typeof v === "function" || typeof v === "symbol";

/**
 * Walks `value` as JSON.stringify would, handing each token to `emit` and each
 * string (keys too) to `emitString`. Throws UNSUPPORTED for what it can't
 * follow the same way (a toJSON, a class instance, a BigInt, nesting past
 * MAX_MEASURE_DEPTH).
 */
function walkJson(value: unknown, emit: (token: string) => void, emitString: (s: string) => void): void {
  const walk = (v: unknown, depth: number): void => {
    if (v === null) return emit("null");
    switch (typeof v) {
      case "string": return emitString(v);
      case "number": return emit(Number.isFinite(v) ? String(v) : "null");
      case "boolean": return emit(v ? "true" : "false");
      case "object": break;
      default:
        // undefined, a function or a symbol in an array; a BigInt throws in JSON.stringify.
        if (skipped(v)) return emit("null");
        throw UNSUPPORTED;
    }
    const obj = v as Record<string, unknown>;
    if (depth >= MAX_MEASURE_DEPTH || Object.hasOwn(obj, "toJSON")) throw UNSUPPORTED;
    const proto = Object.getPrototypeOf(obj);
    if (Array.isArray(obj)) {
      if (proto !== Array.prototype) throw UNSUPPORTED;
      emit("[");
      for (let i = 0; i < obj.length; i++) {
        if (i > 0) emit(",");
        walk(obj[i], depth + 1);
      }
      emit("]");
      return;
    }
    if (proto !== Object.prototype && proto !== null) throw UNSUPPORTED;
    emit("{");
    let first = true;
    for (const key of Object.keys(obj)) {
      const child = obj[key];
      if (skipped(child)) continue;
      if (!first) emit(",");
      first = false;
      emitString(key);
      emit(":");
      walk(child, depth + 1);
    }
    emit("}");
  };
  walk(value, 0);
}

export interface JsonMeasure {
  /** JSON.stringify(value).length */
  length: number;
  /** The start of JSON.stringify(value): at least `prefixChars` characters when it has that many. */
  prefix: string;
  /** Buffer.byteLength(JSON.stringify(value), "utf8") */
  bytes: number;
}

/**
 * The length of JSON.stringify(value), its UTF-8 size and its first
 * `prefixChars` characters (a few more at most, where a short token crosses
 * the cut), in one walk. Plain JSON data only, as a parsed request is;
 * undefined for anything else, which the caller serializes itself.
 */
export function measureJson(value: unknown, prefixChars: number): JsonMeasure | undefined {
  if (skipped(value)) return undefined;
  let length = 0;
  let bytes = 0;
  let prefix = "";
  try {
    walkJson(
      value,
      // Every token but a string is ASCII.
      (text) => {
        length += text.length;
        bytes += text.length;
        if (prefix.length < prefixChars) prefix += text;
      },
      (s) => {
        quotedSizes(s);
        const n = sizedLength;
        const need = prefixChars - prefix.length;
        // One character past the cut, so a surrogate pair there is escaped as a pair.
        if (need > 0) prefix += n <= need ? JSON.stringify(s) : JSON.stringify(s.slice(0, need + 1)).slice(0, need);
        length += n;
        bytes += sizedBytes;
      },
    );
  } catch {
    return undefined;
  }
  return { length, prefix, bytes };
}

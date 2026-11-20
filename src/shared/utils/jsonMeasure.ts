// JSON.stringify's length, head and UTF-8 size for a value, without building
// the string. Request details store a few KB of a payload that can be several
// MB, once for every account a request tries; serializing it whole just to
// keep its size and its first 2,000 characters put a body-sized string on the
// heap each time.

// Characters a string needs escaping for. U+2028 and U+2029 are not among
// them: JSON.stringify writes them as they are.
// eslint-disable-next-line no-control-regex
const NEEDS_ESCAPE = /["\\\u0000-\u001f\ud800-\udfff]/;
// Anything but printable ASCII that is written as it is (all of it but `"`
// and `\`).
const NOT_PLAIN_ASCII = /[^ -!#-[\]-~]/;

const shortEscape = (c: number): boolean => c === 8 || c === 9 || c === 10 || c === 12 || c === 13;

/** Characters JSON.stringify gives the string `s`, quotes included. */
export function quotedLength(s: string): number {
  let n = s.length + 2;
  if (!NEEDS_ESCAPE.test(s)) return n;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20) n += shortEscape(c) ? 1 : 5;
    else if (c === 0x22 || c === 0x5c) n += 1;
    else if (c >= 0xd800 && c <= 0xdfff) {
      const next = s.charCodeAt(i + 1);
      // A pair is copied as it is; a lone half is written \udxxx.
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) i++;
      else n += 5;
    }
  }
  return n;
}

/** UTF-8 bytes of JSON.stringify(s), quotes included. */
export function quotedUtf8Length(s: string): number {
  if (!NOT_PLAIN_ASCII.test(s)) return s.length + 2;
  let n = 2;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20) n += shortEscape(c) ? 2 : 6;
    else if (c === 0x22 || c === 0x5c) n += 2;
    else if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdfff) {
      const next = s.charCodeAt(i + 1);
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        n += 4;
        i++;
      } else {
        n += 6; // \udxxx
      }
    } else n += 3;
  }
  return n;
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
}

/**
 * The length of JSON.stringify(value) and its first `prefixChars` characters
 * (a few more at most, where a short token crosses the cut). Plain JSON data
 * only, as a parsed request is; undefined for anything else, which the caller
 * serializes itself.
 */
export function measureJson(value: unknown, prefixChars: number): JsonMeasure | undefined {
  if (skipped(value)) return undefined;
  let length = 0;
  let prefix = "";
  try {
    walkJson(
      value,
      (text) => {
        length += text.length;
        if (prefix.length < prefixChars) prefix += text;
      },
      (s) => {
        const n = quotedLength(s);
        const need = prefixChars - prefix.length;
        // One character past the cut, so a surrogate pair there is escaped as a pair.
        if (need > 0) prefix += n <= need ? JSON.stringify(s) : JSON.stringify(s.slice(0, need + 1)).slice(0, need);
        length += n;
      },
    );
  } catch {
    return undefined;
  }
  return { length, prefix };
}

/**
 * Buffer.byteLength(JSON.stringify(value), "utf8"), or undefined for what
 * measureJson can't measure.
 */
export function jsonUtf8Length(value: unknown): number | undefined {
  if (skipped(value)) return undefined;
  let bytes = 0;
  try {
    // Every token but a string is ASCII.
    walkJson(value, (text) => { bytes += text.length; }, (s) => { bytes += quotedUtf8Length(s); });
  } catch {
    return undefined;
  }
  return bytes;
}

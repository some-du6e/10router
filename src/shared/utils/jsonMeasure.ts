// JSON.stringify's length and head for a value, without building the string.
// Request details store a few KB of a payload that can be several MB, once for
// every account a request tries; serializing it whole just to keep its size
// and its first 2,000 characters put a body-sized string on the heap each time.

// Characters a string needs escaping for. U+2028 and U+2029 are not among
// them: JSON.stringify writes them as they are.
// eslint-disable-next-line no-control-regex
const NEEDS_ESCAPE = /["\\\u0000-\u001f\ud800-\udfff]/;

/** Characters JSON.stringify gives the string `s`, quotes included. */
export function quotedLength(s: string): number {
  let n = s.length + 2;
  if (!NEEDS_ESCAPE.test(s)) return n;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20) n += c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 1 : 5;
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

// Far below the nesting JSON.stringify overflows the stack on (about 4,500
// levels), so nothing measured here is a value it can't serialize. A cycle
// reaches it too.
export const MAX_MEASURE_DEPTH = 1000;

const UNSUPPORTED = Symbol("unsupported");

export interface JsonMeasure {
  /** JSON.stringify(value).length */
  length: number;
  /** The start of JSON.stringify(value): at least `prefixChars` characters when it has that many. */
  prefix: string;
}

const skipped = (v: unknown): boolean => v === undefined || typeof v === "function" || typeof v === "symbol";

/**
 * The length of JSON.stringify(value) and its first `prefixChars` characters
 * (a few more at most, where a short token crosses the cut). Plain JSON data
 * only, as a parsed request is; undefined for anything else (a toJSON, a class
 * instance, a BigInt, a cycle, nesting past MAX_MEASURE_DEPTH), which the
 * caller serializes itself.
 */
export function measureJson(value: unknown, prefixChars: number): JsonMeasure | undefined {
  let length = 0;
  let prefix = "";
  const emit = (text: string) => {
    length += text.length;
    if (prefix.length < prefixChars) prefix += text;
  };
  const emitString = (s: string) => {
    const n = quotedLength(s);
    const need = prefixChars - prefix.length;
    // One character past the cut, so a surrogate pair there is escaped as a pair.
    if (need > 0) prefix += n <= need ? JSON.stringify(s) : JSON.stringify(s.slice(0, need + 1)).slice(0, need);
    length += n;
  };
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
  if (skipped(value)) return undefined;
  try {
    walk(value, 0);
  } catch {
    return undefined;
  }
  return { length, prefix };
}

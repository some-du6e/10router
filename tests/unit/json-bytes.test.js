// The counters and writers that stand in for JSON.stringify on multi-MB
// bodies must give exactly what JSON.stringify gives, for every string:
// escapes, control characters, non-ASCII, surrogate pairs and lone
// surrogates (which JSON.stringify writes as \udxxx), and cuts that split a
// pair.
import { describe, expect, it } from "vitest";
import { quotedLength, sameJson } from "../../src/shared/utils/jsonMeasure.js";
import { serializesTo, writeJson } from "../../src/shared/utils/jsonBytes.js";
import { __test__ as preview } from "../../src/shared/utils/requestConversation.js";

// mulberry32: 32-bit integer math, so the draws don't collapse to a few values.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every control character, the two JSON escapes, DEL, 2- and 3-byte UTF-8,
// U+2028/2029 (left as they are), pairs, lone highs and lows, and a high
// before what can't complete it.
const PIECES = [
  ...Array.from({ length: 0x20 }, (_, c) => String.fromCharCode(c)),
  "x", "abc", "\"", "\\", "/", "\u007f", "~", "{[,:]}", "é", "ÿ", "߿", "ࠀ", "✓", " ", " ", "﻿", "￿",
  "😀", "𐀀", "􏿿", "\ud800", "\udbff", "\udc00", "\udfff", "\ud800\"", "\ud800\n", "\ud800\ud800", "\udc00\ud800",
];

function randomString(r, max = 80) {
  let s = "";
  const n = Math.floor(r() * max);
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(r() * PIECES.length)];
  return r() < 0.1 ? s.repeat(40) : s;
}

function randomValue(r, depth = 0) {
  const pick = r();
  if (depth > 4 || pick < 0.3) {
    const s = r();
    if (s < 0.45) return randomString(r);
    if (s < 0.6) return [Infinity, -Infinity, NaN, -0, 1e21, 1.5e-7, 42, 0.1, -12.5][Math.floor(r() * 9)];
    if (s < 0.7) return r() < 0.5;
    if (s < 0.8) return null;
    if (s < 0.9) return undefined;
    return [() => 1, Symbol("s")][Math.floor(r() * 2)];
  }
  if (pick < 0.6) return Array.from({ length: Math.floor(r() * 6) }, () => randomValue(r, depth + 1));
  return Object.fromEntries(Array.from({ length: Math.floor(r() * 6) }, () => [randomString(r, 12), randomValue(r, depth + 1)]));
}

// Values whose JSON exists (the top level isn't undefined, a function or a symbol).
function corpus(n, seed) {
  const r = rng(seed);
  const out = [];
  while (out.length < n) {
    const v = randomValue(r);
    if (JSON.stringify(v) !== undefined) out.push(v);
  }
  return out;
}

describe("quotedLength", () => {
  it("is JSON.stringify(s.slice(0, end)).length for every cut of every string", () => {
    const r = rng(1);
    const wrong = [];
    for (let n = 0; n < 2000; n++) {
      // Kept short: every cut of it is checked.
      const s = randomString(r, 60).slice(0, 200);
      for (let end = 0; end <= s.length; end++) {
        if (quotedLength(s, end) !== JSON.stringify(s.slice(0, end)).length) wrong.push([s, end]);
      }
      if (quotedLength(s) !== JSON.stringify(s).length) wrong.push([s, "all"]);
      if (quotedLength(s, s.length + 5) !== JSON.stringify(s).length) wrong.push([s, "past the end"]);
    }
    expect(wrong.slice(0, 3)).toEqual([]);
  });

  it("counts a pair split by the cut as a lone high surrogate", () => {
    expect(quotedLength("a😀b", 2)).toBe(JSON.stringify("a\ud83d").length);
    expect(quotedLength("a😀b", 3)).toBe(JSON.stringify("a😀").length);
  });
});

describe("serializesTo", () => {
  it("is true for the bytes JSON.stringify gives, and false once any byte differs", () => {
    const r = rng(2);
    for (const value of corpus(1500, 3)) {
      const bytes = Buffer.from(JSON.stringify(value), "utf8");
      expect(serializesTo(value, bytes)).toBe(true);
      const flipped = Buffer.from(bytes);
      const at = Math.floor(r() * flipped.length);
      flipped[at] ^= 1 << Math.floor(r() * 8);
      expect(serializesTo(value, flipped)).toBe(false);
      expect(serializesTo(value, bytes.subarray(0, bytes.length - 1))).toBe(false);
      expect(serializesTo(value, Buffer.concat([bytes, Buffer.from(" ")]))).toBe(false);
    }
  });

  it("checks a long plain string through its window, and finds a difference anywhere in it", () => {
    const s = "plain text without escapes ".repeat(20000) + "é😀";
    const bytes = Buffer.from(JSON.stringify({ s }), "utf8");
    expect(serializesTo({ s }, bytes)).toBe(true);
    for (const at of [10, 49 * 1024, bytes.length - 6]) {
      const changed = Buffer.from(bytes);
      changed[at] ^= 1;
      expect(serializesTo({ s }, changed)).toBe(false);
    }
  });

  it("is false for what it can't follow as JSON.stringify would", () => {
    const bytes = (v) => Buffer.from(JSON.stringify(v), "utf8");
    const at = new Date(0);
    expect(serializesTo({ at }, bytes({ at }))).toBe(false);
    const withToJSON = { toJSON: () => "x" };
    expect(serializesTo(withToJSON, bytes(withToJSON))).toBe(false);
    expect(serializesTo(undefined, Buffer.from("null"))).toBe(false);
    expect(serializesTo({ a: 1 }, "{\"a\":1}")).toBe(false);
  });
});

describe("writeJson", () => {
  it("writes the bytes JSON.stringify gives, at the offset, into an exact fit", () => {
    for (const value of corpus(1500, 4)) {
      const expected = Buffer.from(JSON.stringify(value), "utf8");
      const target = Buffer.alloc(expected.length + 3, 0xee);
      expect(writeJson(value, target, 3)).toBe(target.length);
      expect(target.subarray(3).equals(expected)).toBe(true);
      expect(target.subarray(0, 3).equals(Buffer.from([0xee, 0xee, 0xee]))).toBe(true);
    }
  });

  it("writes long strings, escaped or plain, near the end of an exact fit", () => {
    const value = { a: "é\"\n😀\ud800x".repeat(20000), b: "plain ".repeat(20000), c: "\u0001" };
    const expected = Buffer.from(JSON.stringify(value), "utf8");
    const target = Buffer.alloc(expected.length);
    expect(writeJson(value, target, 0)).toBe(expected.length);
    expect(target.equals(expected)).toBe(true);
  });

  it("throws when the JSON doesn't fit, writing nothing past the end", () => {
    for (const value of [{ a: "x".repeat(100) }, { a: "é\n".repeat(100) }, [1, 2, 3]]) {
      const n = Buffer.byteLength(JSON.stringify(value), "utf8");
      const backing = Buffer.alloc(n + 8, 0xee);
      expect(() => writeJson(value, backing.subarray(0, n - 1), 0)).toThrow(RangeError);
      expect(backing.subarray(n - 1).every((b) => b === 0xee)).toBe(true);
    }
  });
});

describe("sameJson", () => {
  it("is true only when JSON.stringify gives the same text", () => {
    const values = corpus(800, 5);
    for (let i = 0; i < values.length; i++) {
      for (const other of [values[i], values[(i * 7 + 1) % values.length], JSON.parse(JSON.stringify(values[i]))]) {
        if (sameJson(values[i], other)) expect(JSON.stringify(values[i])).toBe(JSON.stringify(other));
      }
    }
  });

  it("is true for separate copies of the same JSON data", () => {
    for (const value of corpus(800, 6)) {
      const data = JSON.parse(JSON.stringify(value));
      expect(sameJson(data, JSON.parse(JSON.stringify(value)))).toBe(true);
      expect(sameJson(data, structuredClone(data))).toBe(true);
    }
  });

  it("is false for a difference in a key, its order, a value or an array's length", () => {
    expect(sameJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJson({ a: 1 }, { b: 1 })).toBe(false);
    expect(sameJson([1, 2], [1, 2, 3])).toBe(false);
    expect(sameJson({ a: "x" }, { a: "x", b: 1 })).toBe(false);
    // Left out the same way: still the same text.
    expect(sameJson({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameJson({ at: new Date(0) }, { at: new Date(0) })).toBe(false);
    expect(sameJson(undefined, undefined)).toBe(false);
  });
});

describe("structuredPreview's measure", () => {
  const limitsFor = (maxSize) => {
    const limits = [];
    for (let limit = Math.min(maxSize, 8192); limit >= 32; limit = Math.floor(limit / 2)) limits.push(limit);
    return limits;
  };

  it("gives JSON.stringify's length of each shortened preview, for every limit", () => {
    const { measurePreviewSizes, shortenPreview } = preview;
    const r = rng(7);
    // Long strings too, so every limit cuts some (and some cuts split a pair).
    const values = corpus(600, 8).map((v) => (r() < 0.5 ? { messages: [v, { role: "user", content: randomString(r, 4000) }] } : v));
    for (const value of values) {
      const limits = limitsFor(1 << 30);
      const sizes = measurePreviewSizes(value, limits, 1 << 30);
      if (sizes === undefined) continue;
      expect(sizes).toEqual(limits.map((limit) => JSON.stringify(shortenPreview(value, limit)).length));
    }
  });
});

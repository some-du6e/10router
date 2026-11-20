// Every account a request tries saves a request detail with the client's
// request and the body sent upstream, each capped to a few KB. Capping must
// not serialize the whole prompt, and with full details on, the full copies
// kept for the dashboard must fit the container.
import { afterEach, describe, expect, it, vi } from "vitest";
import { measureJson, MAX_MEASURE_DEPTH } from "../../src/shared/utils/jsonMeasure.js";
import { __test__, memoryCaps } from "../../src/lib/db/repos/requestDetailsRepo.js";

const MB = 1024 * 1024;
const GiB = 1024 * MB;

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../../src/shared/utils/cgroupMemory.js");
});

// mulberry32: 32-bit integer math, so the draws don't collapse to a few values.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pieces that need escaping, or look like they might: lone and paired
// surrogates (a lone high before a quote, a newline or another high), control
// characters, and U+2028/2029, which JSON.stringify leaves as they are.
const PIECES = ["x", "\"", "\\", "\n", "\u0001", "\u001f", "\b", "\f", "\r", "\t", "\u007f", "~", "{[,:]}", "é", "߿", "ࠀ", "✓", "�", "😀", "𐀀",
  "\ud800", "\udc00", "\udfff", "\ud800\"", "\ud800\n", "\ud800\ud800", "\udc00\ud800", " ", " ", " "];

function randomString(r) {
  let s = "";
  const n = Math.floor(r() * 80);
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(r() * PIECES.length)];
  return r() < 0.1 ? s.repeat(40) : s;
}

function randomValue(r, depth = 0) {
  const pick = r();
  if (depth > 4 || pick < 0.3) {
    const s = r();
    if (s < 0.45) return randomString(r);
    if (s < 0.6) return [Infinity, -Infinity, NaN, -0, 1e21, 1.5e-7, 42, 0.1][Math.floor(r() * 8)];
    if (s < 0.7) return r() < 0.5;
    if (s < 0.8) return null;
    if (s < 0.9) return undefined;
    return [() => 1, Symbol("s")][Math.floor(r() * 2)];
  }
  if (pick < 0.6) return Array.from({ length: Math.floor(r() * 6) }, () => randomValue(r, depth + 1));
  return Object.fromEntries(Array.from({ length: Math.floor(r() * 6) }, () => [randomString(r).slice(0, 12), randomValue(r, depth + 1)]));
}

describe("measureJson", () => {
  it("gives JSON.stringify's length and head for plain JSON data", () => {
    const r = rng(3);
    const seen = new Set();
    for (let n = 0; n < 2000; n++) {
      const value = { m: randomValue(r) };
      const json = JSON.stringify(value);
      seen.add(json);
      for (const prefixChars of [0, 1, 2, 7, 100, 2001]) {
        const measured = measureJson(value, prefixChars);
        expect(measured.length).toBe(json.length);
        expect(measured.bytes).toBe(Buffer.byteLength(json, "utf8"));
        expect(json.startsWith(measured.prefix)).toBe(true);
        expect(measured.prefix.length).toBeGreaterThanOrEqual(Math.min(prefixChars, json.length));
      }
    }
    // Empty lists, objects and the few scalars repeat; the rest don't.
    expect(seen.size).toBeGreaterThan(1000);
  });

  it("measures every escape the way JSON.stringify writes it", () => {
    for (const piece of PIECES) {
      for (const s of [piece, `a${piece}`, `${piece}b`, piece.repeat(3)]) {
        // As a value and as a key.
        for (const value of [{ s }, { [s]: 1 }]) {
          const json = JSON.stringify(value);
          expect(measureJson(value, 0)).toEqual({ length: json.length, prefix: "", bytes: Buffer.byteLength(json, "utf8") });
        }
      }
    }
  });

  it("escapes a surrogate pair cut by the head as a pair", () => {
    const value = { t: "a😀b\ud800\"c" };
    const json = JSON.stringify(value);
    for (let prefixChars = 0; prefixChars <= json.length; prefixChars++) {
      expect(json.startsWith(measureJson(value, prefixChars).prefix)).toBe(true);
    }
  });

  it("keeps the head short when one string over 1 MB crosses the cut", () => {
    const value = { model: "m", messages: [{ role: "user", content: `${"line \"é\" 😀\n".repeat(120_000)}end` }] };
    const json = JSON.stringify(value);
    expect(json.length).toBeGreaterThan(MB);
    for (const prefixChars of [1, 30, 2001]) {
      const real = JSON.stringify;
      let longest = 0;
      vi.spyOn(JSON, "stringify").mockImplementation(function (v, ...rest) {
        const out = real.call(JSON, v, ...rest);
        if (typeof out === "string") longest = Math.max(longest, out.length);
        return out;
      });
      const measured = measureJson(value, prefixChars);
      vi.restoreAllMocks();
      // Not the string escaped whole, only the piece at the cut.
      expect(longest).toBeLessThan(64 * 1024);
      expect(measured.length).toBe(json.length);
      expect(json.startsWith(measured.prefix)).toBe(true);
      expect(measured.prefix.length).toBeLessThanOrEqual(prefixChars + 8);
    }
  });

  it("leaves to JSON.stringify what it can't measure the same way", () => {
    const cycle = { a: 1 };
    cycle.self = cycle;
    class Message { constructor() { this.role = "user"; } }
    for (const value of [cycle, { at: new Date(0) }, { x: { toJSON: () => 1 } }, [new Message()], { n: 1n }, undefined, () => 1]) {
      expect(measureJson(value, 10)).toBeUndefined();
    }
  });

  it("stops at MAX_MEASURE_DEPTH, well inside what JSON.stringify can serialize", () => {
    const nest = (levels) => {
      let v = "leaf";
      for (let i = 0; i < levels; i++) v = [v];
      return v;
    };
    const ok = nest(MAX_MEASURE_DEPTH);
    expect(measureJson(ok, 10).length).toBe(JSON.stringify(ok).length);
    expect(measureJson(nest(MAX_MEASURE_DEPTH + 1), 10)).toBeUndefined();
    expect(measureJson(nest(50_000), 10)).toBeUndefined();
  });
});

describe("request details memory caps", () => {
  it("hold the ring and the queue to a share of the container's memory", () => {
    expect(memoryCaps(2 * GiB)).toEqual({ fullRingMaxBytes: Math.floor(2 * GiB * 0.05), queuedRecordsMaxBytes: Math.floor(2 * GiB * 0.03) });
    // The old fixed values are the ceilings, and what applies without a limit.
    expect(memoryCaps(64 * GiB)).toEqual({ fullRingMaxBytes: 256 * MB, queuedRecordsMaxBytes: 128 * MB });
    expect(memoryCaps(null)).toEqual({ fullRingMaxBytes: 256 * MB, queuedRecordsMaxBytes: 128 * MB });
  });

  it("are read from the cgroup limit when the module loads", async () => {
    vi.resetModules();
    vi.doMock("../../src/shared/utils/cgroupMemory.js", () => ({ readCgroupMemoryLimit: () => 2 * GiB }));
    const repo = await import("../../src/lib/db/repos/requestDetailsRepo.js");
    expect({ ...repo.__test__.limits }).toEqual(memoryCaps(2 * GiB));
    vi.resetModules();
  });

  it("make no full copy the ring couldn't hold, and serialize one only when it is packed", async () => {
    const { limits, truncateField, fullCopySource, packSource, unpackFullData } = __test__;
    const cap = limits.fullRingMaxBytes;
    const request = { messages: [{ role: "user", content: "q".repeat(300_000) }] };
    const record = { request: truncateField(request, 5 * 1024) };
    expect(record.request._truncated).toBe(true);
    const stringify = vi.spyOn(JSON, "stringify");
    const serialized = () => stringify.mock.calls.filter(([value]) => value === request).length;
    try {
      // Counted at 2 bytes a character: 600 KB.
      limits.fullRingMaxBytes = 500 * 1024;
      expect(fullCopySource({ request }, record)).toBeNull();
      limits.fullRingMaxBytes = 700 * 1024;
      const source = fullCopySource({ request }, record);
      expect(source.bytes).toBe(2 * record.request._originalSize);
      expect(source.bytes).toBeLessThanOrEqual(limits.fullRingMaxBytes);
      expect(serialized()).toBe(0);
      const packed = await packSource(source);
      expect(serialized()).toBe(1);
      expect(await unpackFullData(packed)).toEqual({ request });
    } finally {
      stringify.mockRestore();
      limits.fullRingMaxBytes = cap;
    }
  });

  it("make no full copy over 16 MB of UTF-8 though under 16M characters, and don't serialize it", () => {
    const { truncateField, fullCopySource } = __test__;
    // 6M three-byte characters: 18 MB of UTF-8.
    const request = { messages: [{ role: "user", content: "€".repeat(6 * MB) }] };
    const stringify = vi.spyOn(JSON, "stringify");
    const record = { request: truncateField(request, 5 * 1024) };
    expect(record.request._originalSize).toBeLessThan(16 * MB);
    expect(fullCopySource({ request }, record)).toBeNull();
    expect(stringify.mock.calls.some(([value]) => value === request)).toBe(false);
  });

  it("make no full copy of a payload they can't measure that is over 16 MB of UTF-8", () => {
    const { limits, truncateField, fullCopySource } = __test__;
    const cap = limits.fullRingMaxBytes;
    // A Date sends the cap through JSON.stringify; 6M three-byte characters are 18 MB of UTF-8.
    const request = { at: new Date(0), content: "€".repeat(6 * MB) };
    try {
      // Room for it in the ring, so only the UTF-8 limit can refuse it.
      limits.fullRingMaxBytes = 256 * MB;
      const record = { request: truncateField(request, 5 * 1024) };
      expect(record.request._originalSize).toBeLessThan(16 * MB);
      const stringify = vi.spyOn(JSON, "stringify");
      expect(fullCopySource({ request }, record)).toBeNull();
      expect(stringify.mock.calls.some(([value]) => value === request)).toBe(false);
    } finally {
      limits.fullRingMaxBytes = cap;
    }
  });

  it("size a full copy from the walk that capped it, and walk nothing again on a stream's end save", () => {
    const { limits, truncateField, fullCopySource } = __test__;
    const cap = limits.fullRingMaxBytes;
    // A big cut payload: the copy is sized from the bytes its capping walk recorded.
    const message = { role: "user", content: "a".repeat(6 * MB) };
    const request = { messages: [message] };
    const keys = vi.spyOn(Object, "keys");
    const walks = () => keys.mock.calls.filter(([value]) => value === message).length;
    try {
      limits.fullRingMaxBytes = 256 * MB;
      const source = fullCopySource({ request }, { request: truncateField(request, 5 * 1024) });
      expect(source.utf8).toBe(Buffer.byteLength(JSON.stringify({ request }), "utf8"));
      expect(walks()).toBe(1);
      // The end save: the same request, capped and sized from the first save.
      expect(fullCopySource({ request }, { request: truncateField(request, 5 * 1024) }).utf8).toBe(source.utf8);
      expect(walks()).toBe(1);
    } finally {
      limits.fullRingMaxBytes = cap;
    }
  });

  it("hand gzip one buffer of the copy's UTF-8, not a joined string", async () => {
    const inputs = [];
    vi.resetModules();
    vi.doMock("node:zlib", async (importOriginal) => {
      const zlib = await importOriginal();
      return { ...zlib, gzip: (input, ...rest) => { inputs.push(input); return zlib.gzip(input, ...rest); } };
    });
    try {
      const fresh = await import("../../src/lib/db/repos/requestDetailsRepo.js");
      const { truncateField, fullCopySource, packSource } = fresh.__test__;
      const request = { messages: [{ role: "user", content: "ü😀\n".repeat(20000) }] };
      const providerRequest = { messages: [{ role: "user", content: "x".repeat(50000) }] };
      const item = { request, providerRequest };
      const record = { request: truncateField(request, 1024), providerRequest: truncateField(providerRequest, 1024) };
      expect(await packSource(fullCopySource(item, record))).toEqual(expect.any(String));
      expect(inputs).toHaveLength(1);
      expect(Buffer.isBuffer(inputs[0])).toBe(true);
      expect(inputs[0].length).toBe(Buffer.byteLength(JSON.stringify(item), "utf8"));
    } finally {
      vi.doUnmock("node:zlib");
      vi.resetModules();
    }
  });

  it("pack without walking the payloads again, writing each one's JSON before serializing the next", async () => {
    const { truncateField, fullCopySource, packSource } = __test__;
    const first = { role: "user", content: "ü".repeat(30000) };
    const second = { role: "user", content: "x".repeat(30000) };
    const item = { request: { messages: [first] }, providerRequest: { messages: [second] } };
    const record = { request: truncateField(item.request, 1024), providerRequest: truncateField(item.providerRequest, 1024) };
    const source = fullCopySource(item, record);
    expect(source.utf8).toBe(Buffer.byteLength(JSON.stringify(item), "utf8"));
    const keys = vi.spyOn(Object, "keys");
    const order = [];
    const real = JSON.stringify;
    vi.spyOn(JSON, "stringify").mockImplementation(function (value, ...rest) {
      if (value === item.request || value === item.providerRequest) order.push(value === item.request ? "serialize request" : "serialize providerRequest");
      return real.call(JSON, value, ...rest);
    });
    const write = Buffer.prototype.write;
    vi.spyOn(Buffer.prototype, "write").mockImplementation(function (text, ...rest) {
      if (typeof text === "string" && text.length > 1000) order.push("write");
      return write.call(this, text, ...rest);
    });
    // The recorded size alone sizes the buffer: a wrong one fails the pack.
    expect(await packSource({ ...source, utf8: source.utf8 + 1 })).toBeNull();
    order.length = 0;
    expect(await packSource(source)).toEqual(expect.any(String));
    vi.restoreAllMocks();
    expect(keys.mock.calls.filter(([value]) => value === first || value === second)).toHaveLength(0);
    expect(order).toEqual(["serialize request", "write", "serialize providerRequest", "write"]);
  });

  it("count as cut only what truncateField cut, not a client's own _truncated fields", () => {
    const { truncateField, fullCopySource } = __test__;
    for (const spoofed of ["a", -1e12, 1e15, null]) {
      // Small enough to be stored as it is.
      const request = { _truncated: true, _originalSize: spoofed, messages: [{ role: "user", content: "hi" }] };
      const record = { request: truncateField(request, 5 * 1024) };
      expect(record.request).toBe(request);
      expect(fullCopySource({ request }, record)).toBeNull();
    }
    // Next to a real cut, the spoofed field is left out and its size not counted.
    const real = { messages: [{ role: "user", content: "y".repeat(20000) }] };
    const spoof = { _truncated: true, _originalSize: "a", content: "hi" };
    const record = { request: truncateField(real, 1024), response: truncateField(spoof, 1024) };
    const source = fullCopySource({ request: real, response: spoof }, record);
    expect(source.parts.map(([key]) => key)).toEqual(["request"]);
    expect(Number.isFinite(source.bytes)).toBe(true);
    expect(source.bytes).toBe(2 * JSON.stringify(real).length);
  });

  it("pack the same bytes the joined JSON gives, measured or not", async () => {
    const { truncateField, fullCopySource, packSource } = __test__;
    const { gunzipSync } = await import("node:zlib");
    const request = { messages: [{ role: "user", content: "ü😀\"\n\ud800 ".repeat(5000) }] };
    // A Date can't be measured, so capping serializes it and sizes that JSON.
    const providerRequest = { at: new Date(0), messages: [{ role: "user", content: "x".repeat(20000) }] };
    const record = { request: truncateField(request, 1024), providerRequest: truncateField(providerRequest, 1024) };
    for (const item of [{ request }, { request, providerRequest }]) {
      const packed = await packSource(fullCopySource(item, record));
      expect(gunzipSync(Buffer.from(packed, "base64")).equals(Buffer.from(JSON.stringify(item), "utf8"))).toBe(true);
    }
  });

  it("cap a large payload without serializing it whole, even when a full copy may follow", () => {
    const { truncateField } = __test__;
    const request = { messages: Array.from({ length: 400 }, (_, i) => ({ role: "user", content: `const x = "${i}"; // é ✓\n`.repeat(120) })) };
    const real = JSON.stringify;
    let large = 0;
    vi.spyOn(JSON, "stringify").mockImplementation(function (value, ...rest) {
      const out = real.call(JSON, value, ...rest);
      if (typeof out === "string" && out.length > 64 * 1024) large++;
      return out;
    });
    const stored = truncateField(request, 5 * 1024);
    vi.restoreAllMocks();
    expect(stored._originalSize).toBe(JSON.stringify(request).length);
    expect(large).toBe(0);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { __test__ } from "../../src/lib/db/repos/requestDetailsRepo.js";
import { __test__ as conversationTest, structuredPreview } from "../../src/shared/utils/requestConversation.js";

const { truncateField, prettyJsonPrefix } = __test__;
const { measurePreviewSizes } = conversationTest;

// The implementation before the single-stringify change, kept as the reference output.
function legacyStructuredPreview(value, maxSize) {
  const preserve = new Set(["role", "type", "name", "id", "call_id", "tool_call_id", "tool_use_id"]);
  const shorten = (item, limit, key = "") => {
    if (typeof item === "string")
      return preserve.has(key) || item.length <= limit ? item : `${item.slice(0, limit)}\n[Content truncated]`;
    if (Array.isArray(item)) return item.map((child) => shorten(child, limit));
    if (item && typeof item === "object")
      return Object.fromEntries(Object.entries(item).map(([k, child]) => [k, shorten(child, limit, k)]));
    return item;
  };
  for (let limit = Math.min(maxSize, 8192); limit >= 32; limit = Math.floor(limit / 2)) {
    const preview = shorten(value, limit);
    if (JSON.stringify(preview).length <= maxSize) return preview;
  }
  return null;
}

function legacyShorten(item, limit, key = "") {
  const preserve = ["role", "type", "name", "id", "call_id", "tool_call_id", "tool_use_id"];
  if (typeof item === "string")
    return preserve.includes(key) || item.length <= limit ? item : `${item.slice(0, limit)}\n[Content truncated]`;
  if (Array.isArray(item)) return item.map((child) => legacyShorten(child, limit));
  if (item && typeof item === "object")
    return Object.fromEntries(Object.entries(item).map(([k, child]) => [k, legacyShorten(child, limit, k)]));
  return item;
}

function legacyTruncateField(obj, maxSize) {
  if (obj === undefined || obj === null) return {};
  let str;
  try { str = JSON.stringify(obj); } catch {
    return { _truncated: true, _originalSize: null, _preview: "[Payload could not be serialized]" };
  }
  if (str.length > maxSize) {
    const preview = JSON.stringify(obj, null, 2);
    const truncated = {
      _truncated: true,
      _originalSize: str.length,
      _omittedSize: str.length - maxSize,
      _preview: preview.substring(0, Math.min(2000, Math.max(0, maxSize - 256))),
      _structuredPreview: null,
    };
    while (JSON.stringify(truncated).length > maxSize && truncated._preview.length > 0) {
      truncated._preview = truncated._preview.slice(0, Math.floor(truncated._preview.length / 2));
    }
    const remaining = maxSize - JSON.stringify(truncated).length;
    truncated._structuredPreview = legacyStructuredPreview(obj, remaining);
    return truncated;
  }
  return obj;
}

function makeBody(targetBytes) {
  const body = {
    model: "claude-sonnet-4-5",
    stream: true,
    system: [{ type: "text", text: "You are Claude Code. ".repeat(50) }],
    tools: [{ name: "Read", description: "Reads a file", input_schema: { type: "object", properties: {}, required: [] } }],
    messages: [],
    metadata: { user_id: "u", nested: { empty: [], obj: {}, n: 1.5, flag: false, none: null, skip: undefined } },
  };
  let i = 0;
  while (JSON.stringify(body).length < targetBytes) {
    body.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: `line "${i}"\t\\ é ✓\n`.repeat(40) }] });
    body.messages.push({ role: "assistant", content: [{ type: "text", text: "short" }, { type: "tool_use", id: `toolu_${i + 1}`, name: "Read", input: { path: `/a/{b}/[c],:${i}` } }] });
    i += 2;
  }
  return body;
}

// Deterministic random JSON-ish values to cover shapes the fixed body misses.
function rng(seed) { return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648; }
function randomValue(r, depth = 0) {
  const pick = r();
  if (depth > 4 || pick < 0.3) {
    const s = r();
    if (s < 0.5) return "x\"\\\n {[,:]}".repeat(Math.floor(r() * 2000));
    if (s < 0.65) return Math.floor(r() * 1e6) / 7;
    if (s < 0.75) return r() < 0.5;
    if (s < 0.85) return null;
    if (s < 0.9) return undefined;
    return "";
  }
  if (pick < 0.6) return Array.from({ length: Math.floor(r() * 6) }, () => randomValue(r, depth + 1));
  const keys = ["role", "type", "name", "id", "content", "text", "a b", "é", "tool_use_id", "x"];
  return Object.fromEntries(Array.from({ length: Math.floor(r() * 6) }, () => [keys[Math.floor(r() * keys.length)], randomValue(r, depth + 1)]));
}

afterEach(() => vi.restoreAllMocks());

describe("requestDetails truncateField", () => {
  it("returns small bodies unchanged and serializes them identically", () => {
    const body = makeBody(1000);
    const stored = truncateField(body, 5 * 1024);
    expect(stored).toBe(body);
    expect(JSON.stringify(stored)).toBe(JSON.stringify(legacyTruncateField(body, 5 * 1024)));
  });

  it.each([5 * 1024, 64 * 1024, 128 * 1024])("matches the legacy stored output for large bodies (max %i)", (max) => {
    for (const size of [20e3, 300e3]) {
      const body = makeBody(size);
      const stored = truncateField(body, max);
      if (size > max) expect(stored._truncated).toBe(true);
      expect(JSON.stringify(stored)).toBe(JSON.stringify(legacyTruncateField(body, max)));
    }
  });

  it("matches the legacy output for random shapes and budgets", () => {
    const r = rng(42);
    for (let n = 0; n < 300; n++) {
      const value = { messages: randomValue(r), tools: randomValue(r) };
      const max = [300, 1024, 5 * 1024][n % 3];
      expect(JSON.stringify(truncateField(value, max))).toBe(JSON.stringify(legacyTruncateField(value, max)));
      expect(JSON.stringify(structuredPreview(value, max))).toBe(JSON.stringify(legacyStructuredPreview(value, max)));
    }
  });

  it("measures preview sizes exactly, so the fast path is taken", () => {
    const r = rng(99);
    const limits = [8192, 4096, 1024, 256, 32];
    let measured = 0;
    for (let n = 0; n < 200; n++) {
      const value = { messages: randomValue(r), tools: randomValue(r) };
      const sizes = measurePreviewSizes(value, limits, Infinity);
      expect(sizes).not.toBeNull();
      if (sizes === undefined) continue;
      measured++;
      expect(sizes).toEqual(limits.map((limit) => JSON.stringify(legacyShorten(value, limit)).length));
    }
    expect(measured).toBeGreaterThan(150);
  });

  it("falls back for values with toJSON (Dates) and still matches", () => {
    const value = { at: new Date(0), messages: [{ role: "user", content: "y".repeat(20000) }] };
    expect(JSON.stringify(truncateField(value, 1024))).toBe(JSON.stringify(legacyTruncateField(value, 1024)));
  });

  it("rebuilds the pretty-printed prefix from compact JSON", () => {
    const r = rng(7);
    for (let n = 0; n < 200; n++) {
      const value = randomValue(r);
      const compact = JSON.stringify(value);
      if (compact === undefined) continue;
      const pretty = JSON.stringify(value, null, 2);
      for (const limit of [0, 1, 37, 2000, pretty.length + 10]) {
        expect(prettyJsonPrefix(compact, limit)).toBe(pretty.substring(0, limit));
      }
    }
  });

  it("serializes a large body at full size only once", () => {
    const body = makeBody(300e3);
    const max = 5 * 1024;
    const real = JSON.stringify;
    let onBody = 0;
    let fullSize = 0;
    vi.spyOn(JSON, "stringify").mockImplementation(function (value, ...rest) {
      if (value === body) onBody++;
      const out = real.call(JSON, value, ...rest);
      if (typeof out === "string" && out.length > 2 * max) fullSize++;
      return out;
    });
    const stored = truncateField(body, max);
    JSON.stringify.mockRestore();
    expect(stored._truncated).toBe(true);
    expect(onBody).toBe(1);
    expect(fullSize).toBe(1);
  });

  it("measures strings exactly at each limit and one either side", () => {
    const limits = [8192, 4096, 1024, 256, 32];
    for (const limit of limits) {
      for (const len of [limit - 1, limit, limit + 1]) {
        const value = { messages: [{ role: "user", content: "z".repeat(len) }] };
        expect(measurePreviewSizes(value, limits, Infinity)).toEqual(
          limits.map((l) => JSON.stringify(legacyShorten(value, l)).length),
        );
      }
    }
  });

  it("builds one candidate preview, not one per limit", () => {
    // Few huge strings: fits only at a small limit, so the old loop tried several.
    const body = { model: "m", messages: Array.from({ length: 4 }, (_, i) => ({ role: "user", content: `${i}`.repeat(75e3) })) };
    const real = JSON.stringify;
    let large = 0;
    vi.spyOn(JSON, "stringify").mockImplementation(function (value, ...rest) {
      const out = real.call(JSON, value, ...rest);
      // Count whole candidate previews, not the per-string measuring calls.
      if (value && typeof value === "object" && !Array.isArray(value) && "messages" in value) large++;
      return out;
    });
    const preview = structuredPreview(body, 5 * 1024);
    JSON.stringify.mockRestore();
    expect(preview).not.toBeNull();
    expect(large).toBe(1);
  });
});

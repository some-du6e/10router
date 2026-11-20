// Every account a request tries saves a request detail holding the client's
// request and the body sent upstream, each capped to a few KB. Capping one must
// not serialize the whole prompt: a 3 MB prompt tried on several accounts would
// put two full-size strings on the heap per try.
import { afterEach, describe, expect, it, vi } from "vitest";
import { __test__ } from "../../src/lib/db/repos/requestDetailsRepo.js";

const { measureJson, truncateField, prettyJsonPrefix } = __test__;

afterEach(() => vi.restoreAllMocks());

function rng(seed) { return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648; }
function randomValue(r, depth = 0) {
  const pick = r();
  if (depth > 4 || pick < 0.3) {
    const s = r();
    if (s < 0.4) return "x\"\\\n\u0001\u001f\b\f\r\t\u007f {[,:]}é✓😀𐀀\udbff".repeat(Math.floor(r() * 40));
    if (s < 0.5) return "😀".repeat(Math.floor(r() * 1500));
    if (s < 0.6) return [Infinity, -Infinity, NaN, -0, 1e21, 1.5e-7, 42, 0.1][Math.floor(r() * 8)];
    if (s < 0.7) return r() < 0.5;
    if (s < 0.8) return null;
    if (s < 0.9) return undefined;
    return [() => 1, Symbol("s")][Math.floor(r() * 2)];
  }
  if (pick < 0.6) return Array.from({ length: Math.floor(r() * 6) }, () => randomValue(r, depth + 1));
  const keys = ["role", "type", "a\"b", "é", "x\n", "content", "😀k", "\ud800"];
  return Object.fromEntries(Array.from({ length: Math.floor(r() * 6) }, () => [keys[Math.floor(r() * keys.length)], randomValue(r, depth + 1)]));
}

function makePrompt(messages) {
  return {
    model: "claude-model",
    stream: true,
    system: [{ type: "text", text: "You are a coding agent.\n".repeat(200) }],
    tools: Array.from({ length: 20 }, (_, i) => ({ name: `tool_${i}`, description: "Does a thing", input_schema: { type: "object", properties: { path: { type: "string" } } } })),
    messages: Array.from({ length: messages }, (_, i) => (i % 2
      ? { role: "assistant", content: [{ type: "tool_use", id: `toolu_${i}`, name: "tool_1", input: { path: `/src/${i}.js` } }] }
      : { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i - 1}`, content: `const x = "${i}"; // é ✓\n`.repeat(120) }] })),
  };
}

// Counts strings JSON.stringify returns that are over `limit` characters.
function countLargeStringifies(limit) {
  const real = JSON.stringify;
  const counter = { large: 0 };
  vi.spyOn(JSON, "stringify").mockImplementation(function (value, ...rest) {
    const out = real.call(JSON, value, ...rest);
    if (typeof out === "string" && out.length > limit) counter.large++;
    return out;
  });
  return counter;
}

describe("measureJson", () => {
  it("gives JSON.stringify's length and head for plain JSON data", () => {
    const r = rng(3);
    for (let n = 0; n < 2000; n++) {
      const value = { m: randomValue(r) };
      const json = JSON.stringify(value);
      for (const prefixChars of [0, 1, 2, 7, 100, 2001]) {
        const measured = measureJson(value, prefixChars);
        expect(measured.length).toBe(json.length);
        expect(json.startsWith(measured.prefix)).toBe(true);
        expect(measured.prefix.length).toBeGreaterThanOrEqual(Math.min(prefixChars, json.length));
      }
    }
  });

  it("escapes a surrogate pair cut by the head as a pair", () => {
    const value = { t: "a😀b" };
    const json = JSON.stringify(value);
    for (let prefixChars = 0; prefixChars <= json.length; prefixChars++) {
      expect(json.startsWith(measureJson(value, prefixChars).prefix)).toBe(true);
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

  it("measures an object seen twice that is not a cycle", () => {
    const shared = { role: "user", content: "hi" };
    const value = { messages: [shared, shared] };
    expect(measureJson(value, 5000)).toEqual({ length: JSON.stringify(value).length, prefix: JSON.stringify(value) });
  });
});

describe("truncateField on a large prompt", () => {
  const max = 5 * 1024;

  it("caps it without serializing it whole, to the same record", () => {
    const body = makePrompt(800);
    const json = JSON.stringify(body);
    expect(json.length).toBeGreaterThan(1e6);
    const counter = countLargeStringifies(2 * max);
    const stored = truncateField(body, max);
    vi.restoreAllMocks();
    expect(counter.large).toBe(0);
    expect(stored._truncated).toBe(true);
    expect(stored._originalSize).toBe(json.length);
    expect(stored._omittedSize).toBe(json.length - max);
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(max);
    // The head of the same pretty-printed JSON the full string gives.
    expect(json.length > 2000 && prettyJsonPrefix(json, 2000).startsWith(stored._preview)).toBe(true);
    expect(stored._preview.length).toBeGreaterThan(0);
  });

  it("builds no full-size string across a request's account attempts", () => {
    // chatCore saves a new request object per attempt, around the client's
    // messages and tools, and a new upstream body per attempt.
    const body = makePrompt(800);
    const counter = countLargeStringifies(2 * max);
    for (let attempt = 0; attempt < 5; attempt++) {
      truncateField({ model: body.model, messages: body.messages, tools: body.tools, stream: true }, max);
      truncateField({ ...body, messages: body.messages.map((m) => ({ ...m })) }, max);
    }
    vi.restoreAllMocks();
    expect(counter.large).toBe(0);
  });

  it("still keeps the whole JSON when a full copy is kept", () => {
    const body = makePrompt(200);
    const fieldJson = {};
    const stored = truncateField(body, max, fieldJson, "providerRequest");
    expect(stored._truncated).toBe(true);
    expect(fieldJson.providerRequest).toBe(JSON.stringify(body));
  });

  it("returns a prompt that fits unchanged", () => {
    const body = makePrompt(2);
    expect(truncateField(body, 64 * 1024)).toBe(body);
  });
});

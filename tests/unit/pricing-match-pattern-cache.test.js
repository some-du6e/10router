import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { matchPattern, getPatternRegexCacheSize, PATTERN_PRICING } from "../../open-sse/providers/pricing.js";
import { PATTERN_CAPABILITIES, MODEL_CAPABILITIES, PROVIDER_CAPABILITIES } from "../../open-sse/providers/capabilities.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// The implementation before patterns were cached: compile on every call.
function oldMatchPattern(pattern, model) {
  const regex = new RegExp("^" + pattern.split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
  return regex.test(model);
}

// thinkingLevels.js keeps its pattern table private, so read the patterns from source.
const thinkingSource = fs.readFileSync(path.join(ROOT, "open-sse/providers/thinkingLevels.js"), "utf8");
const THINKING_PATTERNS = [...thinkingSource.matchAll(/pattern:\s*"([^"]+)"/g)].map(m => m[1]);

const TABLE_PATTERNS = [
  ...PATTERN_CAPABILITIES.map(p => p.pattern),
  ...PATTERN_PRICING.map(p => p.pattern),
  ...THINKING_PATTERNS,
];

// Edge cases: regex metacharacters, anchors, empty, bare wildcard, adjacent wildcards.
const EDGE_PATTERNS = ["*", "", "**", "a*b*c", "gpt-4.1", "gpt-4?1", "a+b", "(x)", "[ab]", "a|b", "^x$", "x\\y", "{1}", "MiniMax-*", "*-preview"];

const TABLE_MODELS = [
  ...Object.keys(MODEL_CAPABILITIES),
  ...Object.values(PROVIDER_CAPABILITIES).flatMap(m => Object.keys(m)),
];

const EDGE_MODELS = [
  "", "gpt-4o", "GPT-4O", "openai/gpt-4o", "gpt-4o-mini", "xgpt-4o", "gpt-4o\n", "gpt-4x1", "gpt-4.1",
  "minimax-m2.5", "MINIMAX-M2.5", "claude-opus-5-5", "anthropic/claude-opus-5-5", "abc", "aXbYc", "ab",
  "a+b", "aab", "(x)", "x", "a", "b", "a|b", "^x$", "x\\y", "{1}", "deepseek-reasoner", "o3-preview",
  "gemini-3-pro", "llama-4-maverick", "totally-unknown-model", "kimi-k2", "glm-5.1", "grok-code-fast",
];

function countRegExpConstructions(fn) {
  const RealRegExp = globalThis.RegExp;
  let constructed = 0;
  globalThis.RegExp = new Proxy(RealRegExp, {
    construct(target, args) { constructed++; return Reflect.construct(target, args); },
  });
  try { fn(); } finally { globalThis.RegExp = RealRegExp; }
  return constructed;
}

describe("matchPattern regex cache", () => {
  it("matches exactly like the uncached implementation over every table pattern", () => {
    const patterns = [...new Set([...TABLE_PATTERNS, ...EDGE_PATTERNS])];
    const models = [...new Set([...TABLE_MODELS, ...EDGE_MODELS])];
    expect(THINKING_PATTERNS.length).toBeGreaterThan(5);
    expect(patterns.length).toBeGreaterThan(150);

    let trueCount = 0;
    const mismatches = [];
    // Two passes so the second one runs against warm cache entries.
    for (let pass = 0; pass < 2; pass++) {
      for (const pattern of patterns) {
        for (const model of models) {
          const expected = oldMatchPattern(pattern, model);
          if (expected) trueCount++;
          if (matchPattern(pattern, model) !== expected) mismatches.push([pattern, model, expected]);
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(trueCount).toBeGreaterThan(100);
  });

  it("compiles each pattern once", () => {
    const pattern = "cache-probe-*-only-in-this-test";
    const sizeBefore = getPatternRegexCacheSize();
    const RealRegExp = globalThis.RegExp;
    let constructed = 0;
    globalThis.RegExp = new Proxy(RealRegExp, {
      construct(target, args) { constructed++; return Reflect.construct(target, args); },
    });
    try {
      for (let i = 0; i < 50; i++) {
        matchPattern(pattern, "cache-probe-x-only-in-this-test");
        matchPattern(pattern, "nope");
      }
    } finally {
      globalThis.RegExp = RealRegExp;
    }

    expect(constructed).toBe(1);
    expect(getPatternRegexCacheSize()).toBe(sizeBefore + 1);
    expect(matchPattern(pattern, "CACHE-PROBE-y-ONLY-in-this-test")).toBe(true);
    expect(matchPattern(pattern, "nope")).toBe(false);
  });

  it("compiles nothing on a repeated full-table scan", async () => {
    vi.resetModules();
    const { getCapabilitiesForModel } = await import("../../open-sse/providers/capabilities.js");
    getCapabilitiesForModel("openai", "totally-unknown-model");
    expect(countRegExpConstructions(() => {
      for (let i = 0; i < 3; i++) getCapabilitiesForModel("openai", "totally-unknown-model");
    })).toBe(0);
  });

  it("keeps one entry per distinct pattern, not per model", async () => {
    vi.resetModules();
    const fresh = await import("../../open-sse/providers/pricing.js");
    expect(fresh.getPatternRegexCacheSize()).toBe(0);
    fresh.matchPattern("a-*", "a-x");
    fresh.matchPattern("a-*", "A-Y");
    fresh.matchPattern("b-*", "b");
    expect(fresh.getPatternRegexCacheSize()).toBe(2);
    for (let i = 0; i < 500; i++) fresh.matchPattern("a-*", `a-${i}`);
    expect(fresh.getPatternRegexCacheSize()).toBe(2);
  });
});
